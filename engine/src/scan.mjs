// Runs the scanners inside the engine image and writes their raw output to the results folder.
// Each tool's state goes to tools.json; a tool that fails to run is recorded, never hidden.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RULES_DIR = process.env.AIFACTORY_RULES_DIR ?? '/opt/aifactory/rules/opengrep';

// A scanner can fail to start or crash for transient reasons (a cold image pull, a dropped
// network call to osv.dev). Give it a few attempts before recording it as not-run. Findings never
// cause a non-ok exit for these tools (gitleaks runs with --exit-code 0; osv's "found" codes are
// in `ok`), so a real finding, secret hit or failed test is never retried or suppressed — only a
// process/exec error or an exit code outside `ok` is. A tool that still fails ends exactly as
// before: { ran: false } -> missingTool -> needs-person.
export const MAX_ATTEMPTS = 3; // the first run plus up to two retries
const BACKOFF_MS = [500, 1500]; // waited before retry 1 and retry 2

/** The commands, as data, so tests can check them without running anything. */
export function scannerCommands({ repo, out, rulesDir = RULES_DIR }) {
  return {
    gitleaks: {
      cmd: 'gitleaks',
      args: ['dir', repo, '--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', path.join(out, 'gitleaks.json')],
      ok: [0],
    },
    opengrep: {
      cmd: 'opengrep',
      args: ['scan', '--config', rulesDir, '--sarif', '--output', path.join(out, 'opengrep.sarif'), '--quiet', repo],
      ok: [0],
    },
    // 0: no vulnerabilities, 1: vulnerabilities found, 128: no package manifests to scan.
    'osv-scanner': {
      cmd: 'osv-scanner',
      args: ['scan', 'source', '--recursive', '--format', 'json', '--output', path.join(out, 'osv.json'), repo],
      ok: [0, 1, 128],
      emptyOn: { 128: { results: [] } },
    },
  };
}

/** Synchronous sleep, so runScanners stays synchronous and its caller is unchanged. */
function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Spawns one scanner once and reduces the result to { status, error, stderr }. */
function runOnce(c) {
  const r = spawnSync(c.cmd, c.args, { encoding: 'utf8', env: { ...process.env, HOME: '/tmp' }, timeout: 10 * 60 * 1000 });
  return { status: r.status, error: r.error, stderr: r.stderr };
}

/**
 * Runs one scanner, retrying only a transient/process failure (a spawn error, or an exit code
 * outside `ok`) up to a small fixed number of attempts. Returns { ran: true, status } on success
 * or { ran: false, error, stderr } after the last failed attempt. Deterministic given a
 * deterministic `run`: a tool that always succeeds returns on the first attempt; one that always
 * fails returns not-run after every attempt, exactly as the single-attempt version did.
 * `run` and `sleep` are injectable so the retry path can be unit-tested without spawning anything.
 */
export function runScanner(c, { run = runOnce, attempts = MAX_ATTEMPTS, sleep: wait = sleep } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = run(c);
    if (!r.error && c.ok.includes(r.status)) return { ran: true, status: r.status };
    last = { ran: false, error: r.error ? (r.error.code ?? r.error.message) : `exit ${r.status}`, stderr: r.stderr };
    if (attempt < attempts) wait(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
  }
  return last;
}

export function runScanners({ repo, out, rulesDir }, options) {
  const tools = {};
  for (const [name, c] of Object.entries(scannerCommands({ repo, out, rulesDir }))) {
    const outcome = runScanner(c, options);
    if (!outcome.ran) {
      tools[name] = { ran: false, error: outcome.error };
      process.stderr.write(`${name}: ${outcome.error}\n${(outcome.stderr ?? '').slice(-2000)}\n`);
      continue;
    }
    const empty = c.emptyOn?.[outcome.status];
    const file = path.join(out, scannerFile(name));
    if (empty && !existsSync(file)) writeFileSync(file, JSON.stringify(empty));
    tools[name] = { ran: true };
  }
  writeFileSync(path.join(out, 'tools.json'), JSON.stringify(tools, null, 2));
  return tools;
}

function scannerFile(name) {
  return { gitleaks: 'gitleaks.json', opengrep: 'opengrep.sarif', 'osv-scanner': 'osv.json' }[name];
}
