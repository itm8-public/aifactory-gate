// The judge: facts in, verdict out. Deterministic, no model. The rules live in policy/policy.v1.json.
// A verdict can only get stricter as facts are added: fail beats needs-person beats pass.
import { SEVERITIES } from './facts.mjs';

export const ZONES = ['green', 'yellow', 'red'];
const STRENGTH = { none: 0, pass: 0, 'needs-person': 1, fail: 2 };
const MAX_WHERE = 5;

/**
 * @param {object} input
 * @param {object} input.policy      parsed policy file
 * @param {string} input.zone        green | yellow | red
 * @param {string[]|null} input.files changed paths, null when they could not be read
 * @param {Record<string,string>} input.checks check name to outcome (success, failure, skipped, cancelled, not-configured)
 * @param {Record<string,{ran:boolean, error?:string}>} input.tools scanner name to whether it produced a result
 * @param {object[]} input.findings  findings from facts.mjs and, when it ran, the AI review
 * @param {{requested: boolean, error?: string, missing?: string[]}} [input.aiReview] `missing`: caller
 *        inputs left empty, so the review was not tried
 * @returns {{verdict: string, reasons: {action: string, text: string, id: string, where?: string[]}[]}}
 *          `id` names the kind of reason (report.mjs says who acts on it); `where` the files or
 *          file:line places it is about, when there are any.
 */
export function decide({ policy, zone, files, checks, tools, findings, aiReview = { requested: false } }) {
  if (!ZONES.includes(zone)) throw new Error(`unknown zone "${zone}"`);
  const reasons = [];
  const add = (action, id, text, where) => {
    if (action && action !== 'none') reasons.push({ action, id, text, ...(where?.length ? { where } : {}) });
  };

  for (const [name, state] of Object.entries(tools)) {
    if (!state.ran) add(policy.missingTool, 'tool-not-run', `${name} did not produce a result${state.error ? ` (${state.error})` : ''}`);
  }

  for (const [name, outcome] of Object.entries(checks)) {
    if (name === 'tests' && outcome === 'not-configured') add(policy.testsNotConfigured[zone], 'tests-not-configured', 'No tests are configured');
    else if (outcome === 'failure') add(policy.failedCheck, 'check-failed', `The check "${name}" failed`);
    else if (outcome !== 'success') add(policy.checkNotRun, 'check-not-run', `The check "${name}" did not run (${outcome || 'no result'})`);
  }

  const secrets = findings.filter((f) => f.tool === 'gitleaks');
  if (secrets.length) add(policy.secrets, 'secrets', `${secrets.length} possible secret(s) in the code`, places(secrets));

  const floor = SEVERITIES.indexOf(policy.failAtSeverity[zone]);
  const facts = findings.filter((f) => f.tool !== 'ai-review');
  const serious = facts.filter((f) => f.tool !== 'gitleaks' && SEVERITIES.indexOf(f.severity) >= floor);
  if (serious.length) add('fail', 'scanner-findings', `${serious.length} finding(s) at ${policy.failAtSeverity[zone]} severity or above`, places(serious));

  // The AI review can only make the verdict stricter. Its findings were checked against the code and
  // by a second model; an unconfirmed one is listed as low and cannot block.
  if (aiReview.requested) {
    const ai = policy.aiReview;
    // Values missing is a setup gap, not a review failure: say which, and where they come from. The
    // action is the same as for a review that did not complete.
    if (aiReview.missing?.length) add(ai.notCompleted, 'ai-values-missing', aiValuesMissing(aiReview.missing));
    else if (aiReview.error) add(ai.notCompleted, 'ai-not-completed', `The AI review did not complete (${aiReview.error})`);
    const fromAi = findings.filter((f) => f.tool === 'ai-review');
    const steering = fromAi.filter((f) => f.rule === 'reviewer-steering');
    if (steering.length) add(ai.reviewerSteering, 'ai-steering', `Text in the change tries to steer the AI review (${placesText(steering)})`, places(steering));
    const critical = fromAi.filter((f) => f.severity === 'critical' && f.rule !== 'reviewer-steering');
    if (critical.length) add(ai.critical, 'ai-critical', `The AI review confirmed ${critical.length} critical finding(s)`, places(critical));
    const high = fromAi.filter((f) => f.severity === 'high' && f.rule !== 'reviewer-steering');
    if (high.length) add(ai.high[zone], 'ai-high', `The AI review confirmed ${high.length} high finding(s)`, places(high));
  }

  if (files === null) add(policy.unreadableChanges, 'changes-unreadable', 'The changed files could not be read, so nothing is ruled out');
  else {
    for (const area of policy.areas) {
      const re = new RegExp(area.pattern, area.flags);
      const hit = files.filter((f) => re.test(f));
      if (hit.length) add(area.action[zone], `area:${area.id}`, area.reason, hit.slice(0, MAX_WHERE));
    }
  }

  const top = reasons.reduce((max, r) => Math.max(max, STRENGTH[r.action] ?? 1), 0);
  const verdict = top === 2 ? 'fail' : top === 1 ? 'needs-person' : 'pass';
  return { verdict, reasons };
}

/** Up to five distinct file:line places of findings, in order. */
function places(findings) {
  const seen = [...new Set(findings.filter((f) => f.file).map((f) => (f.line ? `${f.file}:${f.line}` : f.file)))];
  return seen.slice(0, MAX_WHERE);
}

/** "README.md line 217", "README.md line 217 and 1 more". */
function placesText(findings) {
  const [first] = findings;
  const rest = findings.length - 1;
  return `${first.file}${first.line ? ` line ${first.line}` : ''}${rest ? ` and ${rest} more` : ''}`;
}

/** The reason when the caller turned the AI review on without its values. */
export function aiValuesMissing(missing) {
  const one = missing.length === 1;
  return (
    `AI review is on, but ${one ? 'its value' : 'its values'} ${missing.join(', ')} ${one ? 'is' : 'are'} missing in .github/workflows/aifactory-gate.yml. ` +
    `${one ? 'It comes' : 'They come'} from the customer's page in the AI Factory Management App: set ${one ? 'it' : 'them'} with setup-repo.mjs --ai-review, or set ai-review: false until ${one ? 'it is' : 'they are'} there`
  );
}

/** Counts of findings per severity, for the summary and the verdict record. */
export function countBySeverity(findings) {
  return Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
}
