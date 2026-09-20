/**
 * Constraints the Tenuo core enforces but `@tenuo/core` does not yet export.
 *
 * The TypeScript package exports six helpers (`under`, `oneOf`, `pattern`,
 * `exact`, `max`, `email`) and types `Constraint` as a union of those six. The
 * Rust core reached through WASM understands considerably more, `urlSafe` among
 * them, and parses them from the same plain constraint objects the helpers
 * produce. So the capability we need is expressible today; it just has no helper
 * and no place in the exported union.
 *
 * Two facts make writing the object out by hand acceptable rather than reckless:
 *
 *   1. An unrecognised `kind` is rejected when the session is constructed, not
 *      at the first call. If a future release stops understanding `urlSafe`, the
 *      run fails immediately and loudly instead of quietly running unconstrained.
 *   2. An unrecognised *option* on a recognised kind is silently ignored, which
 *      does widen the constraint. `{ kind: "urlSafe", domains: [...] }` parses
 *      and enforces nothing but the built-in private-address blocking, because
 *      the option is spelled `allowDomains`. That failure mode is invisible, so
 *      the enforcement tests in tests/authorization/network-constraints.test.ts
 *      assert against real URLs rather than against this object's shape.
 *
 * `pattern()` is not an alternative here. It is a glob over the whole URL
 * string, and the glob that permits the release hosts also permits
 * `http://169.254.169.254/latest/meta-data/`.
 */

import type { ConstraintExpr } from "@tenuo/core";

/** Options the core recognises. Spelling matters; see note 2 above. */
interface UrlSafeOptions {
  readonly allowDomains: readonly string[];
  readonly schemes: readonly string[];
}

/**
 * SSRF-safe URL constraint, pinned to an explicit host and scheme allowlist.
 *
 * On top of the allowlist the core blocks private, loopback, link-local,
 * reserved, and cloud-metadata addresses, so an allowlisted name that resolves
 * inward is still refused.
 *
 * It does not check ports or embedded credentials. `fetch_release_document`
 * rejects both, and re-checks the host on every redirect hop, which the
 * constraint cannot see.
 */
export function urlSafe(options: UrlSafeOptions): ConstraintExpr {
  if (options.allowDomains.length === 0) {
    throw new Error("urlSafe() requires at least one allowed domain");
  }
  if (options.schemes.length === 0) {
    throw new Error("urlSafe() requires at least one scheme");
  }
  return {
    kind: "urlSafe",
    allowDomains: [...options.allowDomains],
    schemes: [...options.schemes],
    // Cast, not a lie: the core parses this shape, the exported union has not
    // caught up. The enforcement tests are what hold this claim to account.
  } as unknown as ConstraintExpr;
}

const SEMVER = "^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$";

/**
 * A version string and nothing else.
 *
 * `pattern()` cannot do this job. Its glob is not path-aware — `*` matches `/`
 * as readily as anything else, so `pattern("*.*.*")` accepts
 * `../../../etc/passwd`, which is precisely the value worth refusing when the
 * version is about to be interpolated into a registry URL.
 *
 * A regex may only be narrowed to an `Exact` value during delegation, never to
 * another glob or regex. That costs nothing here: no worker profile narrows the
 * version, because a researcher legitimately needs metadata for both the
 * installed version and the target.
 */
export function semver(): ConstraintExpr {
  return { kind: "regex", source: SEMVER } as unknown as ConstraintExpr;
}
