/**
 * Deterministic eligibility predicates.
 *
 * The decision engine only ever sees actions that are already legal and already
 * make sense. That is the difference between "the model picked a bad step" and
 * "the model picked a step the system was willing to take": there is no prompt
 * wording that gets `publish_draft` offered before verification passed.
 */

import { describeElevation, grantFor } from "@safe-upgrade/domain";
import type { ElevationGrant, RoutableAction } from "@safe-upgrade/domain";
import type { RouteCandidate } from "@safe-upgrade/jev";
import { ACTION_WORKER, TRANSITIONS } from "./transitions.ts";
import {
  implementationChanged,
  testsChanged,
  unresolvedFindings,
  unverifiedFindings,
  type UpgradeState,
} from "./state.ts";

export interface EligibilityConfig {
  readonly maxWorkerAttempts: number;
  readonly maxGraphSteps: number;
}

interface Rule {
  readonly action: RoutableAction;
  /** Returns the reason it is eligible, or null when it is not. */
  readonly evaluate: (state: UpgradeState, config: EligibilityConfig) => string | null;
}

const RULES: readonly Rule[] = [
  {
    action: "assess_verification",
    evaluate: (state) => {
      if (state.findings.length === 0) {
        return null;
      }
      if (state.testAssessment !== null) {
        return null; // Already assessed; assessing again would loop.
      }
      if (unverifiedFindings(state).length === 0) {
        // Every finding already has a verification path, so there is nothing to
        // assess. This is what keeps the test author out of a run whose existing
        // coverage is already sufficient.
        return null;
      }
      return "verification coverage for the findings has not been assessed yet";
    },
  },
  {
    action: "author_tests",
    evaluate: (state) => {
      // Ineligible when every finding already has a meaningful verification path.
      const uncovered = unverifiedFindings(state);
      if (uncovered.length === 0) {
        return null;
      }
      // Deliberately not gated on an assessment existing. The spec's fallback order
      // puts `author_tests` ahead of both `assess_verification` and `implement`, so
      // requiring an assessment first deadlocks: `implement` outranks the assessment
      // and wins every round, and the assessment never happens. The test author
      // assesses as part of authoring instead, and records the result, which is what
      // makes this rule stop being true.
      if (state.testAssessment?.sufficient === true) {
        return null;
      }
      return `${uncovered.length} finding(s) lack a verification path`;
    },
  },
  {
    action: "implement",
    evaluate: (state) => {
      // Ineligible until research produced a cited finding, or concluded that no
      // source change is required.
      if (state.findings.length === 0) {
        return null;
      }
      const unresolved = unresolvedFindings(state);
      if (unresolved.length > 0) {
        return `${unresolved.length} finding(s) are not yet implemented`;
      }
      if (state.lastVerification === "failed") {
        return "verification failed and the implementation may need revision";
      }
      return null;
    },
  },
  {
    action: "configure_ci",
    evaluate: (state) => {
      if (unresolvedFindings(state).length > 0) {
        // Not yet, rather than never. Configuring CI for an upgrade that has not been
        // made writes a workflow whose stated reason — that these are the checks the
        // upgrade was verified against — is not true, and a run blocked waiting for an
        // approval would otherwise spend its remaining steps doing exactly that.
        return null;
      }
      if (state.ciAssessment === null) {
        // Deliberately eligible. Only the CI author can establish what CI is missing,
        // so requiring an assessment first means no action ever sets one and `ciSufficient`
        // is permanently false — a run could never reach `verified` however good the
        // change was. It assesses as part of configuring, like the test author.
        return "whether CI re-runs these checks has not been established";
      }
      if (state.ciAssessment.sufficient) {
        return null;
      }
      return `CI is missing ${state.ciAssessment.missingChecks.join(", ") || "required checks"}`;
    },
  },
  {
    action: "verify",
    evaluate: (state) => {
      if (!implementationChanged(state) && !testsChanged(state)) {
        return null; // Nothing has changed, so there is nothing to verify.
      }
      if (unresolvedFindings(state).length > 0) {
        return null; // Verifying an incomplete migration wastes a clean install.
      }
      if (state.lastVerification === "passed") {
        return null;
      }
      return "changes are complete and ready for independent verification";
    },
  },
  {
    action: "publish_draft",
    evaluate: (state) => {
      if (!state.request.createDraftPullRequest) {
        return null;
      }
      if (state.lastVerification !== "passed") {
        return null;
      }
      if (state.draftPullRequestUrl !== null) {
        return null;
      }
      if (!state.approvalGranted) {
        // Not eligible, but not silently dropped either: the run records that a
        // human decision is the only thing standing in the way.
        return null;
      }
      return "verification passed and publishing is explicitly approved";
    },
  },
  {
    action: "finalize",
    evaluate: (state, config) => {
      if (state.blockingConditions.length > 0 || state.prohibitedActions.length > 0) {
        return "a blocking condition has been recorded";
      }
      if (state.step >= config.maxGraphSteps) {
        return "the graph step limit has been reached";
      }
      if (state.lastVerification === "passed") {
        return "verification passed";
      }
      return null;
    },
  },
];

