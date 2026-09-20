/**
 * What a run says about itself while it is still running.
 *
 * A run installs dependencies, executes a repository's own test suite, and fetches from a
 * registry. On the fixtures that is seconds; on a repository with a real suite it is minutes during
 * which the command printed nothing at all, and there was no way to tell a slow install from a
 * hang.
 *
 * These lines are progress, not findings. Everything a run concludes is in the report and the
 * artifacts, and nothing here is the authority for any of it — so a description that cannot be
 * read off the state is omitted rather than guessed at.
 */

import { count, type CheckResult, type Phase } from "@safe-upgrade/domain";
import type { UpgradeState } from "@safe-upgrade/graph";

export interface ProgressEvent {
  readonly phase: Phase;
  /** A short account of what the node did, or null when there is nothing worth a line. */
  readonly detail: string | null;
}

export type ProgressReporter = (event: ProgressEvent) => void;

/**
 * Describe a node from the state before and after it ran.
 *
 * Both, because the accumulated state alone reports totals: `implement` following a node that
 * wrote two files would say six files changed when it wrote four, which reads as a claim about
 * the wrong node. Taking the difference costs a reference to the previous superstep and makes
 * each line about the step it names.
 */
export function describeProgress(
  phase: Phase,
  state: UpgradeState,
  previous: UpgradeState | null,
): ProgressEvent {
  return { phase, detail: detailFor(phase, state, previous) };
}

function detailFor(phase: Phase, state: UpgradeState, previous: UpgradeState | null): string | null {
  switch (phase) {
    case "inspect": {
      const facts = state.repository;
      return facts === null ? null : `${facts.packageManager}, ${facts.currentVersion} installed`;
    }
    case "baseline_verify":
      return checkSummary(since(state.baselineChecks, previous?.baselineChecks));
    case "research":
      return `${count(state.findings.length, "finding")} from ${count(state.releaseEvidence.length, "source")}`;
    case "route": {
      const chosen = state.routeHistory.at(-1);
      return chosen === undefined ? null : `chose ${chosen.selected}`;
    }
    case "verify":
      return checkSummary(since(state.postChangeChecks, previous?.postChangeChecks));
    case "author_tests":
    case "implement":
    case "configure_ci":
      return workSummary(state, previous);
    case "publish_draft":
      return state.draftPullRequestUrl;
    case "assess_verification":
      return state.lastVerification === "not_run" ? null : `checks ${state.lastVerification}`;
    case "finalize":
      return state.result?.status ?? null;
  }
}

/** What this node appended, which is the tail past whatever was already there. */
function since<T>(current: readonly T[], before: readonly T[] | undefined): readonly T[] {
  return current.slice(before?.length ?? 0);
}

/** The most recent result per purpose, which is what a reader watching a run wants to see. */
function checkSummary(checks: readonly CheckResult[]): string | null {
  if (checks.length === 0) {
    return null;
  }
  const latest = new Map<string, CheckResult>();
  for (const check of checks) {
    latest.set(check.command.purpose, check);
  }
  return [...latest.values()].map((check) => `${check.command.purpose} ${check.outcome}`).join(", ");
}

/**
 * What a worker wrote, or why it stopped.
 *
 * A worker that blocks is the most useful line this prints: it is the moment the run's outcome is
 * decided, and the reason would otherwise wait for the report.
 */
function workSummary(state: UpgradeState, previous: UpgradeState | null): string | null {
  const blocked = since(state.blockingConditions, previous?.blockingConditions).at(-1);
  if (blocked !== undefined) {
    return `stopped: ${blocked}`;
  }
  const wrote = since(state.fileChanges, previous?.fileChanges);
  if (wrote.length > 0) {
    return `${count(wrote.length, "file")} changed`;
  }
  const request = since(state.elevationRequests, previous?.elevationRequests).at(-1);
  return request === undefined ? null : `needs approval for ${request.capability}`;
}

/** `research: 2 findings from 3 sources`, or the phase alone when there is nothing to add. */
export function formatProgress(event: ProgressEvent): string {
  return event.detail === null ? event.phase : `${event.phase}: ${event.detail}`;
}
