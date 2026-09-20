/**
 * What the publisher's authority does and does not reach.
 *
 * The publisher is the only worker whose effects leave the machine, so the interesting
 * assertions are all about refusal: which branch it may commit on, which it may push,
 * that nothing it does can be a merge, and that no other worker can commit at all.
 */

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertCommitMessage } from "@safe-upgrade/tools";
import { AuthorizationError, ToolExecutionError } from "@safe-upgrade/domain";
import { createHarness, type Harness } from "../support/harness.ts";

function git(harness: Harness, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: harness.root, encoding: "utf8" }).trim();
}

describe("committing", () => {
  it("lands on the run branch and nowhere else", async () => {
    const harness = createHarness();
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        await handle.tools.create_branch({ name: harness.runBranch });
        writeFileSync(harness.path("src", "added.ts"), "export const added = 1;\n");
        const result = await handle.tools.commit_changes({ message: "Upgrade left-pad" });
        expect(result.committed).toBe(true);
        expect(result.files).toContain("src/added.ts");
      });
      expect(git(harness, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(harness.runBranch);
      expect(git(harness, ["log", "-1", "--format=%s"])).toBe("Upgrade left-pad");
      // The identity is the run's, so a commit is never misattributed to the person
      // whose machine it happened on.
      expect(git(harness, ["log", "-1", "--format=%an"])).toBe("safe-upgrade");
    } finally {
      harness.cleanup();
    }
  });

  it("refuses to commit before the run branch exists", async () => {
    const harness = createHarness();
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        writeFileSync(harness.path("src", "added.ts"), "export const added = 1;\n");
        // The worktree starts detached at the run's start commit. Committing there would
        // leave the change on an unnamed head that nothing tracks.
        await expect(handle.tools.commit_changes({ message: "too early" })).rejects.toThrow(
          /commits only on/,
        );
      });
    } finally {
      harness.cleanup();
    }
  });

  it("says so rather than inventing a commit when nothing changed", async () => {
    const harness = createHarness();
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        await handle.tools.create_branch({ name: harness.runBranch });
        const result = await handle.tools.commit_changes({ message: "nothing to say" });
        expect(result.committed).toBe(false);
        expect(result.files).toEqual([]);
      });
    } finally {
      harness.cleanup();
    }
  });

  it("is the publisher's alone", async () => {
    const harness = createHarness();
    try {
      for (const worker of ["implementer", "test_author", "ci_author", "verifier"] as const) {
        await harness.runtime.broker.withWorker(worker, "implement", async (handle) => {
          await expect(handle.tools.commit_changes({ message: "not mine to make" })).rejects.toThrow(
            AuthorizationError);
        });
      }
      // Denied before the tool body, so nothing was staged on the way to being refused.
      expect(harness.invocations).not.toContain("commit_changes");
    } finally {
      harness.cleanup();
    }
  });
});

describe("what a commit message may contain", () => {
  it("rejects a message carrying terminal control characters", () => {
    // A message reaches permanent history and then everyone's terminal. Release notes
    // are one of this system's inputs, and an escape sequence in `git log` is a way to
    // make a commit read as something other than what it is.
    expect(() => assertCommitMessage("Upgrade\u001b[2Kleft-pad")).toThrow(ToolExecutionError);
    expect(() => assertCommitMessage("Upgrade\rrewritten")).toThrow(ToolExecutionError);
  });

  it("accepts an ordinary multi-line message", () => {
    expect(() => assertCommitMessage("Upgrade left-pad\n\nFindings addressed:\n- esm-only\n")).not.toThrow();
  });

  it("rejects an empty or oversized message", () => {
    expect(() => assertCommitMessage("   ")).toThrow(ToolExecutionError);
    expect(() => assertCommitMessage("x".repeat(4001))).toThrow(ToolExecutionError);
  });
});

describe("pushing", () => {
  it("refuses the default branch even when asked directly", async () => {
    const harness = createHarness();
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        // Denied by the capability before the tool's own check is reached: the ceiling
        // pins the name, so there is no argument that gets past it.
        await expect(handle.tools.push_branch({ name: harness.defaultBranch })).rejects.toThrow(AuthorizationError);
      });
      expect(harness.invocations).not.toContain("push_branch");
    } finally {
      harness.cleanup();
    }
  });

  it("refuses a branch that merely starts with the run branch's name", async () => {
    const harness = createHarness();
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        await expect(
          handle.tools.push_branch({ name: `${harness.runBranch}-extra` }),
        ).rejects.toThrow(AuthorizationError);
      });
    } finally {
      harness.cleanup();
    }
  });
});

describe("opening a pull request", () => {
  it("cannot be anything but a draft", async () => {
    const harness = createHarness({ withGitHub: true });
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        await expect(
          handle.tools.create_draft_pr({
            base: harness.defaultBranch,
            head: harness.runBranch,
            title: "Upgrade left-pad",
            body: "",
            draft: false,
          }),
        ).rejects.toThrow(AuthorizationError);
      });
      expect(harness.invocations).not.toContain("create_draft_pr");
    } finally {
      harness.cleanup();
    }
  });

  it("is unavailable when the run has no repository configured", async () => {
    const harness = createHarness();
    try {
      await harness.runtime.broker.withWorker("publisher", "publish_draft", async (handle) => {
        // A clear refusal rather than a crash: the capability is in the profile, the
        // tool behind it is not there to call.
        await expect(
          handle.tools.create_draft_pr({
            base: harness.defaultBranch,
            head: harness.runBranch,
            title: "Upgrade left-pad",
            body: "",
            draft: true,
          }),
        ).rejects.toThrow(/not configured for this run/);
      });
    } finally {
      harness.cleanup();
    }
  });
});
