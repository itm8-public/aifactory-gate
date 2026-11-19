// Deterministic check between the finder and the verifier: a finding survives only if its quote is
// really in that file near that line, the file is part of the change, and its rule exists.
// This removes invented findings before any second model call.

const WINDOW = 3;
const MIN_QUOTE = 8;
const norm = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * @param {object} input
 * @param {object[]} input.candidates   finder output
 * @param {(path: string) => string|null} input.readFile  file content at HEAD, null when missing
 * @param {Set<string>} input.changed   paths in the change
 * @param {Set<string>} input.rules     allowed rule ids
 */
export function checkEvidence({ candidates, readFile, changed, rules }) {
  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    const why = reject(c, { readFile, changed, rules });
    if (why) dropped.push({ ...c, dropped: why });
    else kept.push({ ...c, context: context(readFile(c.file), c.line) });
  }
  return { kept, dropped };
}

function reject(c, { readFile, changed, rules }) {
  if (!rules.has(c.rule)) return 'unknown rule';
  if (!changed.has(c.file)) return 'file not in the change';
  const text = readFile(c.file);
  if (text === null) return 'file not found';
  const quote = norm(c.quote);
  if (quote.length < MIN_QUOTE) return 'quote too short';
  const lines = text.split(/\r?\n/);
  if (c.line < 1 || c.line > lines.length) return 'line out of range';
  const from = Math.max(0, c.line - 1 - WINDOW);
  const to = Math.min(lines.length, c.line + WINDOW + quote.split(' ').length);
  if (!norm(lines.slice(from, to).join('\n')).includes(quote)) return 'quote not found at that line';
  return null;
}

/** About 30 numbered lines around the finding, for the verifier. */
export function context(text, line, radius = 15) {
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return lines
    .slice(from, to)
    .map((l, i) => `${from + i + 1}: ${l}`)
    .join('\n');
}
