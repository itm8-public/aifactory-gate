import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_PATH,
  AI_REVIEW_BRANCH,
  CALLER_PATH,
  CLAUDE_MD_ALT_PATH,
  CLAUDE_MD_PATH,
  CLAUDE_SETTINGS_PATH,
  COPILOT_PATH,
  DEFAULT_TOKEN_SCOPE,
  OPTIONAL_PERMISSIONS,
  PROJECT_TOKEN_SCOPE,
  REQUIRED_CHECK,
  TOOLS_BRANCH,
  TOOL_NAMES,
  aiReviewCalls,
  checkAiReview,
  mergeClaudeSettings,
  oidcPrefix,
  oidcSubjects,
  parseArgs,
  parseTools,
  plan,
  run,
  setAiReview,
  toolFilesCalls,
  toolFilesPlan,
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
  assert.deepEqual(lines.slice(0, 5), [
    'permissions:',
    '  contents: read',
    '  id-token: write',
    "  actions: read # a push to main reuses the pull request's verdict",
    '  pull-requests: write # the gate posts its result as one pull request comment',
  ]);
  assert.deepEqual(lines.slice(9, 16), [
    '      test-command: |',
    '        npm test',
    '      ai-review: true',
    `      review-endpoint: '${ENDPOINT}'`,
    `      azure-client-id: '${CLIENT}'`,
    `      azure-tenant-id: '${TENANT}'`,
    `      review-token-scope: '${DEFAULT_TOKEN_SCOPE}'`,
  ]);
  assert.equal(lines[16], '    uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@v0');
});

/** The template without the two optional permission lines: a caller written before gate 0.5.0. */
const withoutOptional = (text) => text.replace(/^ *(actions|pull-requests):.*\r?\n/gm, '');

test('setAiReview grants the optional permissions a caller lacks, exactly as the template has them', () => {
  const older = withoutOptional(template);
  assert.notEqual(older, template);
  assert.doesNotThrow(() => setAiReview(older, values), 'a caller without them is not refused');
  assert.equal(setAiReview(older, values), setAiReview(template, values));
  assert.equal(setAiReview(setAiReview(older, values), values), setAiReview(template, values), 'running it again changes nothing');
});

test('setAiReview keeps a permission the caller already names, and a block it cannot extend', () => {
  const chosen = template.replace(/^ {2}pull-requests:.*$/m, '  pull-requests: read').replace(/^ {2}actions:.*$/m, '  actions: none # no reuse here');
  const out = setAiReview(chosen, values);
  assert.match(out, /^ {2}pull-requests: read$/m);
  assert.match(out, /^ {2}actions: none # no reuse here$/m);
  assert.equal(out.match(/^ *(actions|pull-requests):/gm).length, 2, 'nothing added next to them');

  const writeAll = withoutOptional(template).replace(/^permissions:\n(?: {2}.*\n)+/m, 'permissions: write-all\n');
  assert.match(writeAll, /^permissions: write-all$/m);
  assert.doesNotMatch(setAiReview(writeAll, values), /^ *(actions|pull-requests):/m, 'write-all already grants them');
});

test("setAiReview adds the optional permissions to the gate job's own permissions block when it has one", () => {
  const jobLevel = [
    'permissions:',
    '  contents: read',
    'jobs:',
    '  gate:',
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@v0',
    '    with:',
    '      zone: green',
    '',
  ].join('\n');
  const lines = setAiReview(jobLevel, values).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['permissions:', '  contents: read'], 'the workflow block is not the one the gate job gets');
  assert.deepEqual(lines.slice(4, 9), [
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    "      actions: read # a push to main reuses the pull request's verdict",
    '      pull-requests: write # the gate posts its result as one pull request comment',
  ]);
  assert.equal(lines[9], '    uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@v0');
});

