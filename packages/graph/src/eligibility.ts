/**
 * Deterministic eligibility predicates.
 *
 * The decision engine only ever sees actions that are already legal and already
 * make sense. That is the difference between "the model picked a bad step" and
 * "the model picked a step the system was willing to take": there is no prompt
 * wording that gets `publish_draft` offered before verification passed.
 */

import { count, describeElevation, grantFor } from "@safe-upgrade/domain";
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
  /** Stop after read-only coverage assessment. Writing workers are never eligible. */
  readonly assessmentOnly?: boolean;
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
      return `${count(uncovered.length, "finding")} ${uncovered.length === 1 ? "lacks" : "lack"} a verification path`;
    },
  },
  {
    action: "implement",
    evaluate: (state) => {
      // The dependency move comes first and does not wait for a finding to justify it.
      //
      // This rule used to be ineligible whenever research produced nothing, on the reasoning
      // that there was no migration work to do. But moving the dependency *is* the change
      // this run exists to make, and findings only describe extra work on top of it. With the
      // old rule, an upgrade whose research came back clean — which is most upgrades — went
      // all the way through routing, wrote a CI workflow, and finished without ever touching
      // the manifest. Real repositories showed this plainly: the patch contained a workflow
      // and no version change at all.
      // A finding whose change reaches test files needs the test author first.
      //
      // The implementer converts source and may not write tests, so going first leaves the
      // package half in each module system and fails a verification round for a reason that has
      // nothing to do with the upgrade. The deterministic order already preferred coverage here,
      // but a preference is only as good as whatever is doing the choosing: a live model, offered
      // the same two actions, picked migrating with 0.85 to 0.98 confidence, and the run that
      // reaches `verified` under the deterministic order came out `blocked`.
      //
      // So it is a constraint rather than a preference. Trusted code knows the cost, and nothing
      // in what the engine is shown could tell it.
      if (
        !testsChanged(state) &&
        unresolvedFindings(state).some((finding) => finding.spansTestFiles === true)
      ) {
        return null;
      }
      if (!state.dependencyMoved) {
        return "the dependency has not been moved to the target version yet";
      }
      const unresolved = unresolvedFindings(state);
      if (unresolved.length > 0) {
        return `${count(unresolved.length, "finding")} ${unresolved.length === 1 ? "is" : "are"} not yet implemented`;
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
      // Asking for a draft at the start of the run is the operator decision. A second
      // approval after `verified` made sense when a person was at a laptop and might not
      // want a remote branch. When the draft is the product — a Dependabot bump, a
      // scheduled upgrade — that gate stopped every clean lockfile change, which is most
      // of them. Elevation still stops the run; merging still takes a person.
      return "verification passed and a draft was requested";
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
    if (
      config.assessmentOnly === true &&
      rule.action !== "assess_verification" &&
      rule.action !== "finalize"
    ) {
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
  // A requested draft is no longer a pending approval. The operator asked for it
  // before the run; if verification passed, the publisher is eligible. What still
  // waits here is elevation: a capability no worker holds.
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
