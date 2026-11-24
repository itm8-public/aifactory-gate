import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AI_REVIEW_BRANCH,
  CALLER_PATH,
  DEFAULT_TOKEN_SCOPE,
  PROJECT_TOKEN_SCOPE,
  REQUIRED_CHECK,
  aiReviewCalls,
  checkAiReview,
  oidcPrefix,
  oidcSubjects,
  parseArgs,
  plan,
  run,
  setAiReview,
} from '../scripts/setup-repo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/setup-repo.mjs');
const template = readFileSync(path.join(root, 'templates/aifactory-gate.yml'), 'utf8');

test('arguments need a repository and one reviewer kind', () => {
  assert.throws(() => parseArgs(['--team', 'x']), /--repo/);
  assert.throws(() => parseArgs(['--repo', 'o/r']), /exactly one/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--team', 't', '--reviewer', 'u']), /exactly one/);
  assert.deepEqual(parseArgs(['--repo', 'o/r', '--reviewer', 'u', '--apply']), { apply: true, repo: 'o/r', reviewer: 'u' });
});

test('team plan: ruleset requires the gate check and the team approves prod', () => {
  const calls = plan({ repo: 'o/r', reviewer: { type: 'Team', id: 42 } });
  assert.equal(calls[0].method, 'POST');
  const rules = calls[0].body.rules;
  const checks = rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
  assert.deepEqual(checks, [{ context: REQUIRED_CHECK, integration_id: 15368 }]);
  assert.equal(rules.find((r) => r.type === 'pull_request').parameters.require_code_owner_review, true);
  assert.deepEqual(calls[0].body.bypass_actors, [{ actor_id: 42, actor_type: 'Team', bypass_mode: 'pull_request' }]);
  const prod = calls.find((c) => c.path.endsWith('/environments/prod'));
  assert.deepEqual(prod.body.reviewers, [{ type: 'Team', id: 42 }]);
  assert.equal(prod.body.prevent_self_review, true);
});

test('personal repository: repository admins bypass, the user approves prod', () => {
  const calls = plan({ repo: 'me/app', reviewer: { type: 'User', id: 7 } });
  assert.equal(calls[0].body.bypass_actors[0].actor_type, 'RepositoryRole');
  assert.deepEqual(calls.find((c) => c.path.endsWith('/environments/prod')).body.reviewers, [{ type: 'User', id: 7 }]);
});

test('an existing ruleset is updated, not duplicated', () => {
  const calls = plan({ repo: 'o/r', reviewer: { type: 'Team', id: 1 }, existingRulesetId: 99 });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, 'repos/o/r/rulesets/99');
});

test('--profile solo parses; any other value is rejected', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/r', '--reviewer', 'u', '--profile', 'solo']), { apply: false, repo: 'o/r', reviewer: 'u', profile: 'solo' });
  assert.throws(() => parseArgs(['--repo', 'o/r', '--reviewer', 'u', '--profile', 'duo']), /profile/);
});

test('solo profile drops the required code-owner review; nothing else changes', () => {
  const solo = plan({ repo: 'o/r', reviewer: { type: 'Team', id: 42 }, profile: 'solo' });
  const prRule = solo[0].body.rules.find((r) => r.type === 'pull_request');
  assert.equal(prRule.parameters.require_code_owner_review, false, 'a solo customer has no second reviewer');
  // The gate check and the bypass actor are untouched: the gate still gates the serious cases.
  const checks = solo[0].body.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
  assert.deepEqual(checks, [{ context: REQUIRED_CHECK, integration_id: 15368 }]);
  assert.deepEqual(solo[0].body.bypass_actors, [{ actor_id: 42, actor_type: 'Team', bypass_mode: 'pull_request' }]);
  // The default (no profile) still requires a code-owner review.
  const base = plan({ repo: 'o/r', reviewer: { type: 'Team', id: 42 } });
  assert.equal(base[0].body.rules.find((r) => r.type === 'pull_request').parameters.require_code_owner_review, true);
});

// AI review: setup-repo is the only writer of the caller's AI review values, so it must refuse a
// half-wired setup (ai-review: true with an empty or malformed value) before anything is changed.
const ENDPOINT = 'https://itm8-review.openai.azure.com';
const CLIENT = '11111111-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const aiArgs = (over = {}) => {
  const v = { '--review-endpoint': ENDPOINT, '--azure-client-id': CLIENT, '--azure-tenant-id': TENANT, ...over };
  return ['--repo', 'o/r', '--ai-review', ...Object.entries(v).flatMap(([k, x]) => (x === null ? [] : [k, x]))];
};
const values = { endpoint: ENDPOINT, clientId: CLIENT, tenantId: TENANT, scope: DEFAULT_TOKEN_SCOPE };

