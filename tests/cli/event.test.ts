/**
 * Reading a Dependabot pull request out of a GitHub Actions event.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBumpTitle, parseGroupedUpdates, readPullRequestEvent, UsageError } from "@safe-upgrade/cli";

describe("Dependabot titles", () => {
  it("reads a single-package bump", () => {
    expect(parseBumpTitle("Bump cookie from 0.7.2 to 1.0.2")).toEqual({
      packageName: "cookie",
      targetVersion: "1.0.2",
      workspace: "",
    });
  });

  it("reads a conventional-commit prefix and a scoped package", () => {
    expect(parseBumpTitle("chore(deps): bump @babel/core from 7.23.0 to 7.24.0")).toEqual({
      packageName: "@babel/core",
      targetVersion: "7.24.0",
      workspace: "",
    });
  });

  it("reads a bump that names a workspace path", () => {
    expect(parseBumpTitle("Bump postcss from 7.0.39 to 8.4.35 in /packages/app")).toEqual({
      packageName: "postcss",
      targetVersion: "8.4.35",
      workspace: "packages/app",
    });
  });

  it("does not treat a grouped title as a single-package bump", () => {
    expect(parseBumpTitle("Bump the npm group with 2 updates")).toBeNull();
  });

  it("refuses a range on the target side", () => {
    expect(parseBumpTitle("Bump cookie from 0.7.2 to ^1.0.0")).toBeNull();
  });
});

describe("the GitHub event", () => {
  it("fills the package, version, pull number, and repository", () => {
    const event = writeEvent({
      pull_request: {
        number: 12,
        title: "Bump cookie from 0.7.2 to 1.0.2",
        user: { login: "dependabot[bot]" },
      },
      repository: { full_name: "acme/app" },
    });

    expect(readPullRequestEvent({ GITHUB_EVENT_PATH: event })).toMatchObject({
      packageName: "cookie",
      targetVersion: "1.0.2",
      pullRequestNumber: 12,
      repository: "acme/app",
      actor: "dependabot[bot]",
    });
  });

  it("refuses an event that is not a Dependabot pull request", () => {
    const event = writeEvent({
      pull_request: {
        number: 3,
        title: "Bump cookie from 0.7.2 to 1.0.2",
        user: { login: "alice" },
      },
      repository: { full_name: "acme/app" },
    });

    expect(() => readPullRequestEvent({ GITHUB_EVENT_PATH: event })).toThrow(UsageError);
    expect(() => readPullRequestEvent({ GITHUB_EVENT_PATH: event })).toThrow(/Dependabot/);
  });

  it("refuses a missing event path rather than reading cwd", () => {
    expect(() => readPullRequestEvent({})).toThrow(/GITHUB_EVENT_PATH/);
  });

  it("reads companions from a grouped body's Updates lines", () => {
    const event = writeEvent({
      pull_request: {
        number: 9,
        title: "Bump the npm group with 2 updates",
        body: "Updates `cookie` from 0.7.2 to 1.0.2\nUpdates `ms` from 2.1.2 to 2.1.3\n",
        user: { login: "dependabot[bot]" },
      },
      repository: { full_name: "acme/app" },
    });

    expect(readPullRequestEvent({ GITHUB_EVENT_PATH: event })).toMatchObject({
      packageName: "cookie",
      targetVersion: "1.0.2",
      companions: [{ packageName: "ms", targetVersion: "2.1.3" }],
    });
  });
});

describe("grouped body lines", () => {
  it("reads exact Updates lines and ignores the rest", () => {
    expect(
      parseGroupedUpdates("Updates `foo` from 1.0.0 to 2.0.0\nAlso see the changelog\nUpdates `bar` from 3.0.0 to 3.1.0\n"),
    ).toEqual([
      { packageName: "foo", targetVersion: "2.0.0" },
      { packageName: "bar", targetVersion: "3.1.0" },
    ]);
  });
});

function writeEvent(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "safe-upgrade-event-"));
  const path = join(directory, "event.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}
