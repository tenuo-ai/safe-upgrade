/**
 * The entrypoint that assembles a run.
 *
 * Order matters here and is not incidental. Isolation and detection happen
 * before any authority exists, because the capability ceilings are derived from
 * what they return: the worktree path that `under()` contains, the branch that
 * `exact()` pins, the package manager whose executable will be spawned. Only
 * once those are settled is a parent session minted, and only then can a worker
 * be delegated anything.
 *
 * The worktree is released in a `finally`, so a thrown error still leaves the
 * user's checkout without a stray worktree registration.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeArtifacts } from "./artifacts.ts";
import { describeProgress, type ProgressReporter } from "./progress.ts";
import { renderReviewNote } from "./review-note.ts";
import { join } from "node:path";
import {
  count,
  describeElevation,
  grantFor,
  parseOrThrow,
  PackageResolutionError,
  currentVersionOf,
  relateVersions,
  requestedUpdates,
  upgradeRequestSchema,
  upgradeTargets,
  type CheckPurpose,
  type ElevationGrant,
  type FinalResult,
  type Phase,
  type RepositoryFacts,
  type UpgradeRequest,
} from "@safe-upgrade/domain";
import { AuditLog, type AuditEvent } from "@safe-upgrade/evidence";
import { classifyRun } from "@safe-upgrade/domain";
import { detectRepositoryFacts, isolateRepository } from "@safe-upgrade/bootstrap";
import {
  createDevAuthorizationRuntime,
  createProductionAuthorizationRuntime,
} from "@safe-upgrade/authorization";
import { commentOnPullRequest, type GitHubToolOptions } from "@safe-upgrade/tools";
import { GraphRecursionError, MemorySaver } from "@langchain/langgraph";
import {
  buildGraph,
  classificationInput,
  superstepBudget,
  type RouterConfig,
  type UpgradeState,
} from "@safe-upgrade/graph";
import { DeterministicEngine, type DecisionEngine } from "@safe-upgrade/jev";
import { createWorkerRegistry, type PatchGenerator } from "@safe-upgrade/workers";

export interface RunOptions {
  /** The user's checkout. Read, never written. */
  readonly repositoryPath: string;
  readonly packageName: string;
  readonly targetVersion: string;
  /** Inspect, research, and assess coverage without offering a writing worker. */
  readonly assessmentOnly?: boolean;
  readonly companions?: readonly { readonly packageName: string; readonly targetVersion: string }[];
  readonly workspace?: string;
  /**
   * Defaults to a fresh UUID. Must be one: the domain schema requires it, and
   * two concurrent runs sharing an id would share a branch name.
   */
  readonly runId?: string;
  readonly startCommit?: string;
  readonly allowTransitive?: boolean;
  readonly createDraftPullRequest?: boolean;
  /** Where the audit log and check output are written. */
  readonly artifactsDirectory?: string;
  /** Defaults to the deterministic engine, which needs no network. */
  readonly engine?: DecisionEngine;
  /** Coding model used for structured repository-specific source and test patches. */
  readonly patchGenerator?: PatchGenerator;
  readonly router?: Partial<RouterConfig>;
  readonly partialAllowed?: boolean;
  /**
   * Approvals a person has already given, each naming one call by its request id.
   *
   * A run option rather than something the run can produce. A previous run reports
   * what it needs approved; approving it is an action outside the run, and the next
   * run is told the answer.
   */
  readonly approvals?: readonly ElevationGrant[];
  /**
   * Called once per node as the run proceeds, for a caller that wants to show progress.
   *
   * Progress only. Nothing a run concludes arrives this way, so a caller that ignores it sees
   * exactly the same report.
   */
  readonly onProgress?: ProgressReporter;
  /**
   * @deprecated Same as `createDraftPullRequest`. Kept so existing callers that passed
   * both flags keep working. Asking for a draft is now the decision to open one if
   * verification passes.
   */
  readonly publishApproved?: boolean;
  /**
   * Leave the classified verdict on this pull request.
   *
   * For a Dependabot bump the conversation is already there. Commenting works for
   * blocked and human_required runs, which never reach the publisher.
   */
  readonly commentPullRequest?: number;
  /** Repository and token for the draft pull request and any review comment. */
  readonly github?: GitHubToolOptions;
  /**
   * An externally issued warrant to run under.
   *
   * Absent means the development root, which mints its own authority and which Tenuo
   * refuses outside a development or test environment. Present means this process can
   * narrow what an issuer granted and cannot grant itself anything — which is the
   * difference spec 11 draws, so it is a caller's decision rather than a default.
   *
   * The key and the secret are named, not passed: the values stay in the environment and
   * out of this object, which is checkpointed and reported on.
   */
  readonly authorization?: ProductionAuthorization;
  readonly clock?: () => Date;
}

