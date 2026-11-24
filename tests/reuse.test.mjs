// The push to main reuses the verdict a pull request's gate run gave exactly the same change.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { findCommand, parseArgs } from '../engine/bin/aifactory-review.mjs';
import { PROMPT_VERSION } from '../engine/src/models/prompts.mjs';
import { findReusable, githubApi, inputsHash, reuseVerdict, subjectOf, unzipEntry } from '../engine/src/reuse.mjs';
import { buildVerdict } from '../engine/src/verdict.mjs';

const REPO = 'oral-care/app';
const INPUTS = JSON.stringify({ zone: 'green', level: 2, 'ai-review': true });
const H = inputsHash(INPUTS);
const GATE = (sha) => [{ path: 'itm8-public/aifactory-gate/.github/workflows/gate.yml@refs/tags/v0', ref: 'refs/tags/v0', sha }];
const policyVersion = JSON.parse(readFileSync(new URL('../policy/policy.v1.json', import.meta.url), 'utf8')).version;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versions = { engine: pkg.version, policy: policyVersion, models: '1', tools: {} };

/** A zip with one deflated file, as GitHub serves an artifact. */
export function zipOf(name, text) {
  const data = Buffer.from(text);
  const packed = deflateRawSync(data);
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, file, packed]);
  const dir = Buffer.concat([central, file]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}

const record = (over = {}) => ({
  verdict: 'pass',
  zone: 'green',
  level: 2,
  profile: '',
  enforced: true,
  reasons: [],
  counts: { low: 0, medium: 0, high: 0, critical: 0 },
  findings: [],
  aiReview: { requested: true, promptVersion: PROMPT_VERSION, deployments: { find: 'review-find' } },
  versions,
  subject: { commit: 'MERGEREF', tree: 'T', base: 'BASE', baseTree: 'BT', inputs: H },
  decidedAt: '2026-11-24T10:00:00.000Z',
  ...over,
});

/** A fake GitHub with one merged pull request (#6, head HEAD1) and its gate run 90. */
function github({ verdictFile = record(), job = {}, run = {}, pulls, push = {}, current = {}, artifact = {} } = {}) {
  const calls = [];
  const routes = {
    [`repos/${REPO}/actions/runs/100`]: { id: 100, workflow_id: 7, referenced_workflows: GATE('G1'), ...current },
    [`repos/${REPO}/git/commits/PUSH`]: { tree: { sha: 'T' }, parents: [{ sha: 'BASE' }, { sha: 'HEAD1' }], ...push },
    [`repos/${REPO}/git/commits/BASE`]: { tree: { sha: 'BT' } },
    [`repos/${REPO}/commits/PUSH/pulls`]: pulls ?? [{ number: 6, head: { sha: 'HEAD1' }, base: { repo: { full_name: REPO } } }],
    [`repos/${REPO}/actions/workflows/7/runs?event=pull_request&status=completed&head_sha=HEAD1&per_page=20`]: {
      workflow_runs: [{ id: 90, run_number: 12, run_attempt: 1, html_url: 'https://github.com/x/runs/90', head_repository: { full_name: REPO }, referenced_workflows: GATE('G1'), pull_requests: [], ...run }],
    },
    [`repos/${REPO}/actions/runs/90/attempts/1/jobs?per_page=100`]: {
      jobs: [
        { id: 1, name: 'gate / verdict', conclusion: 'success', started_at: '2026-11-24T10:00:00Z', completed_at: '2026-11-24T10:05:00Z', ...job },
        { id: 2, name: 'gate / comment', conclusion: 'success', started_at: '2026-11-24T10:05:00Z', completed_at: '2026-11-24T10:05:30Z' },
      ],
    },
    [`repos/${REPO}/actions/runs/90/artifacts?name=aifactory-verdict&per_page=100`]: {
      artifacts: [{ id: 55, name: 'aifactory-verdict', expired: false, created_at: '2026-11-24T10:04:00Z', ...artifact }],
    },
  };
  const api = async (p) => {
    calls.push(p);
    const r = routes[p];
    if (r instanceof Error) throw r;
    if (r === undefined) throw Object.assign(new Error(`404 ${p}`), { status: 404 });
    return r;
  };
  const download = async (id) => {
    assert.equal(id, 55);
    return zipOf('verdict.json', JSON.stringify(verdictFile));
  };
  return { api, download, calls, routes };
}

