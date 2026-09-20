/**
 * Attacks on the filesystem boundary.
 *
 * The path resolver is the last thing standing between a worker that may write source and the
 * rest of the machine, so this file tries to get out rather than confirming that ordinary paths
 * work. Every case is run against a real directory with real symlinks, because the interesting
 * failures are ones that only appear once the operating system is involved.
 *
 * One of these found a live hole: `.Git/hooks/pre-commit` was classified as ordinary source,
 * because protected directories were matched by exact string against a set. On macOS and
 * Windows that path is `.git/hooks/pre-commit`, a file git runs on the next commit.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyPath, createPathContext, resolveInsideRoot } from "@safe-upgrade/tools";
import type { PathContext } from "@safe-upgrade/tools";

let root: string;
let outside: string;
let context: PathContext;

beforeEach(() => {
  // Canonical from the start: on macOS a temporary directory is reached through a symlink, and
  // a test that compared the two prefixes would fail for reasons unrelated to its subject.
  root = realpathSync(mkdtempSync(join(tmpdir(), "escape-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "escape-outside-")));
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "a secret");
  context = createPathContext(root);
});

/** Resolve a path given relative to the worktree, as a worker's absolute argument. */
function at(relativePath: string): ReturnType<typeof resolveInsideRoot> {
  return resolveInsideRoot(context, join(root, relativePath));
}

describe("leaving the worktree", () => {
  it("refuses a traversal that climbs out", () => {
    expect(() => at("../escape-outside/secret.txt")).toThrow(/escapes|resolves outside/);
    expect(() => at("src/../../../../etc/passwd")).toThrow(/escapes|resolves outside/);
  });

  it("refuses an absolute path elsewhere on the machine", () => {
    expect(() => resolveInsideRoot(context, "/etc/passwd")).toThrow(/escapes/);
    expect(() => resolveInsideRoot(context, join(outside, "secret.txt"))).toThrow(/escapes/);
  });

  it("refuses a relative path, which could be resolved against anything", () => {
    expect(() => resolveInsideRoot(context, "src/a.js")).toThrow(/must be absolute/);
    expect(() => resolveInsideRoot(context, "./a.js")).toThrow(/must be absolute/);
  });

  it("refuses a null byte, which truncates the path for whatever reads it next", () => {
    expect(() => resolveInsideRoot(context, `${join(root, "src/a.js")}\0.png`)).toThrow(/null byte/);
  });

  it("keeps a traversal that stays inside", () => {
    // `.git/../src/b.js` never leaves, and refusing it would be a rule about spelling.
    expect(at(".git/../src/b.js").relative).toBe("src/b.js");
  });
});

describe("symlinks", () => {
  it("refuses a file that is a symlink out of the tree", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.js"));
    expect(() => at("src/link.js")).toThrow(/resolves outside/);
  });

  it("refuses a file under a symlinked directory", () => {
    // The file need not exist: the write would follow the parent out, so resolving the deepest
    // existing ancestor is what catches it.
    symlinkSync(outside, join(root, "src", "away"));
    expect(() => at("src/away/new-file.js")).toThrow(/resolves outside/);
  });

  it("refuses a symlink that points out through a second symlink", () => {
    const hop = join(outside, "hop");
    symlinkSync(outside, hop);
    symlinkSync(hop, join(root, "src", "double"));
    expect(() => at("src/double/x.js")).toThrow(/resolves outside/);
  });

  it("allows a symlink that stays inside", () => {
    symlinkSync(join(root, "src"), join(root, "alias"));
    expect(at("alias/a.js").relative).toBe("src/a.js");
  });

  it("collapses a traversal before following a link, which can only narrow where it lands", () => {
    // `src/away/../../src/a.js` is normalised textually first, so the link is never traversed
    // and the path resolves to `src/a.js`. That differs from what the kernel would open if it
    // walked the link, and the difference is always in the safe direction: the collapsed path
    // is the one operated on, and it is inside the worktree. The link is what would have led
    // out, and it is gone before anything opens a file.
    symlinkSync(outside, join(root, "src", "away"));
    expect(at("src/away/../../src/a.js").relative).toBe("src/a.js");
  });
});

