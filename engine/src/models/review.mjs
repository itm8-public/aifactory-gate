// The model steps: find (model A), evidence check (deterministic), verify (model B), explain (model C).
// Returns findings for the policy; never a verdict. Any error is returned, never swallowed, so the
// policy can turn it into needs-person.
import { checkEvidence } from './evidence.mjs';
import { hiddenTextFindings, revealHidden } from './hidden.mjs';
import { EXPLAIN_SCHEMA, FIND_SCHEMA, MODEL_RULES, PROMPT_VERSION, VERIFY_SCHEMA, explainPrompt, findPrompt, verifyPrompt } from './prompts.mjs';

/**
 * @param {object} input
 * @param {{files: {path:string, patch:string}[], truncated: boolean}} input.diff
 * @param {(path: string) => string|null} input.readFile
 * @param {string[]} input.scannerRules  rule ids of the scanner rule pack
 * @param {string} input.zone
 * @param {object} input.models  role to { deployment, structured?, temperature? } (policy/models.v1.json)
 * @param {Function} input.complete  from createModelClient
 */
export async function reviewWithModels({ diff, readFile, scannerRules, zone, models, complete }) {
  const state = { promptVersion: PROMPT_VERSION, deployments: {}, usage: {}, found: 0, dropped: [], refuted: 0, uncertain: 0 };
  if (diff.files.length === 0) return { findings: [], state };
  const rules = { ...MODEL_RULES, ...Object.fromEntries(scannerRules.map((id) => [id, 'A rule of the itm8 scanner rule pack'])) };
  const call = async (role, prompt, schema, schemaName) => {
    const cfg = models[role];
    state.deployments[role] = cfg.deployment;
    const { data, usage } = await complete({ deployment: cfg.deployment, structured: cfg.structured !== false, temperature: cfg.temperature, schema, schemaName, ...prompt });
    state.usage[role] = usage;
    return data;
  };

  // Hidden text is found without a model, and the models see it in a visible form (so do their
  // quotes, which the evidence check compares with the same visible form of the file).
  const hidden = hiddenTextFindings(diff.files);
  state.hiddenText = hidden.length;
  const shown = { ...diff, files: diff.files.map((f) => ({ ...f, patch: revealHidden(f.patch) })) };
  const readShown = (p) => revealHidden(readFile(p));
  const withHidden = (findings) => [
    ...hidden,
    ...findings.filter((f) => !(f.rule === 'reviewer-steering' && hidden.some((h) => h.file === f.file && h.line === f.line))),
  ];

  const found = await call('find', findPrompt({ ...shown, rules, zone }), FIND_SCHEMA, 'findings');
  state.found = found.findings.length;
  const { kept, dropped } = checkEvidence({
    candidates: found.findings,
    readFile: readShown,
    changed: new Set(diff.files.map((f) => f.path)),
    rules: new Set(Object.keys(rules)),
  });
  state.dropped = dropped.map((d) => ({ file: d.file, line: d.line, rule: d.rule, why: d.dropped }));
  if (kept.length === 0) return { findings: withHidden([]), state };

  const verified = await call('verify', verifyPrompt({ candidates: kept, zone, rules }), VERIFY_SCHEMA, 'verification');
  const byIndex = new Map(verified.results.map((r) => [r.index, r]));
  const findings = [];
  kept.forEach((c, i) => {
    const v = byIndex.get(i);
    if (!v) throw new Error(`verifier gave no answer for finding ${i}`);
    if (v.outcome === 'refuted') return void state.refuted++;
    if (v.outcome === 'uncertain') state.uncertain++;
    findings.push({
      tool: 'ai-review',
      rule: c.rule,
      // An uncertain finding is listed but cannot block on its own.
      severity: v.outcome === 'confirmed' ? v.severity : 'low',
      file: c.file,
      line: c.line,
      title: c.title,
      message: `${c.title}. ${v.reason}`.slice(0, 300),
      outcome: v.outcome,
    });
  });
  return { findings: withHidden(findings), state };
}

/** Model C: plain words for the summary. It sees the result, never the code. */
export async function explainVerdict({ record, models, complete }) {
  const { data } = await complete({
    deployment: models.explain.deployment,
    structured: models.explain.structured !== false,
    temperature: models.explain.temperature,
    schema: EXPLAIN_SCHEMA,
    schemaName: 'explanation',
    ...explainPrompt(record),
  });
  return data.text.slice(0, 1200);
}