const find = (gh, over = {}) => findReusable({ api: gh.api, download: gh.download, repo: REPO, runId: 100, sha: 'PUSH', inputs: H, ...over });

test('unzip: reads one deflated file, refuses what is not there or too large', () => {
  const z = zipOf('verdict.json', '{"verdict":"pass"}');
  assert.equal(unzipEntry(z, 'verdict.json').toString(), '{"verdict":"pass"}');
  assert.throws(() => unzipEntry(z, 'other.json'), /not in the archive/);
  assert.throws(() => unzipEntry(z, 'verdict.json', 4), /larger than/);
  assert.throws(() => unzipEntry(Buffer.from('not a zip at all, not even close to one'), 'verdict.json'), /not a zip/);
});

test('find: the merged pull request run that judged exactly this change', async () => {
  const gh = github();
  const r = await find(gh);
  assert.match(r.reason, /run 90 for pull request #6 judged exactly this change/);
  assert.deepEqual(r.candidate.source, { runId: 90, runAttempt: 1, runUrl: 'https://github.com/x/runs/90', pullRequest: 6, headSha: 'HEAD1', job: { id: 1, conclusion: 'success' } });
  assert.equal(r.candidate.record.verdict, 'pass');
});

test('find: without actions: read from the caller there is nothing to reuse, and the run says why', async () => {
  const gh = github();
  gh.routes[`repos/${REPO}/actions/runs/100`] = Object.assign(new Error('403'), { status: 403 });
  assert.match((await find(gh)).reason, /does not grant actions: read/);
});

test('find: a merge commit is found without pull-requests: read; a squash commit needs it', async () => {
  const merge = github();
  merge.routes[`repos/${REPO}/commits/PUSH/pulls`] = Object.assign(new Error('403'), { status: 403 });
  const r = await find(merge);
  assert.equal(r.candidate.source.headSha, 'HEAD1');
  assert.equal(r.candidate.source.pullRequest, undefined);
  const squash = github({ push: { parents: [{ sha: 'BASE' }] } });
  squash.routes[`repos/${REPO}/commits/PUSH/pulls`] = Object.assign(new Error('403'), { status: 403 });
  assert.match((await find(squash)).reason, /no pull request leads to this commit/);
  const linked = github({ push: { parents: [{ sha: 'BASE' }] } });
  assert.equal((await find(linked)).candidate.source.pullRequest, 6, 'squash: found through the pull request link');
});

test('find: never another change, other inputs or another gate version', async () => {
  for (const [over, why] of [
    [{ verdictFile: record({ subject: { ...record().subject, tree: 'OTHER' } }) }, /judged another change/],
    [{ verdictFile: record({ subject: { ...record().subject, baseTree: 'OTHER' } }) }, /judged another change/],
    [{ verdictFile: record({ subject: { ...record().subject, inputs: 'x' } }) }, /caller inputs differ/],
    [{ verdictFile: record({ subject: undefined }) }, /judged another change/],
    [{ run: { referenced_workflows: GATE('G0') } }, /another gate version/],
    [{ run: { head_repository: { full_name: 'someone/fork' } } }, /no completed pull request run/],
    [{ job: { conclusion: 'cancelled' } }, /verdict job ended cancelled/],
    [{ artifact: { created_at: '2026-11-24T11:00:00Z' } }, /no verdict artifact from its verdict job/],
    [{ artifact: { expired: true } }, /no verdict artifact/],
  ]) {
    const r = await find(github(over));
    assert.equal(r.candidate, undefined, String(why));
    assert.match(r.reason, why);
  }
  assert.match((await find(github(), { inputs: null })).reason, /inputs are unknown/);
});

test('find: a verdict file that disagrees with its job is not trusted', async () => {
  // A test can overwrite verdict.json after the engine wrote it; the job's outcome comes from the
  // engine's exit code, which it cannot change.
  const tampered = await find(github({ verdictFile: record({ verdict: 'pass' }), job: { conclusion: 'failure' } }));
  assert.match(tampered.reason, /verdict file \(pass\) does not match its verdict job \(failure\)/);
  const blocked = await find(github({ verdictFile: record({ verdict: 'needs-person' }), job: { conclusion: 'failure' } }));
  assert.equal(blocked.candidate.record.verdict, 'needs-person', 'a blocking verdict with a failed job is consistent');
  const advisory = await find(github({ verdictFile: record({ verdict: 'fail', level: 1, enforced: false }) }));
  assert.equal(advisory.candidate.record.verdict, 'fail', 'level 1 never fails the job');
});

test('find-reusable never fails the job and writes the candidate only when there is one', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const lines = [];
  const broken = async () => {
    throw new Error('network down');
  };
  const env = { GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '100', GITHUB_SHA: 'PUSH', GH_TOKEN: 't', AIFACTORY_INPUTS: INPUTS };
  assert.equal(await findCommand({ out }, env, { out: (s) => lines.push(s), fetchImpl: broken }), 0);
  assert.match(lines[0], /^no reuse: network down/);
  assert.equal(existsSync(path.join(out, 'reuse-candidate.json')), false);
  assert.deepEqual(parseArgs(['find-reusable', '--out', '/o']).command, 'find-reusable');
});

