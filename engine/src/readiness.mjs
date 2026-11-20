// Production-readiness facts, from a repository's .aifactory/readiness.json.
//
// Most of the itm8 Production Readiness Checklist is already covered, for free, by the gate's
// scanners (secrets, code security, dependency vulnerabilities), the test run and the branch
// ruleset (version control and review before merge) — those run in every zone. This module covers
// only the items the gate cannot verify from the code itself and that a person must confirm:
// ownership (a named system owner and business owner) and the declared checklist below. The policy
// applies these in yellow and red only; green is left to the free, automated checks.
//
// Opt-in: a repository with no manifest is unaffected (the policy's notDeclared action is "none").
// A repository that adds the manifest is held to it.

export const READINESS_FILE = '.aifactory/readiness.json';

// Checklist items that cannot be determined from the code, so the customer attests to them.
// Keys map to the itm8 Production Readiness Checklist; each must be the boolean true to count.
export const CHECKLIST_KEYS = ['ownersInformed', 'businessTestingComplete', 'risksAndRollbackConsidered', 'changeApproved', 'privacyAssessed'];

const named = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {(relPath: string) => (string | null)} readFile reads a repository file, or null if absent/unreadable.
 * @returns {{declared: boolean, unreadable?: boolean, ownersMissing?: boolean, incomplete?: string[]}}
 */
export function readReadiness(readFile) {
  const raw = readFile(READINESS_FILE);
  if (raw == null) return { declared: false };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { declared: true, unreadable: true };
  }
  if (!data || typeof data !== 'object') return { declared: true, unreadable: true };
  const checklist = data.checklist && typeof data.checklist === 'object' ? data.checklist : {};
  return {
    declared: true,
    ownersMissing: !(named(data.systemOwner) && named(data.businessOwner)),
    incomplete: CHECKLIST_KEYS.filter((k) => checklist[k] !== true),
  };
}
