/**
 * One allowed and one denied capability per worker.
 *
 * Every test holds a reference to every protected tool, including the ones it
 * must not be able to use. That is deliberate: possession of a tool reference is
 * not authority, and these tests are what prove it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AuthorizationError } from "@safe-upgrade/domain";
import { ABSENT } from "@safe-upgrade/tools";
import { absentCapabilities } from "@safe-upgrade/authorization";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

const newFile = (content: string) => ({ expectedBeforeHash: ABSENT, content });

describe("inspector", () => {
  it("reads repository files", async () => {
    const { broker, toolset } = harness.runtime;
    const result = await broker.withWorker("inspector", "inspect", (handle) =>
      handle.tools.read_file({ path: harness.path("package.json") }),
    );
    expect(result.content).toContain("fixture-app");
  });

  it("cannot write production source", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("inspector", "inspect", (handle) =>
        handle.tools.write_source_file({
          path: harness.path("src", "index.ts"),
          expectedBeforeHash: ABSENT,
          content: "compromised",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).not.toContain("write_source_file");
  });
});

describe("researcher", () => {
  it("lists repository files", async () => {
    const { broker, toolset } = harness.runtime;
    const files = await broker.withWorker("researcher", "research", (handle) =>
      handle.tools.list_files({ root: harness.root, glob: "src/**" }),
    );
    // Absolute, so the next call can be `read_file` without rebuilding the prefix.
    expect(files).toContain(`${harness.root}/src/index.ts`);
  });

  it("cannot run any check", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("researcher", "research", (handle) =>
        handle.tools.run_check({ kind: "test", script: "", workspace: "" }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).not.toContain("run_check");
  });
});

describe("test author", () => {
  it("receives a read-only warrant while assessing existing coverage", async () => {
    const { broker } = harness.runtime;
    const capabilities = await broker.withWorker(
      "test_author",
      "assess_verification",
      async (handle) => {
        await expect(
          handle.tools.write_test_file({
            path: harness.path("src", "assessment.test.ts"),
            ...newFile("test('assessment', () => {});\n"),
          }),
        ).rejects.toBeInstanceOf(AuthorizationError);
        return handle.capabilities;
      },
    );
    expect(capabilities).toEqual(["read_file", "list_files"]);
    expect(harness.invocations).not.toContain("write_test_file");
  });

  it("writes a test file", async () => {
    const { broker, toolset } = harness.runtime;
    const result = await broker.withWorker("test_author", "author_tests", (handle) =>
      handle.tools.write_test_file({
        path: harness.path("src", "migration.test.ts"),
        ...newFile("test('migration', () => {});\n"),
      }),
    );
    expect(result.fileClass).toBe("test");
    expect(readFileSync(harness.path("src", "migration.test.ts"), "utf8")).toContain("migration");
  });

  it("cannot run a build, only tests", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("test_author", "author_tests", (handle) =>
        handle.tools.run_check({ kind: "build", script: "", workspace: "" }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).not.toContain("run_check");
  });
});

describe("implementer", () => {
  it("writes production source", async () => {
    const { broker, toolset } = harness.runtime;
    const before = readFileSync(harness.path("src", "index.ts"), "utf8");
    const read = await broker.withWorker("implementer", "implement", (handle) =>
      handle.tools.read_file({ path: harness.path("src", "index.ts") }),
    );
    const result = await broker.withWorker("implementer", "implement", (handle) =>
      handle.tools.write_source_file({
        path: harness.path("src", "index.ts"),
        expectedBeforeHash: read.hash,
        content: `${before}export const migrated = true;\n`,
      }),
    );
    expect(result.fileClass).toBe("source");
    expect(readFileSync(harness.path("src", "index.ts"), "utf8")).toContain("migrated");
  });

  it("cannot write tests", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("implementer", "implement", (handle) =>
        handle.tools.write_test_file({
          path: harness.path("src", "sneaky.test.ts"),
          ...newFile("test.skip('regression', () => {});\n"),
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).not.toContain("write_test_file");
  });
});

describe("ci author", () => {
  it("writes a workflow file", async () => {
    const { broker, toolset } = harness.runtime;
    const result = await broker.withWorker("ci_author", "configure_ci", (handle) =>
      handle.tools.write_ci_file({
        path: harness.path(".github", "workflows", "verify.yml"),
        ...newFile("name: verify\non: [pull_request]\n"),
      }),
    );
    expect(result.fileClass).toBe("ci");
  });

  it("cannot write production source", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("ci_author", "configure_ci", (handle) =>
        handle.tools.write_source_file({
          path: harness.path("src", "index.ts"),
          expectedBeforeHash: ABSENT,
          content: "compromised",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).not.toContain("write_source_file");
  });
});

describe("verifier", () => {
  it("reads the worktree", async () => {
    const { broker, toolset } = harness.runtime;
    const result = await broker.withWorker("verifier", "verify", (handle) =>
      handle.tools.read_file({ path: harness.path("src", "index.ts") }),
    );
    expect(result.fileClass).toBe("source");
  });

  it("holds no write capability at all", async () => {
    const { broker, toolset, profiles } = harness.runtime;
    const absent = absentCapabilities(profiles.verifier);
    expect(absent).toContain("write_source_file");
    expect(absent).toContain("write_test_file");
    expect(absent).toContain("write_ci_file");
    expect(absent).toContain("update_dependency");

    for (const attempt of [
      () =>
        broker.withWorker("verifier", "verify", (handle) =>
          handle.tools.write_source_file({
            path: harness.path("src", "index.ts"),
            expectedBeforeHash: ABSENT,
            content: "x",
          }),
        ),
      () =>
        broker.withWorker("verifier", "verify", (handle) =>
          handle.tools.write_test_file({
            path: harness.path("src", "x.test.ts"),
            ...newFile("x"),
          }),
        ),
      () =>
        broker.withWorker("verifier", "verify", (handle) =>
          handle.tools.write_ci_file({
            path: harness.path(".github", "workflows", "x.yml"),
            ...newFile("x"),
          }),
        ),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(harness.invocations).toEqual([]);
  });
});

describe("publisher", () => {
  it("reads git status", async () => {
    const { broker, toolset } = harness.runtime;
    const status = await broker.withWorker("publisher", "publish_draft", (handle) =>
      handle.tools.read_git_status({}),
    );
    expect(status.branch).toBe(harness.defaultBranch);
  });

  it("cannot read arbitrary repository files", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("publisher", "publish_draft", (handle) =>
        handle.tools.read_file({ path: harness.path("package.json") }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).not.toContain("read_file");
  });
});

describe("profile separation", () => {
  it("gives every worker a different capability set", () => {
    const { profiles } = harness.runtime;
    const signatures = Object.values(profiles).map((profile) => Object.keys(profile.allow).sort().join(","));
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("grants no worker the authority to enable dependency lifecycle scripts", () => {
    const { profiles } = harness.runtime;
    for (const profile of Object.values(profiles)) {
      const install = profile.allow.install_dependencies;
      if (install === undefined) {
        continue;
      }
      expect(install.lifecycleScripts).toEqual({ kind: "oneOf", values: ["disabled"] });
    }
  });
});
