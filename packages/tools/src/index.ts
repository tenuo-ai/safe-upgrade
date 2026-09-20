export type { EmptyArgs, RawTool, ToolContext, ToolLimits } from "./context.ts";
export { DEFAULT_LIMITS, defineTool } from "./context.ts";

export type { FileClass, PathContext, ResolvedPath } from "./paths.ts";
export { classifyPath, createPathContext, requireClass, resolveInsideRoot } from "./paths.ts";

export type {
  ListFilesArgs,
  ReadFileArgs,
  ReadFileResult,
  WriteFileArgs,
  WriteFileResult,
} from "./files.ts";
export { ABSENT, createFileTools } from "./files.ts";

export type { RunOutcome } from "./process.ts";
export { assertNoShellSyntax, buildEnvironment, runProcess } from "./process.ts";

export type {
  CheckKind,
  CommandOutcome,
  InstallArgs,
  LifecycleScriptMode,
  LockfileMode,
  RunCheckArgs,
  UpdateDependencyArgs,
} from "./packages.ts";
export { assertSafeScriptName, createPackageTools, isScriptBodyRunnable } from "./packages.ts";

export type {
  FetchReleaseDocumentArgs,
  FetchedDocument,
  ModuleType,
  PublishedShape,
  ReadRegistryMetadataArgs,
  RegistryMetadata,
} from "./releases.ts";
export {
  RELEASE_HOST_ALLOWLIST,
  createReleaseTools,
  isPrivateAddress,
  normalizeDocument,
  publishedShape,
} from "./releases.ts";

export type { BranchArgs, CommitArgs, CommitResult, GitStatus, ReadGitDiffArgs } from "./git.ts";
export { assertBranchName, assertCommitMessage, createGitTools } from "./git.ts";

export type { CreateDraftPrArgs, DraftPullRequest, GitHubToolOptions } from "./github.ts";
export { createGitHubTools } from "./github.ts";

export type {
  UpdateManifestFieldArgs,
  UpdateManifestFieldResult,
} from "./manifest.ts";
export {
  EDITABLE_MANIFEST_FIELDS,
  allowedManifestValues,
  createManifestTools,
  setTopLevelField,
} from "./manifest.ts";
