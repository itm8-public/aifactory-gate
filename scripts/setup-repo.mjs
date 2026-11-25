// Sets up a customer repository for the gate at responsibility level 2: a ruleset on the default
// branch and the dev and prod environments, and one pull request that makes every AI coding tool
// follow the same rules (AGENTS.md and thin adapters for Claude and GitHub Copilot). With --ai-review
// it also turns the AI review on in the repository's caller workflow. Dry run by default: it prints
// every GitHub API call.
//
//   node scripts/setup-repo.mjs --repo OWNER/NAME [--team SLUG | --reviewer LOGIN] [--profile solo] [--tools claude,copilot] [--apply]
//   node scripts/setup-repo.mjs --repo OWNER/NAME --tools claude,copilot [--apply]
//   node scripts/setup-repo.mjs --repo OWNER/NAME [--team SLUG | --reviewer LOGIN] --ai-review
//        --review-endpoint URL --azure-client-id GUID --azure-tenant-id GUID [--review-token-scope SCOPE] [--apply]
//   node scripts/setup-repo.mjs --repo OWNER/NAME --print-oidc
//
// --team      the itm8 review team in the repository's organization (required reviewer on prod,
//             and the ruleset's bypass actor for needs-person verdicts)
// --reviewer  a user account as prod reviewer, for repositories owned by a person (no teams there;
//             repository admins are then the bypass actor)
// --profile   'solo' sets up a self-service customer with no second reviewer: the ruleset does not
//             require a code-owner review (there is no one to give it), so the customer merges their
//             own change once the gate check is green. Pair it with profile: solo in the caller so
//             the gate self-serves green-zone CI/infra; the gate still blocks (and only itm8 / the
//             repo admin can bypass) for secrets, the red zone, confirmed critical/high findings and
//             yellow/red-zone infra. Omit it for the standard, code-owner-reviewed setup.
// --ai-review turns the AI review on in .github/workflows/aifactory-gate.yml with the values from
//             the customer's page in the AI Factory Management App (consent is recorded there first).
//             It opens a pull request with the change, and refuses empty or malformed values, so a
//             caller never gets ai-review: true without them. The same change grants the optional
//             actions: read and pull-requests: write where the caller does not name them yet (a
//             caller without them is not refused). With --team or --reviewer the same run
//             also sets up the ruleset; without them it only opens the pull request (write access
//             is then enough).
// --review-token-scope  defaults to https://cognitiveservices.azure.com/.default (an account
//             endpoint); a Foundry project endpoint (…/api/projects/NAME) needs https://ai.azure.com/.default.
// --tools     which AI tool adapters to add next to AGENTS.md, which is always added: 'claude'
//             (.claude/settings.json with the itm8 plugin, and a CLAUDE.md that imports AGENTS.md),
//             'copilot' (.github/copilot-instructions.md), both (the default) or 'none' (AGENTS.md
//             only). Lovable and Cursor need no file. Part of every run with --team or --reviewer;
//             given alone it adds only these files. It opens one pull request on the branch
//             aifactory/ai-tools and never overwrites a file that is already there: .claude/settings.json
//             is merged, every other existing file is kept, and the output says what was kept.
// --print-oidc prints the repository's GitHub OIDC subject prefix, which the review identity's
//             federated credentials are written for. It only reads.
// Needs the GitHub CLI signed in: admin rights on the repository for the ruleset and environments;
// write access and the token's workflow scope for --ai-review; write access for --tools.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const RULESET_NAME = 'aifactory gate';
export const REQUIRED_CHECK = 'gate / verdict';
export const CALLER_PATH = '.github/workflows/aifactory-gate.yml';
export const AI_REVIEW_BRANCH = 'aifactory/ai-review';
export const DEFAULT_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';
export const PROJECT_TOKEN_SCOPE = 'https://ai.azure.com/.default';
export const TOOLS_BRANCH = 'aifactory/ai-tools';
export const TOOL_NAMES = ['claude', 'copilot'];
export const AGENTS_PATH = 'AGENTS.md';
export const CLAUDE_MD_PATH = 'CLAUDE.md';
export const CLAUDE_MD_ALT_PATH = '.claude/CLAUDE.md';
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
export const COPILOT_PATH = '.github/copilot-instructions.md';
const GITHUB_ACTIONS_APP_ID = 15368;
const REPOSITORY_ADMIN_ROLE_ID = 5;

