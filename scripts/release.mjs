// Release helper. `pin` writes the published image digest into the reusable workflow, so a release
// tag always runs exactly the image built from it. `promote` moves the stable channel (@v0) to a
// release that is on the prerelease channel (@v0-next) and has a green canary on the same commit.
//   node scripts/release.mjs pin ghcr.io/OWNER/aifactory-review@sha256:...
//   node scripts/release.mjs check VERSION      (fails unless VERSION matches package.json)
//   node scripts/release.mjs promote VERSION [--apply]
// `promote` needs the GitHub CLI signed in as a repository admin (the release-tags ruleset lets only
// admins move v* tags). It is a dry run until --apply. It checks the canary; the 48-hour soak on
// itm8's own repositories is a person's judgement, and it only reminds you of it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(root, '.github/workflows/gate.yml');
const IMAGE_LINE = /^(\s*GATE_IMAGE:\s*)\S+.*$/m;
const DIGEST_REF = /^ghcr\.io\/[a-z0-9-]+\/aifactory-review@sha256:[0-9a-f]{64}$/;

export const GATE_REPO = 'itm8-public/aifactory-gate';
// The commit status scripts/canary.mjs records on the gate commit it ran.
export const CANARY_CONTEXT = 'aifactory/canary';
export const SOAK_HOURS = 48;

export function pinImage(workflow, ref) {
  if (!DIGEST_REF.test(ref)) throw new Error(`not a digest reference: ${ref}`);
  if (!IMAGE_LINE.test(workflow)) throw new Error('GATE_IMAGE line not found in gate.yml');
  return workflow.replace(IMAGE_LINE, `$1${ref}`);
}

/** The digest reference gate.yml runs, or null when GATE_IMAGE is not pinned to a digest (main). */
export function pinnedImage(workflow) {
  const ref = workflow.match(IMAGE_LINE)?.[0].replace(/^\s*GATE_IMAGE:\s*/, '').replace(/\s+#.*$/, '').trim();
  return ref && DIGEST_REF.test(ref) ? ref : null;
}

export function checkVersion(version, pkgVersion) {
  const v = version.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`version must be MAJOR.MINOR.PATCH, got "${version}"`);
  if (v !== pkgVersion) throw new Error(`version ${v} does not match package.json ${pkgVersion}`);
  return { version: v, ...channels(v) };
}

/** `major` is the stable channel (@v0); `next` is the prerelease channel (@v0-next) a release publishes to first. */
export function channels(version) {
  const major = `v${String(version).replace(/^v/, '').split('.')[0]}`;
  return { major, next: `${major}-next` };
}

/**
 * Whether VERSION may move to the stable channel: its tag is the commit on the prerelease channel,
 * and the canary recorded success on that commit. `canary` is the aifactory/canary status from
 * GitHub's combined status of the commit (undefined when there is none).
 */
export function promotionCheck({ version, tagSha, nextSha, stableSha, canary, now = new Date() }) {
  const { major, next } = channels(version);
  const problems = [];
  if (!tagSha) {
    problems.push(`There is no tag v${version}. Publish it to @${next} first (README, Release).`);
    return { ok: false, problems, major, next, already: false, canaryHours: null };
  }
  if (tagSha !== nextSha) {
    problems.push(`v${version} is ${short(tagSha)}, but @${next} is ${short(nextSha)}. Only the release on @${next} can be promoted.`);
  }
  if (!canary) problems.push(`No canary result on ${short(tagSha)}. Run: node scripts/canary.mjs`);
  else if (canary.state !== 'success') {
    problems.push(`The canary on ${short(tagSha)} is ${canary.state}${canary.description ? ` (${canary.description})` : ''}. Fix it and run: node scripts/canary.mjs`);
  }
  const hours = canary?.state === 'success' ? (now - new Date(canary.updated_at ?? canary.created_at)) / 36e5 : null;
  return { ok: problems.length === 0, problems, major, next, already: tagSha === stableSha, canaryHours: hours };
}

const short = (sha) => (sha ? sha.slice(0, 7) : 'none');

function realGh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

const notFound = (err) => /HTTP 404|Not Found/i.test(`${err.stderr ?? ''}${err.stdout ?? ''}${err.message ?? ''}`);

