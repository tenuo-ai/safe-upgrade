import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, createPathContext, resolveInsideRoot } from "../src/paths.ts";

let root: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "paths-")));
  root = join(base, "worktree");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(outside, "secrets.txt"), "top secret\n");
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
  it("accepts a path inside the root", () => {
    const context = createPathContext(root);
    expect(resolveInsideRoot(context, join(root, "src", "index.ts")).relative).toBe("src/index.ts");
  });

  it("rejects a relative path", () => {
    const context = createPathContext(root);
    expect(() => resolveInsideRoot(context, "src/index.ts")).toThrow(/must be absolute/);
  });

  it("rejects traversal out of the root", () => {
    const context = createPathContext(root);
    expect(() => resolveInsideRoot(context, join(root, "..", "outside", "secrets.txt"))).toThrow(/escapes/);
  });

  it("rejects a sibling directory that shares a name prefix", () => {
    const context = createPathContext(root);
    expect(() => resolveInsideRoot(context, `${root}-evil/file.ts`)).toThrow(/escapes|outside/);
  });

  it("rejects a symlinked file pointing outside the root", () => {
    symlinkSync(join(outside, "secrets.txt"), join(root, "src", "linked.ts"));
    const context = createPathContext(root);
    expect(() => resolveInsideRoot(context, join(root, "src", "linked.ts"))).toThrow(/outside/);
  });

  it("rejects a write through a symlinked directory", () => {
    symlinkSync(outside, join(root, "escape"));
    const context = createPathContext(root);
    // The file does not exist yet, so only resolving the parent catches this.
    expect(() => resolveInsideRoot(context, join(root, "escape", "new.ts"))).toThrow(/outside/);
  });

  it("refuses to touch the git directory", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    const context = createPathContext(root);
    expect(() => resolveInsideRoot(context, join(root, ".git", "config"))).toThrow(/protected/);
  });

  it("refuses to read environment and credential files", () => {
    const context = createPathContext(root);
    for (const name of [".env", ".env.local", ".npmrc", "id_rsa", "server.pem"]) {
      writeFileSync(join(root, name), "secret\n");
      expect(() => resolveInsideRoot(context, join(root, name))).toThrow(/protected/);
    }
  });
});

describe("classifyPath", () => {
  it("classifies by path alone, not by caller intent", () => {
    expect(classifyPath("src/index.ts")).toBe("source");
    expect(classifyPath("src/index.test.ts")).toBe("test");
    expect(classifyPath("src/index.spec.tsx")).toBe("test");
    expect(classifyPath("test/helpers.ts")).toBe("test");
    expect(classifyPath("__tests__/thing.ts")).toBe("test");
    expect(classifyPath("fixtures/sample/app.ts")).toBe("test");
    expect(classifyPath("package.json")).toBe("manifest");
    expect(classifyPath("pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyPath(".github/workflows/ci.yml")).toBe("ci");
    expect(classifyPath(".env.production")).toBe("sensitive");
    expect(classifyPath("node_modules/left-pad/index.js")).toBe("sensitive");
  });

  it("treats a workflow under a tests directory as CI, not as a test", () => {
    expect(classifyPath(".github/workflows/tests/ci.yml")).toBe("ci");
  });
});
