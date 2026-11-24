import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CANARY_CONTEXT, GATE_REPO, checkVersion, pinImage, pinnedImage, promotionCheck, run } from '../scripts/release.mjs';

const gate = readFileSync(new URL('../.github/workflows/gate.yml', import.meta.url), 'utf8');
const digest = `ghcr.io/itm8-public/aifactory-review@sha256:${'a'.repeat(64)}`;

test('pin writes the digest into GATE_IMAGE and changes nothing else', () => {
  const pinned = pinImage(gate, digest);
  assert.match(pinned, new RegExp(`GATE_IMAGE: ${digest.replace(/[.@]/g, '\\$&')}$`, 'm'));
  assert.equal(pinned.split('\n').length, gate.split('\n').length);
  assert.equal(pinned.replace(/GATE_IMAGE: .*/, ''), gate.replace(/GATE_IMAGE: .*/, ''));
});

test('pin refuses a tag or another image', () => {
  assert.throws(() => pinImage(gate, 'ghcr.io/itm8-public/aifactory-review:0.1.0'), /digest/);
  assert.throws(() => pinImage(gate, `ghcr.io/x/other@sha256:${'a'.repeat(64)}`), /digest/);
});

test('version must match package.json, and names the stable and prerelease channels', () => {
  assert.deepEqual(checkVersion('v0.1.0', '0.1.0'), { version: '0.1.0', major: 'v0', next: 'v0-next' });
  assert.deepEqual(checkVersion('2.3.4', '2.3.4'), { version: '2.3.4', major: 'v2', next: 'v2-next' });
  assert.throws(() => checkVersion('0.2.0', '0.1.0'), /does not match/);
  assert.throws(() => checkVersion('latest', '0.1.0'), /MAJOR/);
});

test('pinnedImage reads the digest a release commit runs, and nothing else', () => {
  assert.equal(pinnedImage(pinImage(gate, digest)), digest);
  assert.equal(pinnedImage(gate.replace(/GATE_IMAGE: .*/, 'GATE_IMAGE: ghcr.io/itm8-public/aifactory-review:0.1.0')), null);
  assert.equal(pinnedImage('name: x\n'), null);
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const green = { context: CANARY_CONTEXT, state: 'success', updated_at: '2026-11-24T10:00:00Z', description: '4 of 4 cases as expected on @v0-next' };

test('promotion needs the release on @v0-next and a green canary on the same commit', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const ok = promotionCheck({ version: '0.4.0', tagSha: A, nextSha: A, stableSha: B, canary: green, now });
  assert.equal(ok.ok, true);
  assert.equal(ok.major, 'v0');
  assert.equal(ok.already, false);
  assert.equal(ok.canaryHours, 50);
  assert.match(promotionCheck({ version: '0.4.0', tagSha: A, nextSha: B, stableSha: B, canary: green }).problems[0], /Only the release on @v0-next/);
  assert.match(promotionCheck({ version: '0.4.0', tagSha: A, nextSha: A, stableSha: B }).problems[0], /No canary result.*canary\.mjs/);
  assert.match(promotionCheck({ version: '0.4.0', tagSha: A, nextSha: A, stableSha: B, canary: { ...green, state: 'failure' } }).problems[0], /canary on aaaaaaa is failure/);
  assert.match(promotionCheck({ version: '0.5.0', tagSha: null, nextSha: A, stableSha: B }).problems[0], /no tag v0\.5\.0/);
  assert.equal(promotionCheck({ version: '0.4.0', tagSha: A, nextSha: A, stableSha: A, canary: green }).already, true);
});

function fakeGh({ tags, statuses = [] }) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, body: input ? JSON.parse(input) : undefined });
    if (args[0] === 'release' || args[1] === '--method') return '{}';
    const tag = args[1].match(/git\/ref\/tags\/(.+)$/)?.[1];
    if (tag) {
      if (!tags[tag]) throw Object.assign(new Error('Not Found'), { stderr: 'HTTP 404' });
      return JSON.stringify({ object: { type: 'commit', sha: tags[tag] } });
    }
    if (args[1].endsWith('/status')) return JSON.stringify({ statuses });
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  return { gh, calls, writes: () => calls.filter((c) => c.args[0] === 'release' || c.args[1] === '--method') };
}

test('promote is a dry run until --apply, then moves @v0 and marks the release stable', () => {
  const tags = { 'v0.4.0': A, 'v0-next': A, v0: B };
  const dry = fakeGh({ tags, statuses: [green] });
  const lines = [];
  run(['promote', '0.4.0'], { gh: dry.gh, out: (l) => lines.push(l) });
  assert.equal(dry.writes().length, 0);
  assert.match(lines.join('\n'), /Dry run/);
  assert.match(lines.join('\n'), /48 hours/);

  const live = fakeGh({ tags, statuses: [green] });
  run(['promote', '0.4.0', '--apply'], { gh: live.gh, out: () => {} });
  const [move, release] = live.writes();
  assert.deepEqual(move.args.slice(0, 4), ['api', '--method', 'PATCH', `repos/${GATE_REPO}/git/refs/tags/v0`]);
  assert.deepEqual(move.body, { sha: A, force: true });
  assert.deepEqual(release.args, ['release', 'edit', 'v0.4.0', '-R', GATE_REPO, '--prerelease=false', '--latest']);
});

test('promote refuses without a green canary and changes nothing', () => {
  const fake = fakeGh({ tags: { 'v0.4.0': A, 'v0-next': A, v0: B } });
  assert.throws(() => run(['promote', '0.4.0', '--apply'], { gh: fake.gh, out: () => {} }), /cannot be promoted[\s\S]*canary\.mjs/);
  assert.equal(fake.writes().length, 0);
  assert.throws(() => run(['promote'], { gh: fake.gh, out: () => {} }), /usage/);
});
