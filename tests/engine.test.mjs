import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../engine/bin/aifactory-review.mjs';
import { gitleaksFindings, osvFindings, sarifFindings, severityFromScore } from '../engine/src/facts.mjs';
import { decide } from '../engine/src/policy.mjs';
import { summary } from '../engine/src/report.mjs';
import { runScanner, scannerCommands } from '../engine/src/scan.mjs';
import { buildVerdict, readResults } from '../engine/src/verdict.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/policy.v1.json', import.meta.url), 'utf8'));
const soloPolicy = JSON.parse(readFileSync(new URL('../policy/policy.solo.v1.json', import.meta.url), 'utf8'));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ran = { gitleaks: { ran: true }, opengrep: { ran: true }, 'osv-scanner': { ran: true } };
const base = { policy, zone: 'green', files: ['src/App.tsx'], checks: { tests: 'success' }, tools: ran, findings: [] };

test('severity from a score', () => {
  assert.equal(severityFromScore('9.8'), 'critical');
  assert.equal(severityFromScore(7), 'high');
  assert.equal(severityFromScore('4.0'), 'medium');
  assert.equal(severityFromScore(1), 'low');
  assert.equal(severityFromScore('n/a'), null);
});

test('gitleaks findings keep no secret value', () => {
  const findings = gitleaksFindings(fixture('gitleaks.json'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].file, 'src/config.ts');
  assert.ok(!JSON.stringify(findings).includes('REDACTED'), 'the Secret field is not copied');
});

test('SARIF uses security-severity before the level', () => {
  const findings = sarifFindings(fixture('opengrep.sarif'));
  assert.deepEqual(
    findings.map((f) => [f.rule, f.severity, f.line]),
    [
      ['supabase-service-role-in-client', 'critical', 12],
      ['raw-html-from-variable', 'medium', 40],
    ],
  );
});

test('SARIF rule ids lose the rule file path prefix', () => {
  const sarif = { runs: [{ tool: { driver: { rules: [] } }, results: [{ ruleId: 'opt.aifactory.rules.opengrep.eval-of-dynamic-code', level: 'error' }] }] };
  assert.equal(sarifFindings(sarif)[0].rule, 'eval-of-dynamic-code');
});

test('osv groups take the highest severity', () => {
  const findings = osvFindings(fixture('osv.json'));
  assert.deepEqual(
    findings.map((f) => [f.rule, f.severity]),
    [
      ['GHSA-aaaa-bbbb-cccc', 'high'],
      ['GHSA-dddd-eeee-ffff', 'medium'],
    ],
  );
});

test('a clean change passes', () => {
  assert.deepEqual(decide(base), { verdict: 'pass', reasons: [] });
});

test('a secret fails in every zone', () => {
  for (const zone of ['green', 'yellow', 'red']) {
    const r = decide({ ...base, zone, findings: gitleaksFindings(fixture('gitleaks.json')) });
    assert.equal(r.verdict, 'fail', zone);
  }
});

test('severity floor depends on the zone', () => {
  const medium = [{ tool: 'opengrep', rule: 'x', severity: 'medium', file: 'a.ts', line: 1, message: '' }];
  assert.equal(decide({ ...base, findings: medium }).verdict, 'pass');
  assert.equal(decide({ ...base, zone: 'red', findings: medium }).verdict, 'fail');
});

test('a scanner that did not run never passes', () => {
  const r = decide({ ...base, tools: { ...ran, opengrep: { ran: false, error: 'exit 2' } } });
  assert.equal(r.verdict, 'needs-person');
  assert.match(r.reasons[0].text, /opengrep did not produce a result \(exit 2\)/);
});

test('failed tests fail; tests that did not run need a person', () => {
  assert.equal(decide({ ...base, checks: { tests: 'failure' } }).verdict, 'fail');
  assert.equal(decide({ ...base, checks: { tests: 'cancelled' } }).verdict, 'needs-person');
});

