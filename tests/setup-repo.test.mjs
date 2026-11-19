import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUIRED_CHECK, parseArgs, plan } from '../scripts/setup-repo.mjs';

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
