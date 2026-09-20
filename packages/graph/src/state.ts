/**
 * Graph state.
 *
 * Everything here is serializable, non-secret, and safe to write to a checkpoint
 * that may be replayed later. Live Tenuo sessions are deliberately absent: the
 * only trace of one is `activeSessionRef`, an opaque key that resolves solely
 * through the in-memory registry and becomes meaningless once the node ends.
 *
 * Reducers are explicit. Evidence, findings, file changes, and route history
 * accumulate, because an append-only record is what makes the final report
 * auditable; everything else is replaced.
 */

import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import type {
  CheckPurpose,
  CheckResult,
  CiAssessment,
  ElevationRequest,
  FileChange,
  FinalResult,
  MigrationFinding,
  Phase,
  ReleaseEvidence,
  RepositoryFacts,
  RouteDecision,
  TestAssessment,
  UpgradeRequest,
  WorkerId,
} from "@safe-upgrade/domain";

const replace = <T>(fallback: () => T) =>
  Annotation<T>({ reducer: (_current: T, update: T) => update, default: fallback });

const append = <T>() =>
  Annotation<readonly T[], readonly T[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  });

/** Union of the two sets, order-independent, no duplicates. */
const union = () =>
  Annotation<readonly string[], readonly string[]>({
    reducer: (current, update) => [...new Set([...current, ...update])],
    default: () => [],
  });

/**
 * Append, but at most once per id.
 *
 * For values whose id *is* their identity. A worker that is routed to twice asks for
 * the same approval twice, and a report listing the same request three times is
 * asking the reader to check whether the three are actually the same.
 */
const appendDistinct = <T extends { readonly id: string }>() =>
  Annotation<readonly T[], readonly T[]>({
    reducer: (current, update) => {
      // The seen set grows as the update is walked, so duplicates arriving together in
      // one update are dropped too. Filtering only against `current` made this true of
      // repeated appends but not of a single one, which is a distinction no caller
      // should have to know about.
      const seen = new Set(current.map((value) => value.id));
      const added: T[] = [];
      for (const value of update) {
        if (!seen.has(value.id)) {
          seen.add(value.id);
          added.push(value);
        }
      }
      return [...current, ...added];
    },
    default: () => [],
  });

const counters = () =>
  Annotation<Readonly<Partial<Record<WorkerId, number>>>, Readonly<Partial<Record<WorkerId, number>>>>({
    reducer: (current, update) => {
      const merged: Partial<Record<WorkerId, number>> = { ...current };
      for (const [worker, count] of Object.entries(update) as [WorkerId, number][]) {
        merged[worker] = (merged[worker] ?? 0) + count;
      }
      return merged;
    },
    default: () => ({}),
  });

/**
 * Placeholder for a run invoked without a request.
 *
 * LangGraph builds channel defaults when the graph is compiled, so the default
 * cannot refuse to exist. Instead it is obviously unset, and the `inspect` node
 * validates the request before anything else happens.
 */
export const UNSET_REQUEST: UpgradeRequest = Object.freeze({
  runId: "",
  repositoryPath: "",
  packageName: "",
  targetVersion: "",
  allowTransitive: false,
  createDraftPullRequest: false,
});

export const UpgradeStateAnnotation = Annotation.Root({
  request: replace<UpgradeRequest>(() => UNSET_REQUEST),
  phase: replace<Phase>(() => "inspect"),
  /** Total nodes executed. Bounds the run independently of LangGraph's own limit. */
  step: Annotation<number, number>({ reducer: (current, update) => current + update, default: () => 0 }),

  repository: replace<RepositoryFacts | null>(() => null),
  releaseEvidence: append<ReleaseEvidence>(),
  findings: append<MigrationFinding>(),
  baselineChecks: append<CheckResult>(),
  postChangeChecks: append<CheckResult>(),
  fileChanges: append<FileChange>(),

  testAssessment: replace<TestAssessment | null>(() => null),
  ciAssessment: replace<CiAssessment | null>(() => null),

  routeHistory: append<RouteDecision>(),
  workerAttempts: counters(),
  /** Opaque handle to the session of the currently running node, if any. */
  activeSessionRef: replace<string | null>(() => null),

  addressedFindingIds: union(),
  verifiedFindingIds: union(),
  targetVersionResolved: replace<boolean>(() => false),
  diffPolicyPassed: replace<boolean>(() => true),
  lastVerification: replace<"not_run" | "passed" | "failed">(() => "not_run"),

  blockingConditions: append<string>(),
  highSeverityUncertainty: append<string>(),
  prohibitedActions: append<string>(),
  pendingApprovals: union(),
  /**
   * Calls a worker asked a human to approve. Append-only: a request that was
   * granted stays in the record, because the approval is part of why the run did
   * what it did.
   */
  elevationRequests: appendDistinct<ElevationRequest>(),

  approvalGranted: replace<boolean>(() => false),
  draftPullRequestUrl: replace<string | null>(() => null),
  result: replace<FinalResult | null>(() => null),
});

