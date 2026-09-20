/**
 * The run's record on disk, spec section 22.
 *
 * One file per kind of thing rather than one file with everything in it. A reviewer
 * answering "what did it read", "what did it decide", or "what did it change" should be
 * able to open the file named after the question, and a later run comparing itself to this
 * one should not have to parse a report written for a person.
 *
 * `patch.diff` is the one a reviewer reads first and the one that was missing longest: a
 * classification is a summary of a change, and the change itself is the evidence for it.
 *
 * Everything here is derived from state that was already checkpoint-safe, so nothing is
 * written that was not already considered safe to persist.
 */

import type { AuditLog } from "@safe-upgrade/evidence";
import type { CheckPhase, CheckResult } from "@safe-upgrade/domain";
import type { RunReport } from "./run.ts";

/** What spec 22 requires, written relative to the run's artifact directory. */
export function writeArtifacts(audit: AuditLog, report: RunReport, patch: string): void {
  const json = (name: string, value: unknown): void => {
    audit.writeArtifact(name, `${JSON.stringify(value, null, 2)}\n`);
  };
  const { finalState } = report;

  json("request.json", report.request);
  json("repository-facts.json", report.facts);
  json("release-evidence.json", finalState.releaseEvidence);
  json("findings.json", finalState.findings);
  json("route-history.json", finalState.routeHistory);

  writeChecks(audit, [...finalState.baselineChecks, ...finalState.postChangeChecks]);

  // Written even when empty, because "this run changed nothing" is a finding a reviewer
  // should be able to establish from the artifacts rather than from their absence.
  audit.writeArtifact("patch.diff", patch);

  json("report.json", report);
}

/**
 * Check records grouped by pass, per spec 22's `checks/{baseline,focused,final}`.
 *
 * The command output itself already lives beside these as text, written when the check
 * ran; these are the structured records that say which command produced which log.
 */
function writeChecks(audit: AuditLog, checks: readonly CheckResult[]): void {
  const counters = new Map<CheckPhase, number>();
  for (const check of checks) {
    const index = (counters.get(check.phase) ?? 0) + 1;
    counters.set(check.phase, index);
    // Numbered because a purpose can run more than once in a pass, and a later run of the
    // same check must not overwrite the record of an earlier one.
    const name = `checks/${check.phase}/${String(index).padStart(2, "0")}-${check.command.purpose}.json`;
    audit.writeArtifact(name, `${JSON.stringify(check, null, 2)}\n`);
  }
}
