/**
 * The comment left on an existing pull request.
 *
 * The pull request is the maintainer's decision surface. Keep the comment
 * compact, lead with the decision, and make every claim traceable to the
 * classified report.
 */

import { type RepositoryFacts, type RunStatus, type UpgradeRequest } from "@safe-upgrade/domain";
import type { RunReport } from "./run.ts";

const DECISION: Readonly<Record<RunStatus, string>> = {
  verified: "The upgrade is supported by repository evidence and its required checks passed. Review the dependency diff normally.",
  partial: "Hold the merge until the remaining gaps below are resolved.",
  human_required: "A scoped operation needs maintainer approval before the assessment can finish.",
  blocked: "Hold the merge. The assessment reached a condition it could not resolve safely.",
  indeterminate: "Hold the merge. The available evidence was insufficient to classify this upgrade.",
};

export function renderReviewNote(report: RunReport): string {
  const { request, result, facts, finalState } = report;
  const current = facts.currentVersion;
  const lines: string[] = [
    `## safe-upgrade: ${result.status}`,
    "",
    DECISION[result.status],
    "",
    `**Upgrade:** \`${request.packageName}\` \`${current}\` → \`${request.targetVersion}\`${companionLine(request, facts)}`,
  ];

  if (result.reasons.length > 0) {
    section(lines, "Decision evidence", result.reasons);
  }

  if (finalState.findings.length > 0) {
    lines.push("", "### Repository impact", "");
    for (const finding of finalState.findings) {
      const verified = finalState.verifiedFindingIds.includes(finding.id) ? "verified" : "unverified";
      lines.push(`- **${finding.releaseClaim}** (${verified})`);
      if (finding.affectedFiles.length > 0) {
        lines.push(`  - Affected code: ${finding.affectedFiles.map((path) => `\`${path}\``).join(", ")}`);
      } else {
        lines.push("  - Affected code: no repository call site identified");
      }
      lines.push(`  - Required work: ${finding.requiredChange}`);
    }
  }

  const checks = [...finalState.baselineChecks, ...finalState.postChangeChecks];
  if (checks.length > 0) {
    lines.push("", "### Verification", "", "| Phase | Check | Result |", "| --- | --- | --- |");
    for (const check of checks) {
      lines.push(`| ${check.phase} | ${check.command.purpose} | ${check.outcome} |`);
    }
  }

  if (finalState.fileChanges.length > 0) {
    section(
      lines,
      "Candidate changes",
      finalState.fileChanges.map((change) => `\`${change.path}\` by ${change.owner}: ${change.reason}`),
    );
  }

  const delegations = delegatedAuthority(report);
  if (delegations.length > 0) {
    section(lines, "Delegated authority exercised", delegations);
  }

  const granted = new Set(report.approvals.map((approval) => approval.id));
  const pending = result.status === "human_required"
    ? finalState.elevationRequests.filter((request) => !granted.has(request.id))
    : [];
  if (pending.length > 0) {
    lines.push("", "### Maintainer action", "");
    for (const item of pending) {
      lines.push(
        `- **${item.worker}** requests \`${item.capability}\` for ${item.reason}`,
        `  - Approval id: \`${item.id}\``,
        `  - Re-run with \`--approve ${item.id} --approved-by <who>\``,
      );
    }
  } else if (result.unverifiedClaims.length > 0) {
    section(lines, "Still unverified", result.unverifiedClaims);
  }

  if (finalState.draftPullRequestUrl !== null) {
    lines.push("", `A draft with the candidate change is available at ${finalState.draftPullRequestUrl}.`);
  }

  lines.push("", "The workflow run contains the complete evidence record.", "");
  return lines.join("\n");
}

function delegatedAuthority(report: RunReport): string[] {
  const byWorker = new Map<string, Set<string>>();
  for (const event of report.events) {
    if (event.type !== "session_delegated") continue;
    const worker = event.worker ?? "worker";
    const held = byWorker.get(worker) ?? new Set<string>();
    const capabilities = event.payload["capabilities"];
    if (Array.isArray(capabilities)) {
      for (const capability of capabilities) {
        if (typeof capability === "string") held.add(capability);
      }
    }
    byWorker.set(worker, held);
  }
  return [...byWorker.entries()].map(([worker, capabilities]) =>
    `${worker}: ${capabilities.size > 0 ? [...capabilities].join(", ") : "no protected tools"}`,
  );
}

function section(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push("", `### ${title}`, "", ...items.map((item) => `- ${item}`));
}

function companionLine(request: UpgradeRequest, facts: RepositoryFacts): string {
  if (request.companions.length === 0) return "";
  const extras = request.companions.map((companion) => {
    const current =
      facts.companions.find((entry) => entry.packageName === companion.packageName)?.currentVersion ??
      "unknown";
    return `\`${companion.packageName}\` \`${current}\` → \`${companion.targetVersion}\``;
  });
  return `; companions: ${extras.join(", ")}`;
}
