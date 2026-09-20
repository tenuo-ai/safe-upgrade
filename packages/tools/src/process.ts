/**
 * Process execution.
 *
 * There is no shell anywhere in this file. Commands are an executable plus an
 * argument array, which means quoting, pipes, redirection, and command
 * substitution are not just discouraged, they are unrepresentable.
 *
 * The environment is an allowlist rather than an inheritance, so a child process
 * cannot read tokens that happen to be exported in the parent.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ToolExecutionError } from "@safe-upgrade/domain";
import type { CommandSpec } from "@safe-upgrade/domain";
import type { ToolLimits } from "./context.ts";

export interface RunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly startedAt: string;
  readonly durationMs: number;
}

/** Variables a build or test command legitimately needs. Nothing else is passed. */
const ENV_ALLOWLIST: readonly string[] = ["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT"];

const SHELL_SYNTAX = /[;&|<>`$(){}[\]!*?~\n\r\\"']/;

/** Characters that only matter if something downstream reaches a shell. */
export function assertNoShellSyntax(value: string, label: string): void {
  if (SHELL_SYNTAX.test(value)) {
    throw new ToolExecutionError(`${label} contains shell syntax and will not be executed: ${value}`);
  }
}

export function buildEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Keep tool output deterministic and non-interactive.
  env.CI = "1";
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  env.npm_config_color = "false";
  env.npm_config_audit = "false";
  env.npm_config_fund = "false";
  for (const [key, value] of Object.entries(extra)) {
    if (SECRET_ENV.test(key)) {
      throw new ToolExecutionError(`refusing to pass ${key} into a child process`);
    }
    env[key] = value;
  }
  return env;
}

const SECRET_ENV = /(token|secret|password|api[_-]?key|credential|warrant|holder)/i;

export interface ProcessIsolation {
  /** Network is off for all code execution and on only for package download. */
  readonly network: "allow" | "deny";
  /** The only host paths the child may modify. */
  readonly writableRoots: readonly string[];
}

interface SandboxedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function commandExists(path: string): boolean {
  return path.includes("/") ? existsSync(path) : false;
}

function seatbeltString(value: string): string {
  return JSON.stringify(resolve(value));
}

/**
 * Put the command behind an operating-system sandbox.
 *
 * Tenuo constrains which tool may be invoked. This constrains code launched by
 * that tool, which otherwise inherits the user's filesystem and network access.
 */
export function sandboxedCommand(
  spec: CommandSpec,
  isolation: ProcessIsolation,
  sandboxHome: string,
): SandboxedCommand {
  const roots = [...new Set([...isolation.writableRoots, sandboxHome].map((path) => resolve(path)))];

  if (process.env["SAFE_UPGRADE_ALLOW_UNSANDBOXED"] === "1") {
    return { executable: spec.executable, args: spec.args, cwd: spec.cwd };
  }

  if (process.platform === "darwin" && commandExists("/usr/bin/sandbox-exec")) {
    const realHome = resolve(homedir());
    const profile = [
      "(version 1)",
      "(allow default)",
      // The real home contains npm, git, SSH, and cloud credentials. The child
      // receives a synthetic HOME and cannot read the real one.
      `(deny file-read* (subpath ${seatbeltString(realHome)}))`,
      ...roots.map((root) => `(allow file-read* (subpath ${seatbeltString(root)}))`),
      "(deny file-write*)",
      ...roots.map((root) => `(allow file-write* (subpath ${seatbeltString(root)}))`),
      ...(isolation.network === "deny" ? ["(deny network*)"] : []),
    ].join("\n");
    return {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, spec.executable, ...spec.args],
      cwd: spec.cwd,
    };
  }

  if (process.platform === "linux" && commandExists("/usr/bin/bwrap")) {
    const realHome = resolve(homedir());
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      ...(isolation.network === "allow" ? ["--share-net"] : []),
      "--ro-bind", "/", "/",
      // All safe-upgrade worktrees and probe directories are outside the real
      // home. Hide it completely rather than relying on environment variables.
      "--tmpfs", realHome,
      ...roots.flatMap((root) => ["--bind", root, root]),
      "--proc", "/proc",
      "--dev", "/dev",
      "--chdir", spec.cwd,
      spec.executable,
      ...spec.args,
    ];
    return { executable: "/usr/bin/bwrap", args, cwd: "/" };
  }

  throw new ToolExecutionError(
    "safe-upgrade cannot execute repository or package code without an OS sandbox. Install sandbox-exec on macOS or bubblewrap at /usr/bin/bwrap on Linux. Set SAFE_UPGRADE_ALLOW_UNSANDBOXED=1 only for isolated test infrastructure.",
  );
}

function capture(limit: number): { append: (chunk: Buffer) => void; text: () => string; truncated: () => boolean } {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (total >= limit) {
        truncated = true;
        return;
      }
      const remaining = limit - total;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total = limit;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    truncated() {
      return truncated;
    },
  };
}

/**
 * Run a command to completion, or kill its whole process tree on timeout. The
 * child gets its own process group so that a test runner spawning workers does
 * not leave orphans behind when we give up on it.
 */
export async function runProcess(
  spec: CommandSpec,
  limits: ToolLimits,
  extraEnv: Readonly<Record<string, string>> = {},
  isolation: ProcessIsolation = { network: "deny", writableRoots: [spec.cwd] },
): Promise<RunOutcome> {
  assertNoShellSyntax(spec.executable, "executable");
  const timeoutMs = Math.min(spec.timeoutMs, limits.commandTimeoutMs);
  const stdout = capture(limits.maxCommandOutputBytes);
  const stderr = capture(limits.maxCommandOutputBytes);
  const startedAt = new Date();
  const started = process.hrtime.bigint();

  const sandboxHome = mkdtempSync(join(tmpdir(), "safe-upgrade-home-"));
  const command = sandboxedCommand(spec, isolation, sandboxHome);
  const env = buildEnvironment({
    HOME: sandboxHome,
    USERPROFILE: sandboxHome,
    TMPDIR: sandboxHome,
    npm_config_cache: join(sandboxHome, ".npm"),
    ...extraEnv,
  });

  const child = spawn(command.executable, [...command.args], {
    cwd: command.cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  let timedOut = false;
  const killTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) {
      return;
    }
    try {
      if (process.platform === "win32") {
        child.kill(signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      // The process may have exited between the timer firing and the kill.
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    // Escalate if the tree ignores SIGTERM.
    setTimeout(() => killTree("SIGKILL"), 5_000).unref();
  }, timeoutMs);

  const settled = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  return {
    exitCode: settled.code,
    signal: settled.signal,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut,
    truncated: stdout.truncated() || stderr.truncated(),
    startedAt: startedAt.toISOString(),
    durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
  };
}
