import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { matches, report, runEval, score } from '../scripts/eval.mjs';
import { readDiff } from '../engine/src/models/diff.mjs';

const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval');
const models = JSON.parse(readFileSync(new URL('../policy/models.v1.json', import.meta.url), 'utf8'));

// A fake pair of models: the finder flags every route handler, the verifier confirms everything.
function fakeModels({ flagClean = false } = {}) {
  return async (req) => {
    if (req.schemaName === 'findings') {
      const findings = [];
      if (req.user.includes("app.get('/api/users/:id'")) {
        findings.push({ file: 'src/api.ts', line: 3, quote: "app.get('/api/users/:id', async (req, res) => {", rule: 'missing-access-check', severity: 'high', title: 'No access check', explanation: 'x' });
      }
      if (flagClean && req.user.includes('export const add')) {
        findings.push({ file: 'src/add.ts', line: 1, quote: 'export const add = (a: number, b: number) => a + b;', rule: 'broken-logic', severity: 'medium', title: 'Invented', explanation: 'x' });
      }
      return { data: { findings }, usage: {} };
    }
    const n = (req.user.match(/^Finding \d+:/gm) ?? []).length;
    return { data: { results: Array.from({ length: n }, (_, index) => ({ index, outcome: 'confirmed', severity: 'high', reason: 'r' })) }, usage: {} };
  };
}

test('matching uses file, rule and a line tolerance', () => {
  const f = { file: 'a.ts', rule: 'injection', line: 10 };
  assert.ok(matches(f, { file: 'a.ts', rule: 'injection', line: 14 }));
  assert.ok(!matches(f, { file: 'a.ts', rule: 'injection', line: 20 }));
  assert.ok(!matches(f, { file: 'a.ts', rule: 'data-exposure' }));
  assert.ok(matches(f, { file: 'a.ts' }));
});

test('low findings are neither found nor false flags', () => {
  const s = score([{ file: 'a.ts', rule: 'x', line: 1, severity: 'low' }], [{ file: 'a.ts' }]);
  assert.equal(s.found, 0);
  assert.equal(s.falseFlags.length, 0);
});

test('a steering finding counts at any severity, as the policy asks a person for every one', () => {
  const unconfirmed = { file: 'README.md', rule: 'reviewer-steering', line: 3, severity: 'low' };
  assert.equal(score([unconfirmed], []).falseFlags.length, 1);
  assert.equal(score([unconfirmed], [{ file: 'README.md', rule: 'reviewer-steering', line: 3 }]).found, 1);
});

test('eval run on the sample cases: found, missed, false flags', async () => {
  const good = await runEval({ casesDir, models, complete: fakeModels() });
  assert.deepEqual(good.totals, { expected: 1, found: 1, missed: 0, falseFlags: 0, errors: 0 });
  const noisy = await runEval({ casesDir, models, complete: fakeModels({ flagClean: true }) });
  assert.equal(noisy.totals.falseFlags, 1);
  assert.match(report(noisy), /\| 02-clean \| 0 \| 0 \| 0 \| 1 \|/);
});

test('a model error counts as an error and misses the case', async () => {
  const r = await runEval({ casesDir, models, complete: async () => { throw new Error('HTTP 503'); } });
  assert.equal(r.totals.errors, 2);
  assert.equal(r.totals.missed, 1);
  assert.equal(r.results[0].error, 'HTTP 503');
});

test('readDiff reads the change from git', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-git-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# x\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  git('add', '.');
  git('commit', '-qm', 'change');
  const d = readDiff(dir, 'HEAD^1');
  assert.deepEqual(d.files.map((f) => f.path), ['src/a.ts']);
  assert.match(d.files[0].patch, /\+export const a = 1;/);
});
