// Reads the results folder, applies the policy and writes verdict.json and summary.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { READERS } from './facts.mjs';
import { countBySeverity, decide } from './policy.mjs';
import { readReadiness } from './readiness.mjs';
import { summary } from './report.mjs';

/** Paths changed between the merge base of `base` and HEAD, or null when git cannot tell. */
export function changedFiles(repo, base) {
  const git = (args) =>
    execFileSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const from = git(['merge-base', base, 'HEAD']).trim();
    return git(['diff', '--name-only', '--no-renames', '-z', from, 'HEAD']).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Findings and tool states from the results folder. A missing or unreadable file means the tool did not run. */
export function readResults(results) {
  const toolsFile = path.join(results, 'tools.json');
  const recorded = existsSync(toolsFile) ? JSON.parse(readFileSync(toolsFile, 'utf8')) : {};
  const tools = {};
  const findings = [];
  for (const [name, reader] of Object.entries(READERS)) {
    const file = path.join(results, reader.file);
    if (recorded[name] && !recorded[name].ran) {
      tools[name] = recorded[name];
      continue;
    }
    if (!existsSync(file)) {
      tools[name] = { ran: false, error: 'no result file' };
      continue;
    }
    try {
      findings.push(...reader.read(JSON.parse(readFileSync(file, 'utf8'))));
      tools[name] = { ran: true };
    } catch (err) {
      tools[name] = { ran: false, error: `unreadable result: ${err.message}` };
    }
  }
  return { tools, findings };
}

/**
 * Applies the policy and writes verdict.json and summary.md.
 * `ai` is the AI review's outcome when it was requested: { requested, findings, state, error }.
 * `explain` (optional) turns the record into plain words; its failure only drops the explanation.
 */
export async function buildVerdict({ repo, results, zone, level, base, checks, policy, versions, files, ai = { requested: false }, explain }) {
  const { tools } = readResults(results);
  // Scanners report paths as they saw them (/repo/src/a.ts in the image); show them repository-relative.
  const prefix = `${repo.replace(/[\\/]+$/, '')}/`;
  const scanned = readResults(results).findings.map((f) => (f.file.startsWith(prefix) ? { ...f, file: f.file.slice(prefix.length) } : f));
  const findings = [...scanned, ...(ai.findings ?? [])];
  const changed = files !== undefined ? files : changedFiles(repo, base);
  const aiReview = { requested: ai.requested, error: ai.error };
  const readiness = readReadiness((rel) => {
    try {
      return readFileSync(path.join(repo, rel), 'utf8');
    } catch {
      return null;
    }
  });
  const { verdict, reasons } = decide({ policy, zone, files: changed, checks, tools, findings, aiReview, readiness });
  const record = {
    verdict,
    zone,
    level,
    enforced: level >= 2,
    reasons,
    counts: countBySeverity(findings),
    tools,
    checks,
    readiness,
    aiReview: ai.requested ? { ...ai.state, error: ai.error ?? null } : { requested: false },
    changedFiles: changed === null ? null : changed.length,
    findings,
    versions,
    decidedAt: new Date().toISOString(),
  };
  if (explain) {
    try {
      record.explanation = await explain(record);
    } catch (err) {
      record.explanationError = err.message;
    }
  }
  writeFileSync(path.join(results, 'verdict.json'), JSON.stringify(record, null, 2));
  writeFileSync(path.join(results, 'summary.md'), summary(record));
  return record;
}