/**
 * Stop unless the target is actually ahead of what is installed.
 *
 * Every check in this system can pass on a downgrade, and the report would have described one
 * as an upgrade. A no-op is worth stopping for too: there is nothing to verify, and a run that
 * produces a CI workflow and a draft pull request for a version change that did not happen is
 * worse than one that says so in a sentence.
 */
function assertMovesForward(current: string, target: string, packageName: string): void {
  switch (relateVersions(current, target)) {
    case "ahead":
      return;
    case "same":
      throw new PackageResolutionError(
        `${packageName} is already at ${target}, so there is nothing for this run to upgrade`,
      );
    case "behind":
      throw new PackageResolutionError(
        `${packageName} is at ${current}, and ${target} is older. This run only moves a dependency forward: every check it performs can pass on a downgrade, so it would report one as a successful upgrade.`,
      );
    case "unordered":
      throw new PackageResolutionError(
        `${packageName} ${current} and ${target} differ only by a prerelease or build tag, and this run does not order those against each other. Name a version whose major, minor, or patch number is higher.`,
      );
  }
}

export interface ProductionAuthorization {
  /** Name of the variable holding the trusted issuer's hex public key. */
  readonly rootPublicKeyEnv: string;
  /** The warrant itself, issued by that issuer for this run. */
  readonly warrant: string;
  /** Name of the variable holding this holder's secret. */
  readonly holderSecretEnv: string;
}

export interface RunReport {
  readonly runId: string;
  readonly request: UpgradeRequest;
  /** The checkout supplied by the caller, retained for continuation commands. */
  readonly sourceRepositoryPath?: string;
  readonly result: FinalResult;
  readonly facts: RepositoryFacts;
  readonly startCommit: string;
  /** The one branch this run could have created and pushed. */
  readonly runBranch: string;
  readonly sourceClean: boolean;
  readonly detectionWarnings: readonly string[];
  readonly absentChecks: readonly CheckPurpose[];
  readonly finalState: UpgradeState;
  readonly events: readonly AuditEvent[];
  /** Approvals this run was given, so the report can tell granted from pending. */
  readonly approvals: readonly ElevationGrant[];
  readonly artifactsDirectory: string | undefined;
  /** Set when this run commented on an existing pull request. */
  readonly reviewCommentUrl?: string;
}

const DEFAULT_ROUTER: RouterConfig = {
  confidenceThreshold: 0.7,
  maxWorkerAttempts: 3,
  maxGraphSteps: 40,
};

