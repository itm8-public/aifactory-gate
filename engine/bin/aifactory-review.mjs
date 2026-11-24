#!/usr/bin/env node
// aifactory-review: the gate's review engine.
//   aifactory-review scan    --repo DIR --out DIR
//   aifactory-review verdict --repo DIR --out DIR --zone green|yellow|red --level 1|2|3 [--base REF]
//                            [--check name=outcome ...] [--ai-review on|off] [--profile solo]
//   aifactory-review run     (scan, then verdict; same options)
//   aifactory-review find-reusable --out DIR
//                            (the push to main: finds the pull request run that judged exactly this
//                            change and writes DIR/reuse-candidate.json; always exits 0)
//   aifactory-review reuse   --repo DIR --out DIR --from FILE (and the verdict options)
//                            (takes that verdict if it matches this commit; exit 3 when it does not)
// The AI review reads AIFACTORY_MODEL_ENDPOINT and AIFACTORY_MODEL_TOKEN (an Entra token), and
// AIFACTORY_AI_REVIEW_MISSING: the caller inputs gate.yml found empty (comma-separated).
// AIFACTORY_INPUTS (the caller's inputs as JSON) identifies the settings a verdict was made with;
// AIFACTORY_OWNER_TYPE (Organization or User) and AIFACTORY_RUN_URL go into the summary.
// find-reusable reads GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_API_URL and GH_TOKEN.
// Exit code: 0 when the verdict is pass or the level is advisory (1); 1 otherwise; 2 on a usage
// error; 3 when reuse finds the candidate does not match.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelClient } from '../src/models/client.mjs';
import { readDiff } from '../src/models/diff.mjs';
import { PROMPT_VERSION } from '../src/models/prompts.mjs';
import { explainVerdict, reviewWithModels } from '../src/models/review.mjs';
import { ZONES } from '../src/policy.mjs';
import { findReusable, githubApi, inputsHash, reuseVerdict, subjectOf } from '../src/reuse.mjs';
import { runScanners } from '../src/scan.mjs';
import { buildVerdict } from '../src/verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, checks: {}, base: 'HEAD^1', level: 2, 'ai-review': 'off', profile: '' };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`expected --option value, got "${key}"`);
    i++;
    if (key === '--check') {
      const at = value.indexOf('=');
      if (at < 1) throw new Error(`--check needs name=outcome, got "${value}"`);
      opts.checks[value.slice(0, at)] = value.slice(at + 1);
    } else opts[key.slice(2)] = value;
  }
  if (!['scan', 'verdict', 'run', 'reuse', 'find-reusable'].includes(command)) throw new Error('command must be scan, verdict, run, reuse or find-reusable');
  if (command === 'find-reusable') {
    if (!opts.out) throw new Error('--out is required');
    return opts;
  }
  if (!opts.repo || !opts.out) throw new Error('--repo and --out are required');
  if (command === 'reuse' && !opts.from) throw new Error('reuse needs --from FILE');
  if (command !== 'scan') {
    if (!ZONES.includes(opts.zone)) throw new Error('--zone must be green, yellow or red');
    opts.level = Number(opts.level);
    if (![1, 2, 3].includes(opts.level)) throw new Error('--level must be 1, 2 or 3');
    if (!['on', 'off'].includes(opts['ai-review'])) throw new Error('--ai-review must be on or off');
    if (!['', 'solo'].includes(opts.profile)) throw new Error("--profile must be 'solo' or empty");
  }
  return opts;
}

/** Rule ids of the scanner rule pack, so the AI review can name them too. */
export function scannerRuleIds(rulesDir) {
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => [...readFileSync(path.join(rulesDir, f), 'utf8').matchAll(/^\s*- id:\s*([\w-]+)/gm)].map((m) => m[1]));
}

/** Reads a file of the checked-out repository; never outside it. */
export function repoReader(repo) {
  const base = realpathSync(repo);
  return (rel) => {
    try {
      const full = realpathSync(path.resolve(base, rel));
      if (full !== base && !full.startsWith(base + path.sep)) return null;
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };
}

function versions(policy) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  let tools;
  try {
    const pins = JSON.parse(readFileSync(path.join(root, 'pins.json'), 'utf8'));
    tools = { gitleaks: pins.gitleaks.version, opengrep: pins.opengrep.version, 'osv-scanner': pins.osvScanner.version };
  } catch {
    tools = { gitleaks: 'unknown', opengrep: 'unknown', 'osv-scanner': 'unknown' };
  }
  return { engine: pkg.version, policy: policy.version, tools };
}

/**
 * The AI review inputs the caller left empty: those gate.yml lists, plus the endpoint when the engine
 * itself sees none. With any missing, the review is not tried and the verdict names them.
 */
export function missingAiValues(env) {
  const listed = (env.AIFACTORY_AI_REVIEW_MISSING ?? '').split(/[\s,]+/).filter(Boolean);
  if (!(env.AIFACTORY_MODEL_ENDPOINT ?? '').trim() && !listed.includes('review-endpoint')) listed.unshift('review-endpoint');
  return listed;
}

