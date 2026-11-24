// Text people cannot see but a model reads. Unicode tag characters (U+E0000 to U+E007F) mirror
// printable ASCII and render as nothing, so they can carry an instruction to the AI review that no
// person reviewing the change would notice. Bidirectional controls can make code read differently
// from how it runs. Both are shown to the models in a visible form, and hidden tag text is reported
// without a model: outside an emoji flag it has no use in code or docs.

const TAGS = '[\\u{E0000}-\\u{E007F}]+';
// A subdivision flag: the black flag, tag letters or digits, the cancel tag (England's flag, say).
const FLAG = '\\u{1F3F4}[\\u{E0061}-\\u{E007A}\\u{E0030}-\\u{E0039}]{2,8}\\u{E007F}';
// Embedding, override and isolate controls (Trojan Source), the zero-width space and word joiner.
const CONTROL = '[\\u202A-\\u202E\\u2066-\\u2069\\u200B\\u2060]';

const HIDDEN = new RegExp(`(${FLAG})|(${TAGS})|${CONTROL}`, 'gu');
const ANY = new RegExp(`${TAGS}|${CONTROL}`, 'u');
const FLAGS = new RegExp(FLAG, 'gu');
const TAG_RUNS = new RegExp(TAGS, 'gu');

/** The ASCII a run of tag characters spells, with anything else as "?". */
export function decodeTags(run) {
  return [...run]
    .map((c) => {
      const cp = c.codePointAt(0) - 0xe0000;
      return cp >= 0x20 && cp < 0x7f ? String.fromCharCode(cp) : '?';
    })
    .join('');
}

/**
 * The text with hidden characters made visible: tag text as ⟦hidden: …⟧, a control as ⟦U+202E⟧.
 * Emoji flags stay as they are. Line breaks never change, so line numbers stay true.
 */
export function revealHidden(text) {
  if (typeof text !== 'string' || !ANY.test(text)) return text;
  return text.replace(HIDDEN, (m, flag, tags) => {
    if (flag) return m;
    if (tags) return `⟦hidden: ${decodeTags(m)}⟧`;
    return `⟦U+${m.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`;
  });
}

/**
 * Hidden tag text in what the models are shown of a change, as reviewer-steering findings. Scans the
 * added and context lines of each patch, with their line numbers in the new file.
 * @param {{path: string, patch: string}[]} files
 */
export function hiddenTextFindings(files) {
  const findings = [];
  for (const f of files) {
    let line = 0;
    for (const raw of f.patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        line = Number(hunk[1]);
        continue;
      }
      if (!line || raw.startsWith('-') || raw.startsWith('\\')) continue;
      const spelled = (raw.slice(1).replace(FLAGS, '').match(TAG_RUNS) ?? []).map(decodeTags).join(' ').trim();
      if (spelled.replace(/[^A-Za-z]/g, '').length >= 3) {
        findings.push({
          tool: 'ai-review',
          rule: 'reviewer-steering',
          severity: 'high',
          file: f.path,
          line,
          title: 'Invisible characters hide text from people',
          message: `Invisible characters hide text from people: "${spelled.slice(0, 120)}"`,
          outcome: 'confirmed',
          detectedBy: 'hidden-text check',
        });
      }
      line++;
    }
  }
  return findings;
}
