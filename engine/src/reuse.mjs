// Reuse of a pull request's verdict on the push to main. When the pushed commit is exactly the change
// a pull request's gate run already judged (the same tree on the same base tree, the same gate commit
// and the same caller inputs), the push run takes that verdict instead of running the tests, the
// scanners and the AI review again. Same change, same verdict, and the AI review is paid for once.
//
// Two halves:
//   findReusable   in gate.yml's "reuse" job, with the job's own GITHUB_TOKEN (actions: read, given
//                  by the caller): finds the pull request run and reads its verdict artifact. That
//                  job runs no repository code.
//   reuseVerdict   in the verdict job: checks the candidate against the checked-out commit itself
//                  and writes the record. Anything that does not match means a normal run.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { summary } from './report.mjs';

export const GATE_WORKFLOW = 'itm8-public/aifactory-gate/.github/workflows/gate.yml@';
export const ARTIFACT = 'aifactory-verdict';
const MAX_VERDICT_BYTES = 4 * 1024 * 1024;
const MAX_HEADS = 3;
const MAX_RUNS = 5;

/** sha256 of the caller's inputs as gate.yml passes them (toJSON(inputs)), or null without them. */
export function inputsHash(inputs) {
  return inputs ? createHash('sha256').update(inputs).digest('hex') : null;
}

/** The change a run judges: HEAD's tree on the tree of its base (the merge base with `base`). */
export function subjectOf(repo, base, inputs) {
  const git = (args) => execFileSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const commit = git(['rev-parse', 'HEAD']);
    const from = git(['merge-base', base, 'HEAD']);
    return { commit, tree: git(['rev-parse', 'HEAD^{tree}']), base: from, baseTree: git(['rev-parse', `${from}^{tree}`]), inputs: inputsHash(inputs) };
  } catch {
    return null;
  }
}

/** The one file `name` of a zip archive (stored or deflated), at most `limit` bytes. */
export function unzipEntry(zip, name, limit = MAX_VERDICT_BYTES) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('broken zip directory');
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (entry !== name) continue;
    if (size > limit || packed > limit) throw new Error(`${name} is larger than ${limit} bytes`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('broken zip entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data, { maxOutputLength: limit });
    throw new Error(`zip method ${method} is not supported`);
  }
  throw new Error(`${name} is not in the archive`);
}

/** The gate.yml a run called: { ref, sha }, or undefined. */
function gateOf(run) {
  return (run.referenced_workflows ?? []).find((w) => String(w.path).toLowerCase().startsWith(GATE_WORKFLOW));
}

/**
 * Finds the verdict a pull request run gave exactly this change.
 * @param {object} input
 * @param {(path: string) => Promise<any>} input.api      GitHub REST GET, JSON; throws { status } on errors
 * @param {(artifactId: number) => Promise<Buffer>} input.download  the artifact's zip
 * @param {string} input.repo   OWNER/NAME
 * @param {string|number} input.runId  this run
 * @param {string} input.sha    the pushed commit
 * @param {string|null} input.inputs  inputsHash of this run's caller inputs
 * @returns {Promise<{candidate?: {source: object, record: object}, reason: string}>}
 */
export async function findReusable({ api, download, repo, runId, sha, inputs }) {
  if (!inputs) return { reason: 'the caller inputs are unknown' };
  let current;
  try {
    current = await api(`repos/${repo}/actions/runs/${runId}`);
  } catch (err) {
    if (err.status === 403 || err.status === 404) return { reason: 'this run cannot read workflow runs: the caller does not grant actions: read' };
    throw err;
  }
  const gate = gateOf(current);
  if (!gate) return { reason: 'this run did not call the gate workflow' };

  const commit = await api(`repos/${repo}/git/commits/${sha}`);
  if (!commit.parents?.length) return { reason: 'the pushed commit has no parent' };
  const tree = commit.tree.sha;
  const baseTree = (await api(`repos/${repo}/git/commits/${commit.parents[0].sha}`)).tree.sha;

  // The pull request heads this commit came from: GitHub's own link (merge, squash or rebase; needs
  // pull-requests: read), and a merge commit's second parent.
  const heads = new Map();
  try {
    for (const pr of await api(`repos/${repo}/commits/${sha}/pulls`)) {
      if (pr.base?.repo?.full_name === repo && pr.head?.sha) heads.set(pr.head.sha, pr.number);
    }
  } catch {
    // Without pull-requests: read only a merge commit is found.
  }
  if (commit.parents.length === 2 && !heads.has(commit.parents[1].sha)) heads.set(commit.parents[1].sha, undefined);
  if (!heads.size) return { reason: 'no pull request leads to this commit' };

  const skipped = [];
  for (const [head, number] of [...heads].slice(0, MAX_HEADS)) {
    const listed = await api(`repos/${repo}/actions/workflows/${current.workflow_id}/runs?event=pull_request&status=completed&head_sha=${head}&per_page=20`);
    const runs = (listed.workflow_runs ?? [])
      .filter((r) => r.head_repository?.full_name === repo && r.id !== current.id)
      .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)
      .slice(0, MAX_RUNS);
    for (const run of runs) {
      const why = await judgeRun({ api, download, repo, run, gate, tree, baseTree, inputs });
      if (typeof why === 'string') {
        skipped.push(`run ${run.id}: ${why}`);
        continue;
      }
      const pullRequest = number ?? run.pull_requests?.find((p) => p.head?.sha === head)?.number;
      return {
        candidate: {
          source: { runId: run.id, runAttempt: run.run_attempt, runUrl: run.html_url, pullRequest, headSha: head, job: why.job },
          record: why.record,
        },
        reason: `the gate run ${run.id}${pullRequest ? ` for pull request #${pullRequest}` : ''} judged exactly this change`,
      };
    }
  }
  return { reason: skipped.length ? `no pull request run judged exactly this change (${skipped.join('; ')})` : 'no completed pull request run of this workflow for that pull request' };
}

