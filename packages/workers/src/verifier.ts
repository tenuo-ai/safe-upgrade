/**
 * Independent verifier, spec 13.6 and 14.6.
 *
 * Holds no write capability of any kind, which is the point: the worker that
 * decides whether the change is acceptable must not be able to adjust the change
 * or the tests to make it acceptable. Every judgement here is a read plus a
 * command.
 *
 * One part of 13.6 is deliberately not attempted here. "Start from a new worktree
 * or clean copy" cannot be a worker's job, because creating a worktree is not
 * among its capabilities and should not be: a verifier that could provision its
 * own environment could provision a favourable one. The runner supplies the
 * worktree, and `docs/deviations.md` records that this verifier currently
 * verifies in the run's worktree rather than a second one.
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

    // Frozen, so this verifies the lockfile being shipped rather than whatever
    // the registry serves today. Lifecycle scripts stay off.
    const install = await handle.tools.install_dependencies({
      lockfile: "frozen",
      lifecycleScripts: "disabled",
    });
    const checks: CheckResult[] = [recordCheck(audit, "verifier", "verify", install)];

    if (install.outcome !== "passed") {
      return {
        postChangeChecks: checks,
        lastVerification: "failed",
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
    const violations = diffPolicyViolations(diff);

    const failedChecks = checks.filter((check) => check.outcome !== "passed");
    const passed = failedChecks.length === 0 && violations.length === 0 && resolved;

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
      verifiedFindingIds: passed ? verifiedFindings(input) : [],
      ...(violations.length > 0 ? { prohibitedActions: violations } : {}),
    };
  };
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