/**
 * Actions that are both legal from the current phase and currently sensible,
 * with per-worker attempt limits applied.
 *
 * `finalize` is appended when nothing else qualifies, so the graph always has a
 * terminal move available and can never deadlock.
 */
/** Whether this worker has already asked for something nobody has granted. */
function awaitingApproval(
  state: UpgradeState,
  worker: string,
  grants: readonly ElevationGrant[],
): boolean {
  return state.elevationRequests.some(
    (request) => request.worker === worker && grantFor(request, grants) === null,
  );
}

export function eligibleActions(
  state: UpgradeState,
  config: EligibilityConfig,
  grants: readonly ElevationGrant[] = [],
): readonly RouteCandidate[] {
  const legal = new Set(TRANSITIONS.route);
  const candidates: RouteCandidate[] = [];

  for (const rule of RULES) {
    if (!legal.has(rule.action)) {
      continue;
    }
    const worker = ACTION_WORKER[rule.action];
    if (worker !== null && (state.workerAttempts[worker] ?? 0) >= config.maxWorkerAttempts) {
      continue; // Out of attempts. Retrying the same worker will not help.
    }
    if (worker !== null && awaitingApproval(state, worker, grants)) {
      // Nor will retrying a worker that is waiting on a person. It asked, it wrote
      // nothing, and nothing about the run has changed since — so it would ask again,
      // and do that until its attempts ran out. The request is already reported as a
      // pending approval, which is what actually moves the run forward.
      continue;
    }
    const reason = rule.evaluate(state, config);
    if (reason !== null) {
      candidates.push({ action: rule.action, worker, reason });
    }
  }

  if (!candidates.some((candidate) => candidate.action === "finalize")) {
    if (candidates.length === 0) {
      candidates.push({
        action: "finalize",
        worker: null,
        reason: "no other action is eligible",
      });
    }
  }
  return candidates;
}

/**
 * Approvals that are pending rather than missing: a technically valid next step
 * that only a human can authorize. Reported as `human_required`, not as failure.
 */
export function pendingApprovalsFor(
  state: UpgradeState,
  grants: readonly ElevationGrant[] = [],
): readonly string[] {
  const pending: string[] = [];
  if (
    state.request.createDraftPullRequest &&
    state.lastVerification === "passed" &&
    state.draftPullRequestUrl === null &&
    !state.approvalGranted
  ) {
    pending.push("draft pull request creation");
  }
  for (const request of state.elevationRequests) {
    if (grantFor(request, grants) !== null) {
      continue;
    }
    // The id is included because it is what a grant has to name. A pending approval
    // a person cannot act on is not much better than a silent failure.
    pending.push(`${describeElevation(request)} — ${request.reason} (approval id ${request.id})`);
  }
  return pending;
}
