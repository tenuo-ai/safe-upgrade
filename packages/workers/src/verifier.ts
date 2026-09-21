/**
 * Independent verifier, spec 13.6 and 14.6.
 *
 * Holds no write capability of any kind, which is the point: the worker that
 * decides whether the change is acceptable must not be able to adjust the change
 * or the tests to make it acceptable. Every judgement here is a read plus a
 * command.
 *
 * The runner supplies a disposable worktree. Before executing repository code,
 * this worker freezes its diff, status, and changed-file hashes. Any verification
 * command that mutates that candidate causes a prohibited-action result, so a
 * check cannot silently repair the implementation it is meant to verify.
 */

import { upgradeTargets, type CheckPurpose, type CheckResult } from "@safe-upgrade/domain";
import type { WorkerFn, WorkerInput } from "@safe-upgrade/graph";
import type { UpgradeStateUpdate } from "@safe-upgrade/graph";
import { checkOrder, recordCheck } from "./checks.ts";
import { inWorktree, type RunContext } from "./context.ts";

/** Edits that weaken a test rather than satisfy it. */
const WEAKENING = [
  { pattern: /^\+.*\.(?:skip|todo)\s*\(/m, description: "a skipped or todo test was added" },
  { pattern: /^\+.*\.only\s*\(/m, description: "a focused test was added, which hides the rest" },
  { pattern: /^\+\s*(?:\/\/|\/\*)\s*(?:@ts-(?:ignore|expect-error)|eslint-disable)/m, description: "a suppression comment was added" },
];

export function createVerifier(options: RunContext): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> => {
    const { handle, runtime, audit } = input;

    // The commands below execute repository code. Even inside the OS sandbox,
    // they may write inside the disposable worktree for coverage or build output.
    // Freeze the candidate first so a check can never silently become part of the
    // implementation it is supposed to verify.
    const candidate = await candidateIntegrity(input, options);

    // Frozen, so this verifies the lockfile being shipped rather than whatever
    // the registry serves today. Lifecycle scripts stay off.
    const install = await handle.tools.install_dependencies({
      lockfile: "frozen",
      lifecycleScripts: "disabled",
    });
    const checks: CheckResult[] = [recordCheck(audit, "verifier", "verify", install)];

    if (install.outcome !== "passed") {
      const mutation = await candidateMutation(input, options, candidate);
      return {
        postChangeChecks: checks,
        lastVerification: "failed",
        diffPolicyPassed: mutation === null,
        ...(mutation === null ? {} : { prohibitedActions: [mutation] }),
        blockingConditions: [
          `a clean frozen install failed with exit code ${String(install.exitCode)}`,
        ],
      };
    }

    for (const { purpose, script } of checkOrder(options.checkScripts)) {
      const outcome = await handle.tools.run_check({
        kind: purpose,
        script,
        workspace: options.facts.workspaceSelector,
      });
      checks.push(recordCheck(audit, "verifier", "verify", outcome));
    }

    const resolved = await resolvesToTarget(input, options);
    const diff = await handle.tools.read_git_diff({ pathspec: "" });
    const mutation = await candidateMutation(input, options, candidate);
    const violations = [
      ...diffPolicyViolations(diff),
      ...(mutation === null ? [] : [mutation]),
    ];

    const failedChecks = checks.filter((check) => check.outcome !== "passed");
    const passed = failedChecks.length === 0 && violations.length === 0 && resolved;
    const deterministicVerified = passed ? verifiedFindings(input) : [];
    const semantic = passed
      ? await semanticCompleteness(input, deterministicVerified, checks, diff)
      : { verified: [] as readonly string[], uncertainty: [] as readonly string[] };

    audit.record({
      phase: "verify",
      worker: "verifier",
      type: "verification_completed",
      payload: {
        ran: checks.map((check) => check.command.purpose),
        failed: failedChecks.map((check) => check.command.purpose),
        diffPolicyViolations: violations,
        dependencyResolvesToTarget: resolved,
        verdict: passed ? "passed" : "failed",
      },
    });

    return {
      postChangeChecks: checks,
      lastVerification: passed ? "passed" : "failed",
      diffPolicyPassed: violations.length === 0,
      targetVersionResolved: resolved,
      verifiedFindingIds: semantic.verified,
      ...(semantic.uncertainty.length === 0
        ? {}
        : { highSeverityUncertainty: semantic.uncertainty }),
      ...(violations.length > 0 ? { prohibitedActions: violations } : {}),
    };
  };
}

async function semanticCompleteness(
  input: WorkerInput,
  deterministicVerified: readonly string[],
  checks: readonly CheckResult[],
  diff: string,
): Promise<{ readonly verified: readonly string[]; readonly uncertainty: readonly string[] }> {
  // Findings explicitly classified as requiring no source change are established by
  // repository facts and the verifier's checks. Asking whether a patch addresses them
  // creates a false negative precisely because the correct patch is no patch at all.
  const semanticFindings = input.state.findings.filter(
    (finding) => finding.noSourceChangeRequired !== true,
  );
  if (semanticFindings.length === 0) {
    return { verified: deterministicVerified, uncertainty: [] };
  }
  try {
    const decision = await input.engine.assessMigrationCompleteness({
      findings: semanticFindings.map((finding) => ({
        id: finding.id,
        summary: finding.releaseClaim,
        affectedFileCount: finding.affectedFiles.length,
        hasVerification: deterministicVerified.includes(finding.id),
      })),
      changedFiles: input.state.fileChanges.map((change) => ({
        path: change.path,
        patch: patchForFile(diff, change.path).slice(0, 4_000),
      })),
      checksPassed: checks
        .filter((check) => check.outcome === "passed")
        .map((check) => check.command.purpose),
    });
    input.audit.record({
      phase: "verify",
      worker: "verifier",
      type: "migration_completeness_assessed",
      payload: {
        complete: decision.complete,
        confidence: decision.confidence,
        assessedFindingIds: semanticFindings.map((finding) => finding.id),
        unaddressedFindingIds: decision.unaddressedFindingIds,
      },
    });
    const rejected = new Set(decision.unaddressedFindingIds);
    return {
      verified: deterministicVerified.filter((id) => !rejected.has(id)),
      uncertainty: decision.complete
        ? []
        : [`Jev identified unresolved migration findings: ${decision.unaddressedFindingIds.join(", ")}`],
    };
  } catch {
    // Deterministic verification remains authoritative when Jev is absent. A
    // semantic engine may veto a finding, but it is never required to authorize
    // the mechanical fallback path.
    return { verified: deterministicVerified, uncertainty: [] };
  }
}

function patchForFile(diff: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return diff
    .split(/(?=^diff --git )/m)
    .find((part) => {
      const header = part.split("\n", 1)[0] ?? "";
      return header.endsWith(` a/${normalized} b/${normalized}`);
    }) ?? "";
}

interface CandidateIntegrity {
  readonly diff: string;
  readonly status: readonly string[];
  readonly changedFileHashes: Readonly<Record<string, string>>;
}

async function candidateIntegrity(
  input: WorkerInput,
  options: RunContext,
): Promise<CandidateIntegrity> {
  const [diff, status] = await Promise.all([
    input.handle.tools.read_git_diff({ pathspec: "" }),
    input.handle.tools.read_git_status({}),
  ]);
  const changedFileHashes: Record<string, string> = {};
  for (const path of [...new Set(input.state.fileChanges.map((change) => change.path))]) {
    try {
      changedFileHashes[path] = (
        await input.handle.tools.read_file({ path: inWorktree(options, path) })
      ).hash;
    } catch {
      // Deletions are already visible in the diff and status snapshots.
    }
  }
  return { diff, status: [...status.entries].sort(), changedFileHashes };
}

async function candidateMutation(
  input: WorkerInput,
  options: RunContext,
  before: CandidateIntegrity,
): Promise<string | null> {
  const after = await candidateIntegrity(input, options);
  if (after.diff !== before.diff) {
    return "a verification command modified the candidate diff";
  }
  if (JSON.stringify(after.status) !== JSON.stringify(before.status)) {
    return "a verification command changed the worktree status";
  }
  for (const [path, hash] of Object.entries(before.changedFileHashes)) {
    if (after.changedFileHashes[path] !== hash) {
      return `a verification command modified ${path}`;
    }
  }
  return null;
}

/**
 * Which findings this verification actually establishes.
 *
 * Only this worker sets these ids, and only from checks it ran itself. "A test was
 * written for it" is a claim about a test; this is a claim about a test that
 * executed and passed against a clean install.
 *
 * A finding whose affected files nothing reaches is excluded even when everything
 * passed, because a green suite that never loads the changed code has not
 * established anything about it. The test author's assessment is what says which
 * those are.
 */
function verifiedFindings(input: WorkerInput): readonly string[] {
  const uncovered = new Set(input.state.testAssessment?.uncoveredFindings ?? []);
  return input.state.findings
    .filter((finding) => finding.noSourceChangeRequired === true || !uncovered.has(finding.id))
    .map((finding) => finding.id);
}

/**
 * The manifest must name the exact target. A range that happens to include the
 * target today is not the same claim: it resolves to something else tomorrow.
 */
async function resolvesToTarget(input: WorkerInput, options: RunContext): Promise<boolean> {
  const relative =
    options.facts.workspace === "" ? "package.json" : `${options.facts.workspace}/package.json`;
  const manifest = await input.handle.tools.read_file({ path: inWorktree(options, relative) });
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.content);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return false;
  }
  const blocks = ["dependencies", "devDependencies", "optionalDependencies"] as const;
  const record = parsed as Record<string, unknown>;
  return upgradeTargets(options.request).every((target) => {
    for (const block of blocks) {
      const declared = record[block];
      if (typeof declared !== "object" || declared === null) {
        continue;
      }
      const specifier = (declared as Record<string, unknown>)[target.packageName];
      if (typeof specifier === "string") {
        return specifier === target.targetVersion;
      }
    }
    return false;
  });
}

/**
 * Diff policy, spec 13.6. A change that removes or weakens a test can make every
 * check pass while proving less than before, so it is treated as a prohibited
 * action rather than a failed check.
 */
export function diffPolicyViolations(diff: string): readonly string[] {
  const violations: string[] = [];
  for (const { pattern, description } of WEAKENING) {
    if (pattern.test(diff)) {
      violations.push(description);
    }
  }
  for (const hunk of diff.split(/^diff --git /m).slice(1)) {
    const header = hunk.split("\n", 1)[0] ?? "";
    const isTest = /(?:^|[/\s])(?:test|tests|__tests__|spec)[/\s]|\.(?:test|spec)\.[cm]?[jt]sx?/.test(header);
    if (isTest && /^deleted file mode/m.test(hunk)) {
      violations.push(`a test file was deleted: ${header.trim()}`);
    }
  }
  return violations;
}