test('missing tests are a note in green and need a person in yellow', () => {
  assert.equal(decide({ ...base, checks: { tests: 'not-configured' } }).verdict, 'pass');
  assert.equal(decide({ ...base, zone: 'yellow', checks: { tests: 'not-configured' } }).verdict, 'needs-person');
});

test('changing the gate itself always needs a person', () => {
  for (const zone of ['green', 'yellow', 'red']) {
    const r = decide({ ...base, zone, files: ['.github/workflows/aifactory-gate.yml'] });
    assert.equal(r.verdict, 'needs-person', zone);
  }
  assert.equal(decide({ ...base, files: ['CODEOWNERS'] }).verdict, 'needs-person');
});

test('identity and migrations need a person from yellow up', () => {
  assert.equal(decide({ ...base, files: ['src/auth/login.ts'] }).verdict, 'pass');
  assert.equal(decide({ ...base, zone: 'yellow', files: ['src/auth/login.ts'] }).verdict, 'needs-person');
  assert.equal(decide({ ...base, zone: 'yellow', files: ['supabase/migrations/001.sql'] }).verdict, 'needs-person');
  assert.equal(decide({ ...base, files: ['src/authorization-docs.md'] }).verdict, 'pass', 'authorization is not auth');
});

test('dependency changes need a person only in red', () => {
  assert.equal(decide({ ...base, zone: 'yellow', files: ['package.json'] }).verdict, 'pass');
  assert.equal(decide({ ...base, zone: 'red', files: ['package.json'] }).verdict, 'needs-person');
});

test('unreadable changes need a person; fail beats needs-person', () => {
  assert.equal(decide({ ...base, files: null }).verdict, 'needs-person');
  assert.equal(decide({ ...base, files: null, checks: { tests: 'failure' } }).verdict, 'fail');
});

test('results folder: a missing file is a tool that did not run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
  writeFileSync(path.join(dir, 'gitleaks.json'), '[]');
  writeFileSync(path.join(dir, 'opengrep.sarif'), JSON.stringify(fixture('opengrep.sarif')));
  const { tools, findings } = readResults(dir);
  assert.deepEqual(tools['osv-scanner'], { ran: false, error: 'no result file' });
  assert.equal(findings.length, 2);
});

test('buildVerdict writes the record and a summary without secrets', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
  writeFileSync(path.join(dir, 'gitleaks.json'), JSON.stringify(fixture('gitleaks.json')));
  writeFileSync(path.join(dir, 'opengrep.sarif'), JSON.stringify(fixture('opengrep.sarif')));
  writeFileSync(path.join(dir, 'osv.json'), JSON.stringify(fixture('osv.json')));
  const record = await buildVerdict({
    repo: dir,
    results: dir,
    zone: 'green',
    level: 1,
    base: 'HEAD^1',
    checks: { tests: 'success' },
    policy,
    versions: { engine: '0.1.0', policy: '1', tools: { gitleaks: 't' } },
    files: ['src/App.tsx'],
  });
  assert.equal(record.verdict, 'fail');
  assert.equal(record.enforced, false);
  assert.deepEqual(record.counts, { low: 0, medium: 2, high: 1, critical: 2 });
  const md = readFileSync(path.join(dir, 'summary.md'), 'utf8');
  assert.match(md, /## aifactory gate: fail/);
  assert.match(md, /advisory/);
  assert.ok(!md.includes('sk_live'), 'no secret in the summary');
});

test('finding paths are shown relative to the repository', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-'));
  writeFileSync(path.join(dir, 'gitleaks.json'), '[]');
  writeFileSync(path.join(dir, 'opengrep.sarif'), JSON.stringify({ runs: [] }));
  writeFileSync(path.join(dir, 'osv.json'), JSON.stringify(fixture('osv.json')));
  const record = await buildVerdict({
    repo: '/repo',
    results: dir,
    zone: 'green',
    level: 2,
    base: 'HEAD^1',
    checks: {},
    policy,
    versions: { engine: '0', policy: '1', tools: {} },
    files: [],
  });
  assert.equal(record.findings[0].file, 'package-lock.json');
});

