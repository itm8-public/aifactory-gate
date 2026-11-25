import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decide } from '../engine/src/policy.mjs';
import { CALLER_JOBS, CANARY_REPO, CASES, CHANNEL, CHECK_NAME, TESTS_NAME, judge, judgeComment, judgeFullRun, judgeJobs, judgeReuse, latestRun, parseArgs, run } from '../scripts/canary.mjs';
import { CANARY_CONTEXT, GATE_REPO } from '../scripts/release.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/policy.v1.json', import.meta.url), 'utf8'));
const GATE_SHA = 'f'.repeat(40);
const gate = { sha: GATE_SHA, engine: '0.4.0' };
const kase = (branch) => CASES.find((c) => c.branch === branch);
const goodRun = (id = 1) => ({
  id,
  html_url: `https://github.com/${CANARY_REPO}/actions/runs/${id}`,
  referenced_workflows: [{ path: `${GATE_REPO}/.github/workflows/gate.yml@${CHANNEL}`, ref: `refs/tags/${CHANNEL}`, sha: GATE_SHA }],
});
const job = (conclusion, steps = [{ name: 'Test outcome' }, { name: 'Scan and decide' }, { name: 'Enforce' }]) => ({ name: CHECK_NAME, conclusion, steps });
const testsJob = (conclusion = 'success') => ({ name: TESTS_NAME, conclusion });
// The verdict job ended `conclusion`; the tests job ran on its own and ended `tests`.
const jobs = (conclusion, tests = 'success') => ({ job: job(conclusion), tests: testsJob(tests) });

// The facts each canary branch produces in the gate, run through the real policy. If a policy or
// reason text changes, this fails until CASES in scripts/canary.mjs is changed with it.
const ran = { gitleaks: { ran: true }, opengrep: { ran: true }, 'osv-scanner': { ran: true } };
const facts = {
  'canary/pass': { files: ['src/greet.mjs', 'test/greet.test.mjs'], findings: [] },
  'canary/secret': { files: ['src/signing.mjs'], findings: [{ tool: 'gitleaks', rule: 'private-key', severity: 'critical' }] },
  'canary/platform': { files: ['infra/main.bicep'], findings: [] },
  'canary/ai-values-missing': {
    files: ['src/double.mjs', 'test/double.test.mjs'],
    findings: [],
    aiReview: { requested: true, missing: ['review-endpoint', 'azure-client-id', 'azure-tenant-id'] },
  },
  'canary/ai-review': { files: ['src/clamp.mjs', 'test/clamp.test.mjs'], findings: [], aiReview: { requested: true } },
  'canary/describes-review': { files: ['README.md'], findings: [], aiReview: { requested: true } },
  'canary-legacy/case': { files: ['README.md'], findings: [] },
};
const recordFor = (branch, extra = {}) => {
  const f = facts[branch];
  const { verdict, reasons } = decide({ policy, zone: 'green', files: f.files, checks: { tests: 'success' }, tools: ran, findings: f.findings, aiReview: f.aiReview });
  return { verdict, reasons, versions: { engine: gate.engine }, aiReview: { error: null }, ...extra };
};

test('every case expects what the policy decides for its change', () => {
  for (const c of CASES) {
    const record = recordFor(c.branch, c.explanation ? { explanation: 'Plain words.' } : {});
    assert.equal(record.verdict, c.verdict, c.branch);
    assert.deepEqual(judge(c, { run: goodRun(), ...jobs(c.verdict === 'pass' ? 'success' : 'failure'), record }, gate), [], c.branch);
  }
});

test('the missing-values reason matches with one value missing too', () => {
  const { reasons } = decide({ policy, zone: 'green', files: [], checks: {}, tools: ran, findings: [], aiReview: { requested: true, missing: ['azure-tenant-id'] } });
  assert.ok(kase('canary/ai-values-missing').reasons[0].test(reasons[0].text), reasons[0].text);
});

