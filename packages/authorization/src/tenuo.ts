/**
 * Tenuo runtime construction.
 *
 * Two entry points, and the difference matters. The development runtime mints
 * its own root, which is only acceptable for fixtures and tests. Production
 * imports a warrant issued elsewhere and verifies it against an explicitly
 * trusted root key, so this process can narrow authority it was given but can
 * never create authority for itself.
 */

import { join } from "node:path";
import { createTenuo, type Session, type Tenuo } from "@tenuo/core";
import type { PackageManager } from "@safe-upgrade/domain";
import type { AuditLog } from "@safe-upgrade/evidence";
import {
  DEFAULT_LIMITS,
  createPathContext,
  type GitHubToolOptions,
  type ToolContext,
  type ToolLimits,
} from "@safe-upgrade/tools";
import { RELEASE_HOST_ALLOWLIST } from "@safe-upgrade/tools";
import { capabilityCeilings, type CeilingContext, type Ceilings } from "./capabilities.ts";
import { workerProfiles, type WorkerProfile } from "./profiles.ts";
import { DelegationBroker } from "./broker.ts";
import { createProtectedToolset, type ProtectedToolset } from "./protected-tools.ts";
import { SessionRegistry } from "./session-registry.ts";
import type { WorkerId } from "@safe-upgrade/domain";

export interface RuntimeOptions {
  readonly runId: string;
  /** Worktree root. Canonicalized here, and every path capability derives from it. */
  readonly worktreeRoot: string;
  readonly packageManager: PackageManager;
  readonly defaultBranch: string;
  readonly runBranch: string;
  readonly requestedPackage: string;
  /** Manifests this run may edit structurally, as absolute paths. */
  readonly manifestPaths?: readonly string[];
  readonly targetVersion: string;
  readonly requestedUpdates?: Readonly<Record<string, string>>;
  readonly workspaceSelector?: string;
  readonly audit: AuditLog;
  readonly limits?: ToolLimits;
  readonly github?: GitHubToolOptions;
  readonly releaseHosts?: readonly string[];
  readonly parentTtlSeconds?: number;
  readonly onInvoke?: (name: string, args: Readonly<Record<string, unknown>>) => void;
  /** Explicit local CLI trial, permitted to mint a root outside NODE_ENV development. */
  readonly allowSelfAuthorizedLocalTrial?: boolean;
}

export interface ProductionRuntimeOptions extends RuntimeOptions {
  /** Environment variable holding the hex public key of the trusted issuer. */
  readonly rootPublicKeyEnv: string;
  /** Warrant minted by that issuer for this run. */
  readonly warrant: string;
  /** Environment variable holding this holder's 32-byte secret. */
  readonly holderSecretEnv: string;
}

export interface AuthorizationRuntime {
  readonly tenuo: Tenuo;
  readonly parentSession: Session;
  readonly ceilings: Ceilings;
  readonly profiles: Readonly<Record<WorkerId, WorkerProfile>>;
  readonly toolset: ProtectedToolset;
  readonly broker: DelegationBroker;
  readonly registry: SessionRegistry;
  readonly toolContext: ToolContext;
}

function assemble(
  tenuo: Tenuo,
  parentSession: Session,
  options: RuntimeOptions,
  ceilingContext: CeilingContext,
  toolContext: ToolContext,
): AuthorizationRuntime {
  const ceilings = capabilityCeilings(ceilingContext);
  const profiles = workerProfiles(ceilingContext);
  const toolset = createProtectedToolset({
    tenuo,
    context: toolContext,
    ceilings,
    ...(options.github === undefined ? {} : { github: options.github }),
    ...(options.releaseHosts === undefined ? {} : { releaseHosts: options.releaseHosts }),
  });
  const registry = new SessionRegistry();
  const broker = new DelegationBroker({
    tenuo,
    parentSession,
    profiles,
    audit: options.audit,
    toolset,
    ceilings,
    worktreeRoot: ceilingContext.worktreeRoot,
    registry,
  });
  return { tenuo, parentSession, ceilings, profiles, toolset, broker, registry, toolContext };
}

