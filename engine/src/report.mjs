// The summary a business user reads on the pull request. Plain language, no secret values.
// It opens with the concrete reason and the exact next step, then gives the detail.
import { SEVERITIES } from './facts.mjs';

// The one action the reader takes next, by verdict. Phrased so it holds whoever clears the
// verdict: on an organization repository that is the itm8 review team, on a personal one the
// repository admin, and for an ordinary green-zone infra change it can be the customer's own code
// owner. The policy engine cannot see who approves, so the wording stays general.
const NEXT_STEP = {
  pass: 'This change can be merged.',
  fail: 'Fix the point(s) below, then push again — the gate re-runs automatically.',
  'needs-person': 'A reviewer must approve this change before it can be merged.',
};

const MAX_LISTED = 20;

/** The opening line: the concrete reason(s) for the verdict, then the next step. */
function lead(verdict, reasons) {
  const next = NEXT_STEP[verdict] ?? '';
  if (verdict === 'pass') return next;
  const want = verdict === 'fail' ? 'fail' : 'needs-person';
  const primary = reasons.filter((r) => r.action === want);
  if (!primary.length) return next;
  const verb = verdict === 'fail' ? 'Must fix' : 'Needs a person';
  const more = primary.length > 1 ? ` (and ${primary.length - 1} more below)` : '';
  return `**${verb}: ${escape(primary[0].text)}${more}.** ${next}`;
}

export function summary(record) {
  const { verdict, reasons, counts, findings, zone, level, enforced, versions } = record;
  const lines = [
    `## aifactory gate: ${verdict}`,
    '',
    lead(verdict, reasons),
    '',
    ...(record.explanation ? ['### In plain words', '', escape(record.explanation), ''] : []),
    `Zone ${zone}, responsibility level ${level}${enforced ? '' : ' (advisory: this result does not block)'}.`,
    '',
  ];
  if (reasons.length) {
    lines.push('### Why', '');
    for (const r of reasons) lines.push(`- ${r.action === 'fail' ? 'Must fix' : 'Needs a person'}: ${r.text}`);
    lines.push('');
  }
  lines.push('### Findings', '', '| Critical | High | Medium | Low |', '| --- | --- | --- | --- |');
  lines.push(`| ${SEVERITIES.slice().reverse().map((s) => counts[s]).join(' | ')} |`, '');
  const listed = findings
    .slice()
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity))
    .slice(0, MAX_LISTED);
  if (listed.length) {
    lines.push('<details><summary>Details</summary>', '');
    for (const f of listed) {
      const where = f.file ? ` in \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      const label = f.tool === 'ai-review' ? `AI review${f.outcome === 'uncertain' ? ' (not confirmed)' : ''}` : f.tool;
      lines.push(`- **${f.severity}** ${label} \`${f.rule}\`${where}: ${escape(f.message)}`);
    }
    if (findings.length > MAX_LISTED) lines.push(`- and ${findings.length - MAX_LISTED} more in the verdict file`);
    lines.push('', '</details>', '');
  }
  const ai = record.aiReview?.deployments
    ? `, AI review prompt ${record.aiReview.promptVersion} (${Object.entries(record.aiReview.deployments)
        .map(([role, d]) => `${role} ${d}`)
        .join(', ')})`
    : '';
  lines.push(
    `<sub>Engine ${versions.engine}, policy ${versions.policy}, ${Object.entries(versions.tools)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}${ai}.</sub>`,
  );
  return lines.join('\n');
}

function escape(text) {
  return String(text).replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\r?\n/g, ' ');
}
