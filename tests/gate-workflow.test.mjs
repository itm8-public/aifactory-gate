// gate.yml's shape, read as text (this repository has no YAML dependency): which job runs repository
// code, what it may do, and what reaches the engine from it. The Test outcome step's script is run
// under bash for every way the tests job can end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const gate = readFileSync(new URL('../.github/workflows/gate.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The jobs of gate.yml, name to the lines of its block, full-line comments left out. */
function jobsOf(text) {
  const lines = text.split('\n');
  const jobs = {};
  let name;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (m) jobs[(name = m[1])] = [];
    else if (/^\S/.test(line)) break;
    else if (name) jobs[name].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

/** The steps of a job, as the text of each `- ` item. */
function stepsOf(job) {
  return job.split(/\n(?= {6}- )/).filter((s) => s.startsWith('      - '));
}

const stepNamed = (job, name) => stepsOf(job).find((s) => s.split('\n')[0].trim() === `- name: ${name}`);

/** The `permissions:` block of a job as { scope: access }. */
function permissionsOf(job) {
  const lines = job.split('\n');
  const at = lines.indexOf('    permissions:');
  if (at < 0) return null;
  const out = {};
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^ {6}([a-z-]+): ([a-z]+)/);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
}

/** The script of a step's `run: |` block, dedented. */
function scriptOf(step) {
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.ok(at > 0, 'the step has a run: | block');
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const jobs = jobsOf(gate);

test('the gate has four jobs, and only "verdict" can be the required check', () => {
  assert.deepEqual(Object.keys(jobs), ['reuse', 'tests', 'verdict', 'comment']);
  for (const [id, job] of Object.entries(jobs)) {
    const name = job.match(/^ {4}name: (.+)$/m)?.[1];
    assert.equal(name, id, `job ${id} is named ${id}`);
  }
  // The engine's reuse takes the run's verdict job by name: no other job may look like it.
  assert.equal(Object.keys(jobs).filter((id) => id === 'verdict' || id.endsWith(' / verdict')).length, 1);
});

test('only the tests job runs repository code, with contents: read and nothing else', () => {
  const t = jobs.tests;
  assert.deepEqual(permissionsOf(t), { contents: 'read' }, 'no OIDC token, no write access');
  assert.match(t, /^ {4}needs: reuse$/m);
  assert.match(t, /^ {4}if: \$\{\{ !cancelled\(\) && inputs\.test-command != '' && needs\.reuse\.outputs\.reused != 'true' \}\}$/m);
  assert.match(t, /^ {4}timeout-minutes: 30$/m);
  assert.match(t, /^ {6}outcome: \$\{\{ steps\.tests\.outcome \}\}$/m);
  const tests = stepNamed(t, 'Tests');
  assert.ok(tests, 'a Tests step');
  assert.match(tests, /working-directory: \$\{\{ inputs\.working-directory \}\}/);
  assert.match(tests, /TEST_COMMAND: \$\{\{ inputs\.test-command \}\}/);
  assert.match(tests, /run: bash -eo pipefail -c "\$TEST_COMMAND"/);
  assert.doesNotMatch(tests, /continue-on-error/, 'the job fails when the tests fail, so "gate / tests" shows it');
  assert.match(t, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(t, /persist-credentials: false/);
  for (const [id, job] of Object.entries(jobs)) {
    if (id === 'tests') continue;
    assert.doesNotMatch(job, /TEST_COMMAND|inputs\.test-command \}\}|setup-node|inputs\.working-directory/, `job ${id} does not run the tests or set them up`);
  }
});

