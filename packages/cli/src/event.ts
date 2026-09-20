/**
 * Reading a GitHub Actions event so a Dependabot pull request can be assessed
 * without repeating the package and pull number on the command line.
 *
 * Conservative: only a Dependabot pull_request event. A title that names one
 * package is enough. A grouped title is accepted only when the body lists
 * exact `Updates \`pkg\` from x to y` lines this run can read.
 */

import { readFileSync } from "node:fs";
import { UsageError } from "./arguments.ts";

export interface UpgradeSpec {
  readonly packageName: string;
  readonly targetVersion: string;
}

export interface PullRequestEvent {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly title: string;
  readonly actor: string;
  readonly packageName: string;
  readonly targetVersion: string;
  readonly companions: readonly UpgradeSpec[];
  readonly workspace: string;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GITHUB_REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * Dependabot's usual title, and the same words after a conventional-commit prefix.
 *
 * `Bump cookie from 0.7.2 to 1.0.2`
 * `chore(deps): bump postcss from 7.0.39 to 8.4.35`
 * `Bump postcss from 7.0.39 to 8.4.35 in /packages/app`
 */
const BUMP_TITLE =
  /(?:^|\b)bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+?)(?:\s+in\s+(\S+))?$/i;

/** `Updates \`foo\` from 1.0.0 to 2.0.0` — Dependabot's grouped-PR body line. */
const GROUPED_UPDATE = /^updates\s+`([^`]+)`\s+from\s+(\S+)\s+to\s+(\S+)/gim;

export function readPullRequestEvent(
  env: Readonly<Record<string, string | undefined>>,
): PullRequestEvent {
  const path = env["GITHUB_EVENT_PATH"];
  if (path === undefined || path === "") {
    throw new UsageError(
      "--from-event needs GITHUB_EVENT_PATH, which GitHub Actions sets. This is not a GitHub Actions run.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new UsageError(`could not read a GitHub event from ${path}`);
  }

  const pull = asRecord(asRecord(raw)["pull_request"]);
  const number = pull["number"];
  const title = pull["title"];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new UsageError("--from-event needs a pull_request event with a pull number");
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new UsageError("--from-event needs a pull_request event with a title");
  }

  const actor = actorOf(raw, env);
  if (!isDependabot(actor)) {
    throw new UsageError(
      `--from-event only reads Dependabot pull requests, and this one is from ${actor || "an unknown actor"}`,
    );
  }

  const body = typeof pull["body"] === "string" ? pull["body"] : "";
  const parsed = parseDependabotUpdate(title, body);
  if (parsed === null) {
    throw new UsageError(
      `the pull request is not a bump this run can read: ${title}`,
    );
  }

  const repository = repositoryOf(raw, env);
  return {
    repository,
    pullRequestNumber: number,
    title,
    actor,
    packageName: parsed.packageName,
    targetVersion: parsed.targetVersion,
    companions: parsed.companions,
    workspace: parsed.workspace,
  };
}

export function parseBumpTitle(
  title: string,
): { readonly packageName: string; readonly targetVersion: string; readonly workspace: string } | null {
  const match = BUMP_TITLE.exec(title.trim());
  if (match === null) {
    return null;
  }
  const packageName = match[1] ?? "";
  const targetVersion = match[3] ?? "";
  if (!PACKAGE_NAME.test(packageName) || !EXACT_VERSION.test(targetVersion)) {
    return null;
  }
  return {
    packageName,
    targetVersion,
    workspace: workspaceFromTitle(match[4] ?? ""),
  };
}

export function parseGroupedUpdates(body: string): readonly UpgradeSpec[] {
  const found: UpgradeSpec[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(GROUPED_UPDATE)) {
    const packageName = match[1] ?? "";
    const targetVersion = match[3] ?? "";
    if (!PACKAGE_NAME.test(packageName) || !EXACT_VERSION.test(targetVersion) || seen.has(packageName)) {
      continue;
    }
    seen.add(packageName);
    found.push({ packageName, targetVersion });
  }
  return found.slice(0, 8);
}

function parseDependabotUpdate(
  title: string,
  body: string,
): {
  readonly packageName: string;
  readonly targetVersion: string;
  readonly companions: readonly UpgradeSpec[];
  readonly workspace: string;
} | null {
  const bump = parseBumpTitle(title);
  const grouped = parseGroupedUpdates(body);
  if (bump !== null) {
    return {
      packageName: bump.packageName,
      targetVersion: bump.targetVersion,
      companions: grouped.filter((entry) => entry.packageName !== bump.packageName),
      workspace: bump.workspace,
    };
  }
  const [primary, ...companions] = grouped;
  if (primary === undefined) {
    return null;
  }
  return {
    packageName: primary.packageName,
    targetVersion: primary.targetVersion,
    companions,
    workspace: workspaceFromTitle(/(?:\s+in\s+)(\S+)\s*$/i.exec(title)?.[1] ?? ""),
  };
}

function workspaceFromTitle(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  const withoutDot = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const withoutSlash = withoutDot.startsWith("/") ? withoutDot.slice(1) : withoutDot;
  if (
    withoutSlash === "" ||
    withoutSlash.split("/").includes("..") ||
    !/^[A-Za-z0-9._@-][A-Za-z0-9._/@-]*$/.test(withoutSlash)
  ) {
    return "";
  }
  return withoutSlash.replace(/\/+$/, "");
}

function actorOf(raw: unknown, env: Readonly<Record<string, string | undefined>>): string {
  const pull = asRecord(asRecord(raw)["pull_request"]);
  const user = asRecord(pull["user"])["login"];
  if (typeof user === "string" && user.length > 0) {
    return user;
  }
  const sender = asRecord(asRecord(raw)["sender"])["login"];
  if (typeof sender === "string" && sender.length > 0) {
    return sender;
  }
  return env["GITHUB_ACTOR"] ?? "";
}

function repositoryOf(raw: unknown, env: Readonly<Record<string, string | undefined>>): string {
  const fromEvent = asRecord(asRecord(raw)["repository"])["full_name"];
  const name = typeof fromEvent === "string" ? fromEvent : (env["GITHUB_REPOSITORY"] ?? "");
  if (!GITHUB_REPOSITORY.test(name)) {
    throw new UsageError(
      "--from-event needs a repository as owner/name, from the event or GITHUB_REPOSITORY",
    );
  }
  return name;
}

function isDependabot(actor: string): boolean {
  return actor === "dependabot[bot]" || actor === "dependabot-preview[bot]";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
