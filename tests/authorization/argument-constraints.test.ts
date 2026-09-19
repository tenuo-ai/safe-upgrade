/**
 * Argument-level constraints from section 20.2 of the spec.
 *
 * Holding a capability is not the same as being able to use it on anything. Each
 * case here uses a capability the worker genuinely has, with an argument it is
 * not allowed to pass.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationError, ToolExecutionError } from "@safe-upgrade/domain";
import { ABSENT } from "@safe-upgrade/tools";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ requestedPackage: "left-pad", targetVersion: "1.3.0", withGitHub: true });
});

afterEach(() => {
  harness.cleanup();
});

describe("path constraints", () => {
  it("denies reading outside the worktree", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("researcher", "research", (handle) =>
        handle.invoke("read_file", toolset.read_file, { path: "/etc/passwd" }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("denies a CI write outside .github/workflows", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("ci_author", "configure_ci", (handle) =>
        handle.invoke("write_ci_file", toolset.write_ci_file, {
          path: harness.path("src", "sneaky.yml"),
          expectedBeforeHash: ABSENT,
          content: "name: sneaky\n",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("refuses a production file passed to the test writer", async () => {
    const { broker, toolset } = harness.runtime;
    // The path is inside the worktree, so the capability's `under` constraint is
    // satisfied and Tenuo allows the call. Classification is the tool's job, and
    // it happens before any byte is written.
    await expect(
      broker.withWorker("test_author", "author_tests", (handle) =>
        handle.invoke("write_test_file", toolset.write_test_file, {
          path: harness.path("src", "index.ts"),
          expectedBeforeHash: ABSENT,
          content: "export const greeting = 'owned';\n",
        }),
      ),
    ).rejects.toBeInstanceOf(ToolExecutionError);
    expect(harness.invocations).toEqual(["write_test_file"]);
  });
});

describe("package constraints", () => {
  it("denies updating a package other than the requested one", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("implementer", "implement", (handle) =>
        handle.invoke("update_dependency", toolset.update_dependency, {
          packageName: "lodash",
          targetVersion: "1.3.0",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("denies installing a version other than the requested target", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("implementer", "implement", (handle) =>
        handle.invoke("update_dependency", toolset.update_dependency, {
          packageName: "left-pad",
          targetVersion: "9.9.9",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("denies an install that would enable dependency lifecycle scripts", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("verifier", "verify", (handle) =>
        handle.invoke("install_dependencies", toolset.install_dependencies, {
          lockfile: "frozen",
          lifecycleScripts: "enabled",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("denies a verifier install that would rewrite the lockfile", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("verifier", "verify", (handle) =>
        handle.invoke("install_dependencies", toolset.install_dependencies, {
          lockfile: "update",
          lifecycleScripts: "disabled",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });
});

describe("git and GitHub constraints", () => {
  it("denies pushing the default branch", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("publisher", "publish_draft", (handle) =>
        handle.invoke("push_branch", toolset.push_branch, { name: harness.defaultBranch }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("denies pushing any branch other than the run branch", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("publisher", "publish_draft", (handle) =>
        handle.invoke("push_branch", toolset.push_branch, { name: "safe-upgrade/someone-elses-run" }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });

  it("denies a non-draft pull request", async () => {
    const { broker, toolset } = harness.runtime;
    const createDraftPr = toolset.create_draft_pr;
    expect(createDraftPr).toBeDefined();
    await expect(
      broker.withWorker("publisher", "publish_draft", (handle) =>
        handle.invoke("create_draft_pr", createDraftPr!, {
          base: harness.defaultBranch,
          head: harness.runBranch,
          title: "Upgrade left-pad",
          body: "evidence",
          draft: false,
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // No network call was attempted, so no token was ever put on the wire.
    expect(harness.invocations).toEqual([]);
  });
});

describe("zero-trust argument naming", () => {
  it("denies an argument the capability does not name", async () => {
    const { broker, toolset } = harness.runtime;
    await expect(
      broker.withWorker("researcher", "research", (handle) =>
        handle.invoke("read_file", toolset.read_file, {
          path: harness.path("package.json"),
          // Not part of the capability, and therefore not merely ignored.
          followSymlinks: true,
        } as Parameters<typeof toolset.read_file.execute>[0]),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(harness.invocations).toEqual([]);
  });
});
