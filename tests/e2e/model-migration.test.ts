/**
 * A repository-specific migration with no built-in transform.
 *
 * The scripted generator stands in for any coding model connected through the
 * provider-neutral contract. The test exercises the complete graph, warrants,
 * package update, behavioral test, source patch, and independent verification.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDecisionEngine } from "@safe-upgrade/jev";
import { runUpgrade, type RunReport } from "@safe-upgrade/runner";
import type { PatchGenerationRequest, PatchGenerator } from "@safe-upgrade/workers";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

const describeE2E = process.env["SAFE_UPGRADE_E2E"] === "1" ? describe : describe.skip;

const PREFIX_TEST = `"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { splitProperty } = require("../src/prefix.js");

test("splits a vendor-prefixed property", () => {
  assert.deepEqual(splitProperty("-moz-tab-size"), { prefix: "-moz-", name: "tab-size" });
});

test("leaves an unprefixed property intact", () => {
  assert.deepEqual(splitProperty("color"), { prefix: "", name: "color" });
});
`;

const PREFIX_SOURCE = `"use strict";

/** Split a possibly-prefixed property into its vendor prefix and bare name. */
function splitProperty(property) {
  const match = /^(-(webkit|moz|ms|o)-)(.+)$/.exec(property);
  return match === null
    ? { prefix: "", name: property }
    : { prefix: match[1], name: match[3] };
}

module.exports = { splitProperty };
`;

class ScriptedMigrationModel implements PatchGenerator {
  readonly calls: PatchGenerationRequest[] = [];

  async propose(request: PatchGenerationRequest): Promise<unknown> {
    this.calls.push(request);
    const findingIds = request.findings.map((finding) => finding.id);
    if (request.kind === "tests") {
      return {
        summary: "cover the removed vendor helper behavior",
        addressedFindingIds: findingIds,
        changes: [
          {
            path: "test/prefix.test.js",
            expectedBeforeHash: "absent",
            content: PREFIX_TEST,
            reason: "capture the prefix behavior before replacing postcss.vendor",
            findingIds,
          },
        ],
      };
    }
    const source = request.editableFiles.find((file) => file.path === "src/prefix.js");
    if (source === undefined) {
      throw new Error("the trusted worker did not offer src/prefix.js");
    }
    return {
      summary: "replace the removed postcss.vendor helper with the equivalent local parser",
      addressedFindingIds: findingIds,
      changes: [
        {
          path: source.path,
          expectedBeforeHash: source.hash,
          content: PREFIX_SOURCE,
          reason: "preserve prefix splitting after postcss.vendor was removed",
          findingIds,
        },
      ],
    };
  }
}

describeE2E("a model-driven migration without a built-in transform", () => {
  let repo: FixtureRepo;
  let artifacts: string;
  let run: RunReport;
  const model = new ScriptedMigrationModel();

  beforeAll(async () => {
    repo = createFixtureRepo({ fixture: "prefix-tool", message: "prefix tool at postcss 7.0.39" });
    artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-model-migration-"));
    run = await runUpgrade({
      repositoryPath: repo.path,
      packageName: "postcss",
      targetVersion: "8.4.35",
      allowTransitive: true,
      artifactsDirectory: artifacts,
      patchGenerator: model,
      engine: new FakeDecisionEngine({
        coverage: (input) => ({
          sufficient: input.candidateTests.length > 0,
          confidence: 0.95,
          rationale: "the focused behavioral test reaches the affected source",
        }),
        completeness: () => ({ complete: true, confidence: 0.95, unaddressedFindingIds: [] }),
      }),
    });
  }, 600_000);

  afterAll(() => {
    repo.cleanup();
    rmSync(artifacts, { recursive: true, force: true });
  });

  it("asked separately for a behavioral test and a source migration", () => {
    expect(model.calls.map((call) => call.kind), JSON.stringify(run.result)).toEqual(["tests", "source"]);
  });

  it("applied each proposal through the worker that owns that file class", () => {
    expect(run.finalState.fileChanges, JSON.stringify(run.result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "test/prefix.test.js", owner: "test_author" }),
        expect.objectContaining({ path: "src/prefix.js", owner: "implementer" }),
      ]),
    );
  });

  it("recorded the model proposals without placing them in graph state", () => {
    const proposed = run.events.filter((event) => event.type === "model_patch_proposed");
    expect(proposed).toHaveLength(2);
    expect(JSON.stringify(run.finalState)).not.toContain("PREFIX_SOURCE");
  });

  it("verified the unfamiliar migration", () => {
    expect(run.result.status, JSON.stringify(run.result)).toBe("verified");
    expect(run.finalState.verifiedFindingIds).toContain("export-removed-at-target:vendor");
  });

  it("left the source checkout untouched", () => {
    expect(repo.status()).toBe("");
    expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.headCommit);
  });
});
