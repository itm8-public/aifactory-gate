// Builds the engine image with every pin from pins.json as a build argument.
//   node scripts/build-image.mjs [tag]     (default tag: aifactory-review:local)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(path.join(root, 'pins.json'), 'utf8'));
const tag = process.argv[2] ?? 'aifactory-review:local';

const args = {
  PIN_BASE_IMAGE: pins.baseImage.ref,
  PIN_GITLEAKS_VERSION: pins.gitleaks.version,
  PIN_GITLEAKS_SHA256: pins.gitleaks.sha256,
  PIN_OPENGREP_VERSION: pins.opengrep.version,
  PIN_OPENGREP_ASSET: pins.opengrep.asset,
  PIN_OPENGREP_SHA256: pins.opengrep.sha256,
  PIN_OSV_SCANNER_VERSION: pins.osvScanner.version,
  PIN_OSV_SCANNER_SHA256: pins.osvScanner.sha256,
};

const r = spawnSync(
  'docker',
  ['build', '--platform', 'linux/amd64', '-f', 'image/Dockerfile', '-t', tag, ...Object.entries(args).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]), '.'],
  { cwd: root, stdio: 'inherit' },
);
process.exitCode = r.status ?? 1;
