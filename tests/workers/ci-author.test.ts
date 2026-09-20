/**
 * What the CI author can and cannot see in a workflow.
 *
 * The reading is deliberately shallow — `run:` lines, not a YAML model of a job graph —
 * and the tests that matter are the ones pinning which way it errs. A check it fails to
 * recognise must come out as missing, because the cost of that is a duplicated step and
 * the cost of the reverse is a gate nobody notices is gone.
 */

import { describe, expect, it } from "vitest";
import {
  coveredPurposes,
  dischargedByWorkflow,
  lowestAdmitted,
  satisfies,
  workflowFor,
} from "@safe-upgrade/workers";
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

  it("stops a run block at a sibling key of the same step", () => {
    // An `env:` mapping is not part of the block, and a value in it mentioning a
    // command would otherwise read as though the step ran that command.
    const content = [
      "      - run: |",
      "          npm ci",
      "        env:",
      "          NOTE: npm run build",
      "      - uses: x",
    ].join("\n");
    expect(covered(content)).toEqual(["install"]);
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

describe("whether a pinned Node version satisfies a range", () => {
  it("accepts a version at or above a lower bound", () => {
    expect(satisfies(">=12", 22)).toBe(true);
    expect(satisfies(">= 18.0.0", 22)).toBe(true);
    expect(satisfies(">=22", 22)).toBe(true);
  });

  it("rejects a version below a lower bound", () => {
    expect(satisfies(">=24", 22)).toBe(false);
  });

  it("honours an upper bound", () => {
    // The bug this replaces took the largest number it could find and ignored `<`
    // entirely, so `>=12 <20` read as "12 or above" and Node 22 looked fine.
    expect(satisfies(">=12 <20", 22)).toBe(false);
    expect(satisfies(">=12 <23", 22)).toBe(true);
    expect(satisfies("^20.1.0", 22)).toBe(false);
    expect(satisfies("^22.0.0", 22)).toBe(true);
  });

  it("refuses an upper bound inside the pinned major", () => {
    // `node-version: "22"` is whatever 22.x is newest, which may well exceed 22.5.
    expect(satisfies(">=22.1 <22.5", 22)).toBe(false);
    expect(satisfies("<=22", 22)).toBe(false);
  });

  it("is satisfied when any alternative of a union is", () => {
    expect(satisfies("^14.13.1 || >=16.0.0", 22)).toBe(true);
    expect(satisfies("^14.13.1 || ^16.0.0", 22)).toBe(false);
  });

  it("says it does not know rather than guessing", () => {
    // Every one of these leaves the finding unaddressed and the run short of
    // `verified`, which is the honest outcome: nobody established that CI runs a
    // version the package accepts.
    expect(satisfies("latest", 22)).toBeNull();
    expect(satisfies("*", 22)).toBeNull();
    expect(satisfies("20.x", 22)).toBeNull();
    expect(satisfies("~22.1", 22)).toBeNull();
    expect(satisfies("14 - 22", 22)).toBeNull();
    expect(satisfies("", 22)).toBeNull();
  });
});

describe("the lowest version a range admits", () => {
  it("reads the floor of a simple range", () => {
    expect(lowestAdmitted(">=12")).toBe(12);
    expect(lowestAdmitted(">=12 <20")).toBe(12);
  });

  it("takes the lowest across a union, not the highest", () => {
    // This decides whether a repository's own `engines` still admits a version its
    // dependency rejects, so the lowest thing it would install on is the question.
    expect(lowestAdmitted("^14.13.1 || >=16.0.0")).toBe(14);
  });

  it("returns nothing for a range it cannot read", () => {
    expect(lowestAdmitted("20.x")).toBeNull();
  });
});

describe("whether a workflow settles a raised runtime requirement", () => {
  it("settles it when the pinned version satisfies the range and nothing contradicts", () => {
    expect(dischargedByWorkflow(">=12", null, 22)).toBe(true);
  });

  it("does not settle it when the pinned version is outside the range", () => {
    expect(dischargedByWorkflow(">=24", null, 22)).toBe(false);
    expect(dischargedByWorkflow(">=12 <20", null, 22)).toBe(false);
  });

  it("does not settle it while the repository still advertises a version the range rejects", () => {
    // What CI runs is not the whole question. A package saying `engines.node >=10` while
    // its dependency needs 12 is broken for whoever installs it on Node 10.
    expect(dischargedByWorkflow(">=12", ">=10", 22)).toBe(false);
    expect(dischargedByWorkflow(">=12", ">=12", 22)).toBe(true);
    expect(dischargedByWorkflow(">=12", ">=18", 22)).toBe(true);
    // A union is judged by the lowest thing it would install on, not the highest.
    expect(dischargedByWorkflow(">=16", "^14.13.1 || >=16.0.0", 22)).toBe(false);
  });

  it("does not settle it on a range it cannot read", () => {
    expect(dischargedByWorkflow("20.x", null, 22)).toBe(false);
    expect(dischargedByWorkflow(">=12", "20.x", 22)).toBe(false);
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