test('the template, setup-repo and the README grant the same caller permissions', () => {
  const grants = (block) => Object.fromEntries([...block.matchAll(/^ {2}([\w-]+):\s*([\w-]+)/gm)].map((m) => [m[1], m[2]]));
  const inTemplate = grants(template.match(/^permissions:\n((?: {2}.*\n)+)/m)[1]);
  assert.deepEqual(inTemplate, { contents: 'read', 'id-token': 'write', actions: 'read', 'pull-requests': 'write' });
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### Caller permissions'));
  assert.deepEqual(grants(section.match(/```yaml\npermissions:\n((?: {2}.*\n)+)```/)[1]), inTemplate);
  for (const [key, value, why] of OPTIONAL_PERMISSIONS) assert.match(template, new RegExp(`^ {2}${key}: ${value} # ${why}$`, 'm'));
  assert.doesNotMatch(
    readFileSync(path.join(root, '.github/workflows/gate.yml'), 'utf8'),
    /^ *(actions|pull-requests): /m,
    'gate.yml must not ask for them: GitHub refuses a called workflow that asks for more than its caller grants',
  );
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

  // The review is on, but the caller predates the optional permissions: the pull request adds them.
  const older = fakeGh(callerReads(withoutOptional(setAiReview(template, values))));
  run([...aiArgs(), '--apply'], { gh: older.gh, ...capture() });
  assert.equal(Buffer.from(older.writes[1].body.content, 'base64').toString('utf8'), setAiReview(template, values));
  assert.match(older.writes[2].body.body, /`actions: read`[\s\S]*`pull-requests: write`[\s\S]*optional/);

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

// Any AI tool, the same rules: AGENTS.md plus thin adapters, in one pull request, never overwriting.
const toolTemplate = (name) => readFileSync(path.join(root, 'templates/ai-tools', name), 'utf8');
const AGENTS = toolTemplate('AGENTS.template.md');
const SETTINGS = JSON.parse(toolTemplate('claude-settings.template.json'));

test('--tools chooses the adapters: both by default, one, or none', () => {
  assert.deepEqual(parseTools('claude,copilot'), ['claude', 'copilot']);
  assert.deepEqual(parseTools(' Copilot , CLAUDE '), ['claude', 'copilot'], 'case, spaces and order do not matter');
  assert.deepEqual(parseTools('copilot'), ['copilot']);
  assert.deepEqual(parseTools('none'), [], 'AGENTS.md only');
  for (const bad of ['', ',', 'cursor', 'claude,gemini', 'none,claude']) assert.throws(() => parseTools(bad), /--tools takes claude, copilot[\s\S]*Nothing was changed/, bad);
  assert.equal(parseArgs(['--repo', 'o/r', '--reviewer', 'u']).tools, undefined, 'left unset, so the run defaults to both');
  assert.deepEqual(parseArgs(['--repo', 'o/r', '--reviewer', 'u', '--tools', 'copilot']).tools, ['copilot']);
  assert.deepEqual(TOOL_NAMES, ['claude', 'copilot']);
});

test('--tools alone adds only the AI tool files; it never stands in for the ruleset options', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/r', '--tools', 'claude,copilot']), { apply: false, repo: 'o/r', tools: ['claude', 'copilot'] });
  assert.throws(() => parseArgs(['--repo', 'o/r']), /exactly one of --team or --reviewer \(or --tools alone/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--tools', 'claude', '--profile', 'solo']), /needs --team or --reviewer/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--team', 't', '--reviewer', 'u', '--tools', 'claude']), /exactly one/);
  assert.throws(() => parseArgs(['--repo', 'o/r', '--print-oidc', '--tools', 'claude']), /only reads/);
  assert.equal(parseArgs([...aiArgs(), '--tools', 'claude']).tools[0], 'claude', 'with --ai-review it asks for the files too');
});

