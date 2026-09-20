import { describe, expect, it } from "vitest";
import { relateVersions } from "../src/version.ts";

/**
 * The check exists because real repositories found its absence. A run asked to move
 * `ansi-styles` from 6.2.3 to 6.2.1 did it: rewrote the manifest, installed the older version,
 * and reported on it as an upgrade. Nothing downstream would have noticed, because every check
 * this system performs can pass on a downgrade.
 */
describe("ordering two exact versions", () => {
  it("recognises a move forward", () => {
    for (const [from, to] of [
      ["1.0.0", "2.0.0"],
      ["1.0.0", "1.1.0"],
      ["1.0.0", "1.0.1"],
      ["0.7.2", "1.0.2"],
      ["6.2.3", "6.10.0"],
      ["1.9.0", "1.10.0"],
    ]) {
      expect(relateVersions(from!, to!), `${from!} -> ${to!}`).toBe("ahead");
    }
  });

  it("recognises a move backward", () => {
    for (const [from, to] of [
      ["6.2.3", "6.2.1"],
      ["2.0.0", "1.9.9"],
      ["1.10.0", "1.9.0"],
    ]) {
      expect(relateVersions(from!, to!), `${from!} -> ${to!}`).toBe("behind");
    }
  });

  it("recognises going nowhere", () => {
    expect(relateVersions("6.1.0", "6.1.0")).toBe("same");
  });

  it("compares numbers rather than text", () => {
    // "10" sorts before "9" as a string, and a lexical comparison here would call a real
    // upgrade a downgrade and refuse it.
    expect(relateVersions("1.9.0", "1.10.0")).toBe("ahead");
    expect(relateVersions("9.0.0", "10.0.0")).toBe("ahead");
  });

  it("declines to order a pair that differs only by a tag", () => {
    // Ordering prerelease identifiers is most of what makes semver hard, and a wrong guess
    // means either refusing a real upgrade or performing a downgrade.
    expect(relateVersions("1.0.0", "1.0.0-rc.1")).toBe("unordered");
    expect(relateVersions("1.0.0-rc.1", "1.0.0")).toBe("unordered");
    expect(relateVersions("1.0.0+build.1", "1.0.0+build.2")).toBe("unordered");
  });

  it("orders a prerelease by its numbers when those differ", () => {
    expect(relateVersions("1.0.0-rc.1", "1.1.0")).toBe("ahead");
    expect(relateVersions("2.0.0-beta", "1.0.0")).toBe("behind");
  });

  it("declines to order anything that is not a version", () => {
    for (const [from, to] of [
      ["^1.0.0", "2.0.0"],
      ["latest", "1.0.0"],
      ["1.0.0", "next"],
      ["", "1.0.0"],
    ]) {
      expect(relateVersions(from!, to!), `${from!} -> ${to!}`).toBe("unordered");
    }
  });
});
