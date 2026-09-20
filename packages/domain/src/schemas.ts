/**
 * Validation for everything that crosses a trust boundary: CLI input, model
 * proposals, persisted graph state, and remote metadata.
 *
 * These schemas are part of the trusted computing base. A value that has not
 * passed through one of them is untrusted, however plausible it looks.
 */

import { z } from "zod";
import type { CheckPurpose, PackageManager } from "./types.ts";

/** Exact semver only. Ranges, tags, and wildcards are rejected by design. */
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** npm naming rules, restricted to the subset we are willing to act on. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const exactVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(EXACT_SEMVER, "target version must be an exact semver, not a range or tag");

export const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(PACKAGE_NAME, "not a valid npm package name");

/** Absolute, already-normalized POSIX path. Callers canonicalize before validating. */
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/"), "path must be absolute")
  .refine((value) => !value.split("/").includes(".."), "path must not contain '..'")
  .refine((value) => !value.includes("\0"), "path must not contain a null byte");

export const packageManagerSchema: z.ZodType<PackageManager> = z.enum(["npm", "pnpm", "yarn"]);

export const checkPurposeSchema: z.ZodType<CheckPurpose> = z.enum([
  "install",
  "test",
  "typecheck",
  "lint",
  "build",
]);

export const commandSpecSchema = z.object({
  executable: z
    .string()
    .min(1)
    .max(128)
    // No shell is ever involved, but a command name containing shell syntax
    // signals that someone built it from a script body rather than an allowlist.
    .regex(/^[A-Za-z0-9._-]+$/, "executable must be a bare command name"),
  args: z.array(z.string().max(4096)).max(64),
  cwd: absolutePathSchema,
  purpose: checkPurposeSchema,
  timeoutMs: z.number().int().positive().max(1_800_000),
});

/** Repository-relative workspace path, or empty for the root. */
const workspacePathSchema = z
  .string()
  .max(512)
  .regex(/^(?:|[A-Za-z0-9._@-][A-Za-z0-9._/@-]*)$/, "workspace must be a relative path without '..'");

export const upgradeTargetSchema = z.object({
  packageName: packageNameSchema,
  targetVersion: exactVersionSchema,
});

export const upgradeRequestSchema = z.object({
  runId: z.string().uuid(),
  repositoryPath: absolutePathSchema,
  packageName: packageNameSchema,
  targetVersion: exactVersionSchema,
  companions: z.array(upgradeTargetSchema).max(8),
  workspace: workspacePathSchema,
  allowTransitive: z.boolean(),
  createDraftPullRequest: z.boolean(),
});

export const releaseEvidenceSchema = z.object({
  id: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceType: z.enum(["registry", "release", "changelog", "migration_guide"]),
  retrievedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "contentHash must be a sha256 hex digest"),
  relevantExtract: z.string().max(4000),
});

export const migrationFindingSchema = z.object({
  id: z.string().min(1),
  releaseClaim: z.string().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1)).min(1, "every finding must cite stored evidence"),
  affectedSymbols: z.array(z.string().max(256)).max(256),
  affectedFiles: z.array(z.string().max(4096)).max(512),
  requiredChange: z.string().min(1).max(4000),
  confidence: z.number().min(0).max(1),
  noSourceChangeRequired: z.boolean().optional(),
  needsHuman: z.boolean().optional(),
  spansTestFiles: z.boolean().optional(),
  requiredNodeRange: z.string().max(128).optional(),
  replacement: z
    .object({
      packageName: packageNameSchema,
      from: z.string().min(1).max(256),
      to: z.string().min(1).max(256),
    })
    .optional(),
});

export const checkResultSchema = z.object({
  command: commandSpecSchema,
  exitCode: z.number().int().nullable(),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  stdoutArtifact: z.string(),
  stderrArtifact: z.string(),
  outcome: z.enum(["passed", "failed", "timed_out", "not_run"]),
});

export const fileChangeSchema = z.object({
  path: absolutePathSchema,
  beforeHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  afterHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  owner: z.enum([
    "inspector",
    "researcher",
    "test_author",
    "implementer",
    "ci_author",
    "verifier",
    "publisher",
  ]),
  reason: z.string().min(1).max(1000),
});

/**
 * Parse with a stable error shape. Zod's own message is kept but the caller
 * decides how to surface it, so validation failures never leak input values
 * into logs by accident.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} failed validation: ${summary}`);
  }
  return result.data;
}