test('summary escapes HTML in messages', () => {
  const md = summary({
    verdict: 'pass',
    reasons: [],
    counts: { low: 1, medium: 0, high: 0, critical: 0 },
    findings: [{ tool: 'opengrep', rule: 'r', severity: 'low', file: 'a', line: 1, message: '<script>x</script>' }],
    zone: 'green',
    level: 2,
    enforced: true,
    versions: { engine: '0.1.0', policy: '1', tools: {} },
  });
  assert.ok(md.includes('&lt;script&gt;'));
});

test('CLI arguments', () => {
  const o = parseArgs(['run', '--repo', '/r', '--out', '/o', '--zone', 'yellow', '--level', '2', '--check', 'tests=success']);
  assert.equal(o.level, 2);
  assert.deepEqual(o.checks, { tests: 'success' });
  assert.throws(() => parseArgs(['run', '--repo', '/r', '--out', '/o', '--zone', 'blue']), /zone/);
  assert.throws(() => parseArgs(['deploy', '--repo', '/r', '--out', '/o']), /command/);
  assert.throws(() => parseArgs(['run', '--repo', '/r', '--out', '/o', '--zone', 'green', '--level', '4']), /level/);
});

test('scanner commands redact secrets and never fail on findings', () => {
  const c = scannerCommands({ repo: '/repo', out: '/out', rulesDir: '/rules' });
  assert.ok(c.gitleaks.args.includes('--redact'));
  assert.deepEqual(c.gitleaks.args.slice(c.gitleaks.args.indexOf('--exit-code'), c.gitleaks.args.indexOf('--exit-code') + 2), ['--exit-code', '0']);
  assert.deepEqual(c['osv-scanner'].ok, [0, 1, 128]);
});

test('a scanner that fails transiently is retried and can still succeed', () => {
  let calls = 0;
  const run = () => (++calls < 3 ? { error: { code: 'ENOENT' } } : { status: 0 });
  const r = runScanner({ ok: [0] }, { run, sleep: () => {} });
  assert.deepEqual(r, { ran: true, status: 0 });
  assert.equal(calls, 3, 'retried until it succeeded');
});

test('a scanner that keeps failing is recorded as not-run after the retries', () => {
  let calls = 0;
  const run = () => {
    calls++;
    return { status: 2, stderr: 'boom' };
  };
  const r = runScanner({ ok: [0] }, { run, attempts: 3, sleep: () => {} });
  assert.equal(r.ran, false);
  assert.equal(r.error, 'exit 2');
  assert.equal(r.stderr, 'boom');
  assert.equal(calls, 3, 'tried exactly the attempt limit, then gave up');
});

test('a scanner that succeeds first time is never retried (a finding exit code is a success)', () => {
  let calls = 0;
  const run = () => {
    calls++;
    return { status: 1 }; // osv-style: 1 means "vulnerabilities found", an ok code
  };
  const r = runScanner({ ok: [0, 1] }, { run, sleep: () => {} });
  assert.deepEqual(r, { ran: true, status: 1 });
  assert.equal(calls, 1, 'a real finding is not retried or suppressed');
});

test('the summary opens with the reason and the next step (needs-person)', () => {
  const md = summary({
    verdict: 'needs-person',
    reasons: [{ action: 'needs-person', text: 'Touches CI, deployment or infrastructure configuration' }],
    counts: { low: 0, medium: 0, high: 0, critical: 0 },
    findings: [],
    zone: 'green',
    level: 2,
    enforced: true,
    versions: { engine: '0', policy: '1', tools: {} },
  });
  const head = md.split('### Why')[0];
  assert.match(head, /\*\*Needs a person: Touches CI, deployment or infrastructure configuration\.\*\*/);
  assert.match(head, /A reviewer must approve this change before it can be merged\./);
  assert.ok(md.indexOf('A reviewer must approve') < md.indexOf('### Why'), 'the lead comes before the detail');
});

