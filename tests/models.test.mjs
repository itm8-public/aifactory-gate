import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { repoReader, scannerRuleIds } from '../engine/bin/aifactory-review.mjs';
import { createModelClient, validate } from '../engine/src/models/client.mjs';
import { limitDiff, splitDiff } from '../engine/src/models/diff.mjs';
import { checkEvidence } from '../engine/src/models/evidence.mjs';
import { FIND_SCHEMA } from '../engine/src/models/prompts.mjs';
import { reviewWithModels } from '../engine/src/models/review.mjs';
import { decide } from '../engine/src/policy.mjs';
import { buildVerdict } from '../engine/src/verdict.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/policy.v1.json', import.meta.url), 'utf8'));
const models = JSON.parse(readFileSync(new URL('../policy/models.v1.json', import.meta.url), 'utf8'));
const ran = { gitleaks: { ran: true }, opengrep: { ran: true }, 'osv-scanner': { ran: true } };
const base = { policy, zone: 'green', files: ['src/api.ts'], checks: { tests: 'success' }, tools: ran, findings: [] };

const API_TS = [
  "import express from 'express';",
  'const app = express();',
  "app.get('/api/users/:id', async (req, res) => {",
  '  const user = await db.users.find(req.params.id);',
  '  res.json(user);',
  '});',
].join('\n');

const diff = { files: [{ path: 'src/api.ts', patch: `diff --git a/src/api.ts b/src/api.ts\n+${API_TS.split('\n').join('\n+')}` }], truncated: false };
const readFile = (p) => (p === 'src/api.ts' ? API_TS : null);

const candidate = (over = {}) => ({
  file: 'src/api.ts',
  line: 3,
  quote: "app.get('/api/users/:id', async (req, res) => {",
  rule: 'missing-access-check',
  severity: 'high',
  title: 'Anyone can read any user',
  explanation: 'The route returns a user by id without checking who asks.',
  ...over,
});

function fakeComplete(answers) {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    const next = answers[req.schemaName];
    if (next instanceof Error) throw next;
    return { data: typeof next === 'function' ? next(req) : next, usage: { total_tokens: 10 } };
  };
  return { complete, calls };
}

test('client: request shape, Entra token, structured output', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }], usage: { total_tokens: 5 } }) };
  };
  const complete = createModelClient({ endpoint: 'https://review.example.net', token: 'tok', fetchImpl });
  const r = await complete({ deployment: 'review-find', system: 's', user: 'u', schema: FIND_SCHEMA, schemaName: 'findings' });
  assert.equal(seen.url, 'https://review.example.net/openai/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.equal(seen.body.model, 'review-find');
  assert.equal('temperature' in seen.body, false, 'no temperature unless the model configuration sets one');
  await complete({ deployment: 'review-find', system: 's', user: 'u', schema: FIND_SCHEMA, schemaName: 'findings', temperature: 0 });
  assert.equal(seen.body.temperature, 0);
  assert.equal(seen.body.response_format.type, 'json_schema');
  assert.deepEqual(r.data, { findings: [] });
});

test('client: refuses bad endpoints and bad answers', async () => {
  assert.throws(() => createModelClient({ endpoint: 'http://x', token: 't' }), /https/);
  assert.throws(() => createModelClient({ endpoint: 'https://x.example/a?b=c', token: 't' }), /https/);
  assert.doesNotThrow(() => createModelClient({ endpoint: 'https://r.services.ai.azure.com/api/projects/review', token: 't' }));
  assert.throws(() => createModelClient({ endpoint: 'https://x.example', token: '' }), /token/);
  const answer = (content, ok = true, status = 200) => async () => ({ ok, status, json: async () => ({ choices: [{ message: { content } }] }) });
  const req = { deployment: 'd', system: 's', user: 'u', schema: FIND_SCHEMA, schemaName: 'f' };
  await assert.rejects(createModelClient({ endpoint: 'https://x.example', token: 't', fetchImpl: answer('nope') })(req), /not JSON/);
  await assert.rejects(createModelClient({ endpoint: 'https://x.example', token: 't', fetchImpl: answer('{"x":1}') })(req), /findings is missing/);
  await assert.rejects(createModelClient({ endpoint: 'https://x.example', token: 't', fetchImpl: answer('', false, 429) })(req), /HTTP 429/);
});