test('githubApi: the job token goes to the API, never to the artifact storage it redirects to', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, auth: init.headers?.authorization });
    if (url.endsWith('/zip')) return { status: 302, ok: false, headers: new Map([['location', 'https://blob.example/a.zip?sig=x']]) };
    if (url.startsWith('https://blob.example')) return { status: 200, ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
    return { status: 200, ok: true, json: async () => ({ ok: 1 }) };
  };
  const { api, download } = githubApi({ token: 'tok', repo: REPO, fetchImpl });
  assert.deepEqual(await api(`repos/${REPO}/actions/runs/1`), { ok: 1 });
  assert.equal((await download(9)).length, 2);
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer tok', 'Bearer tok', undefined]);
});

/** A git repository with a base commit and a change on top; returns its path. */
function gitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-repo-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(path.join(dir, 'README.md'), '# app\n\nThe AI review reads every change.\n');
  git('commit', '-qam', 'docs');
  return { dir, git };
}

test('subjectOf: the tree judged and the tree it was judged against, with the inputs', () => {
  const { dir, git } = gitRepo();
  const s = subjectOf(dir, 'HEAD^1', INPUTS);
  assert.deepEqual(s, { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), base: git('rev-parse', 'HEAD^1'), baseTree: git('rev-parse', 'HEAD^1^{tree}'), inputs: H });
  assert.equal(subjectOf(mkdtempSync(path.join(tmpdir(), 'gate-')), 'HEAD^1', INPUTS), null, 'not a repository');
});

test('buildVerdict records the subject, the profile and that the AI review was requested', async () => {
  const { dir } = gitRepo();
  const out = mkdtempSync(path.join(tmpdir(), 'gate-'));
  for (const [f, c] of [['gitleaks.json', '[]'], ['opengrep.sarif', '{"runs":[]}'], ['osv.json', '{"results":[]}']]) writeFileSync(path.join(out, f), c);
  const policy = JSON.parse(readFileSync(new URL('../policy/policy.solo.v1.json', import.meta.url), 'utf8'));
  const r = await buildVerdict({ repo: dir, results: out, zone: 'green', level: 2, base: 'HEAD^1', checks: { tests: 'success' }, policy, versions, profile: 'solo', inputs: INPUTS, ai: { requested: true, findings: [], state: { promptVersion: PROMPT_VERSION } } });
  assert.equal(r.subject.tree, subjectOf(dir, 'HEAD^1', INPUTS).tree);
  assert.equal(r.subject.inputs, H);
  assert.equal(r.profile, 'solo');
  assert.equal(r.aiReview.requested, true);
  assert.ok(existsSync(path.join(out, 'comment.md')));
});

