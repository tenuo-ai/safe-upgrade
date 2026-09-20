/**
 * Closed unions and record shapes shared by every package.
 *
 * Nothing here is a free-form status string: a run can only end in one of the
 * five `RunStatus` values, and only the phases named in `Phase` exist.
 */

export type RunStatus = "verified" | "partial" | "blocked" | "indeterminate" | "human_required";

export type WorkerId =
  | "inspector"
  | "researcher"
  | "test_author"
  | "implementer"
  | "ci_author"
  | "verifier"
  | "publisher";

export type Phase =
  | "inspect"
  | "baseline_verify"
  | "research"
  | "route"
  | "assess_verification"
  | "author_tests"
  | "implement"
  | "configure_ci"
  | "verify"
  | "publish_draft"
  | "finalize";

export type RoutableAction = Exclude<Phase, "inspect" | "baseline_verify" | "research" | "route">;

export type PackageManager = "npm" | "pnpm" | "yarn";

export type CheckPurpose = "install" | "test" | "typecheck" | "lint" | "build";

export interface UpgradeRequest {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly packageName: string;
  readonly targetVersion: string;
  readonly allowTransitive: boolean;
  readonly createDraftPullRequest: boolean;
}

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly purpose: CheckPurpose;
  readonly timeoutMs: number;
}

export interface RepositoryFacts {
  readonly worktreePath: string;
  readonly defaultBranch: string;
  readonly packageManager: PackageManager;
  readonly workspaceRoots: readonly string[];
  readonly manifests: readonly string[];
  readonly lockfile: string;
  /**
   * The exact version installed today, resolved from the lockfile.
   *
   * Every question research asks is about the difference between two concrete versions, and a
   * range cannot be compared, fetched, or classified as a major bump.
   */
  readonly currentVersion: string;
  /** What the manifest permits, which is usually a range and is what the edit replaces. */
  readonly declaredRange: string;
  readonly verificationCommands: readonly CommandSpec[];
  readonly existingCiFiles: readonly string[];
}

export type ReleaseSourceType = "registry" | "release" | "changelog" | "migration_guide";

export interface ReleaseEvidence {
  readonly id: string;
  readonly sourceUrl: string;
  readonly sourceType: ReleaseSourceType;
  readonly retrievedAt: string;
  readonly contentHash: string;
  readonly relevantExtract: string;
}

export interface MigrationFinding {
  readonly id: string;
  readonly releaseClaim: string;
  readonly evidenceIds: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly affectedFiles: readonly string[];
  readonly requiredChange: string;
  readonly confidence: number;
  /** Set when research concludes only a manifest and lockfile change is needed. */
  readonly noSourceChangeRequired?: boolean;
  /**
   * A runtime version range something outside the source has to satisfy.
   *
   * Carried structurally rather than left for a later worker to read back out of
   * `releaseClaim`. That claim is a sentence, and it mentions two ranges — the new
   * requirement and the old one — so anything parsing it is guessing which is which.
   */
  readonly requiredNodeRange?: string;
}

export type CheckOutcome = "passed" | "failed" | "timed_out" | "not_run";

/** Which pass a check belongs to, which is what spec 22 groups the check records by. */
export type CheckPhase = "baseline" | "focused" | "final";

export interface CheckResult {
  readonly command: CommandSpec;
  readonly phase: CheckPhase;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stdoutArtifact: string;
  readonly stderrArtifact: string;
  readonly outcome: CheckOutcome;
}

export interface FileChange {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly owner: WorkerId;
  readonly reason: string;
}

export type RouteSource = "jev" | "fallback";

export interface RouteDecision {
  readonly step: number;
  readonly from: Phase;
  readonly candidates: readonly RoutableAction[];
  readonly selected: RoutableAction;
  readonly worker: WorkerId | null;
  readonly source: RouteSource;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly fallbackReason: string | null;
  readonly decidedAt: string;
}

export interface TestAssessment {
  readonly sufficient: boolean;
  readonly uncoveredFindings: readonly string[];
  readonly rationale: string;
}

export interface CiAssessment {
  readonly sufficient: boolean;
  readonly selectedWorkflow?: string;
  readonly missingChecks: readonly CheckPurpose[];
}

/** A claim in the final report, tied to the audit events that support it. */
export interface EvidenceLink {
  readonly claim: string;
  readonly eventIds: readonly string[];
}

export interface FinalResult {
  readonly status: RunStatus;
  readonly reasons: readonly string[];
  readonly unverifiedClaims: readonly string[];
  readonly evidenceLinks: readonly EvidenceLink[];
  readonly draftPullRequestUrl: string | null;
  readonly classifiedAt: string;
}