const VALUE_OPTIONS = ['--repo', '--team', '--reviewer', '--profile', '--tools'];
const AI_OPTIONS = ['--review-endpoint', '--azure-client-id', '--azure-tenant-id', '--review-token-scope'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^https:\/\/[a-z0-9.-]+(\/[\w.-]+)*\/\.default$/i;
const PROJECT_PATH = /^\/api\/projects\/[\w.-]+\/?$/;

export function parseArgs(argv) {
  const opts = { apply: false };
  const ai = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--ai-review') opts.aiReview = true;
    else if (a === '--print-oidc') opts.printOidc = true;
    else if (VALUE_OPTIONS.includes(a) && argv[i + 1]) opts[a.slice(2)] = argv[++i];
    else if (AI_OPTIONS.includes(a)) {
      // An empty or absent value is kept as '' and refused below with the plain reason, so a command
      // generated with a blank never turns the review on half-wired.
      const next = argv[i + 1];
      ai[a.slice(2)] = next === undefined || next.startsWith('--') ? '' : argv[++i];
    } else throw new Error(`unknown or incomplete option "${a}"`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? '')) throw new Error('--repo OWNER/NAME is required');
  if (opts.printOidc) {
    if (Object.keys(opts).length > 3 || opts.apply || Object.keys(ai).length) throw new Error('--print-oidc only reads: give it with --repo and nothing else');
    return opts;
  }
  if (opts.tools !== undefined) opts.tools = parseTools(opts.tools);
  if (opts.profile && opts.profile !== 'solo') throw new Error("--profile, when given, must be 'solo'");
  if (opts.aiReview) {
    if (opts.team && opts.reviewer) throw new Error('give at most one of --team or --reviewer');
    if (opts.profile && !opts.team && !opts.reviewer) throw new Error('--profile sets up the ruleset, so it needs --team or --reviewer');
    opts.aiReview = checkAiReview(ai);
    return opts;
  }
  if (Object.keys(ai).length) throw new Error(`${Object.keys(ai).map((k) => `--${k}`).join(', ')} only go with --ai-review`);
  if (opts.team && opts.reviewer) throw new Error('give exactly one of --team or --reviewer');
  if (!opts.team && !opts.reviewer) {
    if (!opts.tools) throw new Error('give exactly one of --team or --reviewer (or --tools alone, to add only the AI tool files)');
    if (opts.profile) throw new Error('--profile sets up the ruleset, so it needs --team or --reviewer');
  }
  return opts;
}

/** `--tools claude,copilot`: the adapters to add. 'none' means AGENTS.md only. */
export function parseTools(value) {
  const names = String(value).split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => n !== 'none' && !TOOL_NAMES.includes(n));
  if (!names.length || unknown.length || (names.includes('none') && names.length > 1)) {
    throw new Error(
      `--tools takes ${TOOL_NAMES.join(', ')} (separated by commas) or none; got "${value}". Lovable and Cursor need no adapter. Nothing was changed.`,
    );
  }
  return TOOL_NAMES.filter((n) => names.includes(n));
}

/**
 * The AI review values, checked. Returns { endpoint, clientId, tenantId, scope } or throws one error
 * that lists every problem in plain words. Nothing is changed when it throws.
 */
export function checkAiReview(values) {
  const endpoint = (values['review-endpoint'] ?? '').trim();
  const clientId = (values['azure-client-id'] ?? '').trim();
  const tenantId = (values['azure-tenant-id'] ?? '').trim();
  const scopeGiven = values['review-token-scope'] !== undefined;
  const scope = scopeGiven ? values['review-token-scope'].trim() : DEFAULT_TOKEN_SCOPE;
  const problems = [];

  let origin = '';
  let projectPath = '';
  if (!endpoint) problems.push('--review-endpoint is empty');
  else {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      url = null;
    }
    const pathname = url?.pathname ?? '';
    const ok =
      url &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^[a-z0-9.-]+$/.test(url.hostname) &&
      (pathname === '/' || PROJECT_PATH.test(pathname)) &&
      !/[?#]/.test(endpoint);
    if (!ok) {
      problems.push(
        `--review-endpoint must be the review Foundry's https origin, such as https://NAME.openai.azure.com (a Foundry project endpoint may add /api/projects/NAME); got "${endpoint}"`,
      );
    } else {
      origin = url.origin;
      projectPath = pathname === '/' ? '' : pathname.replace(/\/$/, '');
    }
  }
  for (const [flag, value] of [
    ['--azure-client-id', clientId],
    ['--azure-tenant-id', tenantId],
  ]) {
    if (!value) problems.push(`${flag} is empty`);
    else if (!GUID.test(value)) problems.push(`${flag} must be a GUID such as 00000000-0000-0000-0000-000000000000; got "${value}"`);
  }
  if (!scope) problems.push('--review-token-scope is empty (leave it out for the default)');
  else if (!SCOPE.test(scope)) problems.push(`--review-token-scope must be an https scope that ends in /.default, such as ${DEFAULT_TOKEN_SCOPE}; got "${scope}"`);
  else if (projectPath && scope !== PROJECT_TOKEN_SCOPE) {
    problems.push(`a Foundry project endpoint needs --review-token-scope ${PROJECT_TOKEN_SCOPE}${scopeGiven ? `; got "${scope}"` : ''}`);
  }

  if (problems.length) {
    throw new Error(
      [
        'the AI review was not turned on, because:',
        ...problems.map((p) => `  - ${p}`),
        "Copy the values from the customer's page in the AI Factory Management App, where the customer's consent is recorded first. Nothing was changed.",
      ].join('\n'),
    );
  }
  return { endpoint: origin + projectPath, clientId: clientId.toLowerCase(), tenantId: tenantId.toLowerCase(), scope };
}