test('judge names each way a run can be wrong', () => {
  const c = kase('canary/platform');
  const record = recordFor('canary/platform');
  const wrongRef = { ...goodRun(), referenced_workflows: [{ path: `${GATE_REPO}/.github/workflows/gate.yml@v0`, ref: 'refs/tags/v0', sha: 'a'.repeat(40) }] };
  assert.deepEqual(judge(c, { run: wrongRef, ...jobs('failure'), record }, gate), [
    'the run called gate.yml at refs/tags/v0, not @v0-next',
    'the run used gate commit aaaaaaa, not fffffff',
  ]);
  assert.match(judge(c, { run: { ...goodRun(), referenced_workflows: [] }, ...jobs('failure'), record }, gate)[0], /did not call/);
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('success'), record }, gate), ['"gate / verdict" ended success, expected failure']);
  assert.deepEqual(judge(c, { run: goodRun(), job: undefined, tests: testsJob(), record }, gate), ['no "gate / verdict" check']);
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('failure'), record: undefined }, gate), ['no verdict.json']);
  // A scanner that stops running adds a reason: a mismatch even though the verdict is the same.
  const extra = { ...record, reasons: [...record.reasons, { action: 'needs-person', text: 'osv-scanner did not produce a result (exit 1)' }] };
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('failure'), record: extra }, gate), ['unexpected reason: osv-scanner did not produce a result (exit 1)']);
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('failure'), record: { ...record, reasons: [] } }, gate), [
    `missing reason ${c.reasons[0]}`,
  ]);
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('failure'), record: { ...record, versions: { engine: '0.3.0' } } }, gate), ['engine 0.3.0, expected 0.4.0']);
  const p = kase('canary/pass');
  assert.deepEqual(judge(p, { run: goodRun(), ...jobs('success'), record: { ...recordFor('canary/pass'), verdict: 'fail' } }, gate), ['verdict fail, expected pass']);
});

test('judge: the tests run in "gate / tests", never in the verdict job', () => {
  const p = kase('canary/pass');
  const record = recordFor('canary/pass');
  // A gate that runs the tests in the verdict job again (0.5.0 and before).
  const together = job('success', [{ name: 'Tests' }, { name: 'Scan and decide' }, { name: 'Enforce' }]);
  assert.deepEqual(judge(p, { run: goodRun(), job: together, record }, gate), [
    '"gate / verdict" ran the tests itself, not in "gate / tests"',
    'no "gate / tests" job',
  ]);
  assert.deepEqual(judge(p, { run: goodRun(), ...jobs('success', 'failure'), record }, gate), ['"gate / tests" ended failure, expected success']);
  assert.deepEqual(judge(p, { run: goodRun(), ...jobs('success', 'skipped'), record }, gate), ['"gate / tests" ended skipped, expected success']);
  // The reused push runs no tests.
  const d = kase('canary/describes-review');
  const reused = recordFor('canary/describes-review', { explanation: 'x', reused: { runId: 7 } });
  assert.deepEqual(judgeReuse(d, { run: goodRun(8), ...jobs('success', 'success'), record: reused }, gate, 7), ['"gate / tests" ended success, expected skipped']);
});

test('the full AI review case needs a completed review and the plain words', () => {
  const c = kase('canary/ai-review');
  const record = recordFor('canary/ai-review');
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('success'), record }, gate), ['no "In plain words" explanation']);
  assert.deepEqual(judge(c, { run: goodRun(), ...jobs('success'), record: { ...record, explanation: 'x', aiReview: { error: 'sign-in failed' } } }, gate), [
    'the AI review did not complete: sign-in failed',
  ]);
});

test('latestRun takes the newest pull_request run', () => {
  assert.equal(latestRun([]), undefined);
  const runs = [
    { id: 1, event: 'pull_request', run_number: 3, run_attempt: 1 },
    { id: 2, event: 'pull_request', run_number: 4, run_attempt: 1 },
    { id: 3, event: 'push', run_number: 9, run_attempt: 1 },
  ];
  assert.equal(latestRun(runs).id, 2);
  assert.equal(latestRun(runs, 'push').id, 3);
});

test('options', () => {
  assert.deepEqual(parseArgs([]), { record: true });
  assert.deepEqual(parseArgs(['--no-record']), { record: false });
  assert.throws(() => parseArgs(['--apply']), /unknown option/);
});

