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

/** One exact package and version this run may move. */
export interface UpgradeTarget {
  readonly packageName: string;
  readonly targetVersion: string;
}

export interface UpgradeRequest {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly packageName: string;
  readonly targetVersion: string;
  /**
   * Further exact packages this run may move, with the primary.
   *
   * Empty on a single-package run. Each entry is a name and version the
   * command line or a grouped Dependabot event named; nothing else is added
   * here because a peer that was only inferred would widen the ceiling.
   */
  readonly companions: readonly UpgradeTarget[];
  /**
   * Workspace directory this run upgrades in, relative to the repository root.
   *
   * Empty means the root. A Dependabot title's `in /packages/app` and `--workspace`
   * both land here as `packages/app`.
   */
  readonly workspace: string;
  readonly allowTransitive: boolean;
  readonly createDraftPullRequest: boolean;
}

/** The primary package and every companion, in that order. */
export function upgradeTargets(request: UpgradeRequest): readonly UpgradeTarget[] {
  return [
    { packageName: request.packageName, targetVersion: request.targetVersion },
    ...request.companions,
  ];
}

/** Name to exact version, for ceilings and the tool-body pair check. */
export function requestedUpdates(request: UpgradeRequest): Readonly<Record<string, string>> {
  const updates: Record<string, string> = {};
  for (const target of upgradeTargets(request)) {
    updates[target.packageName] = target.targetVersion;
  }
  return updates;
}

/** The version installed today for a package this run named. */
export function currentVersionOf(
  facts: RepositoryFacts,
  packageName: string,
  primaryPackage: string,
): string {
  if (packageName === primaryPackage) {
    return facts.currentVersion;
  }
  return facts.companions.find((entry) => entry.packageName === packageName)?.currentVersion ?? "";
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
  /**
   * Workspace this run is scoped to, relative to the repository root.
   *
   * Empty means the root package. Used as the npm/pnpm `--workspace` / `--filter`
   * path. Yarn needs a package name, which is `workspaceSelector` when the
   * manager is yarn.
   */
  readonly workspace: string;
  /**
   * Argument the package manager wants when scoping a command.
   *
   * Path for npm and pnpm, package name for yarn, empty at the root.
   */
  readonly workspaceSelector: string;
  readonly workspacePackageName: string;
  /** Installed versions of companion packages, resolved the same way as `currentVersion`. */
  readonly companions: readonly CompanionFact[];
  readonly verificationCommands: readonly CommandSpec[];
  readonly existingCiFiles: readonly string[];
}

export interface CompanionFact {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly declaredRange: string;
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
   * Set when no rule in this system can discharge the finding.
   *
   * The implementer stops on one of these and reports it instead of attempting it. Without that,
   * a finding nothing can address stays unresolved, the implementer stays eligible, and the run
   * spends its attempts rewriting a lockfile — which is what happened before the first of these
   * existed.
   */
  readonly needsHuman?: boolean;
  /**
   * Set when the change this finding calls for reaches test files.
   *
   * The implementer may not write tests, so a finding like this one cannot be discharged by a
   * single worker: the test author has to move its files first, or the implementer converts the
   * source, the tests go on loading it the old way, and verification fails for a reason that has
   * nothing to do with whether the upgrade works.
   *
   * Recorded here so that routing can enforce the order instead of preferring it. A live model
   * asked to choose between migrating and covering picked migrating with high confidence, which
   * turned a run that reaches `verified` into one that reports `blocked` — the cost of the choice
   * is not visible in anything the engine is shown, so the choice should not be offered.
   */
  readonly spansTestFiles?: boolean;
  /**
   * A runtime version range something outside the source has to satisfy.
   *
   * Carried structurally rather than left for a later worker to read back out of
   * `releaseClaim`. That claim is a sentence, and it mentions two ranges — the new
   * requirement and the old one — so anything parsing it is guessing which is which.
   */
  readonly requiredNodeRange?: string;
  /**
   * A removed export whose replacement the release note and the new surface agree on.
   *
   * Present only when the old name is gone, the new name exists, and the note
   * says one became the other. The implementer may then rename call sites.
   */
  readonly replacement?: {
    readonly packageName: string;
    readonly from: string;
    readonly to: string;
  };
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
