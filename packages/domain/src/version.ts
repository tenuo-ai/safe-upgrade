/**
 * Ordering two exact versions, only as far as is needed to know an upgrade from its opposite.
 *
 * This is not a semver implementation and should not grow into one. The single question asked
 * here is whether a requested target is actually ahead of what the repository has, because a
 * run that answers "no" should stop before it does anything.
 *
 * That check was missing, and real repositories found it immediately: a run asked to move
 * `ansi-styles` from 6.2.3 to 6.2.1 rewrote the manifest, installed the older version, and
 * reported on it as an upgrade. Nothing downstream would have caught it — every check can pass
 * on a downgrade, and the report would have said so.
 */

/** How a target version relates to the installed one. */
export type VersionRelation = "ahead" | "same" | "behind" | "unordered";

export function relateVersions(current: string, target: string): VersionRelation {
  if (current === target) {
    return "same";
  }
  const from = parse(current);
  const to = parse(target);
  if (from === null || to === null) {
    return "unordered";
  }
  for (let index = 0; index < 3; index += 1) {
    const left = from.numbers[index] ?? 0;
    const right = to.numbers[index] ?? 0;
    if (right > left) {
      return "ahead";
    }
    if (right < left) {
      return "behind";
    }
  }
  // Same triple, different text: the difference is a prerelease or build tag. Ordering those
  // correctly is most of what makes semver hard, and guessing it wrong in either direction
  // means either refusing a real upgrade or performing a downgrade. Neither is worth the
  // guess, so the caller is told this pair is not ordered here.
  return "unordered";
}

function parse(version: string): { readonly numbers: readonly number[] } | null {
  const core = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (core === null) {
    return null;
  }
  return { numbers: [Number(core[1]), Number(core[2]), Number(core[3])] };
}