function contexts(options: RuntimeOptions): {
  readonly ceilingContext: CeilingContext;
  readonly toolContext: ToolContext;
} {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const paths = createPathContext(options.worktreeRoot);
  const requestedUpdates = options.requestedUpdates ?? {
    [options.requestedPackage]: options.targetVersion,
  };
  const requestedPackages = Object.keys(requestedUpdates);
  const requestedVersions = [...new Set(Object.values(requestedUpdates))];
  const workspaceSelector = options.workspaceSelector ?? "";
  const ceilingContext: CeilingContext = {
    worktreeRoot: paths.realRoot,
    requestedPackage: options.requestedPackage,
    targetVersion: options.targetVersion,
    requestedPackages,
    requestedVersions,
    requestedUpdates,
    workspaceSelector,
    runBranch: options.runBranch,
    releaseHosts: options.releaseHosts ?? RELEASE_HOST_ALLOWLIST,
    maxCommandTimeoutMs: limits.commandTimeoutMs,
    // From detection. Defaults to the root manifest alone, which is what a
    // single-package repository has and is the least this can be.
    manifestPaths: options.manifestPaths ?? [join(paths.realRoot, "package.json")],
  };
  const toolContext: ToolContext = {
    paths,
    runId: options.runId,
    packageManager: options.packageManager,
    runBranch: options.runBranch,
    defaultBranch: options.defaultBranch,
    requestedPackage: options.requestedPackage,
    targetVersion: options.targetVersion,
    requestedUpdates,
    workspaceSelector,
    limits,
    ...(options.onInvoke === undefined ? {} : { onInvoke: options.onInvoke }),
  };
  return { ceilingContext, toolContext };
}

/**
 * Long enough for an install, a build, and a couple of verification rounds.
 *
 * There is no revocation path here: a leaked session stays usable until it
 * expires, so the TTL is the whole containment story and the run is expected to
 * re-issue rather than hold a longer one. Callers that genuinely need more can
 * pass `parentTtlSeconds`, and should record why.
 */
const DEFAULT_PARENT_TTL_SECONDS = 1_800;

/**
 * Fixture and test runtime. Mints its own root, which `@tenuo/core` permits only
 * when NODE_ENV is development or test.
 */
export function createDevAuthorizationRuntime(options: RuntimeOptions): AuthorizationRuntime {
  const tenuo = createTenuo({
    root: createTenuo.devRoot({
      allowInProduction: options.allowSelfAuthorizedLocalTrial === true,
    }),
  });
  const { ceilingContext, toolContext } = contexts(options);
  // The parent holds exactly the union of the ceilings, so every capability a
  // worker could ever be delegated is visible in one object.
  const parentSession = tenuo.session({
    allow: capabilityCeilings(ceilingContext),
    ttlSeconds: options.parentTtlSeconds ?? DEFAULT_PARENT_TTL_SECONDS,
  });
  return assemble(tenuo, parentSession, options, ceilingContext, toolContext);
}

/**
 * Production runtime. The warrant is imported, not minted: this process cannot
 * issue authority to itself, only narrow what an external issuer granted.
 */
export function createProductionAuthorizationRuntime(
  options: ProductionRuntimeOptions,
): AuthorizationRuntime {
  const tenuo = createTenuo({
    trustedRoots: [createTenuo.publicKeyFromEnv(options.rootPublicKeyEnv)],
  });
  const parentSession = tenuo.sessionFromWire({
    warrant: options.warrant,
    holderKey: createTenuo.holderKeyFromEnv(options.holderSecretEnv),
  });
  const { ceilingContext, toolContext } = contexts(options);
  return assemble(tenuo, parentSession, options, ceilingContext, toolContext);
}
