/**
 * The transition allowlist.
 *
 * This is the outer bound on where the workflow can go. It is a constant in
 * trusted code, so no decision engine, worker, or release note can introduce an
 * edge that is not written here.
 *
 * Every phase can reach `finalize`, because a blocking condition must always
 * have somewhere to land. Nothing can leave `finalize`.
 */

import type { Phase, RoutableAction, WorkerId } from "@safe-upgrade/domain";

export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  inspect: ["baseline_verify", "finalize"],
  baseline_verify: ["research", "finalize"],
  research: ["route", "finalize"],
  route: [
    "assess_verification",
    "author_tests",
    "implement",
    "configure_ci",
    "verify",
    "publish_draft",
    "finalize",
  ],
  assess_verification: ["route", "finalize"],
  author_tests: ["route", "finalize"],
  implement: ["route", "finalize"],
  configure_ci: ["route", "finalize"],
  verify: ["route", "finalize"],
  publish_draft: ["finalize"],
  finalize: [],
};

export function isLegalTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Phases a router may select. Everything before `route` is mandatory and fixed. */
export const ROUTABLE_ACTIONS: readonly RoutableAction[] = [
  "assess_verification",
  "author_tests",
  "implement",
  "configure_ci",
  "verify",
  "publish_draft",
  "finalize",
];

/**
 * Which worker performs each routable action.
 *
 * The engine selects an action; this map resolves the worker. That order matters:
 * a worker identity is never something a model supplies, so a compromised
 * response cannot ask for the implementer's capabilities while claiming to
 * write tests.
 */
export const ACTION_WORKER: Readonly<Record<RoutableAction, WorkerId | null>> = {
  assess_verification: "test_author",
  author_tests: "test_author",
  implement: "implementer",
  configure_ci: "ci_author",
  verify: "verifier",
  publish_draft: "publisher",
  finalize: null,
};
