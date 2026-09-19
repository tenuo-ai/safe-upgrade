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
const ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ", "SYSTEMROOT"];

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
): Promise<RunOutcome> {
  assertNoShellSyntax(spec.executable, "executable");
  const timeoutMs = Math.min(spec.timeoutMs, limits.commandTimeoutMs);
  const stdout = capture(limits.maxCommandOutputBytes);
  const stderr = capture(limits.maxCommandOutputBytes);
  const startedAt = new Date();
  const started = process.hrtime.bigint();

  const child = spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd,
    env: buildEnvironment(extraEnv),
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
  }).finally(() => clearTimeout(timer));

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
