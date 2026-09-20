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
import { exact, max, oneOf, regex, under, urlSafe, wildcard, type ConstraintExpr } from "@tenuo/core";
import { EDITABLE_MANIFEST_FIELDS, allowedManifestValues } from "@safe-upgrade/tools";
import type {
  BranchArgs,
  CommitArgs,
  CreateDraftPrArgs,
  EmptyArgs,
  FetchReleaseDocumentArgs,
  InstallArgs,
  ListFilesArgs,
  ReadFileArgs,
  ReadGitDiffArgs,
  ReadPackageExportsArgs,
  ReadRegistryMetadataArgs,
  RunCheckArgs,
  UpdateDependencyArgs,
  UpdateManifestFieldArgs,
  WriteFileArgs,
} from "@safe-upgrade/tools";

export const CAPABILITIES = [
  "read_file",
  "list_files",
  "write_source_file",
  "write_test_file",
  "write_ci_file",
  "update_manifest_field",
  "install_dependencies",
  "update_dependency",
  "run_check",
  "read_registry_metadata",
  "read_package_exports",
  "fetch_release_document",
  "read_git_status",
  "read_git_diff",
  "create_branch",
  "commit_changes",
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
  update_manifest_field: UpdateManifestFieldArgs;
  install_dependencies: InstallArgs;
  update_dependency: UpdateDependencyArgs;
  run_check: RunCheckArgs;
  read_registry_metadata: ReadRegistryMetadataArgs;
  read_package_exports: ReadPackageExportsArgs;
  fetch_release_document: FetchReleaseDocumentArgs;
  read_git_status: EmptyArgs;
  read_git_diff: ReadGitDiffArgs;
  create_branch: BranchArgs;
  commit_changes: CommitArgs;
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
  /**
   * Manifests this run may edit structurally, from detection.
   *
   * Listed exactly rather than as `under(root)/**\/package.json`, so a manifest
   * that appears in the worktree after detection ran is not editable. In a
   * workspace the set is small and known, and an upgrade that needs to touch a
   * manifest nobody enumerated is a run worth stopping.
   */
  readonly manifestPaths: readonly string[];
}

/**
 * Named but unconstrained, which is the only way to leave an argument open in a
 * closed-world policy. `wildcard()` rather than `pattern("*")`: the glob is a
 * match over the whole value and says "any shape", where this says "any value at
 * all", which is what is meant for a file body or a PR description.
 */
const anyText = () => wildcard();

const ALL_CHECK_KINDS = ["test", "typecheck", "lint", "build"] as const;

const SEMVER = String.raw`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$`;

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

    /**
     * In the ceiling, in no worker's standing profile.
     *
     * The run may set a manifest's module type, because a CommonJS-to-ESM upgrade
     * cannot be done without it. No worker holds it by default, because it changes
     * how every file in the package loads. A worker asks, a human approves, and the
     * broker narrows this down to the one approved call.
     *
     * Both the field and the value are constrained here as well as in the tool. The
     * tool's allowlist is what makes the operation safe; these make it *auditable*,
     * since a denial then names the argument that was out of bounds.
     */
    update_manifest_field: {
      path: oneOf(context.manifestPaths),
      field: oneOf(EDITABLE_MANIFEST_FIELDS),
      value: oneOf(EDITABLE_MANIFEST_FIELDS.flatMap((field: string) => allowedManifestValues(field))),
      expectedBeforeHash: anyText(),
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
      // A version, not a path segment smuggled into the registry URL. A glob
      // cannot express this: `*` matches `/`, so `pattern("*.*.*")` accepts
      // `../../../etc/passwd`.
      version: regex(SEMVER),
    },
    /**
     * Reading a published version's exports, which means loading it.
     *
     * Bounded to the one package this run may upgrade, and to a version, not a path
     * segment: the version reaches an installer argument, and `pattern` would not do —
     * `*` matches `/`, so a glob here would accept `../../../etc/passwd`.
     */
    read_package_exports: {
      packageName: exact(context.requestedPackage),
      version: regex(SEMVER),
    },
    // The only network capability, so the host allowlist and the SSRF blocking
    // belong here rather than only in the tool body.
    fetch_release_document: {
      url: urlSafe({ allowDomains: context.releaseHosts, schemes: ["https"] }),
    },

    read_git_status: {},
    read_git_diff: { pathspec: anyText() },
    create_branch: { name: exact(context.runBranch) },
    // Any message, because a message cannot do damage; the tool bounds its shape
    // and the branch it may land on.
    commit_changes: { message: anyText() },
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
