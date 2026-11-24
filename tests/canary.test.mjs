import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decide } from '../engine/src/policy.mjs';
import { CANARY_REPO, CASES, CHANNEL, CHECK_NAME, judge, judgeComment, judgeReuse, latestRun, parseArgs, run } from '../scripts/canary.mjs';
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
const job = (conclusion) => ({ name: CHECK_NAME, conclusion });

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
    assert.deepEqual(judge(c, { run: goodRun(), job: job(c.verdict === 'pass' ? 'success' : 'failure'), record }, gate), [], c.branch);
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
  assert.deepEqual(judge(c, { run: wrongRef, job: job('failure'), record }, gate), [
    'the run called gate.yml at refs/tags/v0, not @v0-next',
    'the run used gate commit aaaaaaa, not fffffff',
  ]);
  assert.match(judge(c, { run: { ...goodRun(), referenced_workflows: [] }, job: job('failure'), record }, gate)[0], /did not call/);
  assert.deepEqual(judge(c, { run: goodRun(), job: job('success'), record }, gate), ['"gate / verdict" ended success, expected failure']);
  assert.deepEqual(judge(c, { run: goodRun(), job: undefined, record }, gate), ['no "gate / verdict" check']);
  assert.deepEqual(judge(c, { run: goodRun(), job: job('failure'), record: undefined }, gate), ['no verdict.json']);
  // A scanner that stops running adds a reason: a mismatch even though the verdict is the same.
  const extra = { ...record, reasons: [...record.reasons, { action: 'needs-person', text: 'osv-scanner did not produce a result (exit 1)' }] };
  assert.deepEqual(judge(c, { run: goodRun(), job: job('failure'), record: extra }, gate), ['unexpected reason: osv-scanner did not produce a result (exit 1)']);
  assert.deepEqual(judge(c, { run: goodRun(), job: job('failure'), record: { ...record, reasons: [] } }, gate), [
    `missing reason ${c.reasons[0]}`,
  ]);
  assert.deepEqual(judge(c, { run: goodRun(), job: job('failure'), record: { ...record, versions: { engine: '0.3.0' } } }, gate), ['engine 0.3.0, expected 0.4.0']);
  const p = kase('canary/pass');
  assert.deepEqual(judge(p, { run: goodRun(), job: job('success'), record: { ...recordFor('canary/pass'), verdict: 'fail' } }, gate), ['verdict fail, expected pass']);
});

