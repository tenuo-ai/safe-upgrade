/** Find one useful direct-dependency upgrade for the first-run assessment. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveInstalledVersion } from "@safe-upgrade/bootstrap";
import { PackageResolutionError, relateVersions, type PackageManager } from "@safe-upgrade/domain";

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

const MAX_DIRECT_DEPENDENCIES = 200;
const REGISTRY_CONCURRENCY = 8;

type DependencyKind = "production" | "optional" | "development";

interface RegistryResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type RegistryFetch = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<RegistryResponse>;

export interface UpgradeCandidate {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly dependencyKind: DependencyKind;
}

export interface CandidateDiscovery {
  readonly selected: UpgradeCandidate;
  readonly outdated: readonly UpgradeCandidate[];
  readonly checkedCount: number;
  readonly unavailableCount: number;
}

export interface DiscoveryOptions {
  readonly repositoryPath: string;
  readonly workspace?: string;
  readonly fetch?: RegistryFetch;
}

interface DeclaredDependency {
  readonly packageName: string;
  readonly dependencyKind: DependencyKind;
}

/**
 * Select a candidate without executing repository code or changing a manifest.
 * The lockfile supplies the current version and the registry's `latest` document
 * supplies the exact target, so the assessment never reasons about ranges.
 */
export async function discoverUpgradeCandidate(options: DiscoveryOptions): Promise<CandidateDiscovery> {
  const root = options.repositoryPath;
  const present = LOCKFILES.filter(([name]) => existsSync(join(root, name)));
  if (present.length !== 1) {
    throw new PackageResolutionError(
      present.length === 0
        ? "automatic assessment needs package-lock.json, pnpm-lock.yaml, or yarn.lock"
        : `automatic assessment found more than one lockfile: ${present.map(([name]) => name).join(", ")}`,
    );
  }
  const [lockfile, manager] = present[0] as readonly [string, PackageManager];
  const workspace = options.workspace ?? "";
  const manifestPath = join(root, workspace, "package.json");
  const manifest = readManifest(manifestPath);
  const declared = directDependencies(manifest);
  if (declared.length === 0) {
    throw new PackageResolutionError(
      `${workspace === "" ? "the root package" : workspace} has no direct dependencies to assess`,
    );
  }
  if (declared.length > MAX_DIRECT_DEPENDENCIES) {
    throw new PackageResolutionError(
      `automatic assessment found ${String(declared.length)} direct dependencies; name one package explicitly instead`,
    );
  }

  const request = options.fetch ?? defaultRegistryFetch;
  const results = await concurrentMap(declared, REGISTRY_CONCURRENCY, async (dependency) => {
    const currentVersion = resolveInstalledVersion(
      manager,
      join(root, lockfile),
      dependency.packageName,
      workspace,
    );
    if (currentVersion === null) {
      return { kind: "unavailable" as const };
    }
    try {
      const response = await request(
        `https://registry.npmjs.org/${encodeURIComponent(dependency.packageName)}/latest`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) {
        return { kind: "unavailable" as const };
      }
      const body = await response.json();
      const targetVersion = versionFrom(body);
      if (targetVersion === null) {
        return { kind: "unavailable" as const };
      }
      if (relateVersions(currentVersion, targetVersion) !== "ahead") {
        return { kind: "current" as const };
      }
      return {
        kind: "outdated" as const,
        candidate: {
          packageName: dependency.packageName,
          currentVersion,
          targetVersion,
          dependencyKind: dependency.dependencyKind,
        } satisfies UpgradeCandidate,
      };
    } catch {
      return { kind: "unavailable" as const };
    }
  });

  const outdated = results
    .filter((result): result is Extract<(typeof results)[number], { kind: "outdated" }> => result.kind === "outdated")
    .map((result) => result.candidate)
    .sort(compareCandidates);
  const unavailableCount = results.filter((result) => result.kind === "unavailable").length;
  const selected = outdated[0];
  if (selected === undefined) {
    if (unavailableCount === results.length) {
      throw new PackageResolutionError(
        "automatic assessment could not resolve any direct dependency from the lockfile and npm registry",
      );
    }
    throw new PackageResolutionError("no outdated direct dependency was found");
  }
  return { selected, outdated, checkedCount: declared.length, unavailableCount };
}

async function defaultRegistryFetch(
  url: string,
  init: { readonly signal: AbortSignal },
): Promise<RegistryResponse> {
  return fetch(url, {
    signal: init.signal,
    headers: { accept: "application/json" },
    redirect: "error",
  });
}

function readManifest(path: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PackageResolutionError(`could not read ${path}: ${messageOf(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PackageResolutionError(`${path} is not a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function directDependencies(manifest: Readonly<Record<string, unknown>>): readonly DeclaredDependency[] {
  const kinds: ReadonlyArray<readonly [string, DependencyKind]> = [
    ["dependencies", "production"],
    ["optionalDependencies", "optional"],
    ["devDependencies", "development"],
  ];
  const found = new Map<string, DependencyKind>();
  for (const [field, kind] of kinds) {
    const block = manifest[field];
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      continue;
    }
    for (const name of Object.keys(block).sort()) {
      if (!found.has(name)) {
        found.set(name, kind);
      }
    }
  }
  return [...found].map(([packageName, dependencyKind]) => ({ packageName, dependencyKind }));
}

function versionFrom(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const version = (value as Record<string, unknown>)["version"];
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
}

function compareCandidates(left: UpgradeCandidate, right: UpgradeCandidate): number {
  const leftDelta = versionDelta(left.currentVersion, left.targetVersion);
  const rightDelta = versionDelta(right.currentVersion, right.targetVersion);
  if (leftDelta !== rightDelta) {
    return rightDelta - leftDelta;
  }
  const weight: Readonly<Record<DependencyKind, number>> = {
    production: 3,
    optional: 2,
    development: 1,
  };
  if (weight[left.dependencyKind] !== weight[right.dependencyKind]) {
    return weight[right.dependencyKind] - weight[left.dependencyKind];
  }
  return left.packageName.localeCompare(right.packageName);
}

/** Major changes first, then minor, then patch. */
function versionDelta(current: string, target: string): number {
  const before = current.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];
  const after = target.split(/[+-]/, 1)[0]?.split(".").map(Number) ?? [];
  if (before[0] !== after[0]) return 3;
  if (before[1] !== after[1]) return 2;
  return 1;
}

async function concurrentMap<T, U>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const output = new Array<U>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await visit(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
