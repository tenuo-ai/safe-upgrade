/**
 * Git tools.
 *
 * Reading history and diffs is safe; changing refs is not. The write side is
 * limited to creating and pushing one branch whose name trusted code chose
 * before the run started, so there is no argument a worker can pass that makes
 * it push somewhere else.
 */

import { ToolExecutionError } from "@safe-upgrade/domain";
import type { CommandSpec } from "@safe-upgrade/domain";
import { defineTool, type EmptyArgs, type RawTool, type ToolContext } from "./context.ts";
import { runProcess } from "./process.ts";

const BRANCH_NAME = /^[a-z0-9][a-z0-9._/-]{0,100}$/i;

export interface GitStatus {
  readonly clean: boolean;
  readonly branch: string;
  readonly head: string;
  readonly entries: readonly string[];
}

export type ReadGitDiffArgs = {
  /** Restrict the diff to one path. Empty string means the whole worktree. */
  readonly pathspec: string;
}

export type BranchArgs = {
  readonly name: string;
}

export function assertBranchName(name: string): void {
  if (!BRANCH_NAME.test(name)) {
    throw new ToolExecutionError(`not an acceptable branch name: ${name}`);
  }
  if (name.includes("..") || name.endsWith("/") || name.endsWith(".lock")) {
    throw new ToolExecutionError(`not an acceptable branch name: ${name}`);
  }
}

export function createGitTools(context: ToolContext): {
  readonly readGitStatus: RawTool<EmptyArgs, GitStatus>;
  readonly readGitDiff: RawTool<ReadGitDiffArgs, string>;
  readonly createBranch: RawTool<BranchArgs, { readonly branch: string }>;
  readonly pushBranch: RawTool<BranchArgs, { readonly branch: string; readonly pushed: boolean }>;
} {
  const cwd = context.paths.realRoot;
  const git = async (args: readonly string[], timeoutMs = 60_000): Promise<string> => {
    const command: CommandSpec = { executable: "git", args, cwd, purpose: "lint", timeoutMs };
    const outcome = await runProcess(command, context.limits);
    if (outcome.exitCode !== 0) {
      throw new ToolExecutionError(`git ${args[0] ?? ""} failed with exit code ${String(outcome.exitCode)}`);
    }
    return outcome.stdout;
  };

  return {
    readGitStatus: defineTool<EmptyArgs, GitStatus>(
      context,
      "read_git_status",
      "Report worktree cleanliness, current branch, and HEAD.",
      async () => {
        const porcelain = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
        const entries = porcelain.split("\n").filter((line) => line.trim().length > 0);
        return {
          clean: entries.length === 0,
          branch: (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
          head: (await git(["rev-parse", "HEAD"])).trim(),
          entries,
        };
      },
    ),

    readGitDiff: defineTool<ReadGitDiffArgs, string>(
      context,
      "read_git_diff",
      "Read the worktree diff, optionally limited to one path.",
      async (args) => {
        const base = ["diff", "--no-color", "--no-ext-diff"];
        if (args.pathspec.length === 0) {
          return git(base);
        }
        if (args.pathspec.startsWith("-")) {
          throw new ToolExecutionError("pathspec must not look like a flag");
        }
        // `--` ends option parsing, so a path can never be read as a flag.
        return git([...base, "--", args.pathspec]);
      },
    ),

    createBranch: defineTool<BranchArgs, { readonly branch: string }>(
      context,
      "create_branch",
      "Create and check out the run branch.",
      async (args) => {
        assertBranchName(args.name);
        if (args.name !== context.runBranch) {
          throw new ToolExecutionError(`this run may only create ${context.runBranch}, not ${args.name}`);
        }
        await git(["checkout", "-b", args.name]);
        return { branch: args.name };
      },
    ),

    pushBranch: defineTool<BranchArgs, { readonly branch: string; readonly pushed: boolean }>(
      context,
      "push_branch",
      "Push the run branch to origin. Never the default branch, never forced.",
      async (args) => {
        assertBranchName(args.name);
        if (args.name === context.defaultBranch) {
          throw new ToolExecutionError(`refusing to push the default branch ${context.defaultBranch}`);
        }
        if (args.name !== context.runBranch) {
          throw new ToolExecutionError(`this run may only push ${context.runBranch}, not ${args.name}`);
        }
        // An explicit refspec avoids any dependence on push.default, and there
        // is no force flag to be found anywhere in this file.
        await git(["push", "--set-upstream", "origin", `refs/heads/${args.name}:refs/heads/${args.name}`], 180_000);
        return { branch: args.name, pushed: true };
      },
    ),
  };
}