/** A fake GitHub: the canary repository's branches, runs and verdicts, and the gate's tag. */
function fakeGitHub({
  verdicts = {},
  variable = false,
  movesTag = false,
  pinned = true,
  lostOnce,
  noComment = false,
  ranAgain = false,
  legacyReused = false,
  legacyComment = false,
  commentJob = 'success',
  bases = {},
} = {}) {
  const calls = [];
  let tagReads = 0;
  const image = pinned ? `ghcr.io/itm8-public/aifactory-review@sha256:${'a'.repeat(64)}` : 'ghcr.io/itm8-public/aifactory-review:0.1.0';
  const b64 = (s) => Buffer.from(s).toString('base64');
  const live = CASES.filter((c) => variable || !c.needsVariable);
  const byRun = new Map(live.map((c, i) => [i + 1, c]));
  const heads = new Map(CASES.map((c) => [c.branch, `head-${c.branch}`]));
  // `lostOnce`: GitHub starts no run for the first commit pushed to that branch.
  const lost = (c, sha) => c.branch === lostOnce && sha === `head-${c.branch}+`;
  const runFor = (sha) => [...byRun].find(([, c]) => heads.get(c.branch) === sha && !lost(c, sha))?.[0];
  // The push of a merge commit (parents: the judged base, the case head) gets run 100 + the case's run.
  // Each case's pull request run judged it on a base of its own, BASE-<branch>.
  const PUSH = 100;
  const pushRunFor = (sha) => [...byRun].find(([, c]) => (c.reuseOn || c.fullRunOn) && sha === `BASE-${c.branch}+`)?.[0];
  const verdictOf = (c) => verdicts[c.branch] ?? c.verdict;
  const gh = (args, input) => {
    calls.push({ args, body: input ? JSON.parse(input) : undefined });
    const [, ...rest] = args;
    if (args[0] === 'api' && rest[0] === '--method') {
      const [, method, p] = rest;
      const body = JSON.parse(input);
      if (method === 'POST' && p.endsWith('/git/commits')) return JSON.stringify({ sha: `${body.parents[0]}+` });
      const ref = p.match(/git\/refs\/heads\/(.+)$/);
      if (method === 'PATCH' && ref) heads.set(decodeURIComponent(ref[1]), body.sha);
      return '{}';
    }
    const p = rest[0];
    if (p === `repos/${GATE_REPO}/git/ref/tags/${CHANNEL}`) {
      tagReads++;
      return JSON.stringify({ object: { type: 'commit', sha: movesTag && tagReads > 1 ? 'b'.repeat(40) : GATE_SHA } });
    }
    if (p.startsWith(`repos/${GATE_REPO}/contents/.github/workflows/gate.yml`)) return JSON.stringify({ content: b64(`    env:\n      GATE_IMAGE: ${image}\n`) });
    if (p.startsWith(`repos/${GATE_REPO}/contents/package.json`)) return JSON.stringify({ content: b64('{"version":"0.4.0"}') });
    if (p.includes('/actions/variables/')) {
      if (variable) return '{}';
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'HTTP 404' });
    }
    let m;
    if ((m = p.match(/pulls\?state=open&head=itm8-public:(.+)$/))) {
      const branch = decodeURIComponent(m[1]);
      const c = CASES.find((k) => k.branch === branch);
      const number = CASES.indexOf(c) + 1;
      return JSON.stringify([{ html_url: `https://github.com/${CANARY_REPO}/pull/${number}`, number, base: { ref: bases[branch] ?? c.base ?? 'main' } }]);
    }
    if ((m = p.match(/issues\/(\d+)\/comments/))) {
      const c = CASES[Number(m[1]) - 1];
      const v = verdictOf(c);
      const comment = { user: { login: 'github-actions[bot]' }, body: `<!-- aifactory-gate -->\n## aifactory gate: ${v}\n\n### Who acts\n`, updated_at: '2026-11-24T12:00:00Z' };
      if (c.noComment) return JSON.stringify(legacyComment ? [comment] : []);
      return JSON.stringify(v === 'pass' || noComment ? [] : [comment]);
    }
    if ((m = p.match(/git\/ref\/heads\/(.+)$/))) return JSON.stringify({ object: { sha: heads.get(decodeURIComponent(m[1])) } });
    if (p.includes('/git/commits/')) return JSON.stringify({ tree: { sha: 'tree' } });
    if ((m = p.match(/actions\/runs\?head_sha=([^&]+)/))) {
      const pushed = pushRunFor(m[1]);
      if (pushed) return JSON.stringify({ workflow_runs: [{ id: PUSH + pushed, event: 'push', status: 'completed', run_number: PUSH + pushed, run_attempt: 1 }] });
      const id = runFor(m[1]);
      return JSON.stringify({ workflow_runs: id ? [{ id, event: 'pull_request', status: 'completed', run_number: id, run_attempt: 1 }] : [] });
    }
    if ((m = p.match(/actions\/runs\/(\d+)\/jobs(\?|$)/))) {
      const c = byRun.get(Number(m[1]) % PUSH);
      const v = verdictOf(c);
      // The reuse job runs on a push only, the comment job on a pull request only; a reused push
      // skips the tests.
      const onPush = Number(m[1]) > PUSH;
      const reused = onPush && ((c.reuseOn && !ranAgain) || (c.fullRunOn && legacyReused));
      return JSON.stringify({
        jobs: [
          { name: 'gate / reuse', conclusion: onPush ? 'success' : 'skipped' },
          testsJob(reused ? 'skipped' : 'success'),
          job(v === 'pass' ? 'success' : 'failure'),
          { name: 'gate / comment', conclusion: onPush ? 'skipped' : commentJob },
        ],
      });
    }
    if ((m = p.match(/actions\/runs\/(\d+)$/))) return JSON.stringify(goodRun(Number(m[1])));
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const download = (id) => {
    const c = byRun.get(id % PUSH);
    const extra = { ...(c.explanation ? { explanation: 'Plain words.' } : {}), subject: { tree: `T-${c.branch}`, base: `BASE-${c.branch}` } };
    if (id > PUSH && ((c.reuseOn && !ranAgain) || (c.fullRunOn && legacyReused))) extra.reused = { runId: id - PUSH };
    const record = recordFor(c.branch, extra);
    return verdicts[c.branch] ? { ...record, verdict: verdicts[c.branch] } : record;
  };
  return { gh, download, calls, writes: () => calls.filter((c) => c.args[1] === '--method') };
}

