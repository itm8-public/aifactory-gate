// What a person reads on the pull request: the job summary (summary.md) and, when the caller allows
// it, the same text as one pull request comment (comment.md). Plain language, no secret values.
// It opens with the concrete reason and the next step, says who acts and why, then gives a short
// "Fix it" block with a prompt any AI tool (Claude, GitHub Copilot, Lovable, Cursor) or a person can
// use. The prompt is built from fixed text, file paths and line numbers only, never from model output.
import { SEVERITIES } from './facts.mjs';
import { MODEL_RULES } from './models/prompts.mjs';

export const COMMENT_MARKER = '<!-- aifactory-gate -->';
export const DOCS = 'https://github.com/itm8-public/aifactory-gate/blob/main/docs/gate-verdicts-explained.md';
export const BYPASS_DOC = `${DOCS}#emergency-bypass`;
const MAX_LISTED = 20;
const MAX_LISTED_COMMENT = 8;

/**
 * Who acts on each kind of reason, and what the contributor can change. `kind`:
 *   finding  the contributor fixes it and pushes again;
 *   review   a person approves (or asks for a fix); the contributor can often avoid it;
 *   setup    the gate's configuration for this repository (itm8 or the customer admin);
 *   outage   the gate itself did not work: an itm8 problem, not the change;
 *   rerun    a check did not finish: run it again.
 */
const KINDS = {
  'tool-not-run': { kind: 'outage' },
  'ai-not-completed': { kind: 'outage' },
  'changes-unreadable': { kind: 'outage' },
  'check-not-run': {
    kind: 'rerun',
    fix: () => 'Run the gate again (push to the branch, or re-run the job). If the tests hang or take longer than 30 minutes, make them finish.',
  },
  'ai-values-missing': { kind: 'setup' },
  'tests-not-configured': {
    kind: 'review',
    fix: () => 'Add tests for the app. itm8 sets the test command in `.github/workflows/aifactory-gate.yml` (a CI file): ask itm8 to switch it on.',
  },
  'check-failed': {
    kind: 'finding',
    fix: () => "Run the project's tests and fix what fails, then push again.",
    prompt: () => "The project's tests fail. Run them, find the cause and fix the code (or the test, if the test is wrong). Do not skip or delete tests to make them pass.",
  },
  secrets: {
    kind: 'finding',
    fix: (r) =>
      `Remove the secret from ${list(r.where)}. Rotate it where it was issued: it is in the branch history now. Read it from configuration instead (an environment variable, or the secret settings of GitHub or the hosting service).`,
    prompt: (r) =>
      `Possible secrets at ${list(r.where, false)}. Remove each one from the code and read it from configuration instead (an environment variable, or the secret settings of the hosting service). Do not paste the secret into this chat. Tell me which secrets to rotate.`,
  },
  'scanner-findings': {
    kind: 'finding',
    fix: (r) => `Fix the findings at ${list(r.where)}. Details lists each one with its rule.`,
    prompt: (r) => `Security scanners report findings at ${list(r.where, false)}. Fix each one in the code; do not silence the scanner.`,
  },
  'ai-high': {
    kind: 'finding',
    fix: (r) => `Fix what the AI review found at ${list(r.where)}. Details explains each finding.`,
    prompt: (r, f) => `The AI review confirmed problems at:\n${aiPlaces(r, f)}\nFix each one in the code.`,
  },
  'ai-critical': {
    kind: 'review',
    fix: (r) => `Fix what the AI review found at ${list(r.where)} and push again; the gate then runs again. Details explains each finding.`,
    prompt: (r, f) => `The AI review confirmed critical problems at:\n${aiPlaces(r, f)}\nFix each one in the code.`,
  },
  'ai-steering': {
    kind: 'review',
    fix: (r) =>
      `Rewrite the text at ${list(r.where)} as a description for people (what the gate or the review does). Do not address a reviewer or an AI, do not tell it what to report, and remove hidden characters or HTML comments meant for an AI.`,
    prompt: (r) =>
      `The gate's AI review read text at ${list(r.where, false)} as an attempt to steer it. Rewrite that text as a plain description for people of what the gate or the review does. It must not address a reviewer or an AI, tell it what to report, skip or approve, or hide text (invisible characters, HTML comments meant for an AI). Keep the meaning for human readers.`,
  },
  'area:ci-infra': {
    kind: 'review',
    fix: (r) =>
      `It changes CI, deployment or infrastructure files (${list(r.where)}). If you did not mean to, undo the changes to them. If you did, a person looks at them on purpose: next time keep such changes in a pull request of their own, so app changes are not held up.`,
    prompt: (r) =>
      `This pull request changes CI, deployment or infrastructure files: ${list(r.where, false)}. Ask me whether those changes were meant. If not, undo them. If they were, leave them as they are: a person at itm8 reviews them. Do not rename or move files to avoid that.`,
  },
  'area:identity': {
    kind: 'review',
    fix: (r) => `It changes sign-in, roles or permissions (${list(r.where)}), which a person reviews in this zone. Next time keep such changes in a pull request of their own.`,
  },
  'area:migration': {
    kind: 'review',
    fix: (r) => `It changes a database migration (${list(r.where)}), which a person reviews in this zone. Next time keep migrations in a pull request of their own.`,
  },
  'area:dependencies': {
    kind: 'review',
    fix: (r) => `It changes dependencies (${list(r.where)}), which a person reviews in this zone. Next time keep dependency updates in a pull request of their own.`,
  },
};

