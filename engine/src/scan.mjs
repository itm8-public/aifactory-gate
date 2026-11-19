// Runs the scanners inside the engine image and writes their raw output to the results folder.
// Each tool's state goes to tools.json; a tool that fails to run is recorded, never hidden.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RULES_DIR = process.env.AIFACTORY_RULES_DIR ?? '/opt/aifactory/rules/opengrep';

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

export function runScanners({ repo, out, rulesDir }) {
  const tools = {};
  for (const [name, c] of Object.entries(scannerCommands({ repo, out, rulesDir }))) {
    const r = spawnSync(c.cmd, c.args, { encoding: 'utf8', env: { ...process.env, HOME: '/tmp' }, timeout: 10 * 60 * 1000 });
    if (r.error || !c.ok.includes(r.status)) {
      tools[name] = { ran: false, error: r.error ? r.error.code ?? r.error.message : `exit ${r.status}` };
      process.stderr.write(`${name}: ${tools[name].error}\n${(r.stderr ?? '').slice(-2000)}\n`);
      continue;
    }
    const empty = c.emptyOn?.[r.status];
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
