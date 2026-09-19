/**
 * Wraps every side-effecting tool in its capability ceiling.
 *
 * Workers never see a raw tool. The only reference they get is the wrapped one,
 * whose `execute` authorizes before the body runs, so a denial happens strictly
 * before the filesystem, a process, git, or the network is touched.
 *
 * A tool being absent from a prompt is not a control. Authorization is the
 * control, and it applies to every call regardless of how the call was produced.
 */

import type { ProtectedTool, Tenuo } from "@tenuo/core";
import {
  createFileTools,
  createGitHubTools,
  createGitTools,
  createPackageTools,
  createReleaseTools,
  type GitHubToolOptions,
  type RawTool,
  type ToolContext,
} from "@safe-upgrade/tools";
import type { Capability, CapabilityArgs, Ceilings } from "./capabilities.ts";

type Wrapped<T> = T extends RawTool<infer A, infer R>
  ? ProtectedTool<{ execute: (args: A) => Promise<R> }>
  : never;

export interface ProtectedToolset {
  readonly read_file: Wrapped<ReturnType<typeof createFileTools>["readFile"]>;
  readonly list_files: Wrapped<ReturnType<typeof createFileTools>["listFiles"]>;
  readonly write_source_file: Wrapped<ReturnType<typeof createFileTools>["writeSourceFile"]>;
  readonly write_test_file: Wrapped<ReturnType<typeof createFileTools>["writeTestFile"]>;
  readonly write_ci_file: Wrapped<ReturnType<typeof createFileTools>["writeCiFile"]>;
  readonly install_dependencies: Wrapped<ReturnType<typeof createPackageTools>["installDependencies"]>;
  readonly update_dependency: Wrapped<ReturnType<typeof createPackageTools>["updateDependency"]>;
  readonly run_check: Wrapped<ReturnType<typeof createPackageTools>["runCheck"]>;
  readonly read_registry_metadata: Wrapped<ReturnType<typeof createReleaseTools>["readRegistryMetadata"]>;
  readonly fetch_release_document: Wrapped<ReturnType<typeof createReleaseTools>["fetchReleaseDocument"]>;
  readonly read_git_status: Wrapped<ReturnType<typeof createGitTools>["readGitStatus"]>;
  readonly read_git_diff: Wrapped<ReturnType<typeof createGitTools>["readGitDiff"]>;
  readonly create_branch: Wrapped<ReturnType<typeof createGitTools>["createBranch"]>;
  readonly push_branch: Wrapped<ReturnType<typeof createGitTools>["pushBranch"]>;
  /** Present only when the run is configured with a GitHub repository and token. */
  readonly create_draft_pr?: Wrapped<ReturnType<typeof createGitHubTools>["createDraftPr"]>;
}

export interface ProtectedToolsetOptions {
  readonly tenuo: Tenuo;
  readonly context: ToolContext;
  readonly ceilings: Ceilings;
  readonly github?: GitHubToolOptions;
  readonly releaseHosts?: readonly string[];
}

export function createProtectedToolset(options: ProtectedToolsetOptions): ProtectedToolset {
  const { tenuo, context, ceilings } = options;

  const wrap = <C extends Capability, R>(
    capability: C,
    raw: RawTool<CapabilityArgs[C], R>,
  ): ProtectedTool<{ execute: (args: CapabilityArgs[C]) => Promise<R> }> => {
    if (raw.name !== capability) {
      throw new Error(`tool ${raw.name} is being wrapped as ${capability}`);
    }
    return tenuo.tool({ execute: raw.execute }, { allow: ceilings[capability], capability });
  };

  const files = createFileTools(context);
  const packages = createPackageTools(context);
  const releases = createReleaseTools(context, options.releaseHosts);
  const git = createGitTools(context);

  const toolset: ProtectedToolset = {
    read_file: wrap("read_file", files.readFile),
    list_files: wrap("list_files", files.listFiles),
    write_source_file: wrap("write_source_file", files.writeSourceFile),
    write_test_file: wrap("write_test_file", files.writeTestFile),
    write_ci_file: wrap("write_ci_file", files.writeCiFile),
    install_dependencies: wrap("install_dependencies", packages.installDependencies),
    update_dependency: wrap("update_dependency", packages.updateDependency),
    run_check: wrap("run_check", packages.runCheck),
    read_registry_metadata: wrap("read_registry_metadata", releases.readRegistryMetadata),
    fetch_release_document: wrap("fetch_release_document", releases.fetchReleaseDocument),
    read_git_status: wrap("read_git_status", git.readGitStatus),
    read_git_diff: wrap("read_git_diff", git.readGitDiff),
    create_branch: wrap("create_branch", git.createBranch),
    push_branch: wrap("push_branch", git.pushBranch),
  };

  if (options.github === undefined) {
    return toolset;
  }
  const github = createGitHubTools(context, options.github);
  return { ...toolset, create_draft_pr: wrap("create_draft_pr", github.createDraftPr) };
}

/** Every wrapped tool, for minting a parent session from the union of ceilings. */
export function allWrappedTools(toolset: ProtectedToolset): readonly object[] {
  return Object.values(toolset).filter((value): value is object => typeof value === "object" && value !== null);
}
