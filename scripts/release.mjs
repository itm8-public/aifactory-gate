// Release helper. `pin` writes the published image digest into the reusable workflow, so a release
// tag always runs exactly the image built from it.
//   node scripts/release.mjs pin ghcr.io/OWNER/aifactory-review@sha256:...
//   node scripts/release.mjs check VERSION      (fails unless VERSION matches package.json)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(root, '.github/workflows/gate.yml');
const IMAGE_LINE = /^(\s*GATE_IMAGE:\s*)\S+.*$/m;
const DIGEST_REF = /^ghcr\.io\/[a-z0-9-]+\/aifactory-review@sha256:[0-9a-f]{64}$/;

export function pinImage(workflow, ref) {
  if (!DIGEST_REF.test(ref)) throw new Error(`not a digest reference: ${ref}`);
  if (!IMAGE_LINE.test(workflow)) throw new Error('GATE_IMAGE line not found in gate.yml');
  return workflow.replace(IMAGE_LINE, `$1${ref}`);
}

export function checkVersion(version, pkgVersion) {
  const v = version.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`version must be MAJOR.MINOR.PATCH, got "${version}"`);
  if (v !== pkgVersion) throw new Error(`version ${v} does not match package.json ${pkgVersion}`);
  const major = `v${v.split('.')[0]}`;
  // `major` is the stable channel (@v0); `next` is the prerelease/soak channel (@v0-next). A release
  // publishes to `next`; a maintainer promotes it to `major` after a soak.
  return { version: v, major, next: `${major}-next` };
}

function main([command, arg]) {
  if (command === 'pin') {
    writeFileSync(GATE, pinImage(readFileSync(GATE, 'utf8'), arg));
    console.log(`gate.yml now runs ${arg}`);
  } else if (command === 'check') {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const { version, major, next } = checkVersion(arg ?? '', pkg.version);
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nmajor=${major}\nnext=${next}\n`, { flag: 'a' });
    console.log(`version=${version} major=${major} next=${next}`);
  } else throw new Error('command must be pin or check');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exitCode = 1;
  }
}