test('--ai-review parses the three values; the scope defaults to the account scope', () => {
  assert.deepEqual(parseArgs(aiArgs()), { apply: false, repo: 'o/r', aiReview: values });
  const withTeam = parseArgs([...aiArgs(), '--team', 't', '--apply']);
  assert.equal(withTeam.team, 't');
  assert.equal(withTeam.apply, true);
  // Copy-paste noise is cleaned: spaces, a trailing slash, upper-case GUIDs.
  const messy = parseArgs(aiArgs({ '--review-endpoint': ` ${ENDPOINT}/ `, '--azure-client-id': CLIENT.toUpperCase() }));
  assert.deepEqual(messy.aiReview, values);
});

test('--ai-review refuses empty values, listing every problem in plain words', () => {
  for (const [over, problem] of [
    [{ '--review-endpoint': '' }, /--review-endpoint is empty/],
    [{ '--review-endpoint': null }, /--review-endpoint is empty/],
    [{ '--azure-client-id': '' }, /--azure-client-id is empty/],
    [{ '--azure-tenant-id': '   ' }, /--azure-tenant-id is empty/],
    [{ '--review-token-scope': '' }, /--review-token-scope is empty/],
  ]) {
    assert.throws(() => parseArgs(aiArgs(over)), (err) => problem.test(err.message) && /Management App/.test(err.message) && /Nothing was changed/.test(err.message));
  }
  // A flag with no value does not swallow the next flag.
  assert.throws(() => parseArgs(['--repo', 'o/r', '--ai-review', '--review-endpoint', '--azure-client-id', CLIENT, '--azure-tenant-id', TENANT]), /--review-endpoint is empty/);
  // Everything wrong at once is reported at once.
  assert.throws(
    () => checkAiReview({}),
    (err) => ['--review-endpoint is empty', '--azure-client-id is empty', '--azure-tenant-id is empty'].every((p) => err.message.includes(p)),
  );
});

test('--ai-review refuses malformed values', () => {
  for (const endpoint of [
    'http://itm8-review.openai.azure.com',
    'itm8-review.openai.azure.com',
    'https://itm8-review.openai.azure.com/openai/v1',
    'https://x.openai.azure.com?api-version=1',
    'https://x.openai.azure.com:8443',
    'https://u:p@x.openai.azure.com',
  ]) {
    assert.throws(() => parseArgs(aiArgs({ '--review-endpoint': endpoint })), /https origin/, endpoint);
  }
  assert.throws(() => parseArgs(aiArgs({ '--azure-client-id': 'my-identity' })), /--azure-client-id must be a GUID/);
  assert.throws(() => parseArgs(aiArgs({ '--azure-tenant-id': `${TENANT}0` })), /--azure-tenant-id must be a GUID/);
  assert.throws(() => parseArgs(aiArgs({ '--review-token-scope': 'https://cognitiveservices.azure.com' })), /ends in \/\.default/);
});

test('a Foundry project endpoint keeps its path and needs the ai.azure.com scope', () => {
  const project = 'https://itm8-review.services.ai.azure.com/api/projects/review';
  assert.throws(() => parseArgs(aiArgs({ '--review-endpoint': project })), /project endpoint needs --review-token-scope https:\/\/ai\.azure\.com\/\.default/);
  const ok = parseArgs(aiArgs({ '--review-endpoint': `${project}/`, '--review-token-scope': PROJECT_TOKEN_SCOPE }));
  assert.deepEqual(ok.aiReview, { ...values, endpoint: project, scope: PROJECT_TOKEN_SCOPE });
});

test('the AI review options only go with --ai-review, and the reviewer options stay consistent', () => {
  assert.throws(() => parseArgs(['--repo', 'o/r', '--team', 't', '--review-endpoint', ENDPOINT]), /only go with --ai-review/);
  assert.throws(() => parseArgs([...aiArgs(), '--team', 't', '--reviewer', 'u']), /at most one/);
  assert.throws(() => parseArgs([...aiArgs(), '--profile', 'solo']), /needs --team or --reviewer/);
});

test('the command exits non-zero with the plain reason, before any GitHub call', () => {
  const r = spawnSync(process.execPath, [script, ...aiArgs({ '--review-endpoint': '', '--azure-client-id': 'x' })], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /setup-repo: the AI review was not turned on, because:/);
  assert.match(r.stderr, /--review-endpoint is empty/);
  assert.match(r.stderr, /--azure-client-id must be a GUID/);
  assert.equal(r.stdout, '');
});