async function aiReview(opts, models, complete) {
  try {
    const { findings, state } = await reviewWithModels({
      diff: readDiff(opts.repo, opts.base),
      readFile: repoReader(opts.repo),
      scannerRules: scannerRuleIds(process.env.AIFACTORY_RULES_DIR ?? path.join(root, 'rules/opengrep')),
      zone: opts.zone,
      models,
      complete,
    });
    return { requested: true, findings, state };
  } catch (err) {
    return { requested: true, findings: [], state: {}, error: err.message };
  }
}

/** Owner type and run link for the summary, from gate.yml. Anything else is left out. */
export function runContext(env) {
  const ownerType = ['Organization', 'User'].includes(env.AIFACTORY_OWNER_TYPE) ? env.AIFACTORY_OWNER_TYPE : undefined;
  const runUrl = /^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(env.AIFACTORY_RUN_URL ?? '') ? env.AIFACTORY_RUN_URL : undefined;
  return { ...(ownerType ? { ownerType } : {}), ...(runUrl ? { runUrl } : {}) };
}

/** The push run's search for a pull request verdict. Never fails the job: no candidate means a full run. */
export async function findCommand(opts, env, { out = (s) => process.stdout.write(`${s}\n`), fetchImpl } = {}) {
  try {
    const repo = env.GITHUB_REPOSITORY;
    const { api, download } = githubApi({ token: env.GH_TOKEN ?? env.GITHUB_TOKEN, repo, apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com', ...(fetchImpl ? { fetchImpl } : {}) });
    const { candidate, reason } = await findReusable({ api, download, repo, runId: env.GITHUB_RUN_ID, sha: env.GITHUB_SHA, inputs: inputsHash(env.AIFACTORY_INPUTS) });
    if (candidate) writeFileSync(path.join(opts.out, 'reuse-candidate.json'), JSON.stringify(candidate));
    out(`${candidate ? 'reuse' : 'no reuse'}: ${reason}`);
  } catch (err) {
    out(`no reuse: ${err.message}`);
  }
  return 0;
}

function loadPolicy(opts) {
  const policyPath = opts.policy ?? path.join(root, opts.profile === 'solo' ? 'policy/policy.solo.v1.json' : 'policy/policy.v1.json');
  return JSON.parse(readFileSync(policyPath, 'utf8'));
}

/** The reuse command: the candidate's verdict when it matches this commit, else exit 3. */
function reuseCommand(opts, env, models) {
  const policy = loadPolicy(opts);
  let candidate;
  try {
    candidate = JSON.parse(readFileSync(opts.from, 'utf8'));
  } catch (err) {
    process.stderr.write(`aifactory-review: not reused, the candidate is unreadable (${err.message})\n`);
    return 3;
  }
  const { record, problem } = reuseVerdict({
    candidate,
    subject: subjectOf(opts.repo, opts.base, env.AIFACTORY_INPUTS),
    zone: opts.zone,
    level: opts.level,
    profile: opts.profile,
    aiReview: opts['ai-review'],
    versions: { ...versions(policy), models: models.version },
    promptVersion: PROMPT_VERSION,
    context: runContext(env),
    out: opts.out,
  });
  if (problem) {
    process.stderr.write(`aifactory-review: not reused, ${problem}\n`);
    return 3;
  }
  process.stdout.write(`verdict=${record.verdict} reused from run ${record.reused.runId}\n`);
  return record.verdict === 'pass' || !record.enforced ? 0 : 1;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`aifactory-review: ${err.message}\n`);
    return 2;
  }
  mkdirSync(opts.out, { recursive: true });
  if (opts.command === 'find-reusable') return findCommand(opts, process.env);
  const models = JSON.parse(readFileSync(path.join(root, 'policy/models.v1.json'), 'utf8'));
  if (opts.command === 'reuse') return reuseCommand(opts, process.env, models);
  if (opts.command !== 'verdict') runScanners({ repo: opts.repo, out: opts.out });
  if (opts.command === 'scan') return 0;
  const policy = loadPolicy(opts);

  let ai = { requested: false };
  let complete;
  const missing = opts['ai-review'] === 'on' ? missingAiValues(process.env) : [];
  if (missing.length) {
    ai = { requested: true, findings: [], state: {}, missing, error: `AI review values missing: ${missing.join(', ')}` };
  } else if (opts['ai-review'] === 'on') {
    try {
      complete = createModelClient({ endpoint: process.env.AIFACTORY_MODEL_ENDPOINT, token: process.env.AIFACTORY_MODEL_TOKEN });
      ai = await aiReview(opts, models, complete);
    } catch (err) {
      ai = { requested: true, findings: [], state: {}, error: err.message };
    }
  }
  const record = await buildVerdict({
    repo: opts.repo,
    results: opts.out,
    zone: opts.zone,
    level: opts.level,
    base: opts.base,
    checks: opts.checks,
    policy,
    versions: { ...versions(policy), models: models.version },
    ai,
    explain: ai.requested && !ai.error ? (record) => explainVerdict({ record, models, complete }) : undefined,
    profile: opts.profile,
    inputs: process.env.AIFACTORY_INPUTS,
    context: runContext(process.env),
  });
  process.stdout.write(`verdict=${record.verdict}\n`);
  return record.verdict === 'pass' || !record.enforced ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
