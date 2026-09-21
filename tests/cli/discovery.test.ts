import { describe, expect, it } from "vitest";
import { discoverUpgradeCandidate, type RegistryFetch } from "@safe-upgrade/cli";
import { createFixtureRepo } from "../support/fixture-repo.ts";

function registryVersion(version: string): RegistryFetch {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ version }),
  });
}

describe("automatic assessment candidate discovery", () => {
  it("uses the lockfile version and the registry's exact latest version", async () => {
    const repo = createFixtureRepo();
    try {
      const result = await discoverUpgradeCandidate({
        repositoryPath: repo.path,
        fetch: registryVersion("5.0.0"),
      });
      expect(result.selected).toEqual({
        packageName: "escape-string-regexp",
        currentVersion: "4.0.0",
        targetVersion: "5.0.0",
        dependencyKind: "production",
      });
      expect(result.checkedCount).toBe(1);
      expect(result.unavailableCount).toBe(0);
    } finally {
      repo.cleanup();
    }
  });

  it("says when every direct dependency is already current", async () => {
    const repo = createFixtureRepo();
    try {
      await expect(
        discoverUpgradeCandidate({
          repositoryPath: repo.path,
          fetch: registryVersion("4.0.0"),
        }),
      ).rejects.toThrow(/no outdated direct dependency/);
    } finally {
      repo.cleanup();
    }
  });

  it("does not mistake a registry failure for an up-to-date repository", async () => {
    const repo = createFixtureRepo();
    try {
      await expect(
        discoverUpgradeCandidate({
          repositoryPath: repo.path,
          fetch: async () => {
            throw new Error("offline");
          },
        }),
      ).rejects.toThrow(/could not resolve any/);
    } finally {
      repo.cleanup();
    }
  });
});