test('AGENTS.md carries the change flow and the rules, in order, in plain words', () => {
  const flow = AGENTS.slice(AGENTS.indexOf('## How a change gets in'), AGENTS.indexOf('## Rules that never change'));
  const at = (word) => flow.indexOf(word);
  assert.ok(at('branch') >= 0 && at('branch') < at('pull request') && at('pull request') < at('gate / verdict') && at('gate / verdict') < at('merge') && at('merge') < at('`dev`'), 'branch, pull request, gate / verdict, merge, dev');
  assert.match(AGENTS, /Never push to `main`/);
  assert.match(AGENTS, /Work through pull requests only/);
  assert.match(AGENTS, /Never put secrets in code/);
  assert.match(AGENTS, /`needs-person` means a person at itm8 has to look at the change/);
  assert.match(AGENTS, /itm8 decides both and sets them in `\.github\/workflows\/aifactory-gate\.yml`/);
  assert.match(AGENTS, /never ask the person which zone or level/);
  assert.match(AGENTS, /`\/aifactory-code:submit`[\s\S]*Otherwise open a normal pull request/);
});

test('no template says how the AI review works or speaks to a reviewer', () => {
  // A change that describes the review, or addresses a reviewer, is itself flagged by the gate's steering check.
  for (const name of ['AGENTS.template.md', 'CLAUDE.template.md', 'copilot-instructions.template.md', 'claude-settings.template.json']) {
    assert.doesNotMatch(toolTemplate(name), /review|steer|verdict decides|ignore (all|previous)|approve (this|it)/i, name);
  }
});

test('the adapters point to AGENTS.md and turn on the itm8 plugin', () => {
  assert.match(toolTemplate('CLAUDE.template.md'), /^@AGENTS\.md$/m, 'Claude Code reads AGENTS.md only through this import');
  assert.match(toolTemplate('copilot-instructions.template.md'), /\]\(\.\.\/AGENTS\.md\)/, 'the link works from .github/');
  assert.ok(toolTemplate('copilot-instructions.template.md').length < 700, 'a short pointer, not a second rulebook');
  assert.deepEqual(SETTINGS, {
    extraKnownMarketplaces: { 'itm8-aifactory-code': { source: { source: 'github', repo: 'itm8-public/aifactory-code' } } },
    enabledPlugins: { 'aifactory-code@itm8-aifactory-code': true },
  });
});

test('mergeClaudeSettings adds the plugin and changes nothing else', () => {
  const mine = { model: 'opus', permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'other@market': true }, extraKnownMarketplaces: { mine: { source: { source: 'github', repo: 'me/m' } } } };
  const { settings, added, kept } = mergeClaudeSettings(mine);
  assert.deepEqual(added, ['extraKnownMarketplaces.itm8-aifactory-code', 'enabledPlugins.aifactory-code@itm8-aifactory-code']);
  assert.deepEqual(kept, []);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, mine.permissions);
  assert.equal(settings.enabledPlugins['other@market'], true);
  assert.ok(settings.extraKnownMarketplaces.mine);
  assert.deepEqual(mine.enabledPlugins, { 'other@market': true }, 'the input is not mutated');
  assert.deepEqual(mergeClaudeSettings({}).settings, SETTINGS);
  const again = mergeClaudeSettings(settings);
  assert.deepEqual([again.added, again.kept], [[], []], 'running it again changes nothing');
});

test('mergeClaudeSettings never overrides a choice that is already made', () => {
  const off = { enabledPlugins: { 'aifactory-code@itm8-aifactory-code': false } };
  const { settings, added, kept } = mergeClaudeSettings(off);
  assert.equal(settings.enabledPlugins['aifactory-code@itm8-aifactory-code'], false, 'a plugin switched off stays off');
  assert.deepEqual(added, ['extraKnownMarketplaces.itm8-aifactory-code']);
  assert.match(kept[0], /enabledPlugins\.aifactory-code@itm8-aifactory-code is set differently/);
  assert.throws(() => mergeClaudeSettings([]), /not a JSON object/);
  assert.throws(() => mergeClaudeSettings({ enabledPlugins: ['x'] }), /"enabledPlugins" in it is not a JSON object/);
});

const found = (map) => Object.fromEntries(Object.entries(map).map(([p, text]) => [p, { text, sha: `sha-${p}` }]));

