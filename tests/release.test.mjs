import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkVersion, pinImage } from '../scripts/release.mjs';

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