const quiet = { out: () => {}, sleep: () => {} };

test('a green canary pushes one empty commit per case and records success on the gate commit', () => {
  const fake = fakeGitHub();
  assert.equal(run([], { ...fake, ...quiet }), 0);
  const writes = fake.writes();
  const empty = writes.filter((w) => w.args[3].endsWith('/git/commits') && w.body.tree === 'tree'); // same tree: an empty commit
  const live = CASES.filter((c) => !c.needsVariable).map((c) => c.branch);
  assert.deepEqual(empty.map((w) => w.body.parents[0]), live.map((b) => `head-${b}`), 'one on top of each case branch, whatever its base');
  // Never a force-push to a case branch; only the canary's push branches are moved with force.
  for (const w of writes.filter((w) => w.args[2] === 'PATCH' && !w.args[3].includes('/heads/canary-push/'))) assert.equal(w.body.force, false);
  const status = writes.find((w) => w.args[3] === `repos/${GATE_REPO}/statuses/${GATE_SHA}`);
  assert.equal(status.body.state, 'success');
  assert.equal(status.body.context, CANARY_CONTEXT);
  assert.match(status.body.description, /^5 of 5 cases as expected on @v0-next, 2 skipped$/);
});

test('the AI review cases run once their variable is set; the merge of describes-review is pushed and reuses the verdict', () => {
  const fake = fakeGitHub({ variable: true });
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 0);
  assert.match(fake.writes().at(-1).body.description, /^7 of 7 cases/);
  const writes = fake.writes();
  const merge = writes.find((w) => w.args[3].endsWith('/git/commits') && w.body.tree === 'T-canary/describes-review');
  assert.deepEqual(merge.body.parents, ['BASE-canary/describes-review', 'head-canary/describes-review+'], 'a merge of the judged base and the pull request head');
  const moved = writes.filter((w) => w.args[2] === 'PATCH' && w.args[3].includes('/git/refs/heads/'));
  assert.deepEqual(
    moved.filter((w) => w.body.force).map((w) => w.args[3]),
    [`repos/${CANARY_REPO}/git/refs/heads/canary-push/describes-review`, `repos/${CANARY_REPO}/git/refs/heads/canary-push/legacy`],
    'only the push branches are moved with force',
  );
  assert.match(lines.join('\n'), /push of the merge \(canary-push\/describes-review\): /);
});

test('a push of the merge that runs again instead of reusing is a mismatch', () => {
  const fake = fakeGitHub({ variable: true, ranAgain: true });
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 1);
  assert.match(lines.join('\n'), /canary-push\/describes-review: it ran again instead of reusing the pull request verdict/);
});

