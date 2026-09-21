/**
 * What every worker knows before it starts.
 *
 * All of it is produced by trusted code — the request after validation, the facts
 * after detection, the commit after isolation — and none of it is derived from a
 * model or from another worker's output.
 *
 * Workers take this rather than reading the same values out of graph state. State
 * carries `repository` as nullable, because the graph can be invoked before the
 * inspector has run, and a worker reaching for `state.repository?.worktreePath`
 * either has to handle a null it cannot do anything about or paper over it with a
 * fallback that silently builds a wrong path.
 */

import type {
  CheckPurpose,
  RepositoryFacts,
  UpgradeRequest,
} from "@safe-upgrade/domain";
import type { CheckKind } from "@safe-upgrade/tools";
import type { PatchGenerator } from "./coding-model.ts";

export interface RunContext {
  readonly request: UpgradeRequest;
  readonly facts: RepositoryFacts;
  /** Script to run per check the repository actually defines. */
  readonly checkScripts: Readonly<Partial<Record<CheckKind, string>>>;
  /** Purposes the repository does not define, or defines in a form we will not run. */
  readonly absentChecks: readonly CheckPurpose[];
  /** Commit the worktree was created from. */
  readonly startCommit: string;
  /** The one branch this run may create and push. */
  readonly runBranch: string;
  /** Whether the user's checkout was clean when the run started. */
  readonly sourceClean: boolean;
  readonly detectionWarnings: readonly string[];
  /** Optional open-ended patch proposer. It has no tools or repository access. */
  readonly patchGenerator?: PatchGenerator;
}

/** Absolute path inside the run's worktree. */
export function inWorktree(context: RunContext, ...segments: readonly string[]): string {
  return [context.facts.worktreePath, ...segments].join("/");
}
