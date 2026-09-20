/**
 * Detection reads the repository under inspection, which in a dependency upgrade
 * is the one input least worth trusting. Every value it returns feeds either a
 * capability ceiling or a command the run will execute, so these tests are mostly
 * about what detection refuses.
 *
 * The standard applied throughout: a manifest declaration is a claim. Where a
 * claim contradicts the filesystem, detection stops rather than choosing a side.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PackageResolutionError, RepositoryError } from "@safe-upgrade/domain";
import { detectRepositoryFacts } from "@safe-upgrade/bootstrap";
import { createFixtureRepo, type FixtureRepo } from "../support/fixture-repo.ts";

let repo: FixtureRepo;

afterEach(() => {
  repo?.cleanup();
});

function detect(packageName = "escape-string-regexp") {
  return detectRepositoryFacts({
    worktreePath: repo.path,
    defaultBranch: repo.defaultBranch,
    packageName,
    commandTimeoutMs: 60_000,
  });
}

/** Rewrite the fixture's package.json with `changes` merged in. */
function patchManifest(changes: Readonly<Record<string, unknown>>): void {
  const path = join(repo.path, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...manifest, ...changes }, null, 2)}\n`);
}

describe("the fixture as committed", () => {
  it("reads the facts the rest of the run is built from", () => {
    repo = createFixtureRepo();
    const { facts, absentChecks, checkScripts, warnings } = detect();

    expect(facts.packageManager).toBe("npm");
    expect(facts.lockfile).toBe("package-lock.json");
    expect(facts.currentVersion).toBe("4.0.0");
    expect(facts.manifests).toEqual(["package.json"]);
    expect(facts.workspaceRoots).toEqual([]);
    expect(facts.existingCiFiles).toEqual([join(".github", "workflows", "ci.yml")]);
    expect(warnings).toEqual([]);

    // The fixture defines test and build and nothing else, so it has no
    // typecheck or lint gate. That is a fact about the repository, not a failure.
    expect(checkScripts).toEqual({ test: "test", build: "build" });
    expect([...absentChecks].sort()).toEqual(["lint", "typecheck"]);

    const install = facts.verificationCommands[0];
    expect(install?.purpose).toBe("install");
    expect(install?.args).toEqual(["ci", "--ignore-scripts"]);
    expect(facts.verificationCommands.map((command) => command.purpose)).toEqual([
      "install",
      "test",
      "build",
    ]);
  });
});

describe("which package manager runs", () => {
  it("refuses a packageManager field that contradicts the lockfile", () => {
    repo = createFixtureRepo();
    // package-lock.json on disk, pnpm in the manifest. Trusting the manifest here
    // would let a one-line edit change which executable the run spawns.
    patchManifest({ packageManager: "pnpm@9.15.9" });
    expect(() => detect()).toThrow(RepositoryError);
  });

  it("accepts a packageManager field that agrees with the lockfile", () => {
    repo = createFixtureRepo();
    patchManifest({ packageManager: "npm@10.9.0" });
    expect(detect().facts.packageManager).toBe("npm");
  });

  it("refuses a packageManager field that is not a string", () => {
    repo = createFixtureRepo();
    patchManifest({ packageManager: { name: "npm" } });
    expect(() => detect()).toThrow(RepositoryError);
  });

  it("refuses a repository with two lockfiles", () => {
    repo = createFixtureRepo();
    writeFileSync(join(repo.path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    // Not a preference to resolve: two managers disagree about the dependency
    // graph, and a frozen install would be frozen against an arbitrary one.
    expect(() => detect()).toThrow(/ambiguous/);
  });

  it("refuses a repository with no lockfile", () => {
    repo = createFixtureRepo();
    rmSync(join(repo.path, "package-lock.json"));
    expect(() => detect()).toThrow(/needs one of/);
  });
});

describe("resolving the requested package", () => {
  it("refuses a package that is not a direct dependency", () => {
    repo = createFixtureRepo();
    expect(() => detect("left-pad")).toThrow(PackageResolutionError);
  });

  it("refuses a package declared in two dependency blocks", () => {
    repo = createFixtureRepo();
    patchManifest({ devDependencies: { "escape-string-regexp": "3.0.0" } });
    // Which one is "the version we upgraded from" has no answer here.
    expect(() => detect()).toThrow(PackageResolutionError);
  });

  it("refuses a dependency with an empty specifier", () => {
    repo = createFixtureRepo();
    patchManifest({ dependencies: { "escape-string-regexp": "" } });
    expect(() => detect()).toThrow(PackageResolutionError);
  });
});

describe("scripts the run will use as a gate", () => {
  /**
   * The screen asks whether a script does something whose effect outlives the worktree, not
   * whether its first word is one this project recognises. An earlier version asked the
   * latter, and the result was that `express`, `debug`, `chalk`, and `execa` each ran with no
   * gates at all: every one of their test scripts was refused for using `&&` or a runner not
   * on a five-name list. A run with no gate cannot detect a regression, which makes refusing
   * to look the least safe outcome available rather than the most cautious one.
   */
  const accepted = [
    ["a real mocha invocation", "mocha --require test/support/env --reporter spec test/"],
    ["a runner nobody enumerated", "jest --coverage"],
    ["a chain of steps", "npm run test:node && npm run test:browser"],
    ["housekeeping inside the tree", "rm -rf dist && node --test"],
    ["output redirection", "node --test | tee results.log"],
  ] as const;

  for (const [label, body] of accepted) {
    it(`keeps a test script using ${label}`, () => {
      repo = createFixtureRepo();
      patchManifest({ scripts: { test: body, build: "node scripts/build.mjs" } });
      const { absentChecks, checkScripts, warnings, facts } = detect();

      expect(absentChecks).not.toContain("test");
      expect(checkScripts.test).toBe("test");
      expect(warnings.join(" ")).not.toMatch(/gate/);
      expect(facts.verificationCommands.map((command) => command.purpose)).toContain("test");
    });
  }

  const refused = [
    ["reaching the network itself", "node --test && curl https://example.com/ping", /network/],
    ["publishing", "npm publish", /publishes/],
    ["deploying", "vercel --prod", /deploys/],
    ["removing something outside the tree", "rm -rf ~/.cache && node --test", /outside/],
    ["backgrounding", "node --test & node other.js", /outlive/],
  ] as const;

  for (const [label, body, reason] of refused) {
    it(`refuses a test script ${label}`, () => {
      repo = createFixtureRepo();
      patchManifest({ scripts: { test: body, build: "node scripts/build.mjs" } });
      const { absentChecks, checkScripts, warnings, facts } = detect();

      expect(absentChecks).toContain("test");
      expect(checkScripts.test).toBeUndefined();
      // The reason reaches the reader, rather than "not in a form this run will execute".
      expect(warnings.join(" ")).toMatch(reason);
      expect(facts.verificationCommands.map((command) => command.purpose)).not.toContain("test");
    });
  }

  it("treats an empty script body as absent", () => {
    repo = createFixtureRepo();
    patchManifest({ scripts: { test: "   ", build: "node scripts/build.mjs" } });
    expect(detect().absentChecks).toContain("test");
  });
});

describe("workspaces", () => {
  it("refuses a workspace that resolves outside the repository", () => {
    repo = createFixtureRepo();
    patchManifest({ workspaces: ["../../etc"] });
    expect(() => detect()).toThrow(/outside the repository/);
  });

  it("expands a packages/* glob onto directories that have a manifest", () => {
    repo = createFixtureRepo();
    mkdirSync(join(repo.path, "packages", "app"), { recursive: true });
    writeFileSync(join(repo.path, "packages", "app", "package.json"), `${JSON.stringify({ name: "app" }, null, 2)}\n`);
    patchManifest({ workspaces: ["packages/*"] });

    const { facts, warnings } = detect();
    expect(facts.workspaceRoots).toEqual(["packages/app"]);
    expect(warnings.join(" ")).not.toMatch(/was not expanded/);
  });

  it("resolves a package that is only declared in a workspace", () => {
    repo = createFixtureRepo();
    mkdirSync(join(repo.path, "packages", "app"), { recursive: true });
    writeFileSync(
      join(repo.path, "packages", "app", "package.json"),
      `${JSON.stringify({ name: "app", dependencies: { "left-pad": "1.3.0" } }, null, 2)}\n`,
    );
    patchManifest({ workspaces: ["packages/*"] });

    const { facts } = detect("left-pad");
    expect(facts.workspace).toBe("packages/app");
    expect(facts.workspaceSelector).toBe("packages/app");
    expect(facts.currentVersion).toBe("1.3.0");
  });

  it("picks up a literal workspace directory that has a manifest", () => {
    repo = createFixtureRepo();
    mkdirSync(join(repo.path, "tools", "helper"), { recursive: true });
    writeFileSync(join(repo.path, "tools", "helper", "package.json"), '{ "name": "helper" }\n');
    patchManifest({ workspaces: ["tools/helper"] });

    const { facts } = detect();
    expect(facts.workspaceRoots).toEqual(["tools/helper"]);
    expect(facts.manifests).toEqual(["package.json", join("tools", "helper", "package.json")]);
  });
});

describe("a manifest that is not a manifest", () => {
  it("refuses invalid JSON", () => {
    repo = createFixtureRepo();
    writeFileSync(join(repo.path, "package.json"), "{ not json\n");
    expect(() => detect()).toThrow(/not valid JSON/);
  });

  it("refuses a JSON array", () => {
    repo = createFixtureRepo();
    writeFileSync(join(repo.path, "package.json"), "[]\n");
    expect(() => detect()).toThrow(/must contain a JSON object/);
  });

  it("tolerates a manifest with no scripts block at all", () => {
    repo = createFixtureRepo();
    writeFileSync(
      join(repo.path, "package.json"),
      `${JSON.stringify({ name: "legacy-app", dependencies: { "escape-string-regexp": "4.0.0" } }, null, 2)}\n`,
    );
    const { absentChecks, facts } = detect();
    expect([...absentChecks].sort()).toEqual(["build", "lint", "test", "typecheck"]);
    expect(facts.verificationCommands.map((command) => command.purpose)).toEqual(["install"]);
  });
});