test('the legacy caller case: its pull request goes into its own base, and the push of its squash runs in full', () => {
  const fake = fakeGitHub();
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 0);
  const writes = fake.writes();
  const squash = writes.find((w) => w.args[3].endsWith('/git/commits') && w.body.tree === 'T-canary-legacy/case');
  // One parent: no pull request leads to it, so not even a public repository's readable runs let it reuse.
  assert.deepEqual(squash.body.parents, ['BASE-canary-legacy/case'], 'the judged tree on the judged base, one parent');
  assert.match(squash.body.message, /^canary: squash of canary-legacy\/case/);
  const pushed = writes.find((w) => w.args[3] === `repos/${CANARY_REPO}/git/refs/heads/canary-push/legacy`);
  assert.equal(pushed.body.sha, 'BASE-canary-legacy/case+');
  // Its pull request's comments are read although the verdict is pass: there must be none.
  const legacyPr = CASES.findIndex((c) => c.branch === 'canary-legacy/case') + 1;
  assert.ok(fake.calls.some((c) => c.args[1] === `repos/${CANARY_REPO}/issues/${legacyPr}/comments?per_page=100`));
  assert.match(lines.join('\n'), /ok +canary-legacy\/case +expect pass +got pass[^\n]*\n +push of the squash \(canary-push\/legacy\): /);
});

test('the legacy caller case is a mismatch when its push reuses, it has a comment or the comment job fails', () => {
  const out = (opts) => {
    const lines = [];
    assert.equal(run([], { ...fakeGitHub(opts), sleep: () => {}, out: (l) => lines.push(l) }), 1);
    return lines.join('\n');
  };
  assert.match(out({ legacyReused: true }), /MISMATCH canary-legacy\/case[\s\S]*canary-push\/legacy: it reused run \d+; a squash that no pull request leads to must run in full/);
  assert.match(out({ legacyComment: true }), /MISMATCH canary-legacy\/case[\s\S]*1 gate comment\(s\) on the pull request, expected none/);
  // Every case's comment job is judged, not only the legacy one's.
  const failed = out({ commentJob: 'failure' });
  for (const c of CASES.filter((k) => !k.needsVariable)) assert.match(failed, new RegExp(`MISMATCH ${c.branch}[^\\n]*\\n +- "gate / comment" ended failure`));
});

test('a case whose pull request goes into another base is refused before anything is pushed', () => {
  const fake = fakeGitHub({ bases: { 'canary-legacy/case': 'main' } });
  assert.throws(() => run([], { ...fake, ...quiet }), /canary-legacy\/case's pull request in itm8-public\/aifactory-gate-canary goes into main, not canary-legacy\/base/);
  assert.equal(fake.writes().length, 0);
  const other = fakeGitHub({ bases: { 'canary/pass': 'canary-legacy/base' } });
  assert.throws(() => run([], { ...other, ...quiet }), /canary\/pass's pull request .* goes into canary-legacy\/base, not main/);
});

test('judge, judgeJobs, judgeFullRun and judgeComment for a caller that grants less', () => {
  const l = kase('canary-legacy/case');
  const record = recordFor('canary-legacy/case');
  assert.deepEqual(judge(l, { run: goodRun(), ...jobs('success'), record }, gate), []);
  // GitHub refuses to start a called workflow whose job asks for more than the caller grants.
  assert.deepEqual(judge(l, { run: { ...goodRun(), conclusion: 'startup_failure' }, job: undefined, tests: undefined, record: undefined }, gate), [
    'GitHub did not start the workflow (startup_failure): does a gate job ask for more permissions than the caller grants?',
    'no "gate / verdict" check',
    'no "gate / tests" job',
    'no verdict.json',
  ]);
  assert.deepEqual(CALLER_JOBS, ['gate / reuse', 'gate / comment']);
  const listed = (reuse, comment) => [{ name: 'gate / reuse', conclusion: reuse }, testsJob('failure'), job('failure'), { name: 'gate / comment', conclusion: comment }];
  assert.deepEqual(judgeJobs(listed('skipped', 'success')), [], 'the verdict and tests jobs are judged on their own');
  assert.deepEqual(judgeJobs(listed('success', 'skipped')), []);
  assert.deepEqual(judgeJobs(listed('failure', 'cancelled')), ['"gate / reuse" ended failure', '"gate / comment" ended cancelled']);
  assert.deepEqual(judgeFullRun(l, { run: goodRun(9), ...jobs('success'), record }, gate), []);
  // A full run runs the tests: a skipped tests job means it did not run in full.
  assert.deepEqual(judgeFullRun(l, { run: goodRun(9), ...jobs('success', 'skipped'), record: { ...record, reused: { runId: 8 } } }, gate), [
    '"gate / tests" ended skipped, expected success',
    'it reused run 8; a squash that no pull request leads to must run in full',
  ]);
  assert.deepEqual(judgeComment(l, []), []);
  assert.deepEqual(judgeComment(l, [{ user: { login: 'github-actions[bot]' }, body: '<!-- aifactory-gate -->\n## aifactory gate: pass' }]), [
    '1 gate comment(s) on the pull request, expected none',
  ]);
});

test('a non-pass case without the gate comment is a mismatch', () => {
  const fake = fakeGitHub({ noComment: true });
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 1);
  assert.match(lines.join('\n'), /MISMATCH canary\/secret[\s\S]*0 gate comments on the pull request, expected 1/);
});

test('judgeComment and judgeReuse', () => {
  const c = kase('canary/platform');
  const body = '<!-- aifactory-gate -->\n## aifactory gate: needs-person\n\n### Who acts\n';
  const bot = { login: 'github-actions[bot]' };
  assert.deepEqual(judgeComment(c, [{ user: bot, body, updated_at: '2026-11-24T12:00:00Z' }], '2026-11-24T11:00:00Z'), []);
  assert.deepEqual(judgeComment(c, [{ user: bot, body, updated_at: '2026-11-24T10:00:00Z' }], '2026-11-24T11:00:00Z'), ['the comment was not updated by this run']);
  assert.deepEqual(judgeComment(c, [{ user: bot, body: '<!-- aifactory-gate -->\n## aifactory gate: pass' }]), ['the comment does not show needs-person', 'the comment does not say who acts']);
  assert.deepEqual(judgeComment(c, [{ user: { login: 'someone' }, body }]), ['0 gate comments on the pull request, expected 1']);
  assert.deepEqual(judgeComment(kase('canary/pass'), []), [], 'a pass needs no comment');
  const d = kase('canary/describes-review');
  const record = recordFor('canary/describes-review', { explanation: 'x', reused: { runId: 7 } });
  assert.deepEqual(judgeReuse(d, { run: goodRun(8), ...jobs('success', 'skipped'), record }, gate, 7), []);
  assert.deepEqual(judgeReuse(d, { run: goodRun(8), ...jobs('success', 'skipped'), record: { ...record, reused: { runId: 6 } } }, gate, 7), ['it reused run 6, not 7']);
});

test('a mismatch exits 1 and records failure', () => {
  const fake = fakeGitHub({ verdicts: { 'canary/secret': 'pass' } });
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 1);
  assert.equal(fake.writes().at(-1).body.state, 'failure');
  assert.match(lines.join('\n'), /MISMATCH canary\/secret/);
  assert.match(lines.join('\n'), /Do not promote/);
});

