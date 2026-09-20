/**
 * Turning a command outcome into a recorded check result.
 *
 * Output is written to an artifact rather than carried in graph state. State is
 * checkpointed, and a build log is both large and the most likely place for a
 * token echoed by a failing command to end up.
 */

import type { CheckPurpose, CheckResult, WorkerId } from "@safe-upgrade/domain";
import type { CheckKind } from "@safe-upgrade/tools";
import type { AuditLog } from "@safe-upgrade/evidence";
import type { CommandOutcome } from "@safe-upgrade/tools";

export function recordCheck(
  audit: AuditLog,
  worker: WorkerId,
  phase: "baseline_verify" | "verify" | "implement" | "author_tests",
  outcome: CommandOutcome,
): CheckResult {
  const purpose = outcome.command.purpose;
  const slug = `${phase}-${purpose}-${String(outcome.startedAt).replace(/[:.]/g, "-")}`;
  const stdout = audit.writeArtifact(`checks/${slug}.stdout.txt`, outcome.stdout);
  const stderr = audit.writeArtifact(`checks/${slug}.stderr.txt`, outcome.stderr);

  audit.record({
    phase,
    worker,
    type: "command_completed",
    payload: {
      purpose,
      executable: outcome.command.executable,
      args: outcome.command.args,
      outcome: outcome.outcome,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      truncated: outcome.truncated,
      stdoutArtifact: stdout.path,
      stdoutHash: stdout.hash,
      stderrArtifact: stderr.path,
      stderrHash: stderr.hash,
    },
  });

  return {
    command: outcome.command,
    exitCode: outcome.exitCode,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    stdoutArtifact: stdout.path,
    stderrArtifact: stderr.path,
    outcome: outcome.outcome,
  };
}

/** Purposes to run, in the order a developer would run them. */
export function checkOrder(
  scripts: Readonly<Partial<Record<CheckPurpose, string>>>,
): ReadonlyArray<{ readonly purpose: CheckKind; readonly script: string }> {
  // Deliberately CheckKind rather than CheckPurpose: "install" is a purpose but
  // not something `run_check` will run.
  const order: readonly CheckKind[] = ["typecheck", "lint", "test", "build"];
  const planned: Array<{ purpose: CheckKind; script: string }> = [];
  for (const purpose of order) {
    const script = scripts[purpose];
    if (script !== undefined) {
      planned.push({ purpose, script });
    }
  }
  return planned;
}
