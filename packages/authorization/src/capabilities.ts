/**
 * The complete capability vocabulary, and the widest ceiling each capability
 * may ever have.
 *
 * This file is the top of the lattice. Every worker profile is a narrowing of
 * what is written here, and `narrow()` refuses to go the other way, so no
 * profile can grant authority that this file does not already describe.
 *
 * Tenuo runs in zero-trust mode for any capability with a non-empty ceiling:
 * every argument a tool is called with must be named here, or the call is
 * denied. That is why `content` and `expectedBeforeHash` appear even though
 * their constraint accepts any string — naming an argument is what makes it
 * visible to the policy, and an unnamed argument is a denial rather than a
 * silent pass.
 */

import { join } from "node:path";
import { exact, max, oneOf, pattern, under, type ConstraintExpr } from "@tenuo/core";
import type {
  BranchArgs,
  CreateDraftPrArgs,
  EmptyArgs,
  FetchReleaseDocumentArgs,
  InstallArgs,
  ListFilesArgs,
  ReadFileArgs,
  ReadGitDiffArgs,
  ReadRegistryMetadataArgs,
  RunCheckArgs,
  UpdateDependencyArgs,
  WriteFileArgs,
} from "@safe-upgrade/tools";

export const CAPABILITIES = [
  "read_file",
  "list_files",
  "write_source_file",
  "write_test_file",
  "write_ci_file",
  "install_dependencies",
  "update_dependency",
  "run_check",
  "read_registry_metadata",
  "fetch_release_document",
  "read_git_status",
  "read_git_diff",
  "create_branch",
  "push_branch",
  "create_draft_pr",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The argument shape of each capability's tool.
 *
 * Mapping capabilities to argument types lets the compiler reject a ceiling that
 * forgets an argument. Under Tenuo's zero-trust rule a forgotten argument is a
 * runtime denial, and catching that at build time beats catching it mid-run.
 */
export interface CapabilityArgs {
  read_file: ReadFileArgs;
  list_files: ListFilesArgs;
  write_source_file: WriteFileArgs;
  write_test_file: WriteFileArgs;
  write_ci_file: WriteFileArgs;
  install_dependencies: InstallArgs;
  update_dependency: UpdateDependencyArgs;
  run_check: RunCheckArgs;
  read_registry_metadata: ReadRegistryMetadataArgs;
  fetch_release_document: FetchReleaseDocumentArgs;
  read_git_status: EmptyArgs;
  read_git_diff: ReadGitDiffArgs;
  create_branch: BranchArgs;
  push_branch: BranchArgs;
  create_draft_pr: CreateDraftPrArgs;
}

/** Every argument of `A` must carry a constraint. No optional entries. */
export type Ceiling<A> = { readonly [Field in keyof A]-?: ConstraintExpr };

export type Ceilings = { readonly [C in Capability]: Ceiling<CapabilityArgs[C]> };

export interface CeilingContext {
  /** Canonical, symlink-resolved worktree root. */
  readonly worktreeRoot: string;
  /** The one package this run may upgrade. */
  readonly requestedPackage: string;
  /** The one version this run may install. */
  readonly targetVersion: string;
  /** The one branch this run may create and push. */
  readonly runBranch: string;
  readonly releaseHosts: readonly string[];
  readonly maxCommandTimeoutMs: number;
}

/** Any string, including empty and multi-line. Narrowing still applies. */
const anyText = () => pattern("*");

const ALL_CHECK_KINDS = ["test", "typecheck", "lint", "build"] as const;

/**
 * The widest allowed form of every capability. A run's parent session is minted
 * from exactly this, so the union of what workers can be granted is visible in
 * one place.
 */
export function capabilityCeilings(context: CeilingContext): Ceilings {
  const root = context.worktreeRoot;
  const workflows = join(root, ".github", "workflows");

  return {
    read_file: { path: under(root) },
    list_files: { root: under(root), glob: anyText() },

    write_source_file: {
      path: under(root),
      expectedBeforeHash: anyText(),
      content: anyText(),
    },
    write_test_file: {
      path: under(root),
      expectedBeforeHash: anyText(),
      content: anyText(),
    },
    // Narrower than the other writers at the ceiling: no worker, however
    // configured, may write a workflow outside .github/workflows.
    write_ci_file: {
      path: under(workflows),
      expectedBeforeHash: anyText(),
      content: anyText(),
    },

    install_dependencies: {
      lockfile: oneOf(["frozen", "update"]),
      lifecycleScripts: oneOf(["disabled", "enabled"]),
    },
    update_dependency: {
      // Pinned to the request. A second package cannot be upgraded in this run
      // even if a worker asks for it in good faith.
      packageName: exact(context.requestedPackage),
      targetVersion: exact(context.targetVersion),
    },
    run_check: {
      kind: oneOf([...ALL_CHECK_KINDS]),
      script: anyText(),
      workspace: anyText(),
    },

    read_registry_metadata: {
      packageName: exact(context.requestedPackage),
      version: anyText(),
    },
    fetch_release_document: { url: anyText() },

    read_git_status: {},
    read_git_diff: { pathspec: anyText() },
    create_branch: { name: exact(context.runBranch) },
    push_branch: { name: exact(context.runBranch) },
    create_draft_pr: {
      base: anyText(),
      head: exact(context.runBranch),
      title: anyText(),
      body: anyText(),
      // Not "should be a draft". Cannot be anything else.
      draft: exact(true),
    },
  };
}

/** Kept for policies that need a numeric ceiling on a caller-supplied timeout. */
export const timeoutCeiling = (maxMs: number) => max(maxMs);