const kindOf = (r) => KINDS[r.id]?.kind ?? (r.action === 'fail' ? 'finding' : 'review');

/** Who clears a needs-person verdict: the ruleset's bypass actor (scripts/setup-repo.mjs). */
function reviewer(record) {
  const type = record.context?.ownerType;
  if (type === 'User') return { name: 'the repository admin', short: 'The repository admin' };
  if (type === 'Organization') return { name: 'the itm8 review team', short: 'itm8' };
  return { name: 'a reviewer', short: 'A reviewer', detail: 'on an organization repository the itm8 review team, on a personal one the repository admin' };
}

/** The verdict in one sentence: the main reason, and what happens next. */
function lead(record, groups) {
  const { verdict, reasons, enforced } = record;
  if (verdict === 'pass') return 'This change can be merged.';
  const advisory = enforced ? '' : ' Level 1 is advice: this result does not block the merge.';
  if (verdict === 'fail') {
    const primary = reasons.filter((r) => r.action === 'fail');
    return `**Must fix: ${escape(primary[0].text)}${more(primary)}.** Fix it on the same branch and push again: the gate runs again by itself.${advisory}`;
  }
  const primary = reasons.filter((r) => r.action === 'needs-person');
  if (groups.outage.length === primary.length) {
    return `**The gate could not finish: ${escape(primary[0].text)}${more(primary)}.** This is an itm8 problem, not a problem with your change.${advisory}`;
  }
  const first = primary.find((r) => kindOf(r) !== 'outage') ?? primary[0];
  const next = {
    setup: 'Nothing in your change causes this: itm8 or the customer admin must fix the gate setup of this repository.',
    rerun: 'Run the gate again: push to the branch, or re-run the job.',
  }[kindOf(first)];
  const then = next ?? (enforced ? `${capital(reviewer(record).name)} must approve this change before it can be merged.` : '');
  return `**Needs a person: ${escape(first.text)}${more(primary)}.** ${then}${advisory}`.trim();
}

function more(primary) {
  return primary.length > 1 ? ` (and ${primary.length - 1} more below)` : '';
}

function group(reasons) {
  const groups = { finding: [], review: [], setup: [], outage: [], rerun: [] };
  for (const r of reasons) groups[kindOf(r)].push(r);
  return groups;
}

/** "Who acts": one line per party that has something to do. */
function whoActs(record, groups) {
  const lines = [];
  const { enforced } = record;
  const mine = [...groups.finding, ...groups.rerun];
  if (mine.length) lines.push(`- **You (the contributor):** ${mine.map((r) => escape(r.text)).join('; ')}. See Fix it.`);
  if (groups.review.length) {
    const r = reviewer(record);
    lines.push(
      enforced
        ? `- **${r.short}** (${r.detail ?? r.name}): reviews and approves the change, or asks for a fix, because: ${groups.review.map((x) => escape(x.text)).join('; ')}. You can often avoid this: see Fix it.`
        : `- **No one has to approve it** (level 1, the customer is responsible), but a person should look at: ${groups.review.map((x) => escape(x.text)).join('; ')}.`,
    );
  }
  if (groups.setup.length) {
    lines.push(`- **itm8 or the customer admin:** ${groups.setup.map((x) => escape(x.text)).join('; ')}. Nothing in your change causes this.`);
  }
  if (groups.outage.length) {
    lines.push(
      `- **itm8:** the gate itself did not work (${groups.outage.map((x) => escape(x.text)).join('; ')}). Nothing in your change causes this. Run the job again; if it keeps failing, tell itm8. If the change cannot wait, the customer admin can use the [emergency bypass](${BYPASS_DOC}).`,
    );
  }
  return lines;
}

