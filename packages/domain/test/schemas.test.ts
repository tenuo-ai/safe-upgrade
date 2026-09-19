import { describe, expect, it } from "vitest";
import {
  absolutePathSchema,
  commandSpecSchema,
  exactVersionSchema,
  migrationFindingSchema,
  packageNameSchema,
  parseOrThrow,
  upgradeRequestSchema,
} from "../src/schemas.ts";

describe("exact versions", () => {
  it("accepts an exact semver", () => {
    for (const version of ["4.0.0", "1.2.3", "2.0.0-rc.1", "1.0.0+build.5"]) {
      expect(exactVersionSchema.safeParse(version).success, version).toBe(true);
    }
  });

  it("rejects ranges, tags, and wildcards", () => {
    for (const version of ["^4.0.0", "~1.2.3", ">=2", "latest", "4.x", "4", "4.0", ""]) {
      expect(exactVersionSchema.safeParse(version).success, version).toBe(false);
    }
  });
});

describe("package names", () => {
  it("accepts plain and scoped names", () => {
    for (const name of ["zod", "left-pad", "@tenuo/core", "@scope/name.js"]) {
      expect(packageNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it("rejects names that could be read as a path or a flag", () => {
    for (const name of ["../escape", "-rf", "Zod", "@scope", "a/b/c", "pkg;rm -rf /"]) {
      expect(packageNameSchema.safeParse(name).success, name).toBe(false);
    }
  });
});

describe("paths", () => {
  it("requires an absolute path with no traversal", () => {
    expect(absolutePathSchema.safeParse("/tmp/worktree/src/index.ts").success).toBe(true);
    expect(absolutePathSchema.safeParse("src/index.ts").success).toBe(false);
    expect(absolutePathSchema.safeParse("/tmp/../etc/passwd").success).toBe(false);
    expect(absolutePathSchema.safeParse("/tmp/a\0b").success).toBe(false);
  });
});

describe("command specs", () => {
  it("rejects an executable that is not a bare command name", () => {
    const base = { args: [], cwd: "/tmp/wt", purpose: "test" as const, timeoutMs: 1000 };
    expect(commandSpecSchema.safeParse({ ...base, executable: "pnpm" }).success).toBe(true);
    expect(commandSpecSchema.safeParse({ ...base, executable: "pnpm test && curl x" }).success).toBe(false);
    expect(commandSpecSchema.safeParse({ ...base, executable: "/bin/sh" }).success).toBe(false);
  });
});

describe("migration findings", () => {
  it("requires every finding to cite stored evidence", () => {
    const finding = {
      id: "f1",
      releaseClaim: "read() was removed",
      evidenceIds: [],
      affectedSymbols: ["read"],
      affectedFiles: ["src/index.ts"],
      requiredChange: "call parse() instead",
      confidence: 0.9,
    };
    expect(migrationFindingSchema.safeParse(finding).success).toBe(false);
    expect(migrationFindingSchema.safeParse({ ...finding, evidenceIds: ["e1"] }).success).toBe(true);
  });
});

describe("parseOrThrow", () => {
  it("reports the failing field without throwing raw Zod output", () => {
    expect(() =>
      parseOrThrow(
        upgradeRequestSchema,
        {
          runId: "not-a-uuid",
          repositoryPath: "/tmp/wt",
          packageName: "zod",
          targetVersion: "^4.0.0",
          allowTransitive: false,
          createDraftPullRequest: false,
        },
        "upgrade request",
      ),
    ).toThrow(/upgrade request failed validation:.*runId.*targetVersion/s);
  });
});