/**
 * The API calls, as data. `reviewer` is { type: 'Team' | 'User', id }.
 * `existingRulesetId` updates the ruleset of the same name instead of creating a second one.
 */
export function plan({ repo, reviewer, existingRulesetId, profile }) {
  const bypass =
    reviewer.type === 'Team'
      ? { actor_id: reviewer.id, actor_type: 'Team', bypass_mode: 'pull_request' }
      : { actor_id: REPOSITORY_ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' };
  // A solo customer has no second person to review a pull request, so the ruleset cannot require a
  // code-owner review (GitHub never lets an author approve their own PR). Merge safety for solo rests
  // on the gate check instead: with profile: solo the gate self-serves only green-zone CI/infra, while
  // secrets, the red zone, confirmed critical/high findings and yellow/red infra still make the check
  // fail, and only the bypass actor above (the itm8 team, or the repo admin) can override that.
  const requireCodeOwnerReview = profile !== 'solo';
  const ruleset = {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [bypass],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          require_code_owner_review: requireCodeOwnerReview,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: REQUIRED_CHECK, integration_id: GITHUB_ACTIONS_APP_ID }],
        },
      },
    ],
  };
  const branchPolicy = { protected_branches: false, custom_branch_policies: true };
  return [
    existingRulesetId
      ? { method: 'PUT', path: `repos/${repo}/rulesets/${existingRulesetId}`, body: ruleset, why: 'Update the gate ruleset' }
      : { method: 'POST', path: `repos/${repo}/rulesets`, body: ruleset, why: 'Create the gate ruleset' },
    { method: 'PUT', path: `repos/${repo}/environments/dev`, body: { deployment_branch_policy: branchPolicy }, why: 'Environment dev' },
    { method: 'POST', path: `repos/${repo}/environments/dev/deployment-branch-policies`, body: { name: 'main', type: 'branch' }, why: 'dev deploys from main only', tolerate: 'already exists' },
    {
      method: 'PUT',
      path: `repos/${repo}/environments/prod`,
      body: { reviewers: [reviewer], prevent_self_review: true, deployment_branch_policy: branchPolicy },
      why: 'Environment prod with the itm8 reviewer',
    },
    { method: 'POST', path: `repos/${repo}/environments/prod/deployment-branch-policies`, body: { name: 'main', type: 'branch' }, why: 'prod deploys from main only', tolerate: 'already exists' },
  ];
}