export type UpgradeState = typeof UpgradeStateAnnotation.State;
export type UpgradeStateUpdate = typeof UpgradeStateAnnotation.Update;

/**
 * Key names that must never appear in persisted state. Checked by a test against
 * a real checkpoint rather than trusted to review.
 */
export const FORBIDDEN_STATE_KEYS: readonly string[] = [
  "warrant",
  "holderKey",
  "holderSecret",
  "session",
  "parentSession",
  "childSession",
  "token",
  "apiKey",
  "secret",
  "privateKey",
];

/**
 * Credential-shaped key names, as a pattern rather than a substring list.
 *
 * `activeSessionRef` is the reason this is not a naive "contains 'session'"
 * check: an opaque reference to a session is exactly what state is supposed to
 * carry, while the session itself is what it must not.
 */
const CREDENTIAL_KEY =
  /(warrant|holder[_-]?(key|secret)|^tokens?$|token[_-]?(value|secret)?$|api[_-]?key|^secrets?$|secret[_-]?(key|value)?$|password|credential|private[_-]?key)/i;

const EXACT_FORBIDDEN_KEY: ReadonlySet<string> = new Set([
  "session",
  "sessions",
  "parentsession",
  "childsession",
]);

export function isForbiddenStateKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "activesessionref") {
    return false;
  }
  return EXACT_FORBIDDEN_KEY.has(lower) || CREDENTIAL_KEY.test(key);
}

/**
 * Shape a checkpoint must satisfy before it is restored. A checkpoint is
 * untrusted input: it may have been written by an older version, or edited.
 */
export const persistedStateSchema = z
  .object({
    phase: z.enum([
      "inspect",
      "baseline_verify",
      "research",
      "route",
      "assess_verification",
      "author_tests",
      "implement",
      "configure_ci",
      "verify",
      "publish_draft",
      "finalize",
    ]),
    step: z.number().int().nonnegative(),
  })
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (isForbiddenStateKey(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `persisted state must not contain '${key}'`,
        });
      }
    }
  });

/** True when a production source file has been changed by the implementer. */
export function implementationChanged(state: UpgradeState): boolean {
  return state.fileChanges.some((change) => change.owner === "implementer");
}

export function testsChanged(state: UpgradeState): boolean {
  return state.fileChanges.some((change) => change.owner === "test_author");
}

export function baselinePassed(state: UpgradeState): boolean {
  return state.baselineChecks.length > 0 && state.baselineChecks.every((check) => check.outcome === "passed");
}

export function unresolvedFindings(state: UpgradeState): readonly MigrationFinding[] {
  const addressed = new Set(state.addressedFindingIds);
  return state.findings.filter(
    (finding) => finding.noSourceChangeRequired !== true && !addressed.has(finding.id),
  );
}

/**
 * The final state of each check, keyed by purpose.
 *
 * Check results accumulate across verification rounds, which is what the evidence
 * record needs. The classifier needs the opposite: a failure that a later round
 * fixed must not count against the run, and a check that was never re-run must
 * not be quietly forgotten. Taking the last result per purpose gives both.
 */
export function latestChecksByPurpose(checks: readonly CheckResult[]): readonly CheckResult[] {
  const latest = new Map<CheckPurpose, CheckResult>();
  for (const check of checks) {
    latest.set(check.command.purpose, check);
  }
  return [...latest.values()];
}

export function unverifiedFindings(state: UpgradeState): readonly MigrationFinding[] {
  const verified = new Set(state.verifiedFindingIds);
  return state.findings.filter((finding) => !verified.has(finding.id));
}
