// The canary: real GitHub workflow runs of the gate's prerelease channel (@v0-next) on known cases,
// before a release may move to the stable channel (@v0) that every customer calls.
//
//   node scripts/canary.mjs [--no-record]
//
// The cases are branches in itm8-public/aifactory-gate-canary, each with an open draft pull request
// (into main, or into the case's `base`) whose caller runs gate.yml@v0-next. For each case this
// pushes an empty commit to the case branch (a push by a person starts the workflow; one made with
// the workflow token would not), waits for the run, and checks that:
//   - GitHub started the run, and it used gate.yml at the commit @v0-next points at, and that commit
//     pins an image digest;
//   - the check "gate / verdict" (the customers' required check) passed only for a pass verdict;
//   - the tests ran in "gate / tests", the job of their own, and passed; the verdict job did not
//     run them;
//   - the jobs that run with what the caller grants ("gate / reuse", "gate / comment") did not fail;
//   - verdict.json has the expected verdict, exactly the expected reasons and the engine version of
//     that commit (and, for the AI review cases, the plain-words explanation);
//   - for a verdict other than pass, the pull request has the gate's comment, saying who acts; a
//     case with `noComment` must have none.
// A case with `reuseOn` or `fullRunOn` then gets the push to main simulated: a merge commit of its
// pull request, with the tree the pull request run judged, pushed to that branch. With `reuseOn` the
// push run must reuse the pull request's verdict, not run again, and its tests job must be skipped;
// with `fullRunOn` (a caller without actions: read) it must run in full and give the same verdict.
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
// The job that runs the canary's test command (npm test), apart from the verdict job.
export const TESTS_NAME = 'gate / tests';
// The gate's jobs with no permissions block of their own: they run with what the caller grants. A
// caller that grants less must get the gate without what they add, never a failed job.
export const CALLER_JOBS = ['gate / reuse', 'gate / comment'];
const ARTIFACT = 'aifactory-verdict';
const COMMENT_MARKER = '<!-- aifactory-gate -->';

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
  {
    // A README that explains the gate and the AI review to a person, as Oral Care's did when its
    // push to main got a false needs-person (2026-11-24). Describing the review is not steering it.
    branch: 'canary/describes-review',
    what: 'a README that describes the AI review; then its merge is pushed',
    verdict: 'pass',
    reasons: [],
    explanation: true,
    needsVariable: 'AIFACTORY_AZURE_CLIENT_ID',
    reuseOn: 'canary-push/describes-review',
  },
  {
    // A caller that grants only what the customer template granted before 0.5.0 (contents: read,
    // id-token: write), as callers that predate it still do. GitHub refuses to start a called
    // workflow whose job asks for more than the caller grants, so a gate job that needs a new
    // permission would stop every such caller. Its base branch holds that caller, so the pull
    // request's change is one README line. Without pull-requests: write there is no comment; without
    // actions: read the push of its merge cannot reuse the verdict and runs in full.
    branch: 'canary-legacy/case',
    base: 'canary-legacy/base',
    what: 'a caller with the permissions before 0.5.0; then its merge is pushed',
    verdict: 'pass',
    reasons: [],
    noComment: true,
    fullRunOn: 'canary-push/legacy',
  },
];

/**
 * What is wrong with one case's run, as a list of plain sentences (empty when it is as expected).
 * `run` is the workflow run, `job` the "gate / verdict" job and `tests` the "gate / tests" job (or
 * undefined), `record` the parsed verdict.json (or undefined), `gate` what the channel pointed at:
 * { sha, engine }. `expectTests` is how the tests job must end: success, or skipped on a reuse.
 */
