// Evaluation runner: measures the AI review on known cases before a model, prompt or policy change
// is released. The cases themselves are kept private (so nobody can tune code to pass them); this
// repository holds the runner and two sample cases for its tests.
//
//   AIFACTORY_MODEL_ENDPOINT=... AIFACTORY_MODEL_TOKEN=... node scripts/eval.mjs CASES_DIR [--max-missed N] [--max-false N]
//
// A case is a folder with:
//   case.json     { "zone": "green", "expect": [{ "file": "src/a.ts", "rule": "injection", "line": 12 }] }
//                 (an empty "expect" is a clean case: every finding is a false flag)
//   change.patch  the change, as `git diff` prints it
//   files/        the changed files as they are after the change
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoReader, scannerRuleIds } from '../engine/bin/aifactory-review.mjs';
import { createModelClient } from '../engine/src/models/client.mjs';
import { limitDiff, splitDiff } from '../engine/src/models/diff.mjs';
import { reviewWithModels } from '../engine/src/models/review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE_TOLERANCE = 5;

export function matches(finding, expected) {
  if (finding.file !== expected.file) return false;
  if (expected.rule && finding.rule !== expected.rule) return false;
  if (expected.line && Math.abs(finding.line - expected.line) > LINE_TOLERANCE) return false;
  return true;
}

/**
 * Whether a finding can change the verdict, as the policy sees it: anything above low, and a
 * reviewer-steering finding at any severity (the policy asks a person for every one).
 */
export function blocks(finding) {
  return finding.severity !== 'low' || finding.rule === 'reviewer-steering';
}

/** Scores one case: which expectations were found, and which findings matched nothing. */
export function score(findings, expect) {
  const blocking = findings.filter(blocks);
  const found = expect.filter((e) => blocking.some((f) => matches(f, e)));
  const missed = expect.filter((e) => !found.includes(e));
  const falseFlags = blocking.filter((f) => !expect.some((e) => matches(f, e)));
  return { found: found.length, missed, falseFlags };
}

export async function runEval({ casesDir, models, complete }) {
  const scannerRules = scannerRuleIds(path.join(root, 'rules/opengrep'));
  const results = [];
  for (const name of readdirSync(casesDir).sort()) {
    const dir = path.join(casesDir, name);
    if (!existsSync(path.join(dir, 'case.json'))) continue;
    const c = JSON.parse(readFileSync(path.join(dir, 'case.json'), 'utf8'));
    const diff = limitDiff(splitDiff(readFileSync(path.join(dir, 'change.patch'), 'utf8')));
    try {
      const { findings, state } = await reviewWithModels({ diff, readFile: repoReader(path.join(dir, 'files')), scannerRules, zone: c.zone, models, complete });
      results.push({ name, expected: c.expect.length, ...score(findings, c.expect), dropped: state.dropped.length, refuted: state.refuted });
    } catch (err) {
      results.push({ name, expected: c.expect.length, found: 0, missed: c.expect, falseFlags: [], error: err.message });
    }
  }
  const totals = results.reduce(
    (t, r) => ({ expected: t.expected + r.expected, found: t.found + r.found, missed: t.missed + r.missed.length, falseFlags: t.falseFlags + r.falseFlags.length, errors: t.errors + (r.error ? 1 : 0) }),
    { expected: 0, found: 0, missed: 0, falseFlags: 0, errors: 0 },
  );
  return { results, totals };
}

/** Where each miss and false flag points (file, rule, line, never code), so a result can be checked. */
function details(results) {
  const at = (f) => `${f.file}:${f.line ?? '?'} ${f.rule ?? ''}`.trim();
  const lines = results.flatMap((r) => [
    ...r.missed.map((m) => `- ${r.name}: missed ${at(m)}`),
    ...r.falseFlags.map((f) => `- ${r.name}: false flag ${at(f)} (${f.severity})`),
  ]);
  return lines.length ? ['', ...lines] : [];
}

export function report({ results, totals }) {
  const rows = results.map((r) => `| ${r.name} | ${r.expected} | ${r.found} | ${r.missed.length} | ${r.falseFlags.length} | ${r.error ?? ''} |`);
  return [
    '| Case | Expected | Found | Missed | False flags | Error |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    `| **Total** | ${totals.expected} | ${totals.found} | ${totals.missed} | ${totals.falseFlags} | ${totals.errors} |`,
    ...details(results),
  ].join('\n');
}

async function main(argv) {
  const [casesDir, ...rest] = argv;
  if (!casesDir) throw new Error('usage: eval.mjs CASES_DIR [--max-missed N] [--max-false N]');
  const limit = (flag) => (rest.includes(flag) ? Number(rest[rest.indexOf(flag) + 1]) : Infinity);
  const models = JSON.parse(readFileSync(path.join(root, 'policy/models.v1.json'), 'utf8'));
  const complete = createModelClient({ endpoint: process.env.AIFACTORY_MODEL_ENDPOINT, token: process.env.AIFACTORY_MODEL_TOKEN });
  const outcome = await runEval({ casesDir, models, complete });
  console.log(report(outcome));
  const { missed, falseFlags, errors } = outcome.totals;
  if (errors || missed > limit('--max-missed') || falseFlags > limit('--max-false')) return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`eval: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
