// The canary: real GitHub workflow runs of the gate's prerelease channel (@v0-next) on known cases,
// before a release may move to the stable channel (@v0) that every customer calls.
//
//   node scripts/canary.mjs [--no-record]
//
// The cases are branches in itm8-public/aifactory-gate-canary, each with an open draft pull request
// whose caller runs gate.yml@v0-next. For each case this pushes an empty commit to the branch (a push
// by a person starts the workflow; one made with the workflow token would not), waits for the run,
// and checks that:
//   - the run used gate.yml at the commit @v0-next points at, and that commit pins an image digest;
//   - the check "gate / verdict" (the customers' required check) passed only for a pass verdict;
//   - verdict.json has the expected verdict, exactly the expected reasons and the engine version of
//     that commit (and, for the full AI review, the plain-words explanation).
// The result is recorded as the commit status aifactory/canary on that gate commit (--no-record
// skips this); `release.mjs promote` requires it to be success. Exit 1 on any mismatch.
// Needs the GitHub CLI signed in with write access to both repositories.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANARY_CONTEXT, GATE_REPO, pinnedImage, tagCommit } from './release.mjs';

export const CANARY_REPO = 'itm8-public/aifactory-gate-canary';
export const CHANNEL = 'v0-next'; // what the canary's caller pins
export const CHECK_NAME = 'gate / verdict';
const ARTIFACT = 'aifactory-verdict';

// What the gate must decide for each case, at zone green and level 2. `reasons` must match the
// verdict's reasons one to one, so a scanner that silently stops running is a mismatch too.
export const CASES = [
  { branch: 'canary/pass', what: 'a clean app-code change', verdict: 'pass', reasons: [] },
  { branch: 'canary/secret', what: 'a planted fake private key', verdict: 'fail', reasons: [/^\d+ possible secret\(s\) in the code$/] },
  {
    branch: 'canary/platform',
    what: 'an infrastructure change',
    verdict: 'needs-person',
    reasons: [/^Touches CI, deployment or infrastructure configuration$/],
  },
  {
    branch: 'canary/ai-values-missing',
    what: 'AI review on, its values empty',
    verdict: 'needs-person',
    reasons: [/^AI review is on, but its values? [a-z, -]+ (is|are) missing in \.github\/workflows\/aifactory-gate\.yml\./],
  },
  {
    branch: 'canary/ai-review',
    what: 'AI review fully on',
    verdict: 'pass',
    reasons: [],
    explanation: true,
    // Runs only once itm8 has set up the canary's review identity and stored its values here.
    needsVariable: 'AIFACTORY_AZURE_CLIENT_ID',
  },
];

/**
 * What is wrong with one case's run, as a list of plain sentences (empty when it is as expected).
 * `run` is the workflow run, `job` the "gate / verdict" job (or undefined), `record` the parsed
 * verdict.json (or undefined), `gate` what the channel pointed at: { sha, engine }.
 */
export function judge(kase, { run, job, record }, gate) {
  const problems = [];
  const used = (run.referenced_workflows ?? []).find((w) => w.path.startsWith(`${GATE_REPO}/.github/workflows/gate.yml@`));
  if (!used) problems.push(`the run did not call ${GATE_REPO}'s gate.yml`);
  else {
    if (used.ref !== `refs/tags/${CHANNEL}`) problems.push(`the run called gate.yml at ${used.ref}, not @${CHANNEL}`);
    if (used.sha !== gate.sha) problems.push(`the run used gate commit ${used.sha.slice(0, 7)}, not ${gate.sha.slice(0, 7)}`);
  }
  const conclusion = kase.verdict === 'pass' ? 'success' : 'failure';
  if (!job) problems.push(`no "${CHECK_NAME}" check`);
  else if (job.conclusion !== conclusion) problems.push(`"${CHECK_NAME}" ended ${job.conclusion}, expected ${conclusion}`);
  if (!record) {
    problems.push('no verdict.json');
    return problems;
  }
  if (record.verdict !== kase.verdict) problems.push(`verdict ${record.verdict}, expected ${kase.verdict}`);
  const texts = (record.reasons ?? []).map((r) => r.text);
  for (const t of texts) if (!kase.reasons.some((re) => re.test(t))) problems.push(`unexpected reason: ${t}`);
  for (const re of kase.reasons) if (!texts.some((t) => re.test(t))) problems.push(`missing reason ${re}`);
  if (record.versions?.engine !== gate.engine) problems.push(`engine ${record.versions?.engine}, expected ${gate.engine}`);
  if (kase.explanation) {
    if (record.aiReview?.error) problems.push(`the AI review did not complete: ${record.aiReview.error}`);
    if (!String(record.explanation ?? '').trim()) problems.push('no "In plain words" explanation');
  }
  return problems;
}

