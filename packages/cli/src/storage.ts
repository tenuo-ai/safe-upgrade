/** Durable local assessment records and repository-drift checks. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PackageResolutionError } from "@safe-upgrade/domain";
import type { RunReport } from "@safe-upgrade/runner";

const ASSESSMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredAssessment {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly repositoryPath: string;
  readonly startCommit: string;
  readonly sourceClean: boolean;
  readonly packageName: string;
  readonly targetVersion: string;
  readonly workspace: string;
  readonly lockfile: string;
  readonly lockfileSha256: string;
  readonly manifest: string;
  readonly manifestSha256: string;
  readonly artifactsDirectory: string;
  readonly engine: "jev" | "deterministic";
  readonly patchModel?: string;
  readonly createdAt: string;
}

export function safeUpgradeHome(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env["SAFE_UPGRADE_HOME"];
  if (configured !== undefined && configured !== "") {
    return resolve(configured);
  }
  const xdg = env["XDG_STATE_HOME"];
  const stateRoot = xdg !== undefined && isAbsolute(xdg)
    ? xdg
    : join(homedir(), ".local", "state");
  return join(stateRoot, "safe-upgrade");
}

export function defaultRunDirectory(
  env: Readonly<Record<string, string | undefined>>,
  runId: string,
): string {
  return join(safeUpgradeHome(env), "runs", runId);
}

export function saveAssessment(
  report: RunReport,
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly engine: "jev" | "deterministic";
    readonly patchModel?: string;
  },
): StoredAssessment {
  if (report.sourceRepositoryPath === undefined || report.artifactsDirectory === undefined) {
    throw new PackageResolutionError("an assessment needs a source repository and artifact directory before it can be saved");
  }
  const repositoryPath = realpathSync(report.sourceRepositoryPath);
  const workspace = report.request.workspace;
  const manifest = workspace === "" ? "package.json" : join(workspace, "package.json");
  const record: StoredAssessment = {
    schemaVersion: 1,
    id: report.runId,
    repositoryPath,
    startCommit: report.startCommit,
    sourceClean: report.sourceClean,
    packageName: report.request.packageName,
    targetVersion: report.request.targetVersion,
    workspace,
    lockfile: report.facts.lockfile,
    lockfileSha256: sha256File(join(repositoryPath, report.facts.lockfile)),
    manifest,
    manifestSha256: sha256File(join(repositoryPath, manifest)),
    artifactsDirectory: report.artifactsDirectory,
    engine: options.engine,
    ...(options.patchModel === undefined ? {} : { patchModel: options.patchModel }),
    createdAt: report.result.classifiedAt,
  };
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(join(report.artifactsDirectory, "assessment.json"), serialized, { mode: 0o600 });
  const index = join(safeUpgradeHome(options.env), "assessments");
  mkdirSync(index, { recursive: true });
  writeFileSync(join(index, `${record.id}.json`), serialized, { mode: 0o600 });
  return record;
}

export function loadAssessment(
  id: string,
  env: Readonly<Record<string, string | undefined>>,
): StoredAssessment {
  if (!ASSESSMENT_ID.test(id)) {
    throw new PackageResolutionError(`${id} is not an assessment id`);
  }
  const path = join(safeUpgradeHome(env), "assessments", `${id}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PackageResolutionError(`assessment ${id} could not be read from ${path}: ${messageOf(error)}`);
  }
  if (!isStoredAssessment(parsed) || parsed.id !== id) {
    throw new PackageResolutionError(`assessment ${id} has an unsupported or malformed record`);
  }
  return parsed;
}

export function validateAssessmentState(record: StoredAssessment): void {
  if (!record.sourceClean) {
    throw new PackageResolutionError(
      "the assessment was made from a checkout with uncommitted changes; commit or stash them and assess again before applying",
    );
  }
  let repositoryPath: string;
  try {
    repositoryPath = realpathSync(record.repositoryPath);
  } catch (error) {
    throw new PackageResolutionError(`the assessed repository is no longer available: ${messageOf(error)}`);
  }
  const head = git(repositoryPath, ["rev-parse", "HEAD"]);
  if (head !== record.startCommit) {
    throw new PackageResolutionError(
      `the repository moved from ${record.startCommit} to ${head}; run a new assessment before applying`,
    );
  }
  const status = git(repositoryPath, ["status", "--porcelain=v1"]);
  if (status !== "") {
    throw new PackageResolutionError(
      "the repository has uncommitted changes; commit or stash them, then run a new assessment",
    );
  }
  assertHash(repositoryPath, record.lockfile, record.lockfileSha256);
  assertHash(repositoryPath, record.manifest, record.manifestSha256);
}

function assertHash(root: string, relativePath: string, expected: string): void {
  let actual: string;
  try {
    actual = sha256File(join(root, relativePath));
  } catch (error) {
    throw new PackageResolutionError(`${relativePath} changed or disappeared after assessment: ${messageOf(error)}`);
  }
  if (actual !== expected) {
    throw new PackageResolutionError(`${relativePath} changed after assessment; run a new assessment before applying`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new PackageResolutionError(`git ${args[0] ?? "command"} failed: ${messageOf(error)}`);
  }
}

function isStoredAssessment(value: unknown): value is StoredAssessment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["schemaVersion"] === 1 &&
    typeof record["id"] === "string" &&
    typeof record["repositoryPath"] === "string" &&
    typeof record["startCommit"] === "string" &&
    typeof record["sourceClean"] === "boolean" &&
    typeof record["packageName"] === "string" &&
    typeof record["targetVersion"] === "string" &&
    typeof record["workspace"] === "string" &&
    typeof record["lockfile"] === "string" &&
    typeof record["lockfileSha256"] === "string" &&
    typeof record["manifest"] === "string" &&
    typeof record["manifestSha256"] === "string" &&
    typeof record["artifactsDirectory"] === "string" &&
    (record["engine"] === "jev" || record["engine"] === "deterministic") &&
    (record["patchModel"] === undefined || typeof record["patchModel"] === "string") &&
    typeof record["createdAt"] === "string";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
