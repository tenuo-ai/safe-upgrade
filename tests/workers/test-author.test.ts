import { describe, expect, it } from "vitest";
import { loadTest, testPathFor } from "../../packages/workers/src/test-author.ts";

describe("framework-aware focused tests", () => {
  it("keeps TypeScript tests in TypeScript", () => {
    expect(testPathFor("src/client.ts", "vitest")).toBe("test/client.load.test.ts");
  });

  it("uses Vitest imports when the repository uses Vitest", () => {
    const source = loadTest("src/client.ts", ["createClient"], true, "vitest");
    expect(source).toContain('from "vitest"');
    expect(source).toContain('expect(typeof module_.createClient).toBe("function")');
    expect(source).not.toContain('from "node:test"');
  });

  it("uses Jest globals when the repository uses Jest", () => {
    const source = loadTest("src/client.ts", ["createClient"], true, "jest");
    expect(source).toContain('expect(typeof module_.createClient).toBe("function")');
    expect(source).not.toContain('from "vitest"');
    expect(source).not.toContain('from "node:test"');
  });

  it("uses Mocha globals and strict assertions when the repository uses Mocha", () => {
    const source = loadTest("src/client.js", ["createClient"], false, "mocha");
    expect(source).toContain('it("createClient is callable');
    expect(source).toContain('assert.equal(typeof module_.createClient, "function")');
    expect(source).not.toContain("expect(");
  });

  it("keeps node:test as the explicit default", () => {
    const source = loadTest("src/client.js", ["createClient"], true, "node");
    expect(source).toContain('from "node:test"');
    expect(source).toContain("assert.equal");
  });
});
