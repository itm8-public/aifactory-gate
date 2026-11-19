// Sets up a customer repository for the gate at responsibility level 2: a ruleset on the default
// branch and the dev and prod environments. Dry run by default: it prints every GitHub API call.
//
//   node scripts/setup-repo.mjs --repo OWNER/NAME [--team SLUG | --reviewer LOGIN] [--apply]
//
// --team      the itm8 review team in the repository's organization (required reviewer on prod,
//             and the ruleset's bypass actor for needs-person verdicts)
// --reviewer  a user account as prod reviewer, for repositories owned by a person (no teams there;
//             repository admins are then the bypass actor)
// Needs the GitHub CLI signed in with admin rights on the repository.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULESET_NAME = 'aifactory gate';
export const REQUIRED_CHECK = 'gate / verdict';
const GITHUB_ACTIONS_APP_ID = 15368;
const REPOSITORY_ADMIN_ROLE_ID = 5;

export function parseArgs(argv) {
  const opts = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (['--repo', '--team', '--reviewer'].includes(a) && argv[i + 1]) opts[a.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete option "${a}"`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? '')) throw new Error('--repo OWNER/NAME is required');
  if (!opts.team === !opts.reviewer) throw new Error('give exactly one of --team or --reviewer');
  return opts;
}

/**
 * The API calls, as data. `reviewer` is { type: 'Team' | 'User', id }.
 * `existingRulesetId` updates the ruleset of the same name instead of creating a second one.
 */
export function plan({ repo, reviewer, existingRulesetId }) {
  const bypass =
    reviewer.type === 'Team'
      ? { actor_id: reviewer.id, actor_type: 'Team', bypass_mode: 'pull_request' }
      : { actor_id: REPOSITORY_ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' };
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
          require_code_owner_review: true,
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

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function main(argv) {
  const opts = parseArgs(argv);
  const owner = opts.repo.split('/')[0];
  const reviewer = opts.team
    ? { type: 'Team', id: JSON.parse(gh(['api', `orgs/${owner}/teams/${opts.team}`])).id }
    : { type: 'User', id: JSON.parse(gh(['api', `users/${opts.reviewer}`])).id };
  let rulesets;
  try {
    rulesets = JSON.parse(gh(['api', `repos/${opts.repo}/rulesets`]));
  } catch (err) {
    // Found in the first live test: GitHub answers 403 on a private repository of a free account.
    if (/upgrade to github (pro|team)|make this repository public/i.test(`${err.stderr ?? ''}${err.stdout ?? ''}`)) {
      throw new Error(
        'GitHub refuses rulesets on this private repository: its plan has none. It needs GitHub Team (organization) or Pro (personal account). Nothing was changed.',
      );
    }
    throw err;
  }
  const existing = rulesets.find((r) => r.name === RULESET_NAME);
  const calls = plan({ repo: opts.repo, reviewer, existingRulesetId: existing?.id });

  for (const call of calls) {
    console.log(`\n# ${call.why}\n${call.method} ${call.path}\n${JSON.stringify(call.body, null, 2)}`);
    if (!opts.apply) continue;
    try {
      gh(['api', '--method', call.method, call.path, '--input', '-'], JSON.stringify(call.body));
      console.log('-> done');
    } catch (err) {
      const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      if (call.tolerate && text.toLowerCase().includes(call.tolerate)) console.log(`-> ${call.tolerate}`);
      else throw new Error(`${call.method} ${call.path} failed: ${text.trim()}`);
    }
  }
  console.log(opts.apply ? '\nDone.' : '\nDry run. Nothing was changed. Run again with --apply.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`setup-repo: ${err.message}`);
    process.exitCode = 1;
  }
}
