import type { PackageManager } from "@safe-upgrade/domain";
import type { PathContext } from "./paths.ts";

/**
 * Everything a tool implementation needs, all of it supplied by trusted code.
 * No worker and no model contributes to this object.
 */
export interface ToolContext {
  readonly paths: PathContext;
  readonly runId: string;
  readonly packageManager: PackageManager;
  /** Branch the run may push. Anything else is refused by `push_branch`. */
  readonly runBranch: string;
  readonly defaultBranch: string;
  /** The single package this run is allowed to upgrade. */
  readonly requestedPackage: string;
  readonly targetVersion: string;
  readonly limits: ToolLimits;
  /**
   * Fires when a tool body starts, which is only ever after authorization
   * allowed the call. Denied calls never reach it.
   */
  readonly onInvoke?: (name: string, args: Readonly<Record<string, unknown>>) => void;
}

export interface ToolLimits {
  readonly commandTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
  readonly maxFileBytes: number;
  readonly maxReleaseBodyBytes: number;
  readonly releaseTimeoutMs: number;
}

export const DEFAULT_LIMITS: ToolLimits = {
  commandTimeoutMs: 600_000,
  maxCommandOutputBytes: 2_000_000,
  maxFileBytes: 2_000_000,
  maxReleaseBodyBytes: 1_000_000,
  releaseTimeoutMs: 20_000,
};

/**
 * A tool that takes no arguments. Declared with no keys so that its capability
 * ceiling is genuinely empty rather than an open index signature.
 */
export type EmptyArgs = Record<never, never>;

/** The shape `tenuo.tool()` wraps. Arguments are always a flat scalar record. */
export interface RawTool<A extends Record<string, unknown>, R> {
  readonly name: string;
  readonly description?: string;
  execute: (args: A) => Promise<R>;
}

export function defineTool<A extends Record<string, unknown>, R>(
  context: ToolContext,
  name: string,
  description: string,
  body: (args: A) => Promise<R>,
): RawTool<A, R> {
  return {
    name,
    description,
    execute: async (args: A): Promise<R> => {
      context.onInvoke?.(name, args);
      return body(args);
    },
  };
}