test('toolFilesPlan: a bare repository gets AGENTS.md and both adapters', () => {
  const { files, kept } = toolFilesPlan({ tools: ['claude', 'copilot'], existing: {} });
  assert.deepEqual(files.map((f) => f.path), [AGENTS_PATH, CLAUDE_SETTINGS_PATH, CLAUDE_MD_PATH, COPILOT_PATH]);
  assert.deepEqual(kept, []);
  assert.equal(files[0].content, AGENTS);
  assert.deepEqual(JSON.parse(files[1].content), SETTINGS);
  assert.ok(files.every((f) => !f.sha), 'all new files');
});

test('toolFilesPlan: --tools picks the adapters; AGENTS.md is always there', () => {
  const paths = (tools) => toolFilesPlan({ tools, existing: {} }).files.map((f) => f.path);
  assert.deepEqual(paths(['claude']), [AGENTS_PATH, CLAUDE_SETTINGS_PATH, CLAUDE_MD_PATH]);
  assert.deepEqual(paths(['copilot']), [AGENTS_PATH, COPILOT_PATH]);
  assert.deepEqual(paths([]), [AGENTS_PATH]);
});

test('toolFilesPlan: an existing file is kept and the output says why', () => {
  const existing = found({
    [AGENTS_PATH]: '# Our own rules\n',
    [CLAUDE_MD_PATH]: '# Claude notes\nUse tabs.\n',
    [COPILOT_PATH]: 'Be brief.\n',
  });
  const { files, kept } = toolFilesPlan({ tools: ['claude', 'copilot'], existing });
  assert.deepEqual(files.map((f) => f.path), [CLAUDE_SETTINGS_PATH], 'only the missing settings file is added');
  assert.deepEqual(kept.map((k) => k.path), [AGENTS_PATH, CLAUDE_MD_PATH, COPILOT_PATH]);
  assert.match(kept[1].why, /does not import AGENTS\.md: add the line "@AGENTS\.md"/, 'a CLAUDE.md without the import is called out, not edited');
  assert.match(kept[2].why, /GitHub Copilot also reads AGENTS\.md by itself/);
});

test('toolFilesPlan: a CLAUDE.md that already imports AGENTS.md, or sits in .claude/, stops a new one', () => {
  const ok = toolFilesPlan({ tools: ['claude'], existing: found({ [CLAUDE_MD_PATH]: 'Rules:\n@AGENTS.md\n' }) });
  assert.ok(!ok.files.some((f) => f.path === CLAUDE_MD_PATH));
  assert.match(ok.kept.find((k) => k.path === CLAUDE_MD_PATH).why, /already imports @AGENTS\.md/);
  const alt = toolFilesPlan({ tools: ['claude'], existing: found({ [CLAUDE_MD_ALT_PATH]: 'notes' }) });
  assert.ok(!alt.files.some((f) => f.path === CLAUDE_MD_PATH), 'Claude Code reads .claude/CLAUDE.md too');
  assert.equal(alt.kept.find((k) => k.path === CLAUDE_MD_ALT_PATH).path, CLAUDE_MD_ALT_PATH);
  const copilot = toolFilesPlan({ tools: ['copilot'], existing: found({ [COPILOT_PATH]: 'See AGENTS.md\n' }) });
  assert.match(copilot.kept.find((k) => k.path === COPILOT_PATH).why, /already points to AGENTS\.md/);
});