test('the summary opens with must-fix for a fail, then the push step', () => {
  const md = summary({
    verdict: 'fail',
    reasons: [
      { action: 'fail', text: '1 possible secret(s) in the code' },
      { action: 'needs-person', text: 'Touches CI, deployment or infrastructure configuration' },
    ],
    counts: { low: 0, medium: 0, high: 0, critical: 1 },
    findings: [],
    zone: 'green',
    level: 2,
    enforced: true,
    versions: { engine: '0', policy: '1', tools: {} },
  });
  const head = md.split('### Why')[0];
  assert.match(head, /\*\*Must fix: 1 possible secret\(s\) in the code\.\*\*/);
  assert.match(head, /push again/);
});

test('the lead names how many more reasons follow', () => {
  const md = summary({
    verdict: 'needs-person',
    reasons: [
      { action: 'needs-person', text: 'Touches CI, deployment or infrastructure configuration' },
      { action: 'needs-person', text: 'No tests are configured' },
    ],
    counts: { low: 0, medium: 0, high: 0, critical: 0 },
    findings: [],
    zone: 'yellow',
    level: 2,
    enforced: true,
    versions: { engine: '0', policy: '1', tools: {} },
  });
  assert.match(md, /\(and 1 more below\)/);
});

test('a clean pass opens with the mergeable message', () => {
  const md = summary({
    verdict: 'pass',
    reasons: [],
    counts: { low: 0, medium: 0, high: 0, critical: 0 },
    findings: [],
    zone: 'green',
    level: 2,
    enforced: true,
    versions: { engine: '0', policy: '1', tools: {} },
  });
  assert.match(md.split('### Findings')[0], /This change can be merged\./);
});

test('solo policy: green-zone CI/infra self-serves, but the serious cases still block', () => {
  // The standard policy routes green-zone infra to a person; the solo policy passes it.
  assert.equal(decide({ ...base, files: ['.github/workflows/aifactory-gate.yml'] }).verdict, 'needs-person');
  assert.equal(decide({ ...base, policy: soloPolicy, files: ['.github/workflows/aifactory-gate.yml'] }).verdict, 'pass');
  assert.equal(decide({ ...base, policy: soloPolicy, files: ['CODEOWNERS'] }).verdict, 'pass');
  assert.equal(decide({ ...base, policy: soloPolicy, files: ['infra/main.bicep', 'Dockerfile'] }).verdict, 'pass');
  // Everything that genuinely needs itm8 is unchanged under the solo policy.
  assert.equal(decide({ ...base, policy: soloPolicy, findings: gitleaksFindings(fixture('gitleaks.json')) }).verdict, 'fail', 'a secret still fails');
  assert.equal(decide({ ...base, policy: soloPolicy, zone: 'yellow', files: ['.github/workflows/x.yml'] }).verdict, 'needs-person', 'yellow infra still needs a person');
  assert.equal(decide({ ...base, policy: soloPolicy, zone: 'red', files: ['infra/main.bicep'] }).verdict, 'needs-person', 'red infra still needs a person');
  assert.equal(decide({ ...base, policy: soloPolicy, tools: { ...ran, opengrep: { ran: false, error: 'exit 2' } } }).verdict, 'needs-person', 'a missing scanner still needs a person');
  assert.equal(decide({ ...base, policy: soloPolicy, checks: { tests: 'failure' } }).verdict, 'fail', 'a failed test still fails');
});

test('solo policy differs from the standard policy only in green-zone CI/infra', () => {
  const standard = JSON.parse(JSON.stringify(policy));
  standard.version = soloPolicy.version;
  standard.description = soloPolicy.description;
  standard.areas.find((a) => a.id === 'ci-infra').action.green = 'none';
  assert.deepEqual(soloPolicy, standard);
});

test('CLI: --profile selects the solo policy and is validated', () => {
  const o = parseArgs(['run', '--repo', '/r', '--out', '/o', '--zone', 'green', '--level', '2', '--profile', 'solo']);
  assert.equal(o.profile, 'solo');
  assert.equal(parseArgs(['run', '--repo', '/r', '--out', '/o', '--zone', 'green']).profile, '');
  assert.throws(() => parseArgs(['run', '--repo', '/r', '--out', '/o', '--zone', 'green', '--profile', 'duo']), /profile/);
});