test('validate: enum, integer, maxItems', () => {
  assert.equal(validate({ findings: [candidate()] }, FIND_SCHEMA), null);
  assert.match(validate({ findings: [candidate({ severity: 'huge' })] }, FIND_SCHEMA), /not one of/);
  assert.match(validate({ findings: [candidate({ line: '3' })] }, FIND_SCHEMA), /integer/);
  assert.match(validate({ findings: Array(21).fill(candidate()) }, FIND_SCHEMA), /more than 20/);
});

test('diff: lock files out, long files cut, total capped', () => {
  const text = ['a.ts', 'package-lock.json', 'b.ts'].map((p) => `diff --git a/${p} b/${p}\n+${'x'.repeat(50)}\n`).join('');
  const files = splitDiff(text);
  assert.deepEqual(files.map((f) => f.path), ['a.ts', 'package-lock.json', 'b.ts']);
  const limited = limitDiff(files, { totalChars: 200, fileChars: 60, context: 5 });
  assert.deepEqual(limited.files.map((f) => f.path), ['a.ts']);
  assert.equal(limited.truncated, true);
  assert.match(limited.files[0].patch, /cut: the rest/);
});

test('evidence: invented quotes, unknown rules and files outside the change are dropped', () => {
  const { kept, dropped } = checkEvidence({
    candidates: [
      candidate(),
      candidate({ quote: 'await db.users.deleteAll();' }),
      candidate({ rule: 'made-up-rule' }),
      candidate({ file: 'src/other.ts' }),
      candidate({ line: 99 }),
    ],
    readFile,
    changed: new Set(['src/api.ts']),
    rules: new Set(['missing-access-check']),
  });
  assert.equal(kept.length, 1);
  assert.match(kept[0].context, /^1: import express/);
  assert.deepEqual(dropped.map((d) => d.dropped), ['quote not found at that line', 'unknown rule', 'file not in the change', 'line out of range']);
});

test('review: find, check, verify; refuted and invented findings never reach the policy', async () => {
  const { complete, calls } = fakeComplete({
    findings: { findings: [candidate(), candidate({ quote: 'something that is not there at all' }), candidate({ line: 4, quote: 'res.json(user);', rule: 'data-exposure', title: 'Returns the whole user' })] },
    verification: { results: [{ index: 0, outcome: 'confirmed', severity: 'high', reason: 'No check before the read.' }, { index: 1, outcome: 'refuted', severity: 'low', reason: 'Fields are filtered.' }] },
  });
  const r = await reviewWithModels({ diff, readFile, scannerRules: ['eval-of-dynamic-code'], zone: 'green', models, complete });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].deployment, 'review-find');
  assert.equal(calls[1].deployment, 'review-verify');
  assert.match(calls[0].user, /^<untrusted>/);
  assert.match(calls[0].system, /eval-of-dynamic-code/);
  assert.deepEqual(r.findings.map((f) => [f.rule, f.severity, f.outcome]), [['missing-access-check', 'high', 'confirmed']]);
  assert.equal(r.state.found, 3);
  assert.equal(r.state.dropped.length, 1);
  assert.equal(r.state.refuted, 1);
});

test('review: an uncertain finding is listed as low; a missing answer is an error', async () => {
  const uncertain = fakeComplete({
    findings: { findings: [candidate()] },
    verification: { results: [{ index: 0, outcome: 'uncertain', severity: 'critical', reason: 'Middleware not shown.' }] },
  });
  const r = await reviewWithModels({ diff, readFile, scannerRules: [], zone: 'green', models, complete: uncertain.complete });
  assert.deepEqual(r.findings.map((f) => f.severity), ['low']);
  const missing = fakeComplete({ findings: { findings: [candidate()] }, verification: { results: [] } });
  await assert.rejects(reviewWithModels({ diff, readFile, scannerRules: [], zone: 'green', models, complete: missing.complete }), /no answer/);
});