test('toolFilesPlan: an existing .claude/settings.json is merged with its sha, keeping every other setting', () => {
  const mine = `${JSON.stringify({ model: 'opus', permissions: { deny: ['Bash(rm *)'] } }, null, 4)}\n`;
  const { files, kept } = toolFilesPlan({ tools: ['claude'], existing: found({ [CLAUDE_SETTINGS_PATH]: mine }) });
  const settings = files.find((f) => f.path === CLAUDE_SETTINGS_PATH);
  assert.equal(settings.sha, `sha-${CLAUDE_SETTINGS_PATH}`, 'an update of the existing file, not a create');
  const merged = JSON.parse(settings.content);
  assert.equal(merged.model, 'opus');
  assert.deepEqual(merged.permissions, { deny: ['Bash(rm *)'] });
  assert.equal(merged.enabledPlugins['aifactory-code@itm8-aifactory-code'], true);
  assert.match(settings.what, /merged into the existing file/);
  assert.deepEqual(kept, []);
  // CRLF files stay CRLF, and a BOM does not stop the merge.
  const crlf = toolFilesPlan({ tools: ['claude'], existing: found({ [CLAUDE_SETTINGS_PATH]: `﻿${mine.replace(/\n/g, '\r\n')}` }) });
  const c = crlf.files.find((f) => f.path === CLAUDE_SETTINGS_PATH).content;
  assert.ok(c.includes('\r\n') && !/[^\r]\n/.test(c));
});

test('toolFilesPlan: settings that cannot be merged safely are kept, with what to do by hand', () => {
  for (const text of ['{ "model": // my note\n "opus" }', '[]', '{"enabledPlugins": "none"}']) {
    const { files, kept } = toolFilesPlan({ tools: ['claude'], existing: found({ [CLAUDE_SETTINGS_PATH]: text }) });
    assert.ok(!files.some((f) => f.path === CLAUDE_SETTINGS_PATH), text);
    assert.match(kept.find((k) => k.path === CLAUDE_SETTINGS_PATH).why, /left as it is\. Add the "extraKnownMarketplaces" and "enabledPlugins" entries/, text);
  }
  const done = toolFilesPlan({ tools: ['claude'], existing: found({ [CLAUDE_SETTINGS_PATH]: JSON.stringify(SETTINGS) }) });
  assert.ok(!done.files.some((f) => f.path === CLAUDE_SETTINGS_PATH));
  assert.match(done.kept.find((k) => k.path === CLAUDE_SETTINGS_PATH).why, /already has the itm8 plugin/);
});

test('toolFilesCalls: a branch, each file on it, and one pull request that lists what was added and kept', () => {
  const { files, kept } = toolFilesPlan({ tools: ['claude', 'copilot'], existing: found({ [CLAUDE_MD_PATH]: 'mine' }) });
  const calls = toolFilesCalls({ repo: 'o/r', defaultBranch: 'main', baseSha: 'b1', branchExists: false, files, kept });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST repos/o/r/git/refs',
    `PUT repos/o/r/contents/${AGENTS_PATH}`,
    `PUT repos/o/r/contents/${CLAUDE_SETTINGS_PATH}`,
    `PUT repos/o/r/contents/${COPILOT_PATH}`,
    'POST repos/o/r/pulls',
  ]);
  assert.deepEqual(calls[0].body, { ref: `refs/heads/${TOOLS_BRANCH}`, sha: 'b1' });
  assert.equal(Buffer.from(calls[1].body.content, 'base64').toString('utf8'), AGENTS);
  assert.ok(calls.slice(1, 4).every((c) => c.body.branch === TOOLS_BRANCH && !('sha' in c.body)));
  const pr = calls[4].body;
  assert.deepEqual([pr.head, pr.base], [TOOLS_BRANCH, 'main']);
  assert.match(pr.body, /Added:\n- `AGENTS\.md`[\s\S]*- `\.github\/copilot-instructions\.md`/);
  assert.match(pr.body, /Already there, kept as they are:\n- `CLAUDE\.md`/);
  assert.match(pr.body, /touches `\.github\/`, which the gate asks a person at itm8 to look at/);
  assert.doesNotMatch(pr.body, /review/i);
  const again = toolFilesCalls({ repo: 'o/r', defaultBranch: 'main', baseSha: 'b2', branchExists: true, files, kept });
  assert.deepEqual([again[0].method, again[0].path, again[0].body], ['PATCH', `repos/o/r/git/refs/heads/${TOOLS_BRANCH}`, { sha: 'b2', force: true }]);
  const noGithub = toolFilesCalls({ repo: 'o/r', defaultBranch: 'main', baseSha: 'b1', branchExists: false, files: files.filter((f) => !f.path.startsWith('.github/')), kept: [] });
  assert.doesNotMatch(noGithub.at(-1).body.body, /touches `\.github\/`/, 'the heads-up only when .github/ is in the change');
});

