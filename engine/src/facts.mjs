// Reads scanner output into one finding shape:
//   { tool, rule, severity: critical|high|medium|low, file, line, message }
// Secrets never leave this module: gitleaks runs with --redact and only rule, file and line are kept.

export const SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** A CVSS-style score (0 to 10) as a severity. */
export function severityFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 9) return 'critical';
  if (n >= 7) return 'high';
  if (n >= 4) return 'medium';
  return 'low';
}

const WORD_SEVERITY = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low' };

/** gitleaks JSON report (an array). Every secret is critical. */
export function gitleaksFindings(report) {
  if (!Array.isArray(report)) throw new Error('gitleaks report is not an array');
  return report.map((f) => ({
    tool: 'gitleaks',
    rule: String(f.RuleID ?? 'secret'),
    severity: 'critical',
    file: String(f.File ?? ''),
    line: Number(f.StartLine) || 0,
    message: String(f.Description ?? 'Possible secret'),
  }));
}

const SARIF_LEVEL = { error: 'high', warning: 'medium', note: 'low', none: 'low' };

/** SARIF 2.1.0 from opengrep. `security-severity` on the rule wins over the result level. */
export function sarifFindings(sarif, tool = 'opengrep') {
  if (!sarif || !Array.isArray(sarif.runs)) throw new Error(`${tool} SARIF has no runs`);
  const findings = [];
  for (const run of sarif.runs) {
    const rules = new Map((run.tool?.driver?.rules ?? []).map((r) => [r.id, r]));
    for (const result of run.results ?? []) {
      const rule = rules.get(result.ruleId);
      const loc = result.locations?.[0]?.physicalLocation;
      const level = result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
      findings.push({
        tool,
        // Opengrep prefixes rule ids with the rule file's path (opt.aifactory.rules.opengrep.<id>).
        rule: String(result.ruleId ?? 'unknown').split('.').pop(),
        severity: severityFromScore(rule?.properties?.['security-severity']) ?? SARIF_LEVEL[level] ?? 'medium',
        file: String(loc?.artifactLocation?.uri ?? ''),
        line: Number(loc?.region?.startLine) || 0,
        message: String(result.message?.text ?? rule?.shortDescription?.text ?? '').slice(0, 300),
      });
    }
  }
  return findings;
}

/** osv-scanner v2 JSON. One finding per vulnerability group of a package. */
export function osvFindings(report) {
  if (!report || !Array.isArray(report.results ?? [])) throw new Error('osv report has no results');
  const findings = [];
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const vulns = new Map((pkg.vulnerabilities ?? []).map((v) => [v.id, v]));
      const groups = pkg.groups?.length ? pkg.groups : (pkg.vulnerabilities ?? []).map((v) => ({ ids: [v.id] }));
      for (const group of groups) {
        const words = group.ids.map((id) => WORD_SEVERITY[String(vulns.get(id)?.database_specific?.severity ?? '').toLowerCase()]);
        const severity =
          severityFromScore(group.max_severity) ??
          SEVERITIES[Math.max(...words.map((w) => SEVERITIES.indexOf(w ?? 'medium')))] ??
          'medium';
        findings.push({
          tool: 'osv-scanner',
          rule: group.ids[0],
          severity,
          file: String(result.source?.path ?? ''),
          line: 0,
          message: `${pkg.package?.name}@${pkg.package?.version}: ${vulns.get(group.ids[0])?.summary ?? group.ids.join(', ')}`.slice(0, 300),
        });
      }
    }
  }
  return findings;
}

export const READERS = {
  gitleaks: { file: 'gitleaks.json', read: gitleaksFindings },
  opengrep: { file: 'opengrep.sarif', read: (j) => sarifFindings(j, 'opengrep') },
  'osv-scanner': { file: 'osv.json', read: osvFindings },
};
