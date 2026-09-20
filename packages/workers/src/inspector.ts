/**
 * Inspector, covering spec 13.1 and 14.2.
 *
 * It confirms facts rather than discovering them. Detection already ran, in
 * trusted code, before this worker had any authority — it had to, because the
 * capability ceilings are derived from the worktree path and the package manager
 * it reports. A worker whose output decided its own authority would be a worker
 * that could widen it.
 *
 * So what is left here is the part that genuinely needs a capability: reading the
 * worktree's git state through a protected tool, and running the baseline.
 */

import type { CheckPurpose } from "@safe-upgrade/domain";
import type { WorkerFn, WorkerInput } from "@safe-upgrade/graph";
import type { UpgradeStateUpdate } from "@safe-upgrade/graph";
import { checkOrder, recordCheck } from "./checks.ts";
import type { RunContext } from "./context.ts";

export function createInspector(options: RunContext): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> =>
    input.state.phase === "baseline_verify" ? runBaseline(input, options) : confirmFacts(input, options);
}

async function confirmFacts(
  input: WorkerInput,
  options: RunContext,
): Promise<UpgradeStateUpdate> {
  const { handle, runtime, audit } = input;
  const status = await handle.tools.read_git_status({});

  const blocking: string[] = [];
  // The worktree was created moments ago from a known commit. If it is dirty or
  // sits somewhere else, something outside this run is writing to it, and no
  // later evidence about "the change we made" would mean anything.
  if (!status.clean) {
    blocking.push(
      `the run worktree was not clean before any change was made: ${status.entries.join(", ")}`,
    );
  }
  if (status.head !== options.startCommit) {
    blocking.push(
      `the run worktree is at ${status.head} but was created from ${options.startCommit}`,
    );
  }

  const uncertainty: string[] = [];
  if (!options.sourceClean) {
    // Not blocking: the run is valid, it just is not a statement about the user's
    // uncommitted work.
    uncertainty.push(
      "the source checkout had uncommitted changes, which are not part of what was verified",
    );
  }
  if (options.absentChecks.includes("test")) {
    uncertainty.push(
      "the repository defines no runnable test script, so no check here can detect a regression",
    );
  }

  audit.record({
    phase: "inspect",
    worker: "inspector",
    type: "repository_inspected",
    payload: {
      worktreePath: options.facts.worktreePath,
      head: status.head,
      branch: status.branch,
      packageManager: options.facts.packageManager,
      lockfile: options.facts.lockfile,
      currentVersion: options.facts.currentVersion,
      plannedChecks: checkOrder(options.checkScripts).map((entry) => entry.purpose),
      absentChecks: options.absentChecks,
      ciFiles: options.facts.existingCiFiles,
      detectionWarnings: options.detectionWarnings,
    },
  });

  return {
    repository: options.facts,
    ...(blocking.length > 0 ? { blockingConditions: blocking } : {}),
    ...(uncertainty.length > 0 ? { highSeverityUncertainty: uncertainty } : {}),
  };
}

/**
 * Baseline, spec 14.2. Establishes what was already broken before the run
 * touched anything, which is the only thing that makes a later passing check
 * meaningful.
 */
async function runBaseline(
  input: WorkerInput,
  options: RunContext,
): Promise<UpgradeStateUpdate> {
  const { handle, runtime, audit } = input;

  const install = await handle.tools.install_dependencies({
    lockfile: "frozen",
    lifecycleScripts: "disabled",
  });
  const checks = [recordCheck(audit, "inspector", "baseline_verify", install)];

  if (install.outcome !== "passed") {
    // Without dependencies installed, every check after this would fail for a
    // reason that has nothing to do with the upgrade.
    return {
      baselineChecks: checks,
      blockingConditions: [
        `the baseline install failed with exit code ${String(install.exitCode)}, so no baseline exists`,
      ],
    };
  }

  for (const { purpose, script } of checkOrder(options.checkScripts)) {
    const outcome = await handle.tools.run_check({
      kind: purpose,
      script,
      workspace: options.facts.workspaceSelector,
    });
    checks.push(recordCheck(audit, "inspector", "baseline_verify", outcome));
  }

  const failed = checks.filter((check) => check.outcome !== "passed");
  audit.record({
    phase: "baseline_verify",
    worker: "inspector",
    type: "baseline_recorded",
    payload: {
      ran: checks.map((check) => check.command.purpose),
      // Recorded as pre-existing, per 14.2: a check failing here is a fact about
      // the repository, not something this run caused.
      preExistingFailures: failed.map((check) => check.command.purpose),
    },
  });

  return { baselineChecks: checks };
}