test('setAiReview turns the review on in the template and leaves every other line alone', () => {
  const out = setAiReview(template, values);
  assert.match(out, /^ {6}ai-review: true$/m);
  assert.match(out, new RegExp(`^ {6}review-endpoint: '${ENDPOINT}'$`, 'm'));
  assert.match(out, new RegExp(`^ {6}azure-client-id: '${CLIENT}'$`, 'm'));
  assert.match(out, new RegExp(`^ {6}azure-tenant-id: '${TENANT}'\\n {6}review-token-scope: '${DEFAULT_TOKEN_SCOPE}'$`, 'm'));
  assert.doesNotMatch(out, /ai-review: false|: ''$/m);
  const changed = new Set(['ai-review', 'review-endpoint', 'azure-client-id', 'azure-tenant-id', 'review-token-scope']);
  const keep = (text) => text.split('\n').filter((l) => !changed.has(l.trim().split(':')[0]));
  assert.deepEqual(keep(out), keep(template), 'only the AI review lines change');
  assert.equal(setAiReview(out, values), out, 'running it again changes nothing');
  const project = { ...values, scope: PROJECT_TOKEN_SCOPE };
  assert.match(setAiReview(out, project), /review-token-scope: 'https:\/\/ai\.azure\.com\/\.default'/, 'a later run replaces the values');
});

test('setAiReview keeps CRLF line ends and adds keys a trimmed caller lacks', () => {
  const minimal = [
    'permissions:',
    '  contents: read',
    '  id-token: write',
    'jobs:',
    '  gate:',
    '    with:',
    '      zone: green',
    '      test-command: |',
    '        npm test',
    '    uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@v0',
    '  other:',
    '    runs-on: ubuntu-latest',
    '',
  ].join('\r\n');
  const out = setAiReview(minimal, values);
  assert.ok(!/[^\r]\n/.test(out), 'CRLF kept');
  const lines = out.split('\r\n');
  assert.deepEqual(lines.slice(7, 14), [
    '      test-command: |',
    '        npm test',
    '      ai-review: true',
    `      review-endpoint: '${ENDPOINT}'`,
    `      azure-client-id: '${CLIENT}'`,
    `      azure-tenant-id: '${TENANT}'`,
    `      review-token-scope: '${DEFAULT_TOKEN_SCOPE}'`,
  ]);
  assert.equal(lines[14], '    uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@v0');
});

test('setAiReview refuses a caller it cannot change safely', () => {
  assert.throws(() => setAiReview(template.replace(/^\s*id-token: write.*$/m, ''), values), /id-token: write/);
  assert.throws(() => setAiReview(template.replace(/uses: .*$/m, 'uses: someone/else/.github/workflows/x.yml@v1'), values), /does not call the aifactory gate/);
  assert.throws(() => setAiReview(template.replace(/^ {4}with:$/m, '    with: { zone: green }'), values), /no "with:" block/);
  const twice = `${template}\n  again:\n    uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@v0\n    with:\n      zone: green\n`;
  assert.throws(() => setAiReview(twice, values), /more than once/);
});

test('aiReviewCalls: a branch, the file on it, and a pull request', () => {
  const content = setAiReview(template, values);
  const calls = aiReviewCalls({ repo: 'o/r', defaultBranch: 'main', baseSha: 'b1', branchExists: false, fileSha: 'f1', content });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['POST repos/o/r/git/refs', `PUT repos/o/r/contents/${CALLER_PATH}`, 'POST repos/o/r/pulls'],
  );
  assert.deepEqual(calls[0].body, { ref: `refs/heads/${AI_REVIEW_BRANCH}`, sha: 'b1' });
  assert.equal(Buffer.from(calls[1].body.content, 'base64').toString('utf8'), content);
  assert.equal(calls[1].body.sha, 'f1');
  assert.equal(calls[1].body.branch, AI_REVIEW_BRANCH);
  assert.deepEqual([calls[2].body.head, calls[2].body.base], [AI_REVIEW_BRANCH, 'main']);
  const again = aiReviewCalls({ repo: 'o/r', defaultBranch: 'main', baseSha: 'b2', branchExists: true, fileSha: 'f1', content });
  assert.deepEqual([again[0].method, again[0].path, again[0].body], ['PATCH', `repos/o/r/git/refs/heads/${AI_REVIEW_BRANCH}`, { sha: 'b2', force: true }]);
});

/** A stand-in for the GitHub CLI: answers reads from `reads`, records writes. */
function fakeGh(reads, failWrite) {
  const writes = [];
  const gh = (args, input) => {
    if (args[1] === '--method') {
      writes.push({ method: args[2], path: args[3], body: JSON.parse(input) });
      const problem = failWrite?.(args[2], args[3]);
      if (problem) throw Object.assign(new Error('gh failed'), { stderr: problem });
      return '{}';
    }
    if (!(args[1] in reads)) throw Object.assign(new Error('gh failed'), { stderr: 'gh: Not Found (HTTP 404)' });
    return JSON.stringify(reads[args[1]]);
  };
  return { gh, writes };
}
const callerReads = (text) => ({
  'repos/o/r': { full_name: 'o/r', default_branch: 'main' },
  [`repos/o/r/contents/${CALLER_PATH}?ref=main`]: { content: Buffer.from(text).toString('base64'), sha: 'f1' },
  'repos/o/r/git/ref/heads/main': { object: { sha: 'b1' } },
});
const capture = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
};

