/**
 * Package manager and verification tools.
 *
 * Commands are assembled here from the detected package manager and an
 * allowlist, never from a model's suggestion or a package script body. The
 * worker chooses *which kind* of check to run; trusted code decides what that
 * check actually is.
 *
 * Two deliberate departures from a naive reading of the spec, both of which
 * narrow authority rather than widen it:
 *
 * - The package manager is read from the run context instead of being an
 *   argument, so it cannot be swapped per call.
 * - `install` is its own capability rather than a `run_check` kind, because an
 *   install carries the lifecycle-script decision and that deserves to be
 *   authorized separately from running a test suite.
 */

import { ToolExecutionError } from "@safe-upgrade/domain";
import type { CheckOutcome, CheckPurpose, CommandSpec, PackageManager } from "@safe-upgrade/domain";
import { defineTool, type RawTool, type ToolContext } from "./context.ts";
import { assertNoShellSyntax, runProcess, type RunOutcome } from "./process.ts";

/** The only executables this system will ever spawn. */
/**
 * What this process is willing to spawn itself. Only the package manager and the two tools the
 * run drives directly; a repository's own scripts are reached through the manager, never from
 * here, and are screened separately in `screen.ts`.
 */
const EXECUTABLE_ALLOWLIST: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "node", "git"]);

const SCRIPT_NAME = /^[a-z0-9][a-z0-9:._-]{0,63}$/i;

export type CheckKind = Exclude<CheckPurpose, "install">;

