/**
 * Graph nodes.
 *
 * A node does three things: obtain a child session for exactly one worker, run
 * that worker, and return a serializable state update. The worker implementations
 * live behind a registry, so the orchestration can be tested without them and so
 * a worker can never reach the graph's control flow.
 *
 * `inspect`, `baseline_verify`, and `research` are mandatory and fixed. Routing
 * does not begin until the system holds repository facts, a baseline, and release
 * evidence, because a decision made before then would be a guess.
 */

import {
  classifyRun,
  grantFor,
  upgradeRequestSchema,
  type CheckPurpose,
  type ElevationGrant,
  type Phase,
  type WorkerId,
} from "@safe-upgrade/domain";
import type { AuditLog } from "@safe-upgrade/evidence";
import type { ApprovedElevation, AuthorizationRuntime, WorkerHandle } from "@safe-upgrade/authorization";
import type { DecisionEngine } from "@safe-upgrade/jev";
import { decideRoute, type RouterConfig } from "./router.ts";
import { pendingApprovalsFor } from "./eligibility.ts";
import {
  latestChecksByPurpose,
  unverifiedFindings,
  type UpgradeState,
  type UpgradeStateUpdate,
} from "./state.ts";

export interface WorkerInput {
  readonly state: UpgradeState;
  /** Capability-scoped handle. The only way a worker reaches a tool. */
  readonly handle: WorkerHandle;
  readonly runtime: AuthorizationRuntime;
  readonly engine: DecisionEngine;
  readonly audit: AuditLog;
}

export type WorkerFn = (input: WorkerInput) => Promise<UpgradeStateUpdate>;

export type WorkerRegistry = Readonly<Record<WorkerId, WorkerFn>>;

export interface NodeDependencies {
  readonly runtime: AuthorizationRuntime;
  readonly engine: DecisionEngine;
  readonly audit: AuditLog;
  readonly workers: WorkerRegistry;
  readonly config: RouterConfig;
  readonly requiredCheckPurposes?: readonly CheckPurpose[];
  readonly partialAllowed?: boolean;
  /**
   * Approvals for this run, from outside it. Configuration, not state: a grant is
   * not something the graph can produce, and putting it in state would make it
   * something a worker's update could reach.
   */
  readonly elevationGrants?: readonly ElevationGrant[];
  readonly clock?: () => Date;
}

/**
 * Run one worker under its own child session.
 *
 * The session is created here and destroyed by the broker before this returns,
 * which is why the state update reports no active session: by the time the
 * update is persisted, the reference it would name is already gone. The
 * reference itself is recorded in the audit log, where it correlates the
 * delegation with the calls made under it.
 */
async function runWorker(
  dependencies: NodeDependencies,
  worker: WorkerId,
  phase: Phase,
  state: UpgradeState,
): Promise<UpgradeStateUpdate> {
  const workerFn = dependencies.workers[worker];
  // Approvals are matched here, in the graph, from recorded requests and grants
  // that came from outside the run. The worker is handed the resulting session; it
  // has no say in what went into it.
  const elevations = approvedElevations(state, worker, dependencies.elevationGrants ?? []);
  const update = await dependencies.runtime.broker.withWorker(
    worker,
    phase,
    (handle) =>
      workerFn({
        state,
        handle,
        runtime: dependencies.runtime,
        engine: dependencies.engine,
        audit: dependencies.audit,
      }),
    { elevations },
  );
  return {
    ...update,
    step: 1,
    workerAttempts: { [worker]: 1 },
    activeSessionRef: null,
  };
}

/**
 * Requests by this worker that a grant answers.
 *
 * Both sides have to already exist: a request recorded in state by an earlier
 * round, and a grant configured for this run. Nothing is inferred from a worker's
 * current output, so a worker cannot request and self-approve within one turn.
 */
function approvedElevations(
  state: UpgradeState,
  worker: WorkerId,
  grants: readonly ElevationGrant[],
): readonly ApprovedElevation[] {
  const approved: ApprovedElevation[] = [];
  for (const request of state.elevationRequests) {
    if (request.worker !== worker) {
      continue;
    }
    const grant = grantFor(request, grants);
    if (grant !== null) {
      approved.push({ request, grant });
    }
  }
  return approved;
}

/**
 * Turn an unexpected failure into a recorded blocking condition.
 *
 * An authorization denial reaches here as a typed error. It is recorded and the
 * graph moves to a controlled finish; it is never retried with wider authority,
 * and it never crashes the run without an explanation.
 */