describe("protected locations", () => {
  it("refuses the repository's own git directory", () => {
    expect(() => at(".git/config")).toThrow(/protected/);
    expect(() => at(".git/hooks/pre-commit")).toThrow(/protected/);
  });

  it("refuses it however it is capitalised", () => {
    // The hole this file was written to find. macOS and Windows both open `.git` for each of
    // these, and a hook written there runs on the next commit.
    for (const path of [".GIT/config", ".Git/hooks/pre-commit", ".gIt/index"]) {
      expect(() => at(path), path).toThrow(/protected/);
    }
  });

  it("refuses a trailing dot or space, which Windows ignores", () => {
    for (const path of [".git./config", ".git /config", "NODE_MODULES./x.js"]) {
      expect(() => at(path), path).toThrow(/protected/);
    }
  });

  it("refuses installed dependencies, in any case", () => {
    expect(() => at("node_modules/left-pad/index.js")).toThrow(/protected/);
    expect(() => at("NODE_MODULES/left-pad/index.js")).toThrow(/protected/);
    expect(() => at("src/node_modules/x.js")).toThrow(/protected/);
  });

  it("refuses key material and credential files", () => {
    for (const path of [
      ".env",
      ".env.production",
      ".npmrc",
      ".netrc",
      "src/id_rsa",
      "deploy/server.pem",
      "certs/app.p12",
      "SRC/.ENV",
    ]) {
      expect(() => at(path), path).toThrow(/protected/);
    }
  });

  it("refuses ssh and gpg directories wherever they appear", () => {
    expect(() => at(".ssh/known_hosts")).toThrow(/protected/);
    expect(() => at("home/.SSH/config")).toThrow(/protected/);
    expect(() => at(".gnupg/pubring.kbx")).toThrow(/protected/);
  });
});

describe("what a path is classified as", () => {
  it("separates the classes the write tools are scoped to", () => {
    expect(classifyPath(".github/workflows/ci.yml")).toBe("ci");
    expect(classifyPath("test/search.test.js")).toBe("test");
    expect(classifyPath("package.json")).toBe("manifest");
    expect(classifyPath("pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyPath("src/index.js")).toBe("source");
  });

  it("keeps the whole workflows directory to one capability", () => {
    // A nested path under `.github/workflows` used to fall through to the test rules and come
    // back `test`, which would have let the test author write inside the directory CI is read
    // from. Only direct children are ones GitHub runs, but one capability for the directory is
    // a simpler rule than one about which depths execute.
    expect(classifyPath(".github/workflows/ci.yml")).toBe("ci");
    expect(classifyPath(".github/workflows/test/ci.yml")).toBe("ci");
    expect(classifyPath(".github/workflows/nested/deep/anything.txt")).toBe("ci");
    // And a lookalike outside `.github` is not CI, because nothing reads it.
    expect(classifyPath("test/.github/workflows/ci.yml")).toBe("test");
  });

  it("does not let a sensitive file hide under a friendly directory", () => {
    expect(classifyPath("test/fixtures/.env")).toBe("sensitive");
    expect(classifyPath("src/keys/deploy.pem")).toBe("sensitive");
  });
});

describe("the root itself", () => {
  it("insists on an absolute root", () => {
    expect(() => createPathContext("relative/root")).toThrow(/must be absolute/);
  });

  it("resolves the root through its own symlinks", () => {
    // A context built from a symlinked root must compare canonical prefixes, or every path
    // inside it looks like an escape.
    // A unique name, since the temporary directory is shared across runs of this file.
    const link = join(dirname(root), `root-alias-${String(process.pid)}-${String(Date.now())}`);
    symlinkSync(root, link);
    const viaLink = createPathContext(link);
    expect(resolveInsideRoot(viaLink, join(root, "src/a.js")).relative).toBe("src/a.js");
  });
});