/** A reason the run cannot be reused, or { record, job }. */
async function judgeRun({ api, download, repo, run, gate, tree, baseTree, inputs }) {
  const used = gateOf(run);
  if (!used || used.sha !== gate.sha) return 'it ran another gate version';
  const { jobs = [] } = await api(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const verdictJobs = jobs.filter((j) => j.name === 'verdict' || j.name.endsWith(' / verdict'));
  if (verdictJobs.length !== 1) return 'no single verdict job';
  const [job] = verdictJobs;
  if (!['success', 'failure'].includes(job.conclusion)) return `its verdict job ended ${job.conclusion}`;
  // The artifact of that attempt: uploaded while its verdict job ran.
  const { artifacts = [] } = await api(`repos/${repo}/actions/runs/${run.id}/artifacts?name=${ARTIFACT}&per_page=100`);
  const from = Date.parse(job.started_at);
  // A little slack at the end: the upload's time and the job's end are stamped separately.
  const to = Date.parse(job.completed_at) + 30_000;
  const artifact = artifacts
    .filter((a) => a.name === ARTIFACT && !a.expired && Date.parse(a.created_at) >= from && Date.parse(a.created_at) <= to)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!artifact) return 'no verdict artifact from its verdict job';
  let record;
  try {
    record = JSON.parse(unzipEntry(await download(artifact.id), 'verdict.json').toString('utf8'));
  } catch (err) {
    return `unreadable verdict (${err.message})`;
  }
  const s = record.subject;
  if (!s?.tree || s.tree !== tree || s.baseTree !== baseTree) return 'it judged another change';
  if (s.inputs !== inputs) return 'its caller inputs differ';
  // The job's own outcome is GitHub's record, set from the engine's exit code: a verdict file that
  // says otherwise is not trusted.
  const blocking = record.enforced === true && record.verdict !== 'pass';
  if (!['pass', 'fail', 'needs-person'].includes(record.verdict) || typeof record.enforced !== 'boolean') return 'its verdict file is incomplete';
  if ((blocking ? 'failure' : 'success') !== job.conclusion) return `its verdict file (${record.verdict}) does not match its verdict job (${job.conclusion})`;
  return { record, job: { id: job.id, conclusion: job.conclusion } };
}

/**
 * Checks a candidate against the checked-out commit and this run's settings, and writes the reused
 * record (verdict.json, summary.md, comment.md). Returns { record } or { problem }.
 */
export function reuseVerdict({ candidate, subject, zone, level, profile, aiReview, versions, promptVersion, context, out }) {
  const { record, source } = candidate ?? {};
  const s = record?.subject;
  const problem = (() => {
    if (!record || !source?.runId) return 'the candidate is incomplete';
    if (!subject || !s) return 'the change could not be compared';
    if (s.tree !== subject.tree || s.baseTree !== subject.baseTree) return 'it judged another change';
    if (!subject.inputs || s.inputs !== subject.inputs) return 'its caller inputs differ';
    if (record.zone !== zone || record.level !== level || (record.profile ?? '') !== profile) return 'its zone, level or profile differ';
    const requested = record.aiReview?.requested !== false;
    if (requested !== (aiReview === 'on')) return 'its AI review setting differs';
    const v = record.versions ?? {};
    if (v.engine !== versions.engine || v.policy !== versions.policy || v.models !== versions.models) return 'it ran another engine, policy or model version';
    if (requested && record.aiReview?.promptVersion && record.aiReview.promptVersion !== promptVersion) return 'it ran another prompt version';
    if (!['pass', 'fail', 'needs-person'].includes(record.verdict)) return 'its verdict is unknown';
    return null;
  })();
  if (problem) return { problem };
  const reused = {
    runId: source.runId,
    runAttempt: source.runAttempt,
    runUrl: source.runUrl,
    pullRequest: source.pullRequest,
    headSha: source.headSha,
    commit: s.commit,
    tree: s.tree,
    baseTree: s.baseTree,
    decidedAt: record.decidedAt,
  };
  const next = { ...record, subject, context, reused, decidedAt: new Date().toISOString() };
  writeFileSync(path.join(out, 'verdict.json'), JSON.stringify(next, null, 2));
  writeFileSync(path.join(out, 'summary.md'), summary(next));
  writeFileSync(path.join(out, 'comment.md'), summary(next, { comment: true }));
  return { record: next };
}

/** GitHub REST for findReusable, with the job's token. The artifact redirect is followed without it. */
export function githubApi({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
  const api = async (p) => {
    const res = await fetchImpl(`${apiUrl}/${p}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw Object.assign(new Error(`GET ${p.split('?')[0]}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
  const download = async (id) => {
    const res = await fetchImpl(`${apiUrl}/repos/${repo}/actions/artifacts/${id}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    let blob = res;
    if (res.status >= 300 && res.status < 400) blob = await fetchImpl(res.headers.get('location'), { signal: AbortSignal.timeout(60_000) });
    if (!blob.ok) throw new Error(`artifact ${id}: HTTP ${blob.status}`);
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length > MAX_VERDICT_BYTES) throw new Error(`artifact ${id} is too large`);
    return buf;
  };
  return { api, download };
}
