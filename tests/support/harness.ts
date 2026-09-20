/**
 * Test harness: a throwaway git worktree plus a development Tenuo runtime.
 *
 * `invocations` records every tool body that actually started. That is how the
 * authorization tests distinguish "the call was denied" from "the call failed
 * after doing the work", which is the only distinction that matters here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuditLog, sha256Hex, type AuditEvent } from "@safe-upgrade/evidence";
import { DEFAULT_LIMITS } from "@safe-upgrade/tools";
import { createDevAuthorizationRuntime, type AuthorizationRuntime } from "@safe-upgrade/authorization";

export interface Harness {
  /** Canonical worktree root, with macOS `/var` symlinks already resolved. */
  readonly root: string;
  readonly runId: string;
  readonly runBranch: string;
  readonly defaultBranch: string;
  readonly audit: AuditLog;
  readonly runtime: AuthorizationRuntime;
  /** Names of tool bodies that began executing, in order. */
  readonly invocations: string[];
  /** Everything the audit log recorded, for asserting on delegation and denial. */
  readonly events: readonly AuditEvent[];
  path(...segments: string[]): string;
  read(relativePath: string): string;
  hashOf(relativePath: string): string;
  cleanup(): void;
}

export interface HarnessOptions {
  readonly requestedPackage?: string;
  readonly targetVersion?: string;
  readonly withGitHub?: boolean;
  /** Replaces the fixture manifest wholesale, for tests about editing it. */
  readonly manifest?: Readonly<Record<string, unknown>>;
  /** Additional manifests on disk and in the ceiling, as worktree-relative paths. */
  readonly extraManifests?: readonly string[];
}

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    {
      name: "fixture-app",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { "left-pad": "1.3.0" },
      scripts: { test: "node --test", typecheck: "tsc --noEmit", lint: "eslint .", build: "tsc -p ." },
    },
    null,
    2,
  ),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "src/index.ts": "export const greeting = 'hello';\n",
  "src/index.test.ts": "import { greeting } from './index.ts';\nconsole.log(greeting);\n",
  "test/existing.test.ts": "console.log('existing');\n",
  ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "safe-upgrade-")));
  const files: Record<string, string> = { ...FIXTURE_FILES };
  if (options.manifest !== undefined) {
    files["package.json"] = `${JSON.stringify(options.manifest, null, 2)}\n`;
  }
  for (const extra of options.extraManifests ?? []) {
    files[extra] = `${JSON.stringify({ name: extra, version: "1.0.0" }, null, 2)}\n`;
  }
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  const defaultBranch = "main";
  execFileSync("git", ["init", "--initial-branch", defaultBranch], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "harness@example.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Harness"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });

  const runId = randomUUID();
  const runBranch = `safe-upgrade/${runId.slice(0, 8)}`;
  const invocations: string[] = [];
  const audit = new AuditLog({ runId });

  const runtime = createDevAuthorizationRuntime({
    runId,
    worktreeRoot: root,
    packageManager: "pnpm",
    defaultBranch,
    runBranch,
    requestedPackage: options.requestedPackage ?? "left-pad",
    targetVersion: options.targetVersion ?? "1.3.0",
    manifestPaths: [
      join(root, "package.json"),
      ...(options.extraManifests ?? []).map((extra) => join(root, extra)),
    ],
    audit,
    limits: DEFAULT_LIMITS,
    onInvoke: (name) => invocations.push(name),
    ...(options.withGitHub === true
      ? { github: { repository: "tenuo-ai/fixture", token: "ghp_fixtureTokenValue1234567890" } }
      : {}),
  });

  return {
    root,
    runId,
    runBranch,
    defaultBranch,
    audit,
    runtime,
    invocations,
    get events() {
      return audit.events;
    },
    path: (...segments) => join(root, ...segments),
    read: (relativePath) => readFileSync(join(root, relativePath), "utf8"),
    hashOf: (relativePath) => sha256Hex(readFileSync(join(root, relativePath), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
