/**
 * What the CI author can and cannot see in a workflow.
 *
 * The reading is deliberately shallow — `run:` lines, not a YAML model of a job graph —
 * and the tests that matter are the ones pinning which way it errs. A check it fails to
 * recognise must come out as missing, because the cost of that is a duplicated step and
 * the cost of the reverse is a gate nobody notices is gone.
 */

import { describe, expect, it } from "vitest";
import { coveredPurposes, minimumMajor, workflowFor } from "@safe-upgrade/workers";
import type { RunContext } from "@safe-upgrade/workers";
import type { PackageManager } from "@safe-upgrade/domain";

function workflow(content: string): readonly { path: string; hash: string; content: string }[] {
  return [{ path: ".github/workflows/ci.yml", hash: "h", content }];
}

function covered(content: string, packageManager: PackageManager = "npm"): readonly string[] {
  return [...coveredPurposes(workflow(content), packageManager)].sort();
}

describe("reading what a workflow already runs", () => {
  it("recognises a step that runs a check", () => {
    expect(covered("steps:\n  - run: npm ci\n  - run: npm test\n")).toEqual(["install", "test"]);
  });

  it("treats `npm test` and `npm run test` as the same thing", () => {
    expect(covered("  - run: npm run test\n")).toEqual(["test"]);
  });

  it("reads every line of a multi-line run block", () => {
    const content = ["  - run: |", "      npm ci", "      npm run lint", "      npm run build", "  - uses: x"].join(
      "\n",
    );
    expect(covered(content)).toEqual(["build", "install", "lint"]);
  });

  it("does not mistake a differently named script for the check itself", () => {
    // `test:unit` is a different script, and a repository can have both.
    expect(covered("  - run: npm run test:unit\n")).toEqual([]);
    expect(covered("  - run: npm run build-docs\n")).toEqual([]);
  });

  it("does not credit a check run by a different package manager", () => {
    // A pnpm repository whose workflow still says `npm test` is running the wrong tool,
    // and reporting that as covered would hide it.
    expect(covered("  - run: npm test\n", "pnpm")).toEqual([]);
    expect(covered("  - run: pnpm test\n", "pnpm")).toEqual(["test"]);
  });

  it("reports a check reached indirectly as missing", () => {
    // The honest limitation, pinned: `npm run ci` may well run the build, and this
    // cannot tell. Missing is the answer that fails safe.
    expect(covered("  - run: npm run ci\n")).toEqual([]);
  });

  it("sees nothing in a workflow that only installs", () => {
    expect(covered("  - run: npm install\n")).toEqual(["install"]);
  });
});

describe("the Node floor a workflow has to satisfy", () => {
  it("reads the lower bound out of a range", () => {
    expect(minimumMajor(">=12")).toBe(12);
    expect(minimumMajor(">= 18.0.0")).toBe(18);
    expect(minimumMajor("^20.1.0")).toBe(20);
  });

  it("takes the highest bound when a range states several", () => {
    expect(minimumMajor(">=14 <19 || >=20")).toBe(20);
  });

  it("returns nothing when there is no bound to read", () => {
    // Which leaves the finding unaddressed rather than claimed on a guess.
    expect(minimumMajor("latest")).toBeNull();
    expect(minimumMajor("*")).toBeNull();
  });
});

describe("the workflow it writes", () => {
  const context = (packageManager: PackageManager): RunContext =>
    ({
      request: { packageName: "left-pad", targetVersion: "2.0.0" },
      facts: { packageManager },
    }) as unknown as RunContext;

  it("runs every required check and pins a Node version", () => {
    const yaml = workflowFor(context("npm"), ["install", "test", "build"]);
    expect(yaml).toContain("- run: npm ci --ignore-scripts");
    expect(yaml).toContain("- run: npm run test");
    expect(yaml).toContain("- run: npm run build");
    expect(yaml).toMatch(/node-version: "\d+"/);
  });

  it("installs with the frozen form of the repository's own package manager", () => {
    expect(workflowFor(context("pnpm"), ["install"])).toContain("pnpm install --frozen-lockfile");
    expect(workflowFor(context("yarn"), ["install"])).toContain("yarn install --immutable");
    expect(workflowFor(context("npm"), ["install"])).toContain("npm ci");
  });

  it("is readable by the tool that reads existing workflows", () => {
    // Otherwise the re-assessment after writing would report the same gap forever.
    const yaml = workflowFor(context("npm"), ["install", "test", "build"]);
    expect(covered(yaml)).toEqual(["build", "install", "test"]);
  });
});
