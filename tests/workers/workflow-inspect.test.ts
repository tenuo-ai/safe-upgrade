/**
 * Static workflow validation, spec 14.9 and acceptance criterion 15.
 *
 * Two standards, so two sets of tests. The workflow this run writes has to be clean and a
 * violation stops it. An existing workflow is reported on, and the tests that matter most
 * there are the ones that pin down what it does *not* flag, because a validator that
 * reports every repository's deploy pipeline is one nobody reads.
 */

import { describe, expect, it } from "vitest";
import { creditedRisks, describeRisks, inspectWorkflow, workflowFor } from "@safe-upgrade/workers";
import type { RunContext, Workflow } from "@safe-upgrade/workers";

function inspect(content: string, authored = false) {
  return inspectWorkflow(".github/workflows/ci.yml", content, { authored });
}

function kinds(content: string, authored = false) {
  return [...new Set(inspect(content, authored).map((risk) => risk.kind))].sort();
}

const CLEAN = [
  "name: ci",
  "on: [push]",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  check:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: npm ci",
  "      - run: npm test",
].join("\n");

describe("permissions", () => {
  it("passes a workflow that grants read and nothing else", () => {
    expect(inspect(CLEAN, true)).toEqual([]);
  });

  it("reports a scope granted write, and names the scope", () => {
    const risks = inspect(CLEAN.replace("  contents: read", "  contents: write"));
    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({ kind: "write_permission", detail: "grants contents: write", line: 4 });
  });

  it("reports write-all", () => {
    const risks = inspect(CLEAN.replace("permissions:\n  contents: read", "permissions: write-all"));
    expect(risks.map((risk) => risk.detail)).toEqual(["grants write-all"]);
  });

  it("reports id-token: write, which is how a workflow mints a cloud credential", () => {
    const risks = inspect(CLEAN.replace("  contents: read", "  contents: read\n  id-token: write"));
    expect(risks.map((risk) => risk.detail)).toEqual(["grants id-token: write"]);
  });

  it("requires an authored workflow to state its permissions", () => {
    // An unstated block means the repository default, which is frequently write.
    const without = CLEAN.replace("permissions:\n  contents: read\n", "");
    expect(kinds(without, true)).toEqual(["permissions_unstated"]);
  });

  it("does not require that of a workflow that was already there", () => {
    // True of most workflows in the world, and not something this run can fix.
    const without = CLEAN.replace("permissions:\n  contents: read\n", "");
    expect(inspect(without, false)).toEqual([]);
  });
});

describe("secrets", () => {
  it("reports a secret reference and names it", () => {
    const risks = inspect(`${CLEAN}\n      - run: echo \${{ secrets.NPM_TOKEN }}`);
    expect(risks.map((risk) => risk.detail)).toEqual(["reads secrets.NPM_TOKEN"]);
  });

  it("reports one that is commented out", () => {
    // A commented secret is a template someone uncomments.
    const risks = inspect(`${CLEAN}\n      # - run: publish --token \${{ secrets.NPM_TOKEN }}`);
    expect(risks.map((risk) => risk.kind)).toContain("secret_read");
  });

  it("does not read an ordinary expression as a secret", () => {
    expect(inspect(`${CLEAN}\n      - run: echo \${{ github.sha }}`)).toEqual([]);
  });
});

describe("steps that do more than check the code", () => {
  it.each([
    ["      - run: npm publish", "publishes a package"],
    ["      - run: pnpm publish --no-git-checks", "publishes a package"],
    ["      - run: docker push example/app:latest", "pushes or authenticates to a container registry"],
    ["      - run: gh release create v1.0.0", "creates or edits a release"],
    ["      - run: git push origin HEAD", "pushes to a repository"],
    ["      - run: aws s3 sync dist s3://bucket", "changes cloud resources"],
    ["      - uses: actions/deploy-pages@v4", "runs a publishing action"],
  ])("reports %s", (step, detail) => {
    const risks = inspect(`${CLEAN}\n${step}`);
    expect(risks.map((risk) => risk.detail)).toContain(detail);
  });

  it.each([
    "      - run: npm test",
    "      - run: npm run build",
    "      - run: npm run lint",
    "      - run: npm ci",
    // Names that read like a deployment but do nothing.
    "  deploy-preview-check:",
    "      - name: verify the publish config is valid",
  ])("does not report %s", (step) => {
    expect(inspect(`${CLEAN}\n${step}`)).toEqual([]);
  });
});

describe("the workflow this run writes", () => {
  const context = {
    request: { packageName: "left-pad", targetVersion: "1.3.0", runId: "run-1" },
    facts: { packageManager: "npm" },
    checkScripts: { test: "test", build: "build" },
  } as unknown as RunContext;

  it("passes its own validation, which is the acceptance criterion", () => {
    // Criterion 15: CI present, and no deploy, publish, secret, or write permissions.
    expect(inspectWorkflow("x.yml", workflowFor(context, ["install", "test", "build"]), { authored: true })).toEqual([]);
  });
});

describe("which workflows get reported on", () => {
  const gatesTests: Workflow = {
    path: ".github/workflows/ci.yml",
    hash: "a",
    content: `${CLEAN.replace("  contents: read", "  contents: write")}`,
  };
  const deploysOnly: Workflow = {
    path: ".github/workflows/deploy.yml",
    hash: "b",
    content: [
      "name: deploy",
      "on:",
      "  push:",
      "    tags: ['v*']",
      "permissions:",
      "  contents: write",
      "jobs:",
      "  release:",
      "    steps:",
      "      - run: npm publish",
    ].join("\n"),
  };
  const context = { facts: { packageManager: "npm" } } as unknown as RunContext;

  it("reports a workflow it credits with gating a check", () => {
    const statements = creditedRisks([gatesTests], ["test"], context);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("grants contents: write");
    // Says which claim the risk attaches to, so a reviewer knows what is weakened.
    expect(statements[0]).toContain("credits it with gating");
  });

  it("says nothing about a workflow it credits with nothing", () => {
    // A repository with a release pipeline is a normal repository. This upgrade neither
    // caused that nor relies on it, so reporting it would be noise.
    expect(creditedRisks([deploysOnly], ["test"], context)).toEqual([]);
  });

  it("separates the two when a repository has both", () => {
    const statements = creditedRisks([gatesTests, deploysOnly], ["test"], context);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("ci.yml");
  });

  it("says nothing about a credited workflow that is read-only", () => {
    const clean: Workflow = { path: ".github/workflows/ci.yml", hash: "c", content: CLEAN };
    expect(creditedRisks([clean], ["test"], context)).toEqual([]);
  });
});

describe("reporting", () => {
  it("says everything about one workflow in one sentence", () => {
    const risks = inspect(
      `${CLEAN.replace("  contents: read", "  contents: write")}\n      - run: npm publish`,
    );
    expect(describeRisks(risks)).toEqual([
      ".github/workflows/ci.yml grants contents: write, publishes a package",
    ]);
  });

  it("says nothing when there is nothing to say", () => {
    expect(describeRisks([])).toEqual([]);
  });
});
