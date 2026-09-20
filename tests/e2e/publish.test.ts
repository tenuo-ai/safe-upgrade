/**
 * The publishing step, end to end.
 *
 * Two things here are stand-ins, and both are outside the system: the remote is a
 * local bare repository, and GitHub is a local HTTP server. Everything on this side of
 * those boundaries is real — the branch is really created, the commit really contains
 * the run's changes, and the request body is the one the tool would send to GitHub.
 *
 * Standing in for GitHub is also what makes the interesting assertion possible: the
 * test can read what was sent and check that `draft` is true and `head` is the run
 * branch, which is exactly the part a reviewer of this system would want pinned.
 */

import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUpgrade } from "@safe-upgrade/runner";
import { createFixtureRepo } from "../support/fixture-repo.ts";

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

/** A local server that answers the one endpoint the publisher calls. */
async function startFakeGitHub(received: Received[]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          html_url: "https://github.test/acme/legacy-app/pull/7",
          number: 7,
          draft: true,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${String(port)}` };
}

// Installs from the registry, so opt-in like the other end-to-end runs.
const describeE2E = process.env["SAFE_UPGRADE_E2E"] === "1" ? describe : describe.skip;

describeE2E("publishing a verified upgrade", () => {
  let remote: string;

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), "safe-upgrade-remote-"));
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(remote, { recursive: true, force: true });
  });

  it("commits the run's changes onto the run branch, pushes it, and opens a draft", async () => {
    const repo = createFixtureRepo();
    const artifacts = mkdtempSync(join(tmpdir(), "safe-upgrade-artifacts-"));
    const received: Received[] = [];
    const { server, baseUrl } = await startFakeGitHub(received);

    try {
      execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo.path, stdio: "pipe" });

      // First run: discover what needs approving, exactly as a person would.
      const discovery = await runUpgrade({
        repositoryPath: repo.path,
        packageName: "escape-string-regexp",
        targetVersion: "5.0.0",
        artifactsDirectory: join(artifacts, "discovery"),
      });
      const pending = discovery.finalState.elevationRequests;
      expect(pending).toHaveLength(1);

      const published = await runUpgrade({
        repositoryPath: repo.path,
        packageName: "escape-string-regexp",
        targetVersion: "5.0.0",
        artifactsDirectory: join(artifacts, "published"),
        createDraftPullRequest: true,
        approvals: [
          {
            id: String(pending[0]?.id),
            approvedBy: "publish.test",
            approvedAt: new Date().toISOString(),
          },
        ],
        github: { repository: "acme/legacy-app", token: "test-token", apiBaseUrl: baseUrl },
      });

      expect(published.finalState.draftPullRequestUrl).toBe("https://github.test/acme/legacy-app/pull/7");

      // The branch exists on the remote, under the run's own name and nowhere near main.
      const branches = execFileSync("git", ["branch", "--list", "--format=%(refname:short)"], {
        cwd: remote,
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(branches).toContain(`safe-upgrade/${published.runId}`);

      // The commit on the remote carries the migration, not an empty tree. Read from
      // the remote rather than the worktree, so this asserts what a reviewer would pull.
      const files = execFileSync(
        "git",
        ["show", "--name-only", "--format=", `refs/heads/safe-upgrade/${published.runId}`],
        { cwd: remote, encoding: "utf8" },
      );
      expect(files).toContain("package.json");
      expect(files).toContain("src/search.js");
      expect(files).toContain(".github/workflows/safe-upgrade-checks.yml");

      const manifest = execFileSync(
        "git",
        ["show", `refs/heads/safe-upgrade/${published.runId}:package.json`],
        { cwd: remote, encoding: "utf8" },
      );
      expect(JSON.parse(manifest)).toMatchObject({
        type: "module",
        dependencies: { "escape-string-regexp": "5.0.0" },
      });

      // Main is untouched: the bare repository's default branch has no commits at all,
      // because nothing in this system pushes anywhere but the run branch.
      expect(branches).not.toContain("main");

      expect(received).toHaveLength(1);
      const call = received[0];
      expect(call?.path).toBe("/repos/acme/legacy-app/pulls");
      expect(call?.authorization).toBe("Bearer test-token");
      expect(call?.body).toMatchObject({
        draft: true,
        base: "main",
        head: `safe-upgrade/${published.runId}`,
        maintainer_can_modify: false,
      });

      // The description tells a reviewer who changed what, and names the approval.
      const body = String(call?.body.body);
      expect(body).toContain("escape-string-regexp");
      expect(body).toContain("implementer");
      expect(body).toContain("update_manifest_field");
      expect(body).not.toContain("test-token");

      // The section a reviewer should read first, and the one that is easiest to lose:
      // it was previously read off the classified result, which does not exist yet at
      // publish time, so it silently rendered as nothing in every pull request.
      expect(body).toContain("## What this run does not establish");
      expect(body).toMatch(/no runnable `(typecheck|lint)` script/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(artifacts, { recursive: true, force: true });
      repo.cleanup();
    }
  }, 600_000);
});