test('review: nothing kept means no verifier call', async () => {
  const { complete, calls } = fakeComplete({ findings: { findings: [] } });
  const r = await reviewWithModels({ diff, readFile, scannerRules: [], zone: 'green', models, complete });
  assert.equal(calls.length, 1);
  assert.deepEqual(r.findings, []);
});

const ai = (over) => ({ tool: 'ai-review', rule: 'missing-access-check', severity: 'high', file: 'src/api.ts', line: 3, message: 'm', outcome: 'confirmed', ...over });

test('policy: AI findings by zone, and only when requested', () => {
  const requested = { requested: true };
  assert.equal(decide({ ...base, findings: [ai()], aiReview: requested }).verdict, 'fail');
  assert.equal(decide({ ...base, zone: 'yellow', findings: [ai()], aiReview: requested }).verdict, 'needs-person');
  assert.equal(decide({ ...base, findings: [ai({ severity: 'critical' })], aiReview: requested }).verdict, 'needs-person');
  assert.equal(decide({ ...base, findings: [ai({ severity: 'low', outcome: 'uncertain' })], aiReview: requested }).verdict, 'pass');
  assert.equal(decide({ ...base, findings: [ai({ rule: 'reviewer-steering', severity: 'low' })], aiReview: requested }).verdict, 'needs-person');
  assert.equal(decide({ ...base, aiReview: { requested: true, error: 'HTTP 503' } }).verdict, 'needs-person');
  assert.equal(decide({ ...base, findings: [ai()] }).verdict, 'pass', 'not requested: ignored');
});

test('policy: AI findings never loosen a failed fact', () => {
  const r = decide({ ...base, checks: { tests: 'failure' }, findings: [ai({ severity: 'low' })], aiReview: { requested: true } });
  assert.equal(r.verdict, 'fail');
});

test('verdict: the explanation is added; a failing explainer only drops it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
  for (const [f, c] of [['gitleaks.json', '[]'], ['opengrep.sarif', '{"runs":[]}'], ['osv.json', '{"results":[]}']]) writeFileSync(path.join(dir, f), c);
  const args = { repo: '/repo', results: dir, zone: 'green', level: 2, base: 'HEAD^1', checks: { tests: 'success' }, policy, versions: { engine: '0', policy: '1.1', tools: {} }, files: [] };
  const state = { promptVersion: '1', deployments: { find: 'review-find', verify: 'review-verify' } };
  const ok = await buildVerdict({ ...args, ai: { requested: true, findings: [], state }, explain: async () => 'All checks passed. You can merge.' });
  assert.equal(ok.verdict, 'pass');
  const md = readFileSync(path.join(dir, 'summary.md'), 'utf8');
  assert.match(md, /### In plain words\n\nAll checks passed/);
  assert.match(md, /AI review prompt 1 \(find review-find, verify review-verify\)/);
  const bad = await buildVerdict({ ...args, ai: { requested: true, findings: [], state }, explain: async () => { throw new Error('HTTP 500'); } });
  assert.equal(bad.verdict, 'pass');
  assert.equal(bad.explanationError, 'HTTP 500');
});

test('repo reader stays inside the repository; rule ids come from the pack', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
  mkdirSync(path.join(dir, 'repo'));
  writeFileSync(path.join(dir, 'repo', 'a.ts'), 'ok');
  writeFileSync(path.join(dir, 'secret.txt'), 'no');
  const read = repoReader(path.join(dir, 'repo'));
  assert.equal(read('a.ts'), 'ok');
  assert.equal(read('../secret.txt'), null);
  assert.equal(read('missing.ts'), null);
  const ids = scannerRuleIds(new URL('../rules/opengrep', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(ids.includes('supabase-service-role-in-client'));
  assert.equal(ids.length, 8);
});
