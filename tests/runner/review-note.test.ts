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
      baselineChecks: [],
      postChangeChecks: [],
      fileChanges: [],
      pendingApprovals: [],
      elevationRequests: [],
      draftPullRequestUrl: null,
    },
    events: [],
    approvals: [],
    ...overrides,
  } as unknown as RunReport;
}

describe("the review note", () => {
  it("leads with the status so a reviewer does not have to hunt for it", () => {
    const note = renderReviewNote(report({ status: "blocked" }));
    expect(note.startsWith("## safe-upgrade: blocked")).toBe(true);
    expect(note).toContain("Hold the merge");
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
          baselineChecks: [],
          postChangeChecks: [],
          fileChanges: [],
          pendingApprovals: ["implementer calling update_manifest_field (approval id abc)"],
          elevationRequests: [
            {
              id: "abc",
              worker: "implementer",
              capability: "update_manifest_field",
              arguments: { path: "package.json" },
              reason: "set the exact dependency version",
              findingIds: ["dependency-version"],
            },
          ],
          draftPullRequestUrl: null,
        },
      } as never),
    );
    expect(note).toContain("Maintainer action");
    expect(note).toContain("Approval id: `abc`");
    expect(note).toContain("--approve abc");
  });

  it("links a draft this run opened, when it opened one", () => {
    const note = renderReviewNote(
      report({
        finalState: {
          findings: [],
          verifiedFindingIds: [],
          baselineChecks: [],
          postChangeChecks: [],
          fileChanges: [],
          pendingApprovals: [],
          elevationRequests: [],
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

  it("shows repository impact, verification, changes, and delegated authority", () => {
    const note = renderReviewNote(
      report({
        finalState: {
          findings: [
            {
              id: "removed-export",
              releaseClaim: "prefix() was removed",
              evidenceIds: ["release"],
              affectedSymbols: ["prefix"],
              affectedFiles: ["src/index.ts"],
              requiredChange: "replace prefix() with compile()",
              confidence: 0.98,
            },
          ],
          verifiedFindingIds: ["removed-export"],
          baselineChecks: [
            { phase: "baseline", command: { purpose: "test" }, outcome: "passed" },
          ],
          postChangeChecks: [
            { phase: "final", command: { purpose: "test" }, outcome: "passed" },
          ],
          fileChanges: [
            { path: "src/index.ts", owner: "implementer", reason: "migrate removed export" },
          ],
          pendingApprovals: [],
          elevationRequests: [],
          draftPullRequestUrl: null,
        },
        events: [
          {
            type: "session_delegated",
            worker: "implementer",
            payload: { capabilities: ["read_file", "write_source_file"] },
          },
        ],
      } as never),
    );

    expect(note).toContain("Repository impact");
    expect(note).toContain("Affected code: `src/index.ts`");
    expect(note).toContain("| final | test | passed |");
    expect(note).toContain("`src/index.ts` by implementer");
    expect(note).toContain("implementer: read_file, write_source_file");
  });
});