test('--no-record writes nothing to the gate repository', () => {
  const fake = fakeGitHub();
  assert.equal(run(['--no-record'], { ...fake, ...quiet }), 0);
  assert.ok(!fake.writes().some((w) => w.args[3].startsWith(`repos/${GATE_REPO}/`)));
});

test('nothing is recorded when the channel moves during the run', () => {
  const fake = fakeGitHub({ movesTag: true });
  assert.equal(run([], { ...fake, ...quiet }), 1);
  assert.ok(!fake.writes().some((w) => w.args[3].includes('/statuses/')));
});

test('a channel commit without a pinned image is refused before anything is pushed', () => {
  const fake = fakeGitHub({ pinned: false });
  assert.throws(() => run([], { ...fake, ...quiet }), /does not pin an image digest/);
  assert.equal(fake.writes().length, 0);
});

test('runs that never finish are a mismatch after the timeout', () => {
  const fake = fakeGitHub();
  const gh = (args, input) => (String(args[1]).includes('actions/runs?head_sha=') ? JSON.stringify({ workflow_runs: [] }) : fake.gh(args, input));
  let t = 0;
  const code = run([], { gh, download: fake.download, out: () => {}, sleep: (ms) => (t += ms), now: () => t, timeoutMs: 60000, pollMs: 15000 });
  assert.equal(code, 1);
  assert.equal(fake.writes().at(-1).body.state, 'failure');
});

test('a case whose push starts no run gets one more empty commit, then is judged as usual', () => {
  const fake = fakeGitHub({ lostOnce: 'canary/secret' });
  const lines = [];
  let t = 0;
  const code = run([], { ...fake, out: (l) => lines.push(l), sleep: (ms) => (t += ms), now: () => t, pollMs: 15000, nudgeMs: 60000 });
  assert.equal(code, 0);
  const pushes = fake.writes().filter((w) => w.args[2] === 'PATCH').map((w) => w.args[3]);
  assert.equal(pushes.filter((p) => p.endsWith('canary/secret')).length, 2);
  assert.equal(pushes.filter((p) => p.endsWith('canary/pass')).length, 1);
  assert.match(lines.join('\n'), /canary\/secret: no run started within 1 minutes; pushing another empty commit/);
});