/** The latest run of the canary's pull_request workflow for a head commit, or undefined. */
export function latestRun(runs) {
  return runs
    .filter((r) => r.event === 'pull_request')
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
}

export function parseArgs(argv) {
  const opts = { record: true };
  for (const a of argv) {
    if (a === '--no-record') opts.record = false;
    else throw new Error(`unknown option "${a}". Usage: node scripts/canary.mjs [--no-record]`);
  }
  return opts;
}

function realGh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const notFound = (err) => /HTTP 404|Not Found/i.test(`${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`);
const enc = (branch) => branch.split('/').map(encodeURIComponent).join('/');

/** verdict.json of a run, through `gh run download` (it unpacks the artifact), or undefined. */
function realDownload(gh, runId) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aifactory-canary-'));
  try {
    gh(['run', 'download', String(runId), '-R', CANARY_REPO, '-n', ARTIFACT, '-D', dir]);
    return JSON.parse(readFileSync(path.join(dir, 'verdict.json'), 'utf8'));
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the canary. `gh`, the clock and the writers are injectable for tests. Returns the exit code. */
export function run(
  argv,
  { gh = realGh, out = console.log, sleep = sleepSync, now = () => Date.now(), download, timeoutMs = 30 * 60 * 1000, pollMs = 15 * 1000 } = {},
) {
  const opts = parseArgs(argv);
  const api = (p) => JSON.parse(gh(['api', p]));
  const send = (method, p, body) => JSON.parse(gh(['api', '--method', method, p, '--input', '-'], JSON.stringify(body)));
  const fetchVerdict = download ?? ((runId) => realDownload(gh, runId));

  // The commit the channel points at, and what it must run.
  const sha = tagCommit(gh, GATE_REPO, CHANNEL);
  if (!sha) throw new Error(`${GATE_REPO} has no tag ${CHANNEL}.`);
  const fileAt = (file) => Buffer.from(api(`repos/${GATE_REPO}/contents/${file}?ref=${sha}`).content, 'base64').toString('utf8');
  const image = pinnedImage(fileAt('.github/workflows/gate.yml'));
  const engine = JSON.parse(fileAt('package.json')).version;
  out(`@${CHANNEL} = ${GATE_REPO}@${sha.slice(0, 7)}, engine ${engine}, image ${image ?? 'NOT PINNED'}`);
  if (!image) throw new Error(`gate.yml at ${sha.slice(0, 7)} does not pin an image digest: it is not a release commit (README, Release).`);
  const gate = { sha, engine };

  // Which cases run, and their pull requests.
  const owner = CANARY_REPO.split('/')[0];
  const cases = [];
  const skipped = [];
  for (const kase of CASES) {
    if (kase.needsVariable) {
      try {
        api(`repos/${CANARY_REPO}/actions/variables/${kase.needsVariable}`);
      } catch (e) {
        if (!notFound(e)) throw e;
        skipped.push({ kase, why: `the variable ${kase.needsVariable} is not set in ${CANARY_REPO}` });
        continue;
      }
    }
    const pulls = api(`repos/${CANARY_REPO}/pulls?state=open&head=${owner}:${enc(kase.branch)}`);
    if (pulls.length !== 1) throw new Error(`${kase.branch} needs one open pull request in ${CANARY_REPO}; it has ${pulls.length}. See that repository's README.`);
    cases.push({ kase, pr: pulls[0].html_url });
  }

  // An empty commit on each branch: same tree, so the change under review stays the case's change.
  for (const c of cases) {
    const head = api(`repos/${CANARY_REPO}/git/ref/heads/${enc(c.kase.branch)}`).object.sha;
    const tree = api(`repos/${CANARY_REPO}/git/commits/${head}`).tree.sha;
    const message = `canary: ${GATE_REPO}@${CHANNEL} (${sha.slice(0, 7)}, engine ${engine})`;
    c.sha = send('POST', `repos/${CANARY_REPO}/git/commits`, { message, tree, parents: [head] }).sha;
    send('PATCH', `repos/${CANARY_REPO}/git/refs/heads/${enc(c.kase.branch)}`, { sha: c.sha, force: false });
  }
  out(`Pushed an empty commit to ${cases.length} case branch(es) in ${CANARY_REPO}; waiting for the runs.`);

  const deadline = now() + timeoutMs;
  let waiting = cases.slice();
  while (waiting.length) {
    for (const c of waiting) {
      const r = latestRun(api(`repos/${CANARY_REPO}/actions/runs?head_sha=${c.sha}&per_page=20`).workflow_runs ?? []);
      if (r?.status === 'completed') c.run = api(`repos/${CANARY_REPO}/actions/runs/${r.id}`);
    }
    waiting = waiting.filter((c) => !c.run);
    if (!waiting.length) break;
    if (now() >= deadline) break;
    sleep(pollMs);
  }

  let bad = 0;
  const rows = [];
  for (const c of cases) {
    let problems;
    if (!c.run) problems = [`no completed run within ${Math.round(timeoutMs / 60000)} minutes`];
    else {
      const job = api(`repos/${CANARY_REPO}/actions/runs/${c.run.id}/jobs`).jobs.find((j) => j.name === CHECK_NAME);
      const record = fetchVerdict(c.run.id);
      c.got = record?.verdict ?? 'none';
      problems = judge(c.kase, { run: c.run, job, record }, gate);
    }
    if (problems.length) bad++;
    rows.push(
      `${problems.length ? 'MISMATCH' : 'ok      '} ${c.kase.branch.padEnd(26)} expect ${c.kase.verdict.padEnd(12)} got ${(c.got ?? 'none').padEnd(12)} ${c.run?.html_url ?? c.pr}` +
        problems.map((p) => `\n         - ${p}`).join(''),
    );
  }
  for (const s of skipped) rows.push(`skipped  ${s.kase.branch.padEnd(26)} ${s.why}`);
  out(rows.join('\n'));

  // The channel must not have moved while the canary ran, or the result belongs to no one commit.
  const after = tagCommit(gh, GATE_REPO, CHANNEL);
  if (after !== sha) {
    out(`@${CHANNEL} moved to ${String(after).slice(0, 7)} while the canary ran. Nothing recorded; run it again.`);
    return 1;
  }

  const green = bad === 0;
  const description = `${cases.length - bad} of ${cases.length} cases as expected on @${CHANNEL}${skipped.length ? `, ${skipped.length} skipped` : ''}`;
  out(green ? `\nCanary green: ${description}.` : `\nCanary RED: ${description}. Do not promote.`);
  if (opts.record) {
    send('POST', `repos/${GATE_REPO}/statuses/${sha}`, {
      state: green ? 'success' : 'failure',
      context: CANARY_CONTEXT,
      description: description.slice(0, 140),
      target_url: `https://github.com/${CANARY_REPO}/actions/workflows/aifactory-gate.yml`,
    });
    out(`Recorded ${CANARY_CONTEXT} = ${green ? 'success' : 'failure'} on ${GATE_REPO}@${sha.slice(0, 7)}.`);
  } else out('Not recorded (--no-record).');
  if (green) {
    out(`Next: ${engine} runs for 48 hours on itm8's own repositories that call @${CHANNEL}; then node scripts/release.mjs promote ${engine}`);
  }
  return green ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`canary: ${err.message}`);
    process.exitCode = 1;
  }
}