/** Plain steps, and a prompt for an AI tool, built from fixed text and places only. */
function fixIt(record, groups) {
  const actionable = [...groups.finding, ...groups.rerun, ...groups.review].filter((r) => KINDS[r.id]?.fix);
  if (!actionable.length) return [];
  const steps = actionable.map((r) => KINDS[r.id].fix(r, record.findings ?? []));
  const lines = ['### Fix it', '', ...steps.map((s, i) => `${i + 1}. ${s}`), `${steps.length + 1}. After a change, push to the same branch: the gate runs again by itself.`, ''];
  const asks = actionable.filter((r) => KINDS[r.id].prompt).map((r) => KINDS[r.id].prompt(r, record.findings ?? []));
  if (asks.length) {
    const prompt = [
      `The itm8 AI Factory gate checked my pull request and returned "${record.verdict}". Help me change it so the gate can pass:`,
      ...asks.map((a) => `- ${a.replace(/\n/g, '\n  ')}`),
      'Rules: do not change .github/workflows/aifactory-gate.yml, CODEOWNERS or the gate settings to get past the gate. Never put a secret in the code or in this chat. Keep the change small and explain it to me in plain words. Then run the tests and push to the same branch.',
    ].join('\n');
    lines.push(
      '<details><summary>Prompt for your AI tool (Claude, GitHub Copilot, Lovable, Cursor) or for a person</summary>',
      '',
      '```text',
      prompt.replace(/```/g, "'''"),
      '```',
      '',
      '</details>',
      '',
    );
  }
  return lines;
}

/**
 * @param {object} record  the verdict record (verdict.mjs)
 * @param {{comment?: boolean}} [opts]  comment: the shorter text for the pull request comment
 */
export function summary(record, { comment = false } = {}) {
  const { verdict, reasons, counts, findings, zone, level, enforced, versions } = record;
  const groups = group(reasons);
  const lines = [...(comment ? [COMMENT_MARKER] : []), `## aifactory gate: ${verdict}`, ''];
  if (record.reused) lines.push(reusedNote(record.reused), '');
  lines.push(lead(record, groups), '');
  if (record.explanation) lines.push('### In plain words', '', escape(record.explanation), '');
  if (verdict !== 'pass') {
    const who = whoActs(record, groups);
    if (who.length) lines.push('### Who acts', '', ...who, '');
    lines.push(...fixIt(record, groups));
  }
  lines.push(`Zone ${zone}, responsibility level ${level}${enforced ? '' : ' (advisory: this result does not block)'}.`, '');
  if (reasons.length) {
    lines.push('### Why', '');
    for (const r of reasons) lines.push(`- ${r.action === 'fail' ? 'Must fix' : 'Needs a person'}: ${escape(r.text)}`);
    lines.push('');
  }
  if (comment) {
    lines.push(...findingList(findings, MAX_LISTED_COMMENT));
    if (record.context?.runUrl) lines.push(`Full result, with every finding: [the gate run](${record.context.runUrl}). How the gate decides: [verdicts explained](${DOCS}).`);
    return lines.join('\n');
  }
  lines.push('### Findings', '', '| Critical | High | Medium | Low |', '| --- | --- | --- | --- |');
  lines.push(`| ${SEVERITIES.slice().reverse().map((s) => counts[s]).join(' | ')} |`, '');
  lines.push(...findingList(findings, MAX_LISTED));
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

function findingList(findings, max) {
  const listed = findings
    .slice()
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity))
    .slice(0, max);
  if (!listed.length) return [];
  const lines = ['<details><summary>Details</summary>', ''];
  for (const f of listed) {
    const where = f.file ? ` in \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    const label = f.tool === 'ai-review' ? `AI review${f.outcome === 'uncertain' ? ' (not confirmed)' : ''}` : f.tool;
    lines.push(`- **${f.severity}** ${label} \`${f.rule}\`${where}: ${escape(f.message)}`);
  }
  if (findings.length > max) lines.push(`- and ${findings.length - max} more in the verdict file`);
  lines.push('', '</details>', '');
  return lines;
}

/** The note on a verdict reused from the pull request's gate run. */
function reusedNote(reused) {
  const pr = reused.pullRequest ? `pull request #${reused.pullRequest}` : 'the pull request';
  const run = reused.runUrl ? `[run ${reused.runId}](${reused.runUrl})` : `run ${reused.runId}`;
  return `_Verdict reused: the gate already judged exactly this change (tree \`${short(reused.tree)}\` on \`${short(reused.baseTree)}\`) for ${pr}, in ${run}. Nothing ran again: this is the result the pull request got._`;
}

/** The text for a gate that produced no verdict at all (gate.yml writes it when the engine did not run). */
export function outageText(runUrl) {
  return [
    '## aifactory gate: needs-person',
    '',
    '**The gate could not finish: it produced no verdict.** This is an itm8 problem, not a problem with your change.',
    '',
    '### Who acts',
    '',
    `- **itm8:** the gate itself did not work. Run the job again; if it keeps failing, tell itm8. If the change cannot wait, the customer admin can use the [emergency bypass](${BYPASS_DOC}).`,
    ...(runUrl ? ['', `[The gate run](${runUrl})`] : []),
  ].join('\n');
}

/** "`a.ts:3`, `b.ts:9`" (or without code marks for the prompt). */
function list(where = [], code = true) {
  if (!where.length) return code ? 'the places listed under Details' : 'the places the gate lists';
  return where.map((w) => (code ? `\`${w}\`` : w)).join(', ');
}

/** AI findings at the reason's places, with the fixed meaning of their rule (never model text). */
function aiPlaces(reason, findings) {
  const at = new Set(reason.where ?? []);
  const lines = findings
    .filter((f) => f.tool === 'ai-review' && at.has(`${f.file}:${f.line}`))
    .map((f) => `- ${f.file}:${f.line} (${f.rule}: ${MODEL_RULES[f.rule] ?? 'a rule of the itm8 scanner rule pack'})`);
  return [...new Set(lines)].join('\n') || `- ${list(reason.where, false)}`;
}

const short = (sha) => String(sha ?? '').slice(0, 7);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function escape(text) {
  return String(text).replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\r?\n/g, ' ');
}