function asBlockingCondition(worker: WorkerId, error: unknown): UpgradeStateUpdate {
  const message = error instanceof Error ? error.message : String(error);
  return {
    step: 1,
    workerAttempts: { [worker]: 1 },
    activeSessionRef: null,
    blockingConditions: [`${worker} could not complete: ${message}`],
  };
}

export function createNodes(dependencies: NodeDependencies): Readonly<Record<Phase, (state: UpgradeState) => Promise<UpgradeStateUpdate>>> {
  const workerNode =
    (worker: WorkerId, phase: Phase, nextPhase: Phase) =>
    async (state: UpgradeState): Promise<UpgradeStateUpdate> => {
      try {
        const update = await runWorker(dependencies, worker, phase, state);
        // A worker may set the next phase itself, for instance to record a
        // blocking condition; otherwise the fixed successor applies.
        return { phase: nextPhase, ...update };
      } catch (error) {
        return asBlockingCondition(worker, error);
      }
    };

  const inspect = workerNode("inspector", "inspect", "baseline_verify");

  return {
    /**
     * Validate the request before touching the repository. The CLI validates too,
     * but a graph can also be resumed from a checkpoint or invoked directly, and
     * the first node is the last place this can be caught cheaply.
     */
    inspect: async (state) => {
      const parsed = upgradeRequestSchema.safeParse(state.request);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ");
        return { step: 1, blockingConditions: [`the upgrade request is not valid: ${detail}`] };
      }
      return inspect(state);
    },
    baseline_verify: workerNode("inspector", "baseline_verify", "research"),
    research: workerNode("researcher", "research", "route"),

    route: async (state) => {
      const route = await decideRoute(state, {
        engine: dependencies.engine,
        config: dependencies.config,
        audit: dependencies.audit,
        ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      });
      return {
        step: 1,
        phase: route.decision.selected,
        routeHistory: [route.decision],
        pendingApprovals: pendingApprovalsFor(state, dependencies.elevationGrants ?? []),
      };
    },

    assess_verification: workerNode("test_author", "assess_verification", "route"),
    author_tests: workerNode("test_author", "author_tests", "route"),
    implement: workerNode("implementer", "implement", "route"),
    configure_ci: workerNode("ci_author", "configure_ci", "route"),
    verify: workerNode("verifier", "verify", "route"),
    publish_draft: workerNode("publisher", "publish_draft", "finalize"),

    finalize: async (state) => {
      const requiredPurposes =
        dependencies.requiredCheckPurposes ?? (["install", "test", "typecheck"] as const);
      // Only the latest result per purpose counts: a failure that a later round
      // fixed is history, not an outstanding failure.
      const requiredChecks = latestChecksByPurpose(state.postChangeChecks).filter((check) =>
        requiredPurposes.includes(check.command.purpose),
      );
      const baselineRequiredFailure = latestChecksByPurpose(state.baselineChecks).some(
        (check) => requiredPurposes.includes(check.command.purpose) && check.outcome !== "passed",
      );

      const result = classifyRun({
        baselineKnown: state.baselineChecks.length > 0,
        baselineRequiredFailure,
        targetVersionResolved: state.targetVersionResolved,
        findingIds: state.findings.map((finding) => finding.id),
        addressedFindingIds: state.addressedFindingIds,
        verifiedFindingIds: state.verifiedFindingIds,
        requiredChecks,
        optionalCheckPurposes: [],
        diffPolicyPassed: state.diffPolicyPassed,
        ciSufficient: state.ciAssessment?.sufficient ?? false,
        highSeverityUncertainty: state.highSeverityUncertainty,
        blockingConditions: state.blockingConditions,
        prohibitedActions: state.prohibitedActions,
        pendingApprovals: state.pendingApprovals,
        partialAllowed: dependencies.partialAllowed ?? true,
        evidenceLinks: [],
        draftPullRequestUrl: state.draftPullRequestUrl,
        now: (dependencies.clock ?? (() => new Date()))().toISOString(),
      });

      dependencies.audit.record({
        phase: "finalize",
        type: "result_classified",
        payload: {
          status: result.status,
          reasons: result.reasons,
          unverifiedClaims: result.unverifiedClaims,
          unverifiedFindingCount: unverifiedFindings(state).length,
        },
      });

      return { step: 1, phase: "finalize", result };
    },
  };
}
