/**
 * Publisher, spec 13.7.
 *
 * The only worker whose effects leave the machine. It creates the run branch, commits
 * what the other workers wrote, pushes it, and opens a draft pull request. It cannot
 * merge, cannot mark a pull request ready, and cannot push any branch but its own —
 * the ceiling pins the branch name with `exact`, and the GitHub tool refuses anything
 * that is not a draft.
 *
 * It writes no source. By the time it runs the change is fixed, and the only thing
 * left to decide is whether a human sees it.
 *
 * Everything it puts in the pull request comes from recorded state: versions, finding
 * identifiers, check outcomes, approvals. No release-note text is copied into the
 * body. A pull request description is read by people and increasingly by other agents,
 * and text fetched from a registry has no business appearing there as though this run
 * vouched for it.
 */

import type { CheckOutcome, FileChange, MigrationFinding } from "@safe-upgrade/domain";
import { latestChecksByPurpose, type UpgradeStateUpdate, type WorkerFn, type WorkerInput } from "@safe-upgrade/graph";
import type { RunContext } from "./context.ts";

export function createPublisher(context: RunContext): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> => {
    const { request } = context;
    const branch = context.runBranch;

    const status = await input.handle.tools.read_git_status({});
    if (status.clean) {
      // Publishing an empty branch would produce a pull request that reviewers cannot
      // act on and that looks, from the outside, like a successful upgrade.
      return {
        blockingConditions: [
          "there is nothing to publish: the worktree matches the commit the run started from",
        ],
      };
    }

    await input.handle.tools.create_branch({ name: branch });
    const commit = await input.handle.tools.commit_changes({
      message: commitMessage(context, input.state.findings),
    });
    if (!commit.committed) {
      return {
        blockingConditions: ["git reported nothing to commit after the run's changes were staged"],
      };
    }

    await input.handle.tools.push_branch({ name: branch });

    input.audit.record({
      phase: "publish_draft",
      worker: "publisher",
      type: "branch_published",
      payload: { branch, commit: commit.commit, files: commit.files },
    });

    const draft = await input.handle.tools.create_draft_pr({
      base: context.facts.defaultBranch,
      head: branch,
      title: `Upgrade ${request.packageName} to ${request.targetVersion}`,
      body: pullRequestBody(context, input),
      draft: true,
    });

    input.audit.record({
      phase: "publish_draft",
      worker: "publisher",
      type: "draft_pull_request_opened",
      payload: { url: draft.url, number: draft.number, branch },
    });

    return { draftPullRequestUrl: draft.url };
  };
}

function commitMessage(context: RunContext, findings: readonly MigrationFinding[]): string {
  const { packageName, targetVersion } = context.request;
  const lines = [
    `Upgrade ${packageName} to ${targetVersion}`,
    "",
    `Automated by a safe-upgrade run. Every change is attributed to a worker in the`,
    `run's audit log, and the run branch is ${context.request.runId}.`,
  ];
  if (findings.length > 0) {
    lines.push("", "Findings addressed:");
    for (const finding of findings) {
      lines.push(`- ${finding.id}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The description a reviewer reads.
 *
 * Written to be checkable rather than persuasive: what changed, who changed it, what
 * was run, what was approved, and — last, not buried — what the run could not
 * establish. A reviewer who reads only the final section still knows where to look.
 */
function pullRequestBody(context: RunContext, input: WorkerInput): string {
  const { state } = input;
  const sections: string[] = [
    `Upgrades \`${context.request.packageName}\` from \`${context.facts.currentVersion}\` to \`${context.request.targetVersion}\`.`,
    "",
    "This branch was produced by an automated run. Nothing here has been reviewed by a person yet.",
  ];

  if (state.findings.length > 0) {
    sections.push("", "## What the upgrade required", "");
    for (const finding of state.findings) {
      const verified = state.verifiedFindingIds.includes(finding.id) ? "verified" : "not verified";
      sections.push(`- **${finding.id}** (${verified}) — ${finding.releaseClaim}`);
      sections.push(`  - ${finding.requiredChange}`);
    }
  }

  const changes = state.fileChanges;
  if (changes.length > 0) {
    sections.push("", "## Changes, by the worker that made them", "");
    for (const owner of ownersOf(changes)) {
      sections.push(`- \`${owner}\``);
      for (const change of changes.filter((item) => item.owner === owner)) {
        sections.push(`  - \`${change.path}\` — ${change.reason}`);
      }
    }
  }

  const checks = latestChecksByPurpose(state.postChangeChecks);
  if (checks.length > 0) {
    sections.push("", "## Checks run on this branch", "");
    for (const check of checks) {
      sections.push(`- \`${check.command.purpose}\`: ${describe(check.outcome)}`);
    }
  }

  const approvals = state.elevationRequests;
  if (approvals.length > 0) {
    sections.push(
      "",
      "## Approvals this run needed",
      "",
      "These calls are outside what any worker holds by default, and each was approved for",
      "exactly the arguments shown.",
      "",
    );
    for (const request of approvals) {
      const args = Object.entries(request.arguments)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      sections.push(`- \`${request.worker}\` calling \`${request.capability}\` with ${args}`);
    }
  }

  const notEstablished = state.result?.unverifiedClaims ?? state.blockingConditions;
  if (notEstablished.length > 0) {
    sections.push("", "## What this run does not establish", "");
    for (const claim of notEstablished) {
      sections.push(`- ${claim}`);
    }
  }

  return `${sections.join("\n")}\n`;
}

function ownersOf(changes: readonly FileChange[]): readonly string[] {
  return [...new Set(changes.map((change) => change.owner))];
}

function describe(outcome: CheckOutcome): string {
  return outcome === "passed" ? "passed" : outcome;
}