test('the verdict job waits for the tests, cannot be skipped, and reads them only through Test outcome', () => {
  const v = jobs.verdict;
  assert.match(v, /^ {4}needs: \[reuse, tests\]$/m);
  // A required check whose job is skipped counts as passed: this job must run even in a cancelled run.
  assert.match(v, /^ {4}if: \$\{\{ always\(\) \}\}$/m);
  assert.deepEqual(permissionsOf(v), { contents: 'read', 'id-token': 'write' });
  assert.doesNotMatch(v, /actions\/cache|download-artifact|cache:/, 'nothing another job of the run wrote is read');
  const outcome = stepNamed(v, 'Test outcome');
  assert.ok(outcome, 'a Test outcome step');
  const rest = stepsOf(v).filter((s) => s !== outcome).join('\n');
  assert.doesNotMatch(rest, /needs\.tests\./, 'only Test outcome reads the tests job');
  assert.match(stepNamed(v, 'Scan and decide'), /TESTS: \$\{\{ steps\.tests\.outputs\.outcome \}\}/);
  assert.match(stepNamed(v, 'Enforce'), /if: \$\{\{ always\(\) \}\}/);
  assert.match(stepNamed(v, "Reuse the pull request's verdict"), /if: \$\{\{ needs\.reuse\.outputs\.reused == 'true' \}\}/);
});

test('the reuse job checks the candidate itself, so a reused push skips the tests', () => {
  const r = jobs.reuse;
  assert.equal(permissionsOf(r), null, 'it uses what the caller grants');
  assert.match(r, /^ {6}reused: \$\{\{ steps\.check\.outputs\.reused \}\}$/m);
  const check = stepNamed(r, 'Check it against this commit');
  assert.ok(check);
  assert.match(check, /"\$GATE_IMAGE" reuse --repo \/repo/);
  assert.match(scriptOf(check), /0\|1\) echo "reused=true"/);
});

// The Test outcome step's own script, run under bash with the values GitHub would give it.
function bash() {
  const r = spawnSync('bash', ['-c', 'printf %s "$PROBE"'], { encoding: 'utf8', env: { ...process.env, PROBE: 'ok' } });
  return r.stdout === 'ok';
}

test('Test outcome: one of five words, whatever the tests job wrote', { skip: !bash() && 'no bash that passes the environment through' }, () => {
  const script = scriptOf(stepNamed(jobs.verdict, 'Test outcome'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-outcome-'));
  try {
    const run = (configured, job, outcome) => {
      const file = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
      const r = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8',
        env: { ...process.env, CONFIGURED: configured, JOB: job, OUTCOME: outcome, GITHUB_OUTPUT: file },
      });
      assert.equal(r.status, 0, r.stderr);
      return { word: readFileSync(file, 'utf8'), stdout: r.stdout };
    };
    const cases = [
      // [test-command set, needs.tests.result, needs.tests.outputs.outcome, what the engine gets]
      ['false', 'skipped', '', 'not-configured'],
      ['false', '', '', 'not-configured'],
      ['true', 'success', 'success', 'success'],
      ['true', 'failure', 'failure', 'failure'],
      ['true', 'success', 'failure', 'failure'], // failing is never a way round the gate
      ['true', 'failure', 'success', 'skipped'], // a pass from a job that failed is not believed
      ['true', 'failure', 'skipped', 'skipped'], // checkout or setup-node failed: the tests did not run
      ['true', 'cancelled', '', 'cancelled'],
      ['true', 'failure', 'cancelled', 'cancelled'], // the tests hit the job's timeout
      ['true', 'skipped', '', 'skipped'], // a push whose reuse fell through in the verdict job
      ['true', 'success', '', 'skipped'],
      ['true', 'success', 'pass', 'skipped'],
      ['true', 'success', 'success\nfailure', 'skipped'],
      ['true', 'success', 'success ', 'skipped'],
    ];
    for (const [configured, job, outcome, want] of cases) {
      assert.equal(run(configured, job, outcome).word, `outcome=${want}\n`, JSON.stringify([configured, job, outcome]));
    }
    // What the tests job wrote is never printed: it could be a workflow command.
    const { stdout } = run('true', 'success', '::error::forged');
    assert.doesNotMatch(stdout, /forged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
