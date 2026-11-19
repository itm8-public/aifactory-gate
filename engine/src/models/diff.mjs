// The change under review, as patches per file, with limits so a large change cannot flood a model.
import { execFileSync } from 'node:child_process';

export const LIMITS = { totalChars: 80_000, fileChars: 12_000, context: 5 };
const SKIP = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock)$|\.(min\.js|map|svg|png|jpe?g|gif|ico|woff2?|pdf|zip)$/i;

/** Splits `git diff` output into { path, patch } per file. */
export function splitDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const header = chunk.split('\n', 1)[0];
    const m = / b\/(.+)$/.exec(header);
    if (m) files.push({ path: m[1], patch: `diff --git ${chunk}` });
  }
  return files;
}

/** Applies the limits: lock files and binaries out, long patches cut, total capped. */
export function limitDiff(files, limits = LIMITS) {
  const kept = [];
  let total = 0;
  let truncated = false;
  for (const f of files) {
    if (SKIP.test(f.path) || /^Binary files /m.test(f.patch)) continue;
    let patch = f.patch;
    if (patch.length > limits.fileChars) {
      patch = `${patch.slice(0, limits.fileChars)}\n[... cut: the rest of this file's change is not shown]`;
      truncated = true;
    }
    if (total + patch.length > limits.totalChars) {
      truncated = true;
      break;
    }
    kept.push({ path: f.path, patch });
    total += patch.length;
  }
  return { files: kept, truncated };
}

export function readDiff(repo, base) {
  const git = (args) =>
    execFileSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const from = git(['merge-base', base, 'HEAD']).trim();
  return limitDiff(splitDiff(git(['diff', `-U${LIMITS.context}`, '--no-renames', '--no-color', from, 'HEAD'])));
}
