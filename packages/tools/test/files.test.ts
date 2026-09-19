import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@safe-upgrade/evidence";
import { ABSENT, createFileTools } from "../src/files.ts";
import { DEFAULT_LIMITS, type ToolContext } from "../src/context.ts";
import { createPathContext } from "../src/paths.ts";

let root: string;
let tools: ReturnType<typeof createFileTools>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "files-")));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");

  const context: ToolContext = {
    paths: createPathContext(root),
    runId: "run",
    packageManager: "pnpm",
    runBranch: "safe-upgrade/run",
    defaultBranch: "main",
    requestedPackage: "left-pad",
    targetVersion: "1.3.0",
    limits: DEFAULT_LIMITS,
  };
  tools = createFileTools(context);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("optimistic concurrency", () => {
  it("writes when the expected hash matches", async () => {
    const before = await tools.readFile.execute({ path: join(root, "src", "index.ts") });
    const result = await tools.writeSourceFile.execute({
      path: join(root, "src", "index.ts"),
      expectedBeforeHash: before.hash,
      content: "export const a = 2;\n",
    });
    expect(result.beforeHash).toBe(before.hash);
    expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toBe("export const a = 2;\n");
  });

  it("refuses to overwrite a file that changed underneath it", async () => {
    const before = await tools.readFile.execute({ path: join(root, "src", "index.ts") });
    writeFileSync(join(root, "src", "index.ts"), "export const a = 99;\n");

    await expect(
      tools.writeSourceFile.execute({
        path: join(root, "src", "index.ts"),
        expectedBeforeHash: before.hash,
        content: "export const a = 2;\n",
      }),
    ).rejects.toThrow(/changed since it was read/);
    // The concurrent edit survives; a stale write never wins.
    expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toBe("export const a = 99;\n");
  });

  it("creates a file only when the caller expects it to be absent", async () => {
    const created = await tools.writeSourceFile.execute({
      path: join(root, "src", "new.ts"),
      expectedBeforeHash: ABSENT,
      content: "export const b = 1;\n",
    });
    expect(created.beforeHash).toBeNull();
    expect(created.afterHash).toBe(sha256Hex("export const b = 1;\n"));
  });

  it("rejects creating a file that already exists", async () => {
    await expect(
      tools.writeSourceFile.execute({
        path: join(root, "src", "index.ts"),
        expectedBeforeHash: ABSENT,
        content: "export const a = 3;\n",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects writing a missing file without the absent sentinel", async () => {
    await expect(
      tools.writeSourceFile.execute({
        path: join(root, "src", "missing.ts"),
        expectedBeforeHash: sha256Hex("anything"),
        content: "x",
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("file class enforcement", () => {
  it("will not write a test file through the source writer", async () => {
    await expect(
      tools.writeSourceFile.execute({
        path: join(root, "src", "index.test.ts"),
        expectedBeforeHash: ABSENT,
        content: "x",
      }),
    ).rejects.toThrow(/classified as test/);
  });

  it("will not write a manifest through the source writer", async () => {
    await expect(
      tools.writeSourceFile.execute({
        path: join(root, "package.json"),
        expectedBeforeHash: ABSENT,
        content: "{}",
      }),
    ).rejects.toThrow(/classified as manifest/);
  });

  it("will not write a lockfile through any writer", async () => {
    await expect(
      tools.writeSourceFile.execute({
        path: join(root, "pnpm-lock.yaml"),
        expectedBeforeHash: ABSENT,
        content: "lockfileVersion: '9.0'\n",
      }),
    ).rejects.toThrow(/classified as lockfile/);
  });
});

describe("list_files", () => {
  it("matches a glob across segments and skips protected paths", async () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(root, "src", "util.ts"), "export const u = 1;\n");

    const matched = await tools.listFiles.execute({ root, glob: "**/*.ts" });
    expect(matched).toEqual(["src/index.ts", "src/util.ts"]);
    expect(matched.some((file) => file.includes("node_modules"))).toBe(false);
  });
});
