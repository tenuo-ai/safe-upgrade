/**
 * The note a reviewer reads on an existing pull request.
 *
 * A Dependabot pull request is already the conversation. This is what this run
 * has to say about that bump: the status first, then what it found, then what a
 * person still has to do. It is composed from the classified report, never from
 * release-note text.
 */

import { count, type RepositoryFacts, type RunStatus, type UpgradeRequest } from "@safe-upgrade/domain";
import type { RunReport } from "./run.ts";

const HEADLINE: Readonly<Record<RunStatus, string>> = {
  verified: "This upgrade was verified against this repository's own checks.",
  partial: "This upgrade is only partial. Read what is missing before merging.",
  human_required: "This upgrade is not finished. A person has to approve a capability no worker holds.",
  blocked: "Do not merge this bump as-is. The run stopped because it cannot make the change safely.",
  indeterminate: "This run could not classify the upgrade. Treat it as unverified.",
};

export function renderReviewNote(report: RunReport): string {
  const { request, result, facts, finalState } = report;
  const current = facts.currentVersion;
  const lines: string[] = [
    `## safe-upgrade: ${result.status}`,
    "",
    HEADLINE[result.status],
    "",
    `Upgrades \`${request.packageName}\` from \`${current}\` to \`${request.targetVersion}\`${companionLine(request, facts)}.`,
  ];

  if (finalState.draftPullRequestUrl !== null) {
    lines.push("", `A draft with this run's full change is at ${finalState.draftPullRequestUrl}.`);
  }

  if (result.reasons.length > 0) {
    lines.push("", "### Why", "");
    for (const reason of result.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  if (finalState.findings.length > 0) {
    lines.push("", "### Findings", "");
    for (const finding of finalState.findings) {
      const verified = finalState.verifiedFindingIds.includes(finding.id) ? "verified" : "not verified";
      lines.push(`- **${finding.id}** (${verified}) — ${finding.releaseClaim}`);
    }
  }

  const pending = result.status === "human_required" ? finalState.pendingApprovals : [];
  if (pending.length > 0) {
    lines.push(
      "",
      "### What to approve",
      "",
      `Re-run with \`--approve <id> --approved-by <who>\` for ${count(pending.length, "pending approval")}:`,
      "",
    );
    for (const item of pending) {
      lines.push(`- ${item}`);
    }
  }

  if (result.unverifiedClaims.length > 0) {
    lines.push("", "### What this run does not establish", "");
    for (const claim of result.unverifiedClaims) {
      lines.push(`- ${claim}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function companionLine(request: UpgradeRequest, facts: RepositoryFacts): string {
  if (request.companions.length === 0) {
    return "";
  }
  const extras = request.companions.map((companion) => {
    const current =
      facts.companions.find((entry) => entry.packageName === companion.packageName)?.currentVersion ??
      "unknown";
    return `\`${companion.packageName}\` from \`${current}\` to \`${companion.targetVersion}\``;
  });
  return `, plus ${extras.join(", ")}`;
}