test('the full AI review case needs a completed review and the plain words', () => {
  const c = kase('canary/ai-review');
  const record = recordFor('canary/ai-review');
  assert.deepEqual(judge(c, { run: goodRun(), job: job('success'), record }, gate), ['no "In plain words" explanation']);
  assert.deepEqual(judge(c, { run: goodRun(), job: job('success'), record: { ...record, explanation: 'x', aiReview: { error: 'sign-in failed' } } }, gate), [
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
function fakeGitHub({ verdicts = {}, variable = false, movesTag = false, pinned = true, lostOnce, noComment = false, ranAgain = false } = {}) {
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
  const PUSH = 100;
  const pushRunFor = (sha) => [...byRun].find(([, c]) => c.reuseOn && sha === 'BASE+')?.[0];
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
      const number = CASES.findIndex((c) => c.branch === decodeURIComponent(m[1])) + 1;
      return JSON.stringify([{ html_url: `https://github.com/${CANARY_REPO}/pull/${number}`, number }]);
    }
    if ((m = p.match(/issues\/(\d+)\/comments/))) {
      const c = CASES[Number(m[1]) - 1];
      const v = verdictOf(c);
      return JSON.stringify(v === 'pass' || noComment ? [] : [{ user: { login: 'github-actions[bot]' }, body: `<!-- aifactory-gate -->\n## aifactory gate: ${v}\n\n### Who acts\n`, updated_at: '2026-11-24T12:00:00Z' }]);
    }
    if ((m = p.match(/git\/ref\/heads\/(.+)$/))) return JSON.stringify({ object: { sha: heads.get(decodeURIComponent(m[1])) } });
    if (p.includes('/git/commits/')) return JSON.stringify({ tree: { sha: 'tree' } });
    if ((m = p.match(/actions\/runs\?head_sha=([^&]+)/))) {
      const pushed = pushRunFor(m[1]);
      if (pushed) return JSON.stringify({ workflow_runs: [{ id: PUSH + pushed, event: 'push', status: 'completed', run_number: PUSH + pushed, run_attempt: 1 }] });
      const id = runFor(m[1]);
      return JSON.stringify({ workflow_runs: id ? [{ id, event: 'pull_request', status: 'completed', run_number: id, run_attempt: 1 }] : [] });
    }
    if ((m = p.match(/actions\/runs\/(\d+)\/jobs$/))) {
      const c = byRun.get(Number(m[1]) % PUSH);
      const v = verdictOf(c);
      return JSON.stringify({ jobs: [job(v === 'pass' ? 'success' : 'failure')] });
    }
    if ((m = p.match(/actions\/runs\/(\d+)$/))) return JSON.stringify(goodRun(Number(m[1])));
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const download = (id) => {
    const c = byRun.get(id % PUSH);
    const extra = { ...(c.explanation ? { explanation: 'Plain words.' } : {}), ...(c.reuseOn ? { subject: { tree: 'T', base: 'BASE' } } : {}) };
    if (id > PUSH && !ranAgain) extra.reused = { runId: id - PUSH };
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
  const commits = writes.filter((w) => w.args[3].endsWith('/git/commits'));
  assert.equal(commits.length, CASES.filter((c) => !c.needsVariable).length);
  for (const c of commits) assert.equal(c.body.tree, 'tree'); // same tree: an empty commit
  for (const w of writes.filter((w) => w.args[2] === 'PATCH')) assert.equal(w.body.force, false); // never a force-push
  const status = writes.find((w) => w.args[3] === `repos/${GATE_REPO}/statuses/${GATE_SHA}`);
  assert.equal(status.body.state, 'success');
  assert.equal(status.body.context, CANARY_CONTEXT);
  assert.match(status.body.description, /^4 of 4 cases as expected on @v0-next, 2 skipped$/);
});

test('the AI review cases run once their variable is set; the merge of describes-review is pushed and reuses the verdict', () => {
  const fake = fakeGitHub({ variable: true });
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 0);
  assert.match(fake.writes().at(-1).body.description, /^6 of 6 cases/);
  const writes = fake.writes();
  const merge = writes.find((w) => w.args[3].endsWith('/git/commits') && w.body.tree === 'T');
  assert.deepEqual(merge.body.parents, ['BASE', 'head-canary/describes-review+'], 'a merge of the judged base and the pull request head');
  const moved = writes.filter((w) => w.args[2] === 'PATCH' && w.args[3].includes('/git/refs/heads/'));
  assert.deepEqual(moved.filter((w) => w.body.force).map((w) => w.args[3]), [`repos/${CANARY_REPO}/git/refs/heads/canary-push/describes-review`], 'only the push branch is moved with force');
  assert.match(lines.join('\n'), /push of the merge \(canary-push\/describes-review\): /);
});

test('a push of the merge that runs again instead of reusing is a mismatch', () => {
  const fake = fakeGitHub({ variable: true, ranAgain: true });
  const lines = [];
  assert.equal(run([], { ...fake, sleep: () => {}, out: (l) => lines.push(l) }), 1);
  assert.match(lines.join('\n'), /canary-push\/describes-review: it ran again instead of reusing the pull request verdict/);
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
  assert.deepEqual(judgeReuse(d, { run: goodRun(8), job: job('success'), record }, gate, 7), []);
  assert.deepEqual(judgeReuse(d, { run: goodRun(8), job: job('success'), record: { ...record, reused: { runId: 6 } } }, gate, 7), ['it reused run 6, not 7']);
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
