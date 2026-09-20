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
import { join } from "node:path";
import {
  parseOrThrow,
  upgradeRequestSchema,
  type CheckPurpose,
  type FinalResult,
  type RepositoryFacts,
  type UpgradeRequest,
} from "@safe-upgrade/domain";
import { AuditLog, type AuditEvent } from "@safe-upgrade/evidence";
import { detectRepositoryFacts, isolateRepository } from "@safe-upgrade/bootstrap";
import { createDevAuthorizationRuntime } from "@safe-upgrade/authorization";
import { buildGraph, type RouterConfig, type UpgradeState } from "@safe-upgrade/graph";
import { DeterministicEngine, type DecisionEngine } from "@safe-upgrade/jev";
import { createWorkerRegistry } from "@safe-upgrade/workers";

export interface RunOptions {
  /** The user's checkout. Read, never written. */
  readonly repositoryPath: string;
  readonly packageName: string;
  readonly targetVersion: string;
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
  readonly router?: Partial<RouterConfig>;
  readonly partialAllowed?: boolean;
  readonly clock?: () => Date;
}

export interface RunReport {
  readonly runId: string;
  readonly request: UpgradeRequest;
  readonly result: FinalResult;
  readonly facts: RepositoryFacts;
  readonly startCommit: string;
  readonly sourceClean: boolean;
  readonly detectionWarnings: readonly string[];
  readonly absentChecks: readonly CheckPurpose[];
  readonly finalState: UpgradeState;
  readonly events: readonly AuditEvent[];
  readonly artifactsDirectory: string | undefined;
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
      commandTimeoutMs: 10 * 60_000,
    });

    // Validated here rather than trusted from the caller: the graph validates
    // again at the first node, but the ceilings below are built from these values.
    const request = parseOrThrow(upgradeRequestSchema, {
      runId,
      repositoryPath: isolation.worktreePath,
      packageName: options.packageName,
      targetVersion: options.targetVersion,
      allowTransitive: options.allowTransitive ?? false,
      createDraftPullRequest: options.createDraftPullRequest ?? false,
    }, "upgrade request");

    const artifactsDirectory = options.artifactsDirectory;
    if (artifactsDirectory !== undefined) {
      mkdirSync(artifactsDirectory, { recursive: true });
    }
    const audit = new AuditLog({
      runId,
      ...(artifactsDirectory === undefined ? {} : { directory: artifactsDirectory }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

    const runtime = createDevAuthorizationRuntime({
      runId,
      worktreeRoot: isolation.worktreePath,
      packageManager: detection.facts.packageManager,
      defaultBranch: isolation.defaultBranch,
      runBranch: isolation.runBranch,
      requestedPackage: options.packageName,
      targetVersion: options.targetVersion,
      audit,
    });

    // Everything the workers are told, in one value, all of it produced by
    // trusted code before any worker held a capability.
    const workers = createWorkerRegistry({
      request,
      facts: detection.facts,
      checkScripts: detection.checkScripts,
      absentChecks: detection.absentChecks,
      startCommit: isolation.startCommit,
      sourceClean: isolation.sourceClean,
      detectionWarnings: detection.warnings,
    });

    const graph = buildGraph({
      runtime,
      engine: options.engine ?? new DeterministicEngine(),
      audit,
      workers,
      config: { ...DEFAULT_ROUTER, ...options.router },
      // A check the repository does not define cannot be required. Requiring a
      // typecheck of a repository with no typecheck script would report a missing
      // gate as a failure of this run.
      requiredCheckPurposes: requiredPurposes(detection.checkScripts),
      partialAllowed: options.partialAllowed ?? true,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }).compile();

    const finalState = (await graph.invoke({ request })) as UpgradeState;

    const result = finalState.result;
    if (result === null) {
      throw new Error("the graph finished without classifying a result");
    }

    const report: RunReport = {
      runId,
      request,
      result,
      facts: detection.facts,
      startCommit: isolation.startCommit,
      sourceClean: isolation.sourceClean,
      detectionWarnings: detection.warnings,
      absentChecks: detection.absentChecks,
      finalState,
      events: audit.events,
      artifactsDirectory,
    };

    if (artifactsDirectory !== undefined) {
      audit.writeArtifact("result.json", `${JSON.stringify(result, null, 2)}\n`);
      audit.writeArtifact("report.md", renderReport(report));
    }
    return report;
  } finally {
    isolation.release();
  }
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
  const lines: string[] = [
    `# Upgrade run ${report.runId}`,
    "",
    `**Result:** ${result.status}`,
    "",
    `- Package: \`${report.request.packageName}\` ${facts.currentVersion} to ${report.request.targetVersion}`,
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
  section(
    "Checks",
    [...finalState.baselineChecks, ...finalState.postChangeChecks].map(
      (check) =>
        `${check.command.purpose} (${check.outcome}) — \`${check.command.executable} ${check.command.args.join(" ")}\``,
    ),
  );
  section(
    "Checks this repository does not define",
    report.absentChecks.map((purpose) => `${purpose}: no runnable script, so no gate`),
  );
  section("Detection warnings", report.detectionWarnings);
  section("Findings", finalState.findings.map((finding) => `${finding.id}: ${finding.releaseClaim}`));
  section("Residual uncertainty", finalState.highSeverityUncertainty);
  section("Prohibited actions", finalState.prohibitedActions);

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