/** The commit a tag points at (peeling an annotated tag), or null when there is no such tag. */
export function tagCommit(gh, repo, tag) {
  let obj;
  try {
    obj = JSON.parse(gh(['api', `repos/${repo}/git/ref/tags/${tag}`])).object;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
  while (obj.type === 'tag') obj = JSON.parse(gh(['api', `repos/${repo}/git/tags/${obj.sha}`])).object;
  return obj.sha;
}

function promote([version, ...flags], { gh, out }) {
  const apply = flags.includes('--apply');
  const unknown = flags.filter((f) => f !== '--apply');
  if (!version || unknown.length) throw new Error('usage: release.mjs promote VERSION [--apply]');
  const v = version.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`version must be MAJOR.MINOR.PATCH, got "${version}"`);
  const { major, next } = channels(v);
  const tagSha = tagCommit(gh, GATE_REPO, `v${v}`);
  const nextSha = tagCommit(gh, GATE_REPO, next);
  const stableSha = tagCommit(gh, GATE_REPO, major);
  const combined = tagSha ? JSON.parse(gh(['api', `repos/${GATE_REPO}/commits/${tagSha}/status`])) : { statuses: [] };
  const canary = combined.statuses.find((s) => s.context === CANARY_CONTEXT);
  const check = promotionCheck({ version: v, tagSha, nextSha, stableSha, canary });

  out(`v${v} = ${short(tagSha)}, @${next} = ${short(nextSha)}, @${major} = ${short(stableSha)}`);
  if (!check.ok) throw new Error(`v${v} cannot be promoted:\n- ${check.problems.join('\n- ')}`);
  out(`Canary green on ${short(tagSha)} ${check.canaryHours.toFixed(1)} h ago: ${canary.description ?? ''}`);
  if (check.already) {
    out(`@${major} is already v${v}. Nothing to change.`);
    return;
  }
  out(
    `\nBefore you apply: v${v} has run on itm8's own repositories that call @${next} for ${SOAK_HOURS} hours` +
      ' with no gate problem. This command does not check that.' +
      (check.canaryHours < SOAK_HOURS ? ` The canary passed only ${check.canaryHours.toFixed(1)} h ago.` : ''),
  );
  const calls = [
    { why: `Move @${major} to v${v} (all @${major} customers get it)`, args: ['api', '--method', 'PATCH', `repos/${GATE_REPO}/git/refs/tags/${major}`, '--input', '-'], body: { sha: tagSha, force: true } },
    { why: `Mark the GitHub release v${v} as stable and latest`, args: ['release', 'edit', `v${v}`, '-R', GATE_REPO, '--prerelease=false', '--latest'] },
  ];
  for (const call of calls) {
    out(`\n# ${call.why}\ngh ${call.args.filter((a) => a !== '--input' && a !== '-').join(' ')}${call.body ? ` ${JSON.stringify(call.body)}` : ''}`);
    if (apply) {
      gh(call.args, call.body ? JSON.stringify(call.body) : undefined);
      out('-> done');
    }
  }
  out(`\nRollback, if customers report a problem: gh api --method PATCH repos/${GATE_REPO}/git/refs/tags/${major} -f sha=${stableSha ?? 'PREVIOUS_SHA'} -F force=true`);
  out(apply ? `\nDone: @${major} runs v${v}.` : '\nDry run. Nothing was changed. Run again with --apply.');
}

export function run([command, ...rest], { gh = realGh, out = console.log } = {}) {
  if (command === 'pin') {
    writeFileSync(GATE, pinImage(readFileSync(GATE, 'utf8'), rest[0]));
    out(`gate.yml now runs ${rest[0]}`);
  } else if (command === 'check') {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const { version, major, next } = checkVersion(rest[0] ?? '', pkg.version);
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nmajor=${major}\nnext=${next}\n`, { flag: 'a' });
    out(`version=${version} major=${major} next=${next}`);
  } else if (command === 'promote') promote(rest, { gh, out });
  else throw new Error('command must be pin, check or promote');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    console.error(`release: ${err.message}`);
    process.exitCode = 1;
  }
}