test('run --ai-review: the dry run only reads; --apply writes branch, file and pull request in order', () => {
  const dry = fakeGh(callerReads(template));
  const log = capture();
  run(aiArgs(), { gh: dry.gh, ...log });
  assert.equal(dry.writes.length, 0);
  assert.match(log.lines.join('\n'), /ai-review: true[\s\S]*Dry run\. Nothing was changed/);

  const live = fakeGh(callerReads(template));
  run([...aiArgs(), '--apply'], { gh: live.gh, ...capture() });
  assert.deepEqual(
    live.writes.map((w) => `${w.method} ${w.path}`),
    ['POST repos/o/r/git/refs', `PUT repos/o/r/contents/${CALLER_PATH}`, 'POST repos/o/r/pulls'],
  );
  assert.match(Buffer.from(live.writes[1].body.content, 'base64').toString('utf8'), /ai-review: true/);
});

test('run --ai-review: nothing to do when the values are already there; a clear error without a caller', () => {
  const already = fakeGh(callerReads(setAiReview(template, values)));
  const log = capture();
  run([...aiArgs(), '--apply'], { gh: already.gh, ...log });
  assert.equal(already.writes.length, 0);
  assert.match(log.lines.join('\n'), /already on[\s\S]*Nothing to change/);

  const none = fakeGh({ 'repos/o/r': { full_name: 'o/r', default_branch: 'main' } });
  assert.throws(() => run(aiArgs(), { gh: none.gh, ...capture() }), /no \.github\/workflows\/aifactory-gate\.yml on main\. Install the gate first/);
});

test('run --ai-review: a token without the workflow scope gets the fix, not the raw API error', () => {
  const noScope = fakeGh(callerReads(template), (method) =>
    method === 'PUT' ? 'refusing to allow an OAuth App to create or update workflow `.github/workflows/aifactory-gate.yml` without `workflow` scope' : null,
  );
  assert.throws(() => run([...aiArgs(), '--apply'], { gh: noScope.gh, ...capture() }), /gh auth refresh -s workflow/);
});

test('--print-oidc only reads, and prints the immutable prefix when the repository uses one', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/r', '--print-oidc']), { apply: false, repo: 'o/r', printOidc: true });
  assert.throws(() => parseArgs(['--repo', 'o/r', '--print-oidc', '--apply']), /only reads/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--print-oidc', '--team', 't']), /only reads/);
  assert.throws(() => parseArgs([...aiArgs(), '--print-oidc']), /only reads/);

  const immutable = { use_default: true, use_immutable_subject: true, sub_claim_prefix: 'repo:Org@11/Repo@22' };
  assert.equal(oidcPrefix(immutable, 'Org/Repo'), 'repo:Org@11/Repo@22');
  assert.equal(oidcPrefix({ use_default: true }, 'Org/Repo'), 'repo:Org/Repo');
  assert.equal(oidcPrefix({ use_default: true, use_immutable_subject: false, sub_claim_prefix: 'repo:Org@11/Repo@22' }, 'Org/Repo'), 'repo:Org/Repo');
  assert.throws(() => oidcPrefix({ use_default: false, include_claim_keys: ['repository_owner_id', 'context'] }, 'Org/Repo'), /custom OIDC subject template/);
  assert.throws(() => oidcPrefix({ use_immutable_subject: true }, 'Org/Repo'), /no subject prefix/);
  assert.deepEqual(oidcSubjects('repo:Org@11/Repo@22'), ['repo:Org@11/Repo@22:pull_request', 'repo:Org@11/Repo@22:ref:refs/heads/main']);

  const { gh, writes } = fakeGh({ 'repos/org/repo': { full_name: 'Org/Repo' }, 'repos/org/repo/actions/oidc/customization/sub': immutable });
  const out = [];
  const err = [];
  run(['--repo', 'org/repo', '--print-oidc'], { gh, out: (l) => out.push(l), err: (l) => err.push(l) });
  assert.deepEqual(out, ['repo:Org@11/Repo@22'], 'stdout carries the prefix alone, ready to paste');
  assert.match(err.join('\n'), /repo:Org@11\/Repo@22:pull_request\n {2}repo:Org@11\/Repo@22:ref:refs\/heads\/main/);
  assert.equal(writes.length, 0);
});