export function judge(kase, { run, job, tests, record }, gate, { expectTests = 'success' } = {}) {
  const problems = [];
  // What a caller sees when a gate job asks for a permission it does not grant: no jobs at all.
  if (run.conclusion === 'startup_failure') problems.push('GitHub did not start the workflow (startup_failure): does a gate job ask for more permissions than the caller grants?');
  const used = (run.referenced_workflows ?? []).find((w) => w.path.startsWith(`${GATE_REPO}/.github/workflows/gate.yml@`));
  if (!used) problems.push(`the run did not call ${GATE_REPO}'s gate.yml`);
  else {
    if (used.ref !== `refs/tags/${CHANNEL}`) problems.push(`the run called gate.yml at ${used.ref}, not @${CHANNEL}`);
    if (used.sha !== gate.sha) problems.push(`the run used gate commit ${used.sha.slice(0, 7)}, not ${gate.sha.slice(0, 7)}`);
  }
  const conclusion = kase.verdict === 'pass' ? 'success' : 'failure';
  if (!job) problems.push(`no "${CHECK_NAME}" check`);
  else {
    if (job.conclusion !== conclusion) problems.push(`"${CHECK_NAME}" ended ${job.conclusion}, expected ${conclusion}`);
    // Repository code runs only in the tests job; the verdict job runs the engine on a runner that
    // never ran it.
    if ((job.steps ?? []).some((s) => s.name === 'Tests')) problems.push(`"${CHECK_NAME}" ran the tests itself, not in "${TESTS_NAME}"`);
  }
  if (!tests) problems.push(`no "${TESTS_NAME}" job`);
  else if (tests.conclusion !== expectTests) problems.push(`"${TESTS_NAME}" ended ${tests.conclusion}, expected ${expectTests}`);
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

/** What is wrong with the run's jobs that use the caller's permissions: they must not fail. */
export function judgeJobs(jobs) {
  return jobs.filter((j) => CALLER_JOBS.includes(j.name) && !['success', 'skipped'].includes(j.conclusion)).map((j) => `"${j.name}" ended ${j.conclusion}`);
}

/**
 * What is wrong with the gate's pull request comment for a case's run (empty when it is as
 * expected). Only a verdict other than pass needs one; it must be newer than the run's start. A case
 * with `noComment` must have none.
 */
export function judgeComment(kase, comments, runStarted) {
  const mine = comments.filter((c) => c.user?.login === 'github-actions[bot]' && String(c.body).startsWith(COMMENT_MARKER));
  if (kase.noComment) return mine.length ? [`${mine.length} gate comment(s) on the pull request, expected none`] : [];
  if (kase.verdict === 'pass') return [];
  if (mine.length !== 1) return [`${mine.length} gate comments on the pull request, expected 1`];
  const [c] = mine;
  const problems = [];
  if (!c.body.includes(`## aifactory gate: ${kase.verdict}`)) problems.push(`the comment does not show ${kase.verdict}`);
  if (!c.body.includes('### Who acts')) problems.push('the comment does not say who acts');
  if (runStarted && Date.parse(c.updated_at) < Date.parse(runStarted)) problems.push('the comment was not updated by this run');
  return problems;
}

/** What is wrong with the push run that should have reused the pull request run's verdict (and so ran no tests). */
export function judgeReuse(kase, { run, job, tests, record }, gate, prRunId) {
  const problems = judge(kase, { run, job, tests, record }, gate, { expectTests: 'skipped' });
  if (record && record.reused?.runId !== prRunId) {
    problems.push(record.reused ? `it reused run ${record.reused.runId}, not ${prRunId}` : 'it ran again instead of reusing the pull request verdict');
  }
  return problems;
}

/** What is wrong with the push run whose caller cannot read the pull request run: it must run in full, tests included. */
export function judgeFullRun(kase, { run, job, tests, record }, gate) {
  const problems = judge(kase, { run, job, tests, record }, gate);
  if (record?.reused) problems.push(`it reused run ${record.reused.runId}; a caller without actions: read must run in full`);
  return problems;
}

/** The latest run of the canary's workflow for a head commit and event, or undefined. */
export function latestRun(runs, event = 'pull_request') {
  return runs
    .filter((r) => r.event === event)
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
  {
    gh = realGh,
    out = console.log,
    sleep = sleepSync,
    now = () => Date.now(),
    download,
    timeoutMs = 30 * 60 * 1000,
    pollMs = 15 * 1000,
    nudgeMs = 5 * 60 * 1000,
  } = {},
) {
  const opts = parseArgs(argv);
  const api = (p) => JSON.parse(gh(['api', p]));
  const send = (method, p, body) => JSON.parse(gh(['api', '--method', method, p, '--input', '-'], JSON.stringify(body)));
  const fetchVerdict = download ?? ((runId) => realDownload(gh, runId));
  // The verdict job and the tests job of a run (skipped jobs are listed too), and what is wrong with
  // the jobs that use the caller's permissions.
  const jobsOf = (runId) => {
    const { jobs = [] } = api(`repos/${CANARY_REPO}/actions/runs/${runId}/jobs?per_page=100`);
    return { job: jobs.find((j) => j.name === CHECK_NAME), tests: jobs.find((j) => j.name === TESTS_NAME), problems: judgeJobs(jobs) };
  };

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
    // The base decides what the pull request's change is: into main, the legacy case's change would
    // be its caller, not one README line.
    const base = kase.base ?? 'main';
    if (pulls[0].base?.ref !== base) throw new Error(`${kase.branch}'s pull request in ${CANARY_REPO} goes into ${pulls[0].base?.ref}, not ${base}. See that repository's README.`);
    cases.push({ kase, pr: pulls[0].html_url, number: pulls[0].number });
  }

  // An empty commit on each branch: same tree, so the change under review stays the case's change.
  const push = (c) => {
    const head = api(`repos/${CANARY_REPO}/git/ref/heads/${enc(c.kase.branch)}`).object.sha;
    const tree = api(`repos/${CANARY_REPO}/git/commits/${head}`).tree.sha;
    const message = `canary: ${GATE_REPO}@${CHANNEL} (${sha.slice(0, 7)}, engine ${engine})`;
    c.sha = send('POST', `repos/${CANARY_REPO}/git/commits`, { message, tree, parents: [head] }).sha;
    send('PATCH', `repos/${CANARY_REPO}/git/refs/heads/${enc(c.kase.branch)}`, { sha: c.sha, force: false });
    c.pushedAt = now();
  };
  for (const c of cases) push(c);
  out(`Pushed an empty commit to ${cases.length} case branch(es) in ${CANARY_REPO}; waiting for the runs.`);

  const deadline = now() + timeoutMs;
  let waiting = cases.slice();
  while (waiting.length) {
    for (const c of waiting) {
      const r = latestRun(api(`repos/${CANARY_REPO}/actions/runs?head_sha=${c.sha}&per_page=20`).workflow_runs ?? []);
      if (r?.status === 'completed') c.run = api(`repos/${CANARY_REPO}/actions/runs/${r.id}`);
      // GitHub can take a few minutes to start a run for a pushed commit (almost two were seen on
      // the first live run) and can miss one. Without a run after nudgeMs, push once more for
      // that case rather than wait out the timeout.
      else if (!r && !c.nudged && now() - c.pushedAt >= nudgeMs) {
        out(`${c.kase.branch}: no run started within ${Math.round(nudgeMs / 60000)} minutes; pushing another empty commit.`);
        push(c);
        c.nudged = true;
      }
    }
    waiting = waiting.filter((c) => !c.run);
    if (!waiting.length) break;
    if (now() >= deadline) break;
    sleep(pollMs);
  }

  // The push to main, simulated on a branch of its own: a merge commit of the pull request with the
  // tree its run judged, on the base it judged it against. Its run must take that verdict
  // (`reuseOn`), or, for a caller that cannot read the pull request run, run in full (`fullRunOn`).
  const pushAndJudgeMerge = (c) => {
    const target = c.kase.reuseOn ?? c.kase.fullRunOn;
    const { subject } = c.record ?? {};
    if (!subject?.tree || !subject.base) return [`${target}: the pull request verdict has no subject to push`];
    const ref = `repos/${CANARY_REPO}/git/refs/heads/${enc(target)}`;
    const pushMerge = (attempt) => {
      const message = `canary: merge of ${c.kase.branch} (pull request run ${c.run.id}), attempt ${attempt}`;
      const merge = send('POST', `repos/${CANARY_REPO}/git/commits`, { message, tree: subject.tree, parents: [subject.base, c.sha] }).sha;
      try {
        send('PATCH', ref, { sha: merge, force: true });
      } catch (e) {
        if (!notFound(e) && !/HTTP 422|Reference does not exist/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) throw e;
        send('POST', `repos/${CANARY_REPO}/git/refs`, { ref: `refs/heads/${target}`, sha: merge });
      }
      return { merge, at: now() };
    };
    let pushed = pushMerge(1);
    let nudged = false;
    let run;
    const until = now() + timeoutMs;
    while (!run && now() < until) {
      const r = latestRun(api(`repos/${CANARY_REPO}/actions/runs?head_sha=${pushed.merge}&per_page=20`).workflow_runs ?? [], 'push');
      if (r?.status === 'completed') run = api(`repos/${CANARY_REPO}/actions/runs/${r.id}`);
      else if (!r && !nudged && now() - pushed.at >= nudgeMs) {
        out(`${target}: no run started within ${Math.round(nudgeMs / 60000)} minutes; pushing the merge again.`);
        pushed = pushMerge(2);
        nudged = true;
      } else sleep(pollMs);
    }
    if (!run) return [`${target}: no completed push run within ${Math.round(timeoutMs / 60000)} minutes`];
    c.pushRun = run;
    const { job, tests, problems } = jobsOf(run.id);
    const record = fetchVerdict(run.id);
    const judged = c.kase.reuseOn ? judgeReuse(c.kase, { run, job, tests, record }, gate, c.run.id) : judgeFullRun(c.kase, { run, job, tests, record }, gate);
    return [...judged, ...problems].map((p) => `${target}: ${p}`);
  };

  let bad = 0;
  const rows = [];
  for (const c of cases) {
    let problems;
    if (!c.run) problems = [`no completed run within ${Math.round(timeoutMs / 60000)} minutes`];
    else {
      const { job, tests, problems: jobProblems } = jobsOf(c.run.id);
      const record = fetchVerdict(c.run.id);
      c.got = record?.verdict ?? 'none';
      c.record = record;
      problems = [...judge(c.kase, { run: c.run, job, tests, record }, gate), ...jobProblems];
      if (c.kase.verdict !== 'pass' || c.kase.noComment) {
        problems.push(...judgeComment(c.kase, api(`repos/${CANARY_REPO}/issues/${c.number}/comments?per_page=100`), c.run.run_started_at ?? c.run.created_at));
      }
      if ((c.kase.reuseOn || c.kase.fullRunOn) && !problems.length) problems.push(...pushAndJudgeMerge(c));
    }
    if (problems.length) bad++;
    rows.push(
      `${problems.length ? 'MISMATCH' : 'ok      '} ${c.kase.branch.padEnd(26)} expect ${c.kase.verdict.padEnd(12)} got ${(c.got ?? 'none').padEnd(12)} ${c.run?.html_url ?? c.pr}` +
        (c.pushRun ? `\n         push of the merge (${c.kase.reuseOn ?? c.kase.fullRunOn}): ${c.pushRun.html_url}` : '') +
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
