/**
 * The comment left on an existing pull request.
 */

import { describe, expect, it } from "vitest";

import { renderReviewNote } from "@safe-upgrade/runner";
import type { RunReport } from "@safe-upgrade/runner";

function report(overrides: Partial<RunReport> & { readonly status?: RunReport["result"]["status"] }): RunReport {
  const status = overrides.status ?? "verified";
  return {
    request: { packageName: "cookie", targetVersion: "1.0.2", companions: [] },
    result: {
      status,
      reasons: ["the lockfile moved and the checks passed"],
      unverifiedClaims: [],
    },
    facts: { currentVersion: "0.7.2", companions: [] },
    finalState: {
      findings: [],
      verifiedFindingIds: [],
      pendingApprovals: [],
      draftPullRequestUrl: null,
    },
    ...overrides,
  } as unknown as RunReport;
}

describe("the review note", () => {
  it("leads with the status so a reviewer does not have to hunt for it", () => {
    const note = renderReviewNote(report({ status: "blocked" }));
    expect(note.startsWith("## safe-upgrade: blocked")).toBe(true);
    expect(note).toContain("Do not merge this bump as-is");
    expect(note).toContain("cookie");
    expect(note).toContain("0.7.2");
    expect(note).toContain("1.0.2");
  });

  it("names pending approvals so a Dependabot PR can be the approval surface", () => {
    const note = renderReviewNote(
      report({
        status: "human_required",
        finalState: {
          findings: [],
          verifiedFindingIds: [],
          pendingApprovals: ["implementer calling update_manifest_field (approval id abc)"],
          draftPullRequestUrl: null,
        },
      } as never),
    );
    expect(note).toContain("What to approve");
    expect(note).toContain("approval id abc");
    expect(note).toContain("--approve");
  });

  it("links a draft this run opened, when it opened one", () => {
    const note = renderReviewNote(
      report({
        finalState: {
          findings: [],
          verifiedFindingIds: [],
          pendingApprovals: [],
          draftPullRequestUrl: "https://github.test/acme/app/pull/9",
        },
      } as never),
    );
    expect(note).toContain("https://github.test/acme/app/pull/9");
  });

  it("does not copy generated prose into the comment", () => {
    const note = renderReviewNote(report({ status: "verified" }));
    expect(note).not.toMatch(/I think|looks good|LGTM/i);
  });
});