export interface CommandOutcome {
  readonly command: CommandSpec;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export type LockfileMode = "frozen" | "update";

/**
 * Lifecycle scripts execute arbitrary code shipped by dependencies. Enabling
 * them is a separate decision, so it is a separate value in a closed
 * vocabulary rather than a boolean flag: a capability can then grant
 * `oneOf(["disabled"])` and nothing a worker passes will turn them on.
 */
export type LifecycleScriptMode = "disabled" | "enabled";

export type InstallArgs = {
  readonly lockfile: LockfileMode;
  readonly lifecycleScripts: LifecycleScriptMode;
}

export type UpdateDependencyArgs = {
  readonly packageName: string;
  readonly targetVersion: string;
}

export type RunCheckArgs = {
  readonly kind: CheckKind;
  /** Package script to run. Empty string means "use the conventional name". */
  readonly script: string;
  /** Workspace to run in. Empty string means the repository root. */
  readonly workspace: string;
}

function assertExecutable(executable: string): void {
  if (!EXECUTABLE_ALLOWLIST.has(executable)) {
    throw new ToolExecutionError(`executable is not allowlisted: ${executable}`);
  }
}

/**
 * A package script is untrusted text. We never execute a script body, only a
 * script *name*, and only after confirming the name cannot carry shell syntax.
 */
export function assertSafeScriptName(script: string): void {
  assertNoShellSyntax(script, "script name");
  if (!SCRIPT_NAME.test(script)) {
    throw new ToolExecutionError(`script name is not a plain identifier: ${script}`);
  }
}

function workspaceArgs(manager: PackageManager, workspace: string): string[] {
  if (workspace.length === 0) {
    return [];
  }
  assertNoShellSyntax(workspace, "workspace");
  switch (manager) {
    case "pnpm":
      return ["--filter", workspace.startsWith(".") || workspace.startsWith("@") ? workspace : `./${workspace}`];
    case "npm":
      return ["--workspace", workspace];
    case "yarn":
      return ["workspace", workspace];
  }
}

function installArgs(manager: PackageManager, args: InstallArgs): string[] {
  const frozen = args.lockfile === "frozen";
  const ignoreScripts = args.lifecycleScripts === "disabled";
  const out: string[] = [];
  switch (manager) {
    case "pnpm":
      out.push("install");
      if (frozen) {
        out.push("--frozen-lockfile");
      }
      if (ignoreScripts) {
        out.push("--ignore-scripts");
      }
      return out;
    case "npm":
      out.push(frozen ? "ci" : "install");
      if (ignoreScripts) {
        out.push("--ignore-scripts");
      }
      return out;
    case "yarn":
      out.push("install");
      if (frozen) {
        out.push("--frozen-lockfile");
      }
      if (ignoreScripts) {
        out.push("--ignore-scripts");
      }
      return out;
  }
}

function updateArgs(manager: PackageManager, spec: string): string[] {
  switch (manager) {
    case "pnpm":
      return ["add", spec, "--save-exact"];
    case "npm":
      return ["install", spec, "--save-exact"];
    case "yarn":
      return ["add", spec, "--exact"];
  }
}

const CONVENTIONAL_SCRIPT: Readonly<Record<CheckKind, string>> = {
  test: "test",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
};

function classify(outcome: RunOutcome): CheckOutcome {
  if (outcome.timedOut) {
    return "timed_out";
  }
  return outcome.exitCode === 0 ? "passed" : "failed";
}

function toCommandOutcome(command: CommandSpec, outcome: RunOutcome): CommandOutcome {
  return {
    command,
    outcome: classify(outcome),
    exitCode: outcome.exitCode,
    startedAt: outcome.startedAt,
    durationMs: outcome.durationMs,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncated,
  };
}

export function createPackageTools(context: ToolContext): {
  readonly installDependencies: RawTool<InstallArgs, CommandOutcome>;
  readonly updateDependency: RawTool<UpdateDependencyArgs, CommandOutcome>;
  readonly runCheck: RawTool<RunCheckArgs, CommandOutcome>;
} {
  const manager = context.packageManager;
  assertExecutable(manager);
  const cwd = context.paths.realRoot;

  return {
    installDependencies: defineTool<InstallArgs, CommandOutcome>(
      context,
      "install_dependencies",
      "Install dependencies with the detected package manager.",
      async (args) => {
        if (args.lockfile !== "frozen" && args.lockfile !== "update") {
          throw new ToolExecutionError(`unknown lockfile mode: ${String(args.lockfile)}`);
        }
        if (args.lifecycleScripts !== "disabled" && args.lifecycleScripts !== "enabled") {
          throw new ToolExecutionError(`unknown lifecycle script mode: ${String(args.lifecycleScripts)}`);
        }
        const command: CommandSpec = {
          executable: manager,
          args: installArgs(manager, args),
          cwd,
          purpose: "install",
          timeoutMs: context.limits.commandTimeoutMs,
        };
        return toCommandOutcome(command, await runProcess(command, context.limits));
      },
    ),

    updateDependency: defineTool<UpdateDependencyArgs, CommandOutcome>(
      context,
      "update_dependency",
      "Update one dependency to an exact version and refresh the lockfile.",
      async (args) => {
        // Tenuo pins these to the requested package and version, but the tool
        // re-checks: a ceiling that is only enforced in one place is a ceiling
        // that breaks silently when the policy is edited.
        const expected = context.requestedUpdates[args.packageName];
        if (expected === undefined) {
          throw new ToolExecutionError(
            `this run may only update ${Object.keys(context.requestedUpdates).join(", ")}, not ${args.packageName}`,
          );
        }
        if (args.targetVersion !== expected) {
          throw new ToolExecutionError(
            `this run may only install ${args.packageName}@${expected}, not ${args.targetVersion}`,
          );
        }
        assertNoShellSyntax(args.packageName, "package name");
        assertNoShellSyntax(args.targetVersion, "target version");
        const command: CommandSpec = {
          executable: manager,
          args: [
            ...workspaceArgs(manager, context.workspaceSelector),
            ...updateArgs(manager, `${args.packageName}@${args.targetVersion}`),
          ],
          cwd,
          purpose: "install",
          timeoutMs: context.limits.commandTimeoutMs,
        };
        return toCommandOutcome(command, await runProcess(command, context.limits));
      },
    ),

    runCheck: defineTool<RunCheckArgs, CommandOutcome>(
      context,
      "run_check",
      "Run a test, typecheck, lint, or build check.",
      async (args) => {
        const script = args.script.length > 0 ? args.script : CONVENTIONAL_SCRIPT[args.kind];
        if (script === undefined) {
          throw new ToolExecutionError(`unknown check kind: ${String(args.kind)}`);
        }
        assertSafeScriptName(script);
        const command: CommandSpec = {
          executable: manager,
          args: [...workspaceArgs(manager, args.workspace), "run", script],
          cwd,
          purpose: args.kind,
          timeoutMs: context.limits.commandTimeoutMs,
        };
        return toCommandOutcome(command, await runProcess(command, context.limits));
      },
    ),
  };
}