const GATE_USES = /^\s*uses:\s*['"]?[\w.-]+\/aifactory-gate\/\.github\/workflows\/gate\.yml@/;
const indent = (l) => l.match(/^ */)[0].length;
const content = (l) => l.trim() !== '' && !l.trim().startsWith('#');

/**
 * The permissions gate 0.5.0 can use besides contents: read and id-token: write, as in
 * templates/aifactory-gate.yml. Both are optional: without them the gate works as before.
 */
export const OPTIONAL_PERMISSIONS = [
  ['actions', 'read', "a push to main reuses the pull request's verdict"],
  ['pull-requests', 'write', 'the gate posts its result as one pull request comment'],
];

/** Where the gate job is: the uses: line, its indentation, and the job's lines [start, end). */
function gateJob(lines, byHand) {
  const uses = lines.flatMap((l, i) => (GATE_USES.test(l) ? [i] : []));
  if (!uses.length) throw new Error(`${CALLER_PATH} does not call the aifactory gate (no "uses: itm8-public/aifactory-gate/.github/workflows/gate.yml@…" line)`);
  if (uses.length > 1) throw new Error(`${CALLER_PATH} calls the aifactory gate more than once; ${byHand}`);
  const u = uses[0];
  const jobIndent = indent(lines[u]);
  // The gate job's keys share the uses: line's indentation; the job ends at a line indented less.
  let start = u;
  while (start > 0 && !(content(lines[start - 1]) && indent(lines[start - 1]) < jobIndent)) start--;
  let end = u + 1;
  while (end < lines.length && !(content(lines[end]) && indent(lines[end]) < jobIndent)) end++;
  return { u, jobIndent, start, end };
}

/**
 * Adds the optional permissions the caller does not name yet to the permissions block that the gate
 * job gets: the job's own, or else the workflow's. A permission it already names keeps its value, and
 * a block it cannot extend safely (write-all, read-all, {} or no block) stays as it is.
 */
function addOptionalPermissions(lines, { start, end, jobIndent }) {
  let at = -1;
  for (let i = start; i < end && at < 0; i++) if (indent(lines[i]) === jobIndent && /^\s*permissions\s*:/.test(lines[i])) at = i;
  if (at < 0) at = lines.findIndex((l) => /^permissions\s*:/.test(l));
  if (at < 0 || !/^\s*permissions\s*:\s*(#.*)?$/.test(lines[at])) return lines;
  const children = [];
  for (let i = at + 1; i < lines.length && !(content(lines[i]) && indent(lines[i]) <= indent(lines[at])); i++) if (content(lines[i])) children.push(i);
  if (!children.length) return lines;
  const pad = ' '.repeat(indent(lines[children[0]]));
  const added = OPTIONAL_PERMISSIONS.filter(([key]) => !children.some((i) => new RegExp(`^${pad}${key}\\s*:`).test(lines[i]))).map(([key, value, why]) => `${pad}${key}: ${value} # ${why}`);
  const out = lines.slice();
  out.splice(children[children.length - 1] + 1, 0, ...added);
  return out;
}

/**
 * The caller workflow with the AI review turned on: sets ai-review, review-endpoint, azure-client-id,
 * azure-tenant-id and review-token-scope in the gate job's `with:` block, replacing a value that is
 * there and adding one that is not. It also grants the OPTIONAL_PERMISSIONS the caller does not name
 * yet. Everything else in the file, comments included, stays as it was. Throws a plain-language error
 * when the file is not a caller it can safely change; a caller without the optional permissions is not
 * refused.
 */
export function setAiReview(text, { endpoint, clientId, tenantId, scope }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const byHand = 'set the AI review values by hand as in templates/aifactory-gate.yml';

  if (!lines.some((l) => /^\s*id-token:\s*write\b/.test(l) || /^\s*permissions:\s*write-all\b/.test(l))) {
    throw new Error(
      `${CALLER_PATH} does not grant "id-token: write", which the gate needs to sign in to the review Foundry. Add it under permissions: as in templates/aifactory-gate.yml, then run this again`,
    );
  }
  const { jobIndent, start, end } = gateJob(lines, byHand);
  let withAt = -1;
  for (let i = start; i < end; i++) if (indent(lines[i]) === jobIndent && /^\s*with:\s*(#.*)?$/.test(lines[i])) withAt = i;
  if (withAt < 0) throw new Error(`the gate job in ${CALLER_PATH} has no "with:" block; ${byHand}`);
  let blockEnd = withAt + 1;
  while (blockEnd < end && !(content(lines[blockEnd]) && indent(lines[blockEnd]) <= jobIndent)) blockEnd++;
  const block = [];
  for (let i = withAt + 1; i < blockEnd; i++) if (content(lines[i])) block.push(i);
  if (!block.length) throw new Error(`the gate job's "with:" block in ${CALLER_PATH} is empty; ${byHand}`);
  const childIndent = indent(lines[block[0]]);
  const pad = ' '.repeat(childIndent);

  const q = (v) => `'${v}'`;
  const values = [
    ['ai-review', 'true'],
    ['review-endpoint', q(endpoint)],
    ['azure-client-id', q(clientId)],
    ['azure-tenant-id', q(tenantId)],
    ['review-token-scope', q(scope)],
  ];
  const out = lines.slice();
  const absent = [];
  let lastAi = -1;
  for (const [key, value] of values) {
    const at = block.find((i) => indent(lines[i]) === childIndent && new RegExp(`^ *${key}\\s*:`).test(lines[i]));
    if (at === undefined) {
      absent.push(`${pad}${key}: ${value}`);
      continue;
    }
    if (/:\s*[|>]/.test(lines[at])) throw new Error(`${key} in ${CALLER_PATH} is a multi-line value; ${byHand}`);
    out[at] = `${pad}${key}: ${value}`;
    lastAi = Math.max(lastAi, at);
  }
  if (absent.length) {
    // After the last AI review key already there, or else after the last line of the block.
    const after = lastAi >= 0 ? lastAi : block[block.length - 1];
    out.splice(after + 1, 0, ...absent);
  }
  return addOptionalPermissions(out, gateJob(out, byHand)).join(eol);
}

/** The writes that turn the AI review on: a branch from the default branch, the file, a pull request. */
export function aiReviewCalls({ repo, defaultBranch, baseSha, branchExists, fileSha, content }) {
  return [
    branchExists
      ? {
          method: 'PATCH',
          path: `repos/${repo}/git/refs/heads/${AI_REVIEW_BRANCH}`,
          body: { sha: baseSha, force: true },
          why: `Reset the branch ${AI_REVIEW_BRANCH} to ${defaultBranch}`,
        }
      : { method: 'POST', path: `repos/${repo}/git/refs`, body: { ref: `refs/heads/${AI_REVIEW_BRANCH}`, sha: baseSha }, why: `Branch ${AI_REVIEW_BRANCH} from ${defaultBranch}` },
    {
      method: 'PUT',
      path: `repos/${repo}/contents/${CALLER_PATH}`,
      body: { message: 'ci: turn on the aifactory AI review', content: Buffer.from(content, 'utf8').toString('base64'), sha: fileSha, branch: AI_REVIEW_BRANCH },
      show: content,
      why: `Turn the AI review on in ${CALLER_PATH}`,
    },
    {
      method: 'POST',
      path: `repos/${repo}/pulls`,
      body: {
        title: 'Turn on the aifactory AI review',
        head: AI_REVIEW_BRANCH,
        base: defaultBranch,
        body: [
          "Turns on the AI review in the aifactory gate, with the values from the customer's page in the AI Factory Management App, where the customer's consent is recorded.",
          '',
          'The review identity lives in itm8\'s tenant: nothing changes in your Azure. Written by `setup-repo.mjs --ai-review`.',
          '',
          "Where the caller did not name them yet, it also grants `actions: read` (a push to main reuses the pull request's verdict) and `pull-requests: write` (the gate posts its result as one pull request comment). Both are optional: the gate works without them.",
        ].join('\n'),
      },
      why: 'Open the pull request',
      tolerate: 'a pull request already exists',
    },
  ];
}

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'ai-tools');
const readTemplate = (name) => readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Adds the itm8 marketplace and plugin to an existing .claude/settings.json (already parsed) and
 * changes nothing else. A key that is already there is never changed: when it holds another value it
 * is reported as kept. Returns { settings, added, kept }; throws when the file is not a shape it can
 * merge into.
 */
export function mergeClaudeSettings(current, wanted = JSON.parse(readTemplate('claude-settings.template.json'))) {
  if (!isObject(current)) throw new Error('its top level is not a JSON object');
  const settings = structuredClone(current);
  const added = [];
  const kept = [];
  for (const [section, entries] of Object.entries(wanted)) {
    if (settings[section] === undefined) settings[section] = {};
    else if (!isObject(settings[section])) throw new Error(`"${section}" in it is not a JSON object`);
    for (const [key, value] of Object.entries(entries)) {
      if (!(key in settings[section])) {
        settings[section][key] = value;
        added.push(`${section}.${key}`);
      } else if (!isDeepStrictEqual(settings[section][key], value)) {
        kept.push(`${section}.${key} is set differently there, so it was left as it is`);
      }
    }
  }
  return { settings, added, kept };
}

const importsAgents = (text) => /(^|\s)@AGENTS\.md\b/.test(text);
const mentionsAgents = (text) => /AGENTS\.md/.test(text);

/**
 * What the AI tool pull request adds, and what it keeps. `tools` is a list of 'claude' and 'copilot'
 * (AGENTS.md is always part of it). `existing` maps a path to { text, sha } for each file that is
 * already on the default branch. Nothing that exists is overwritten: .claude/settings.json is merged,
 * every other file is kept. Returns { files: [{ path, what, content, sha? }], kept: [{ path, why }] }.
 */
export function toolFilesPlan({ tools, existing }) {
  const files = [];
  const kept = [];
  const add = (p, what, content, sha) => files.push({ path: p, what, content, ...(sha ? { sha } : {}) });

  if (existing[AGENTS_PATH]) kept.push({ path: AGENTS_PATH, why: 'already there, so the shared instructions were not changed' });
  else add(AGENTS_PATH, 'the instructions every AI tool follows, in plain words', readTemplate('AGENTS.template.md'));

  if (tools.includes('claude')) {
    const settings = existing[CLAUDE_SETTINGS_PATH];
    const what = 'turns on the itm8 AI Factory plugin for Claude Code';
    if (!settings) add(CLAUDE_SETTINGS_PATH, what, readTemplate('claude-settings.template.json'));
    else {
      let merged;
      try {
        merged = mergeClaudeSettings(JSON.parse(settings.text.replace(/^﻿/, '')));
      } catch (err) {
        const reason = err instanceof SyntaxError ? 'is not valid JSON' : err.message;
        kept.push({
          path: CLAUDE_SETTINGS_PATH,
          why: `${reason}, so it was left as it is. Add the "extraKnownMarketplaces" and "enabledPlugins" entries from templates/ai-tools/claude-settings.template.json by hand`,
        });
      }
      if (merged) {
        if (merged.added.length) {
          const json = `${JSON.stringify(merged.settings, null, 2)}\n`;
          add(CLAUDE_SETTINGS_PATH, `${what} (merged into the existing file: ${merged.added.join(', ')} added, everything else unchanged)`, settings.text.includes('\r\n') ? json.replace(/\n/g, '\r\n') : json, settings.sha);
        }
        for (const why of merged.kept) kept.push({ path: CLAUDE_SETTINGS_PATH, why });
        if (!merged.added.length && !merged.kept.length) kept.push({ path: CLAUDE_SETTINGS_PATH, why: 'already has the itm8 plugin' });
      }
    }

    const claudeMdPath = [CLAUDE_MD_PATH, CLAUDE_MD_ALT_PATH].find((p) => existing[p]);
    if (!claudeMdPath) add(CLAUDE_MD_PATH, 'makes Claude Code read AGENTS.md (Claude Code does not read it by itself when a CLAUDE.md exists)', readTemplate('CLAUDE.template.md'));
    else {
      kept.push({
        path: claudeMdPath,
        why: importsAgents(existing[claudeMdPath].text)
          ? 'already there and already imports @AGENTS.md'
          : 'already there, so it was not changed. It does not import AGENTS.md: add the line "@AGENTS.md" at its top, or Claude Code will not see the shared instructions',
      });
    }
  }

  if (tools.includes('copilot')) {
    if (existing[COPILOT_PATH]) {
      kept.push({
        path: COPILOT_PATH,
        why: `already there, so it was not changed${mentionsAgents(existing[COPILOT_PATH].text) ? ' (it already points to AGENTS.md)' : '; GitHub Copilot also reads AGENTS.md by itself'}`,
      });
    } else add(COPILOT_PATH, 'points GitHub Copilot to AGENTS.md', readTemplate('copilot-instructions.template.md'));
  }
  return { files, kept };
}

/** The writes of the AI tool pull request: a branch from the default branch, each file, a pull request. */
export function toolFilesCalls({ repo, defaultBranch, baseSha, branchExists, files, kept }) {
  const list = (items) => items.map((i) => `- \`${i.path}\`: ${i.what ?? i.why}`);
  const underGithub = files.some((f) => f.path.startsWith('.github/'));
  const body = [
    'Makes every AI tool used in this repository follow the same rules, so Claude, GitHub Copilot, Lovable, Cursor and others can be used side by side. The gate does not change: it runs on GitHub, whichever tool wrote the change.',
    '',
    'Added:',
    ...list(files),
    ...(kept.length ? ['', 'Already there, kept as they are:', ...list(kept)] : []),
    ...(underGithub ? ['', 'This pull request touches `.github/`, which the gate asks a person at itm8 to look at. That is expected.'] : []),
    '',
    'Written by `setup-repo.mjs`.',
  ].join('\n');
  return [
    branchExists
      ? { method: 'PATCH', path: `repos/${repo}/git/refs/heads/${TOOLS_BRANCH}`, body: { sha: baseSha, force: true }, why: `Reset the branch ${TOOLS_BRANCH} to ${defaultBranch}` }
      : { method: 'POST', path: `repos/${repo}/git/refs`, body: { ref: `refs/heads/${TOOLS_BRANCH}`, sha: baseSha }, why: `Branch ${TOOLS_BRANCH} from ${defaultBranch}` },
    ...files.map((f) => ({
      method: 'PUT',
      path: `repos/${repo}/contents/${f.path}`,
      body: {
        message: `${f.sha ? 'chore: update' : 'docs: add'} ${f.path} for AI tools`,
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        branch: TOOLS_BRANCH,
        ...(f.sha ? { sha: f.sha } : {}),
      },
      show: f.content,
      why: `${f.sha ? 'Update' : 'Add'} ${f.path}: ${f.what}`,
    })),
    {
      method: 'POST',
      path: `repos/${repo}/pulls`,
      body: { title: 'Add the same instructions for every AI tool', head: TOOLS_BRANCH, base: defaultBranch, body },
      why: 'Open the pull request',
      tolerate: 'a pull request already exists',
    },
  ];
}

/**
 * The repository's OIDC subject prefix, from GET repos/{repo}/actions/oidc/customization/sub and the
 * repository's full name (subjects are case-sensitive, so the name comes from GitHub, not the command).
 */
export function oidcPrefix(customization, fullName) {
  if (customization.use_default === false && customization.include_claim_keys?.length) {
    throw new Error(
      `${fullName} uses a custom OIDC subject template (${customization.include_claim_keys.join(', ')}), so its subjects are not repo:…:pull_request. The review identity's federated credentials must be written for that template; ask itm8`,
    );
  }
  if (customization.use_immutable_subject) {
    if (!/^repo:\S+$/.test(customization.sub_claim_prefix ?? '')) throw new Error(`GitHub says ${fullName} uses immutable OIDC subjects but returned no subject prefix`);
    return customization.sub_claim_prefix;
  }
  return `repo:${fullName}`;
}

/** Subjects the gate's OIDC token carries: pull requests, and pushes to main. The gate job has no environment. */
export function oidcSubjects(prefix) {
  return [`${prefix}:pull_request`, `${prefix}:ref:refs/heads/main`];
}

function realGh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

const notFound = (err) => /HTTP 404|Not Found/i.test(`${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`);

/** Runs the command. `gh` and the two writers are injectable for tests. */
export function run(argv, { gh = realGh, out = console.log, err = console.error } = {}) {
  const opts = parseArgs(argv);
  const api = (p) => JSON.parse(gh(['api', p]));

  if (opts.printOidc) {
    const fullName = api(`repos/${opts.repo}`).full_name;
    const prefix = oidcPrefix(api(`repos/${opts.repo}/actions/oidc/customization/sub`), fullName);
    out(prefix);
    err(
      [
        '',
        `The OIDC subject prefix of ${fullName}. The review identity trusts these subjects`,
        '(issuer https://token.actions.githubusercontent.com, audience api://AzureADTokenExchange):',
        ...oidcSubjects(prefix).map((s) => `  ${s}`),
        "Paste the prefix into the customer's page in the AI Factory Management App.",
      ].join('\n'),
    );
    return;
  }

  const calls = [];
  if (opts.team || opts.reviewer) {
    const owner = opts.repo.split('/')[0];
    const reviewer = opts.team
      ? { type: 'Team', id: api(`orgs/${owner}/teams/${opts.team}`).id }
      : { type: 'User', id: api(`users/${opts.reviewer}`).id };
    let rulesets;
    try {
      rulesets = api(`repos/${opts.repo}/rulesets`);
    } catch (e) {
      // Found in the first live test: GitHub answers 403 on a private repository of a free account.
      if (/upgrade to github (pro|team)|make this repository public/i.test(`${e.stderr ?? ''}${e.stdout ?? ''}`)) {
        throw new Error(
          'GitHub refuses rulesets on this private repository: its plan has none. It needs GitHub Team (organization) or Pro (personal account). Nothing was changed.',
        );
      }
      throw e;
    }
    const existing = rulesets.find((r) => r.name === RULESET_NAME);
    calls.push(...plan({ repo: opts.repo, reviewer, existingRulesetId: existing?.id, profile: opts.profile }));
  }

  let repoInfo;
  const defaultBranchOf = () => (repoInfo ??= api(`repos/${opts.repo}`)).default_branch;
  const baseShaOf = (defaultBranch) => {
    try {
      return api(`repos/${opts.repo}/git/ref/heads/${defaultBranch.split('/').map(encodeURIComponent).join('/')}`).object.sha;
    } catch (e) {
      if (notFound(e)) throw new Error(`${opts.repo} has no commits on ${defaultBranch} yet. Make a first commit there, then run this again. Nothing was changed.`);
      throw e;
    }
  };
  const branchExistsOn = (branch) => {
    try {
      api(`repos/${opts.repo}/git/ref/heads/${branch}`);
      return true;
    } catch (e) {
      if (!notFound(e)) throw e;
      return false;
    }
  };

  if (opts.aiReview) {
    const defaultBranch = defaultBranchOf();
    let file;
    try {
      file = api(`repos/${opts.repo}/contents/${CALLER_PATH}?ref=${encodeURIComponent(defaultBranch)}`);
    } catch (e) {
      if (notFound(e)) {
        throw new Error(`${opts.repo} has no ${CALLER_PATH} on ${defaultBranch}. Install the gate first (README, Install), then run this again. Nothing was changed.`);
      }
      throw e;
    }
    const before = Buffer.from(file.content ?? '', 'base64').toString('utf8');
    const after = setAiReview(before, opts.aiReview);
    if (after === before) out(`\n# The AI review is already on in ${CALLER_PATH} with these values. Nothing to change there.`);
    else {
      const baseSha = baseShaOf(defaultBranch);
      const branchExists = branchExistsOn(AI_REVIEW_BRANCH);
      calls.push(...aiReviewCalls({ repo: opts.repo, defaultBranch, baseSha, branchExists, fileSha: file.sha, content: after }));
    }
  }

  // The AI tool files are part of the standard setup (a run with --team or --reviewer) and of any run
  // that names --tools. A run that only turns the AI review on does not open a second pull request.
  const tools = opts.tools ?? (opts.team || opts.reviewer ? TOOL_NAMES : undefined);
  if (tools) {
    const defaultBranch = defaultBranchOf();
    const wanted = [AGENTS_PATH, ...(tools.includes('claude') ? [CLAUDE_SETTINGS_PATH, CLAUDE_MD_PATH, CLAUDE_MD_ALT_PATH] : []), ...(tools.includes('copilot') ? [COPILOT_PATH] : [])];
    const existing = {};
    for (const p of wanted) {
      try {
        const f = api(`repos/${opts.repo}/contents/${p}?ref=${encodeURIComponent(defaultBranch)}`);
        existing[p] = { text: Array.isArray(f) ? '' : Buffer.from(f.content ?? '', 'base64').toString('utf8'), sha: Array.isArray(f) ? undefined : f.sha };
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    }
    const { files, kept } = toolFilesPlan({ tools, existing });
    out(`\n# AI tool files (${tools.length ? tools.join(' and ') : 'AGENTS.md only'}): ${files.length ? `${files.length} to add or update` : 'nothing to add'}`);
    if (kept.length) out(['Kept as they are:', ...kept.map((k) => `  - ${k.path}: ${k.why}`)].join('\n'));
    if (files.length) {
      calls.push(...toolFilesCalls({ repo: opts.repo, defaultBranch, baseSha: baseShaOf(defaultBranch), branchExists: branchExistsOn(TOOLS_BRANCH), files, kept }));
    }
  }

  if (!calls.length) {
    out('\nNothing to change.');
    return;
  }
  for (const call of calls) {
    out(`\n# ${call.why}\n${call.method} ${call.path}\n${call.show ?? JSON.stringify(call.body, null, 2)}`);
    if (!opts.apply) continue;
    try {
      gh(['api', '--method', call.method, call.path, '--input', '-'], JSON.stringify(call.body));
      out('-> done');
    } catch (e) {
      const text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      if (call.tolerate && text.toLowerCase().includes(call.tolerate)) out(`-> ${call.tolerate}`);
      else if (/without `?workflow`? scope/i.test(text)) {
        throw new Error(`GitHub refused to change ${CALLER_PATH}: the GitHub CLI token has no workflow scope. Run "gh auth refresh -s workflow", then run this again.`);
      } else throw new Error(`${call.method} ${call.path} failed: ${text.trim()}`);
    }
  }
  out(opts.apply ? '\nDone.' : '\nDry run. Nothing was changed. Run again with --apply.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`setup-repo: ${err.message}`);
    process.exitCode = 1;
  }
}