export async function runUpgrade(options: RunOptions): Promise<RunReport> {
  const runId = options.runId ?? randomUUID();

  const isolation = isolateRepository({
    repositoryPath: options.repositoryPath,
    runId,
    ...(options.startCommit === undefined ? {} : { startCommit: options.startCommit }),
  });

  try {
    const detection = detectRepositoryFacts({
      worktreePath: isolation.worktreePath,
      defaultBranch: isolation.defaultBranch,
      packageName: options.packageName,
      companions: options.companions ?? [],
      workspace: options.workspace ?? "",
      commandTimeoutMs: 10 * 60_000,
    });

    const request = parseOrThrow(upgradeRequestSchema, {
      runId,
      repositoryPath: isolation.worktreePath,
      packageName: options.packageName,
      targetVersion: options.targetVersion,
      companions: options.companions ?? [],
      workspace: detection.facts.workspace,
      allowTransitive: options.allowTransitive ?? false,
      createDraftPullRequest: options.createDraftPullRequest ?? false,
    }, "upgrade request");

    for (const target of upgradeTargets(request)) {
      const current = currentVersionOf(detection.facts, target.packageName, request.packageName);
      assertMovesForward(current, target.targetVersion, target.packageName);
    }

    const artifactsDirectory = options.artifactsDirectory;
    if (artifactsDirectory !== undefined) {
      mkdirSync(artifactsDirectory, { recursive: true });
    }
    const audit = new AuditLog({
      runId,
      ...(artifactsDirectory === undefined ? {} : { directory: artifactsDirectory }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

    const runtimeOptions = {
      runId,
      worktreeRoot: isolation.worktreePath,
      packageManager: detection.facts.packageManager,
      defaultBranch: isolation.defaultBranch,
      runBranch: isolation.runBranch,
      requestedPackage: options.packageName,
      requestedUpdates: requestedUpdates(request),
      workspaceSelector: detection.facts.workspaceSelector,
      manifestPaths: detection.facts.manifests.map((manifest) => join(isolation.worktreePath, manifest)),
      ...(options.github === undefined ? {} : { github: options.github }),
      targetVersion: options.targetVersion,
      audit,
    };
    // Which root this run trusts, decided here and nowhere else.
    const runtime =
      options.authorization === undefined
        ? createDevAuthorizationRuntime(runtimeOptions)
        : createProductionAuthorizationRuntime({ ...runtimeOptions, ...options.authorization });

    // Everything the workers are told, in one value, all of it produced by
    // trusted code before any worker held a capability.
    const workers = createWorkerRegistry({
      request,
      facts: detection.facts,
      checkScripts: detection.checkScripts,
      absentChecks: detection.absentChecks,
      startCommit: isolation.startCommit,
      runBranch: isolation.runBranch,
      sourceClean: isolation.sourceClean,
      detectionWarnings: detection.warnings,
      ...(options.patchGenerator === undefined ? {} : { patchGenerator: options.patchGenerator }),
    });

    const routerConfig = {
      ...DEFAULT_ROUTER,
      ...options.router,
      ...(options.assessmentOnly === true ? { assessmentOnly: true } : {}),
    };
    const graph = buildGraph({
      runtime,
      engine: options.engine ?? new DeterministicEngine(),
      audit,
      workers,
      config: routerConfig,
      // A check the repository does not define cannot be required. Requiring a
      // typecheck of a repository with no typecheck script would report a missing
      // gate as a failure of this run.
      requiredCheckPurposes: requiredPurposes(detection.checkScripts),
      partialAllowed: options.partialAllowed ?? true,
      ...(options.approvals === undefined ? {} : { elevationGrants: options.approvals }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      // In process and for this run only. Nothing here resumes a graph across a restart, and the
      // checkpointer is not for that: it is what makes the last committed state readable after an
      // invoke throws, which is the difference between a failed run that reports what it did and
      // one that reports nothing.
    }).compile({ checkpointer: new MemorySaver() });

    const invocation = {
      configurable: { thread_id: runId },
      recursionLimit: superstepBudget(routerConfig.maxWorkerAttempts),
    };

    const classification = {
      requiredCheckPurposes: requiredPurposes(detection.checkScripts),
      partialAllowed: options.partialAllowed ?? true,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    };
    const finalState = await runGraph(
      graph,
      invocation,
      {
        request,
        // Either flag is the operator saying a verified run should open a draft.
        ...((options.createDraftPullRequest === true || options.publishApproved === true)
          ? { approvalGranted: true }
          : {}),
      },
      classification,
      options.onProgress,
    );

    const result = finalState.result;
    if (result === null) {
      throw new Error("the graph finished without classifying a result");
    }

    const reviewCommentUrl = await postReviewComment(options, {
      runId,
      request,
      result,
      facts: detection.facts,
      startCommit: isolation.startCommit,
      runBranch: isolation.runBranch,
      sourceClean: isolation.sourceClean,
      detectionWarnings: detection.warnings,
      absentChecks: detection.absentChecks,
      finalState,
      events: audit.events,
      approvals: options.approvals ?? [],
      artifactsDirectory,
    }, audit);

    const report: RunReport = {
      runId,
      request,
      sourceRepositoryPath: options.repositoryPath,
      result,
      facts: detection.facts,
      startCommit: isolation.startCommit,
      runBranch: isolation.runBranch,
      sourceClean: isolation.sourceClean,
      detectionWarnings: detection.warnings,
      absentChecks: detection.absentChecks,
      finalState,
      events: audit.events,
      approvals: options.approvals ?? [],
      artifactsDirectory,
      ...(reviewCommentUrl === undefined ? {} : { reviewCommentUrl }),
    };

    if (artifactsDirectory !== undefined) {
      audit.writeArtifact("result.json", `${JSON.stringify(result, null, 2)}\n`);
      audit.writeArtifact(
        "report.md",
        options.assessmentOnly === true ? renderAssessment(report) : renderReport(report),
      );
      // Last, and from the worktree before it is released: the diff is the evidence the
      // classification is a summary of.
      writeArtifacts(audit, report, isolation.patch());
    }
    return report;
  } finally {
    isolation.release();
  }
}

type CompiledGraph = ReturnType<ReturnType<typeof buildGraph>["compile"]>;
type Invocation = {
  readonly configurable: { readonly thread_id: string };
  readonly recursionLimit: number;
};

/**
 * Run the graph, and recover the last committed state if it runs out of supersteps.
 *
 * The budget is set above what the attempt caps allow, so reaching it means a rule that should
 * have stopped the run did not. That is worth reporting as a blocked run rather than as a crash:
 * the work is already done by then, and `writeArtifacts` runs afterwards from a worktree released
 * in the `finally` — so throwing here loses `patch.diff` and the diff with it, permanently. The
 * audit log survives because it appends as it goes, which is the only reason this was visible.
 */
async function runGraph(
  graph: CompiledGraph,
  invocation: Invocation,
  input: { readonly request: UpgradeRequest; readonly approvalGranted?: boolean },
  classification: Parameters<typeof classificationInput>[1],
  onProgress: ProgressReporter | undefined,
): Promise<UpgradeState> {
  try {
    // Streamed rather than invoked, so a caller can say what is happening while it happens.
    //
    // Both modes, for one reason each: `updates` names the node that just ran, and `values` is
    // the accumulated state in plain form. Taking the name from one and the contents from the
    // other avoids reading an update through its reducer wrappers, which is all `updates` would
    // give — an overwrite channel reports a wrapper rather than the value.
    let ran: Phase | null = null;
    let previous: UpgradeState | null = null;
    for await (const [mode, chunk] of await graph.stream(input, {
      ...invocation,
      streamMode: ["updates", "values"],
    })) {
      if (mode === "updates") {
        ran = (Object.keys(chunk as Record<string, unknown>)[0] ?? null) as Phase | null;
        continue;
      }
      const values = chunk as UpgradeState;
      if (onProgress !== undefined && ran !== null) {
        onProgress(describeProgress(ran, values, previous));
      }
      previous = values;
      ran = null;
    }
    // The final state from the checkpointer, which is the same read the recovery below makes.
    // `stream` yields per superstep and does not hand back an accumulated result.
    return (await graph.getState(invocation)).values as UpgradeState;
  } catch (error) {
    if (!(error instanceof GraphRecursionError)) {
      throw error;
    }
    const recovered = (await graph.getState(invocation)).values as UpgradeState;
    const limit = String(invocation.recursionLimit);
    return {
      ...recovered,
      result: classifyRun({
        ...classificationInput(recovered, classification),
        blockingConditions: [
          ...recovered.blockingConditions,
          `the run reached its limit of ${limit} steps without settling. The attempt caps should have stopped it first, so this is a defect in the routing rules rather than a property of this repository. What it had done by then is in the artifacts.`,
        ],
      }),
    };
  }
}

/**
 * Comment on an existing pull request after the run has a result.
 *
 * Not a graph node. Blocked and human_required never reach the publisher, and those
 * are the Dependabot cases a reviewer most needs to see. A refusal here is a
 * ToolExecutionError and fails the run: a comment that was asked for and not posted
 * would look like a silent success.
 */
async function postReviewComment(
  options: RunOptions,
  report: RunReport,
  audit: AuditLog,
): Promise<string | undefined> {
  if (options.commentPullRequest === undefined || options.github === undefined) {
    return undefined;
  }
  const posted = await commentOnPullRequest(
    options.github,
    options.commentPullRequest,
    renderReviewNote(report),
  );
  audit.record({
    phase: "finalize",
    type: "review_comment_posted",
    payload: { pullRequest: options.commentPullRequest, url: posted.url },
  });
  return posted.url;
}

/** Install always counts. Beyond that, only checks the repository actually has. */
function requiredPurposes(
  scripts: Readonly<Partial<Record<CheckPurpose, string>>>,
): readonly CheckPurpose[] {
  const purposes: CheckPurpose[] = ["install"];
  for (const purpose of ["typecheck", "test", "build"] as const) {
    if (scripts[purpose] !== undefined) {
      purposes.push(purpose);
    }
  }
  return purposes;
}

/** Human-readable counterpart to result.json, per spec section 16. */
export function renderReport(report: RunReport): string {
  const { result, facts, finalState } = report;
  const granted = new Set(
    finalState.elevationRequests
      .filter((request) => grantFor(request, report.approvals) !== null)
      .map((request) => request.id),
  );
  const lines: string[] = [
    `# Upgrade run ${report.runId}`,
    "",
    `**Result:** ${result.status}`,
    "",
    // The declared range is shown when it differs, because "^2.1.3 to 1.0.2" reads as the
    // upgrade someone asked for while 2.1.3 is the version this run actually compared against.
    `- Package: \`${report.request.packageName}\` ${facts.currentVersion}${
      facts.declaredRange === facts.currentVersion ? "" : ` (declared \`${facts.declaredRange}\`)`
    } to ${report.request.targetVersion}`,
    `- Repository: ${facts.worktreePath} at ${report.startCommit}`,
    `- Package manager: ${facts.packageManager} (${facts.lockfile})`,
    `- Source checkout clean at start: ${String(report.sourceClean)}`,
    "",
  ];

  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) {
      return;
    }
    lines.push(`## ${title}`, "", ...items.map((item) => `- ${item}`), "");
  };

  section("Why this result", result.reasons);
  section("What this run does not establish", result.unverifiedClaims);
  // Split, because the same purposes appear in both and an unlabelled list of six
  // entries reads as though the suite ran twice for no reason. Which side a check
  // fell on is what makes a failure attributable to the change.
  const describeCheck = (check: (typeof finalState.baselineChecks)[number]): string =>
    `${check.command.purpose} (${check.outcome}) — \`${check.command.executable} ${check.command.args.join(" ")}\``;
  section("Checks before the change", finalState.baselineChecks.map(describeCheck));
  section("Checks after the change", finalState.postChangeChecks.map(describeCheck));
  section(
    "Checks this repository does not define",
    report.absentChecks.map((purpose) => `${purpose}: no runnable script, so no gate`),
  );
  section("Detection warnings", report.detectionWarnings);
  section("Findings", finalState.findings.map((finding) => `${finding.id}: ${finding.releaseClaim}`));
  // Attributed, because "the run changed these files" and "this worker, holding this
  // capability, changed this file for this reason" are different claims, and only the
  // second one can be checked against the audit log.
  section(
    "Changes, and the worker that made each",
    finalState.fileChanges.map((change) => `\`${change.path}\` — ${change.owner}: ${change.reason}`),
  );
  section("Residual uncertainty", finalState.highSeverityUncertainty);
  section("Prohibited actions", finalState.prohibitedActions);
  section("CI that gates these checks, and what else it can do", finalState.ciWorkflowRisks);

  // The approval id is the whole point of this section. A run that reports
  // `human_required` and does not say what to approve, or how, has told the reader
  // that they are blocked without telling them what unblocks them.
  const ungranted = finalState.elevationRequests.filter(
    (request) => !granted.has(request.id),
  );
  if (ungranted.length > 0) {
    lines.push("## Approval needed before this can proceed", "");
    for (const request of ungranted) {
      lines.push(
        `### ${describeElevation(request)}`,
        "",
        `- Why: ${request.reason}`,
        `- Serves: ${request.findingIds.join(", ") || "no finding"}`,
        `- Approval id: \`${request.id}\``,
        "",
        "Nothing was written. Re-run with this id approved to let it proceed:",
        "",
        "```json",
        `{ "id": "${request.id}", "approvedBy": "<who>", "approvedAt": "<iso timestamp>" }`,
        "```",
        "",
      );
    }
  }

  if (finalState.draftPullRequestUrl !== null) {
    lines.push("## Published", "", `- Draft pull request: ${finalState.draftPullRequestUrl}`, "");
  } else if (finalState.fileChanges.length > 0) {
    // A run that produced a change and did not publish it has left that change in a
    // worktree that is removed when the run ends. Saying where it survives matters more
    // than it sounds: the alternative is a verified result whose work quietly disappears.
    // Deliberately not the worktree path — by the time anyone reads this, it is gone.
    lines.push(
      "## Not published",
      "",
      report.artifactsDirectory === undefined
        ? `- The change was made on \`${report.runBranch}\` in a worktree that has since been removed, and no artifact directory was given to keep it in.`
        : `- The change was made on \`${report.runBranch}\`. The worktree is gone; the diff is in \`${join(report.artifactsDirectory, "patch.diff")}\`.`,
      report.request.createDraftPullRequest
        ? "- A draft was requested but not opened, so verification did not pass or GitHub refused the push. The diff is the record of what this run did."
        : "- A draft was not requested, so nothing was pushed and no pull request exists.",
      "",
    );
  }

  if (report.artifactsDirectory !== undefined) {
    lines.push(
      "## Evidence",
      "",
      `- Audit log: \`${join(report.artifactsDirectory, "audit.jsonl")}\``,
      `- Authorization events: \`${join(report.artifactsDirectory, "authorization-events.jsonl")}\``,
      "",
    );
  }
  return lines.join("\n");
}

/** A first-run report that describes risk and the next action without implying a migration ran. */
export function renderAssessment(report: RunReport): string {
  const { facts, finalState, request } = report;
  const sourceRepositoryPath = report.sourceRepositoryPath ?? facts.worktreePath;
  const affectedFiles = [...new Set(finalState.findings.flatMap((finding) => finding.affectedFiles))];
  const migrationFindings = finalState.findings.filter(
    (finding) => finding.noSourceChangeRequired !== true,
  );
  const compatibilityFindings = finalState.findings.filter(
    (finding) => finding.noSourceChangeRequired === true,
  );
  const coverage = finalState.testAssessment;
  const lines: string[] = [
    `# Upgrade assessment for ${request.packageName}`,
    "",
    `- Current: \`${facts.currentVersion}\`${
      facts.declaredRange === facts.currentVersion ? "" : ` (declared \`${facts.declaredRange}\`)`
    }`,
    `- Target: \`${request.targetVersion}\``,
    `- Package manager: ${facts.packageManager}`,
    `- Repository: ${sourceRepositoryPath} at ${report.startCommit}`,
    "- Repository files changed: none",
    "",
    "## Assessment",
    "",
    `- Migration work: ${migrationFindings.length === 0 ? "no repository-specific source or test migration identified" : `required for ${count(affectedFiles.length, "affected file")}`}`,
    `- Compatibility checks: ${compatibilityFindings.length === 0 ? "none identified" : count(compatibilityFindings.length, "repository condition")}`,
    `- Existing verification: ${coverage === null ? "no coverage gap required assessment" : coverage.sufficient ? "covers the identified migration risk" : "does not cover all affected code"}`,
    "",
  ];

  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, "", ...items.map((item) => `- ${item}`), "");
  };
  const checks = finalState.baselineChecks.map(
    (check) => `${check.command.purpose}: ${check.outcome}`,
  );
  section("Current baseline", checks);
  if (finalState.findings.length > 0) {
    lines.push("## Impact on this repository", "");
    for (const finding of finalState.findings) {
      lines.push(`- ${finding.releaseClaim}`);
      lines.push(
        finding.affectedFiles.length === 0
          ? "  - Repository evidence: no source edit is currently indicated"
          : `  - Affected code: ${finding.affectedFiles.map((path) => `\`${path}\``).join(", ")}`,
        `  - Required work: ${finding.requiredChange}`,
      );
    }
    lines.push("");
  }
  if (finalState.findings.length === 0) {
    lines.push(
      "## Impact on this repository",
      "",
      "- No migration finding was established from the available package and repository evidence.",
      "",
    );
  }
  if (coverage !== null) {
    section("Verification coverage", [
      `${coverage.sufficient ? "Covered" : "Gap"}: ${coverage.rationale}`,
    ]);
  }
  section("Uncertainty to review", finalState.highSeverityUncertainty);

  const delegations = report.events.filter((event) => event.type === "session_delegated");
  const boundaries = delegations.map((event) => {
    const capabilities = event.payload["capabilities"];
    const held = Array.isArray(capabilities) ? capabilities.join(", ") : "no capabilities recorded";
    return `${event.worker ?? "worker"}: ${held}`;
  });
  section("Delegated access used for this assessment", [...new Set(boundaries)]);

  const workspace = request.workspace === "" ? "" : ` --workspace ${shellQuote(request.workspace)}`;
  lines.push(
    "## Apply the upgrade",
    "",
    "```bash",
    `pnpm safe-upgrade ${shellQuote(`${request.packageName}@${request.targetVersion}`)} --repository ${shellQuote(sourceRepositoryPath)}${workspace}`,
    "```",
    "",
    "The upgrade will run in another disposable worktree and ask for approval if a step needs authority outside its worker's warrant.",
    "",
  );
  if (report.artifactsDirectory !== undefined) {
    lines.push("## Evidence", "", `- Full record: \`${report.artifactsDirectory}\``, "");
  }
  return lines.join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
