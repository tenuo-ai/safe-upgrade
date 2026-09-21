/**
 * A live Jev smoke test for the complete approval workflow.
 *
 * It is deliberately separate from SAFE_UPGRADE_E2E so ordinary CI and local
 * test runs never require an external credential. Enable it explicitly with
 * SAFE_UPGRADE_LIVE_JEV=1 and provide TYPESAFE_API_KEY in the environment.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ElevationGrant } from "@safe-upgrade/domain";
import { JevDecisionEngine } from "@safe-upgrade/jev";
import { runUpgrade, type RunReport } from "@safe-upgrade/runner";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

const enabled = process.env["SAFE_UPGRADE_LIVE_JEV"] === "1";
const describeLive = enabled ? describe : describe.skip;

let repo: FixtureRepo;
let artifacts: string;
let discovery: RunReport;
let completed: RunReport;

describeLive("a live Jev-backed upgrade", () => {
  beforeAll(async () => {
    repo = createFixtureRepo();
    artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-live-jev-"));

    discovery = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      artifactsDirectory: join(artifacts, "discovery"),
      engine: new JevDecisionEngine(),
    });

    const request = discovery.finalState.elevationRequests[0];
    if (request === undefined) {
      throw new Error("the discovery run did not request the expected approval");
    }
    const grant: ElevationGrant = {
      id: request.id,
      approvedBy: "live-jev-test",
      approvedAt: new Date().toISOString(),
    };

    completed = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "escape-string-regexp",
      targetVersion: "5.0.0",
      artifactsDirectory: join(artifacts, "completed"),
      approvals: [grant],
      engine: new JevDecisionEngine(),
    });
  }, 600_000);

  afterAll(() => {
    repo.cleanup();
    rmSync(artifacts, { recursive: true, force: true });
  });

  it("waits for the narrow manifest approval before changing the repository", () => {
    expect(discovery.result.status).toBe("human_required");
    expect(discovery.finalState.elevationRequests[0]).toMatchObject({
      worker: "implementer",
      capability: "update_manifest_field",
      arguments: { path: "package.json", field: "type", value: "module" },
    });
  });

  it("finishes the approved upgrade and records a live semantic assessment", () => {
    expect(
      completed.result.status,
      JSON.stringify({
        result: completed.result,
        verifiedFindingIds: completed.finalState.verifiedFindingIds,
        uncertainty: completed.finalState.highSeverityUncertainty,
        semanticEvents: completed.events.filter(
          (event) => event.type === "migration_completeness_assessed",
        ),
      }),
    ).toBe("verified");
    expect(completed.events.some((event) => event.type === "migration_completeness_assessed")).toBe(true);
    expect(completed.finalState.verifiedFindingIds).toContain("esm-only-at-target");
  });
});
