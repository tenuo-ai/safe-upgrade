/**
 * Capabilities a human has to approve, one call at a time.
 *
 * Some writes are legitimate parts of an upgrade and still too consequential to
 * hand a worker by default. Setting `package.json`'s `type` field is the case that
 * forced this: it is exactly what a CommonJS-to-ESM upgrade requires, and it
 * changes how every file in the package loads.
 *
 * Four ways this differs from a boolean "approved" flag:
 *
 * The approval names the call, not the capability. A request carries the exact
 * argument values and the worker asking, and the grant carries only the request's
 * id, which is a digest of both. Approving `type: "module"` therefore cannot be
 * replayed as `type: "commonjs"`, and an approval given to the implementer does not
 * travel to the test author.
 *
 * The approval cannot widen anything. The elevated capability is still narrowed out
 * of the run's ceiling, so a grant for something the ceiling never permitted
 * produces nothing. What approval changes is whether a worker holds a capability
 * the run already had, never what the run is allowed to do.
 *
 * The request comes from a worker while the grant comes from outside the run. A
 * worker can ask; nothing it returns can answer.
 *
 * And the request is stable across runs. Its arguments are the values a person
 * would recognise — a worktree-relative path, a field name, a value — not the
 * absolute path of a temporary worktree that will not exist next time. Approving a
 * run that has already finished would otherwise be the only kind of approval
 * possible.
 */

import { createHash } from "node:crypto";

export interface ElevationRequest {
  /** Digest of worker, capability, and arguments. Recomputed on use, never trusted as given. */
  readonly id: string;
  /** The only worker this approval applies to. */
  readonly worker: string;
  readonly capability: string;
  /**
   * The authorization-relevant arguments, and only those.
   *
   * Strings, so the request is comparable, canonically serializable, and readable
   * by the person approving it. Paths are worktree-relative.
   *
   * Arguments that guard rather than permit are deliberately absent. An
   * `expectedBeforeHash` is a concurrency check, and folding it in here would mean
   * any unrelated edit to the file invalidated an approval that was about the field
   * and the value.
   */
  readonly arguments: Readonly<Record<string, string>>;
  /** What the worker needs it for, in terms a reviewer can weigh. */
  readonly reason: string;
  /** Findings this call serves, so the request can be traced to the evidence. */
  readonly findingIds: readonly string[];
}

export interface ElevationGrant {
  /** Must equal the id of the request being approved. */
  readonly id: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/**
 * Stable id for a requested call.
 *
 * Keys are sorted so two requests for the same call agree, and every part is
 * length-prefixed so `{a: "b:c"}` and `{"a:b": "c"}` cannot collide into the same
 * digest and let one approval cover the other.
 */
export function elevationId(
  worker: string,
  capability: string,
  args: Readonly<Record<string, string>>,
): string {
  const hash = createHash("sha256");
  for (const part of [worker, capability]) {
    hash.update(`${String(part.length)}:${part}`);
  }
  for (const key of Object.keys(args).sort()) {
    const value = args[key] ?? "";
    hash.update(`${String(key.length)}:${key}${String(value.length)}:${value}`);
  }
  return hash.digest("hex");
}

export function describeElevation(request: Omit<ElevationRequest, "id">): string {
  const pairs = Object.keys(request.arguments)
    .sort()
    .map((key) => `${key}=${request.arguments[key] ?? ""}`)
    .join(" ");
  return `${request.worker} calling ${request.capability} with ${pairs}`;
}

/** A request with its id derived rather than supplied. */
export function elevationRequest(input: Omit<ElevationRequest, "id">): ElevationRequest {
  return { ...input, id: elevationId(input.worker, input.capability, input.arguments) };
}

/**
 * Find the grant that approves this request, if there is one.
 *
 * The id is recomputed from the request's own fields before matching, so a request
 * carrying a borrowed id from some other approved call does not match that call's
 * grant.
 */
export function grantFor(
  request: ElevationRequest,
  grants: readonly ElevationGrant[],
): ElevationGrant | null {
  const expected = elevationId(request.worker, request.capability, request.arguments);
  return grants.find((grant) => grant.id === expected) ?? null;
}
