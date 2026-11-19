// The judge: facts in, verdict out. Deterministic, no model. The rules live in policy/policy.v1.json.
// A verdict can only get stricter as facts are added: fail beats needs-person beats pass.
import { SEVERITIES } from './facts.mjs';

export const ZONES = ['green', 'yellow', 'red'];
const STRENGTH = { none: 0, pass: 0, 'needs-person': 1, fail: 2 };

/**
 * @param {object} input
 * @param {object} input.policy      parsed policy file
 * @param {string} input.zone        green | yellow | red
 * @param {string[]|null} input.files changed paths, null when they could not be read
 * @param {Record<string,string>} input.checks check name to outcome (success, failure, skipped, cancelled, not-configured)
 * @param {Record<string,{ran:boolean, error?:string}>} input.tools scanner name to whether it produced a result
 * @param {object[]} input.findings  findings from facts.mjs and, when it ran, the AI review
 * @param {{requested: boolean, error?: string}} [input.aiReview]
 */
export function decide({ policy, zone, files, checks, tools, findings, aiReview = { requested: false } }) {
  if (!ZONES.includes(zone)) throw new Error(`unknown zone "${zone}"`);
  const reasons = [];
  const add = (action, text) => {
    if (action && action !== 'none') reasons.push({ action, text });
  };

  for (const [name, state] of Object.entries(tools)) {
    if (!state.ran) add(policy.missingTool, `${name} did not produce a result${state.error ? ` (${state.error})` : ''}`);
  }

  for (const [name, outcome] of Object.entries(checks)) {
    if (name === 'tests' && outcome === 'not-configured') add(policy.testsNotConfigured[zone], 'No tests are configured');
    else if (outcome === 'failure') add(policy.failedCheck, `The check "${name}" failed`);
    else if (outcome !== 'success') add(policy.checkNotRun, `The check "${name}" did not run (${outcome || 'no result'})`);
  }

  const secrets = findings.filter((f) => f.tool === 'gitleaks');
  if (secrets.length) add(policy.secrets, `${secrets.length} possible secret(s) in the code`);

  const floor = SEVERITIES.indexOf(policy.failAtSeverity[zone]);
  const facts = findings.filter((f) => f.tool !== 'ai-review');
  const serious = facts.filter((f) => f.tool !== 'gitleaks' && SEVERITIES.indexOf(f.severity) >= floor);
  if (serious.length) add('fail', `${serious.length} finding(s) at ${policy.failAtSeverity[zone]} severity or above`);

  // The AI review can only make the verdict stricter. Its findings were checked against the code and
  // by a second model; an unconfirmed one is listed as low and cannot block.
  if (aiReview.requested) {
    const ai = policy.aiReview;
    if (aiReview.error) add(ai.notCompleted, `The AI review did not complete (${aiReview.error})`);
    const fromAi = findings.filter((f) => f.tool === 'ai-review');
    const steering = fromAi.filter((f) => f.rule === 'reviewer-steering');
    if (steering.length) add(ai.reviewerSteering, 'Text in the change tries to steer the AI review');
    const critical = fromAi.filter((f) => f.severity === 'critical' && f.rule !== 'reviewer-steering');
    if (critical.length) add(ai.critical, `The AI review confirmed ${critical.length} critical finding(s)`);
    const high = fromAi.filter((f) => f.severity === 'high' && f.rule !== 'reviewer-steering');
    if (high.length) add(ai.high[zone], `The AI review confirmed ${high.length} high finding(s)`);
  }

  if (files === null) add(policy.unreadableChanges, 'The changed files could not be read, so nothing is ruled out');
  else {
    for (const area of policy.areas) {
      const re = new RegExp(area.pattern, area.flags);
      if (files.some((f) => re.test(f))) add(area.action[zone], area.reason);
    }
  }

  const top = reasons.reduce((max, r) => Math.max(max, STRENGTH[r.action] ?? 1), 0);
  const verdict = top === 2 ? 'fail' : top === 1 ? 'needs-person' : 'pass';
  return { verdict, reasons };
}

/** Counts of findings per severity, for the summary and the verdict record. */
export function countBySeverity(findings) {
  return Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
}
