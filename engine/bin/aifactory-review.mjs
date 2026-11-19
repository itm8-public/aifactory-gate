#!/usr/bin/env node
// aifactory-review: the gate's review engine.
//   aifactory-review scan    --repo DIR --out DIR
//   aifactory-review verdict --repo DIR --out DIR --zone green|yellow|red --level 1|2|3 [--base REF]
//                            [--check name=outcome ...] [--ai-review on|off]
//   aifactory-review run     (scan, then verdict; same options)
// The AI review reads AIFACTORY_MODEL_ENDPOINT and AIFACTORY_MODEL_TOKEN (an Entra token).
// Exit code: 0 when the verdict is pass or the level is advisory (1); 1 otherwise; 2 on a usage error.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelClient } from '../src/models/client.mjs';
import { readDiff } from '../src/models/diff.mjs';
import { explainVerdict, reviewWithModels } from '../src/models/review.mjs';
import { ZONES } from '../src/policy.mjs';
import { runScanners } from '../src/scan.mjs';
import { buildVerdict } from '../src/verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, checks: {}, base: 'HEAD^1', level: 2, 'ai-review': 'off' };
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
  if (!['scan', 'verdict', 'run'].includes(command)) throw new Error('command must be scan, verdict or run');
  if (!opts.repo || !opts.out) throw new Error('--repo and --out are required');
  if (command !== 'scan') {
    if (!ZONES.includes(opts.zone)) throw new Error('--zone must be green, yellow or red');
    opts.level = Number(opts.level);
    if (![1, 2, 3].includes(opts.level)) throw new Error('--level must be 1, 2 or 3');
    if (!['on', 'off'].includes(opts['ai-review'])) throw new Error('--ai-review must be on or off');
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

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`aifactory-review: ${err.message}\n`);
    return 2;
  }
  mkdirSync(opts.out, { recursive: true });
  if (opts.command !== 'verdict') runScanners({ repo: opts.repo, out: opts.out });
  if (opts.command === 'scan') return 0;
  const policy = JSON.parse(readFileSync(opts.policy ?? path.join(root, 'policy/policy.v1.json'), 'utf8'));
  const models = JSON.parse(readFileSync(path.join(root, 'policy/models.v1.json'), 'utf8'));

  let ai = { requested: false };
  let complete;
  if (opts['ai-review'] === 'on') {
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
  });
  process.stdout.write(`verdict=${record.verdict}\n`);
  return record.verdict === 'pass' || !record.enforced ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