const toolReads = (present = {}) => ({
  'repos/o/r': { full_name: 'o/r', default_branch: 'main' },
  'repos/o/r/git/ref/heads/main': { object: { sha: 'b1' } },
  ...Object.fromEntries(Object.entries(present).map(([p, text]) => [`repos/o/r/contents/${p}?ref=main`, { content: Buffer.from(text).toString('base64'), sha: `s-${p}` }])),
});
const writePaths = (gh) => gh.writes.map((w) => `${w.method} ${w.path}`);

test('run --tools: the dry run only reads; --apply opens one pull request with the files', () => {
  const dry = fakeGh(toolReads());
  const log = capture();
  run(['--repo', 'o/r', '--tools', 'claude,copilot'], { gh: dry.gh, ...log });
  assert.equal(dry.writes.length, 0);
  const text = log.lines.join('\n');
  assert.match(text, /# AI tool files \(claude and copilot\): 4 to add or update/);
  assert.match(text, /# How to work in this repository/, 'the dry run shows the file');
  assert.match(text, /Dry run\. Nothing was changed/);

  const live = fakeGh(toolReads());
  run(['--repo', 'o/r', '--tools', 'claude,copilot', '--apply'], { gh: live.gh, ...capture() });
  assert.deepEqual(writePaths(live), [
    'POST repos/o/r/git/refs',
    `PUT repos/o/r/contents/${AGENTS_PATH}`,
    `PUT repos/o/r/contents/${CLAUDE_SETTINGS_PATH}`,
    `PUT repos/o/r/contents/${CLAUDE_MD_PATH}`,
    `PUT repos/o/r/contents/${COPILOT_PATH}`,
    'POST repos/o/r/pulls',
  ]);
  assert.equal(live.writes[0].body.ref, `refs/heads/${TOOLS_BRANCH}`);
});

test('run --tools: existing files are never overwritten and the output lists what was kept', () => {
  const gh = fakeGh(toolReads({ [AGENTS_PATH]: 'ours', [CLAUDE_MD_PATH]: 'ours', [COPILOT_PATH]: 'ours', [CLAUDE_SETTINGS_PATH]: '{"model":"opus"}' }));
  const log = capture();
  run(['--repo', 'o/r', '--tools', 'claude,copilot', '--apply'], { gh: gh.gh, ...log });
  assert.deepEqual(writePaths(gh), ['POST repos/o/r/git/refs', `PUT repos/o/r/contents/${CLAUDE_SETTINGS_PATH}`, 'POST repos/o/r/pulls']);
  const settings = gh.writes[1].body;
  assert.equal(settings.sha, `s-${CLAUDE_SETTINGS_PATH}`);
  const merged = JSON.parse(Buffer.from(settings.content, 'base64').toString('utf8'));
  assert.equal(merged.model, 'opus');
  assert.equal(merged.enabledPlugins['aifactory-code@itm8-aifactory-code'], true);
  const text = log.lines.join('\n');
  assert.match(text, /Kept as they are:\n {2}- AGENTS\.md: already there/);
  assert.match(text, /- CLAUDE\.md: already there, so it was not changed\. It does not import AGENTS\.md/);
  assert.match(text, /- \.github\/copilot-instructions\.md: already there/);
});

test('run --tools: with every file in place there is nothing to change and nothing is written', () => {
  const present = { [AGENTS_PATH]: 'a', [CLAUDE_MD_PATH]: '@AGENTS.md', [COPILOT_PATH]: 'c', [CLAUDE_SETTINGS_PATH]: JSON.stringify(SETTINGS) };
  const gh = fakeGh(toolReads(present));
  const log = capture();
  run(['--repo', 'o/r', '--tools', 'claude,copilot', '--apply'], { gh: gh.gh, ...log });
  assert.equal(gh.writes.length, 0);
  assert.match(log.lines.join('\n'), /nothing to add[\s\S]*Kept as they are[\s\S]*Nothing to change\./);
});

test('run --tools: a branch left by an earlier run is reset; none and one adapter shrink the pull request', () => {
  const reads = { ...toolReads(), [`repos/o/r/git/ref/heads/${TOOLS_BRANCH}`]: { object: { sha: 'old' } } };
  const again = fakeGh(reads);
  run(['--repo', 'o/r', '--tools', 'none', '--apply'], { gh: again.gh, ...capture() });
  assert.deepEqual(writePaths(again), [`PATCH repos/o/r/git/refs/heads/${TOOLS_BRANCH}`, `PUT repos/o/r/contents/${AGENTS_PATH}`, 'POST repos/o/r/pulls']);
  const copilotOnly = fakeGh(toolReads());
  run(['--repo', 'o/r', '--tools', 'copilot', '--apply'], { gh: copilotOnly.gh, ...capture() });
  assert.deepEqual(writePaths(copilotOnly).slice(1, -1), [`PUT repos/o/r/contents/${AGENTS_PATH}`, `PUT repos/o/r/contents/${COPILOT_PATH}`]);
});

test('run: the standard setup (--team) adds the AI tool pull request after the ruleset, both adapters by default', () => {
  const gh = fakeGh({ ...toolReads(), 'orgs/o/teams/t': { id: 5 }, 'repos/o/r/rulesets': [] });
  run(['--repo', 'o/r', '--team', 't', '--apply'], { gh: gh.gh, ...capture() });
  const paths = writePaths(gh);
  assert.equal(paths[0], 'POST repos/o/r/rulesets');
  assert.deepEqual(paths.slice(-6), [
    'POST repos/o/r/git/refs',
    `PUT repos/o/r/contents/${AGENTS_PATH}`,
    `PUT repos/o/r/contents/${CLAUDE_SETTINGS_PATH}`,
    `PUT repos/o/r/contents/${CLAUDE_MD_PATH}`,
    `PUT repos/o/r/contents/${COPILOT_PATH}`,
    'POST repos/o/r/pulls',
  ]);
  const narrowed = fakeGh({ ...toolReads(), 'orgs/o/teams/t': { id: 5 }, 'repos/o/r/rulesets': [] });
  run(['--repo', 'o/r', '--team', 't', '--tools', 'claude', '--apply'], { gh: narrowed.gh, ...capture() });
  assert.ok(!writePaths(narrowed).some((p) => p.endsWith(COPILOT_PATH)));
});

test('run --ai-review alone does not open the AI tool pull request unless --tools is given', () => {
  const alone = fakeGh(callerReads(template));
  run([...aiArgs(), '--apply'], { gh: alone.gh, ...capture() });
  assert.ok(!writePaths(alone).some((p) => p.includes('AGENTS.md')));
  assert.equal(alone.writes.filter((w) => w.path === 'repos/o/r/pulls').length, 1);
  const both = fakeGh(callerReads(template));
  run([...aiArgs(), '--tools', 'copilot', '--apply'], { gh: both.gh, ...capture() });
  assert.deepEqual(both.writes.filter((w) => w.path === 'repos/o/r/pulls').map((w) => w.body.head), [AI_REVIEW_BRANCH, TOOLS_BRANCH]);
});

test('run --tools: an empty repository gets the reason, not a raw API error', () => {
  const gh = fakeGh({ 'repos/o/r': { full_name: 'o/r', default_branch: 'main' } });
  assert.throws(() => run(['--repo', 'o/r', '--tools', 'none'], { gh: gh.gh, ...capture() }), /has no commits on main yet[\s\S]*Nothing was changed/);
});

test('the command refuses a bad --tools value before any GitHub call', () => {
  const r = spawnSync(process.execPath, [script, '--repo', 'o/r', '--tools', 'cursor'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /setup-repo: --tools takes claude, copilot/);
  assert.equal(r.stdout, '');
});