const candidateFor = (dir, over = {}, source = {}) => ({
  source: { runId: 90, runAttempt: 1, runUrl: 'https://github.com/o/r/actions/runs/90', pullRequest: 6, headSha: 'HEAD1', ...source },
  record: record({ subject: { ...subjectOf(dir, 'HEAD^1', INPUTS), commit: 'MERGEREF' }, ...over }),
});
const settings = (dir, out) => ({ subject: subjectOf(dir, 'HEAD^1', INPUTS), zone: 'green', level: 2, profile: '', aiReview: 'on', versions, promptVersion: PROMPT_VERSION, context: { ownerType: 'Organization' }, out });

test('reuse: the same change takes the pull request verdict, and the summary says from which run', () => {
  const { dir, git } = gitRepo();
  const out = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const { record: r, problem } = reuseVerdict({ candidate: candidateFor(dir), ...settings(dir, out) });
  assert.equal(problem, undefined);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.subject.commit, git('rev-parse', 'HEAD'), 'the record names this commit');
  assert.deepEqual([r.reused.runId, r.reused.pullRequest, r.reused.commit, r.reused.decidedAt], [90, 6, 'MERGEREF', '2026-11-24T10:00:00.000Z']);
  const md = readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(md, /_Verdict reused: the gate already judged exactly this change .* for pull request #6, in \[run 90\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/90\)\. Nothing ran again/);
  assert.equal(JSON.parse(readFileSync(path.join(out, 'verdict.json'), 'utf8')).reused.runId, 90);
});

test('reuse: anything that differs means a full run', () => {
  const { dir } = gitRepo();
  const out = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const s = settings(dir, out);
  const cases = [
    [{ candidate: candidateFor(dir, { subject: { ...record().subject } }) }, /another change/],
    [{ candidate: candidateFor(dir, { subject: { ...subjectOf(dir, 'HEAD^1', INPUTS), inputs: 'x' } }) }, /inputs differ/],
    [{ zone: 'yellow' }, /zone, level or profile/],
    [{ level: 3 }, /zone, level or profile/],
    [{ profile: 'solo' }, /zone, level or profile/],
    [{ aiReview: 'off' }, /AI review setting/],
    [{ versions: { ...versions, engine: '9.9.9' } }, /another engine/],
    [{ promptVersion: '1' }, /another prompt version/],
    [{ candidate: candidateFor(dir, { verdict: 'maybe' }) }, /verdict is unknown/],
    [{ candidate: { record: record() } }, /incomplete/],
    [{ subject: null }, /could not be compared/],
  ];
  for (const [over, why] of cases) {
    const r = reuseVerdict({ candidate: candidateFor(dir), ...s, ...over });
    assert.match(r.problem ?? 'reused', why);
  }
  assert.equal(existsSync(path.join(out, 'verdict.json')), false, 'nothing is written when it does not match');
});

test('engine reuse command: exit 0 or 1 with the verdict, 3 when it does not match', () => {
  const { dir } = gitRepo();
  const bin = fileURLToPath(new URL('../engine/bin/aifactory-review.mjs', import.meta.url));
  const run = (candidate, extra = []) => {
    const out = mkdtempSync(path.join(tmpdir(), 'gate-'));
    const from = path.join(out, 'candidate.json');
    writeFileSync(from, JSON.stringify(candidate));
    const args = [bin, 'reuse', '--repo', dir, '--out', out, '--from', from, '--zone', 'green', '--level', '2', '--base', 'HEAD^1', '--ai-review', 'on', ...extra];
    return spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, AIFACTORY_INPUTS: INPUTS } });
  };
  const pass = run(candidateFor(dir));
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /verdict=pass reused from run 90/);
  const blocked = run(candidateFor(dir, { verdict: 'needs-person', reasons: [{ action: 'needs-person', id: 'area:ci-infra', text: 'Touches CI, deployment or infrastructure configuration' }] }));
  assert.equal(blocked.status, 1);
  const other = run(candidateFor(dir), ['--profile', 'solo']);
  assert.equal(other.status, 3);
  assert.match(other.stderr, /not reused, its zone, level or profile differ/);
  assert.throws(() => parseArgs(['reuse', '--repo', '/r', '--out', '/o', '--zone', 'green']), /--from/);
});
