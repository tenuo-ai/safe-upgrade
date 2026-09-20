/**
 * The command line, spec criterion 1 and section 18.
 *
 * The tests that matter most are refusals. This is the outermost layer, so anything it lets
 * through becomes a run, and two of its rules — an exact version, and no secret in `argv` —
 * are the kind that are easy to relax by accident later.
 */

import { describe, expect, it } from "vitest";
import { EXIT, exitCodeFor, HELP, parseArguments, summarize, UsageError, wantsHelp } from "@safe-upgrade/cli";
import type { RunReport } from "@safe-upgrade/runner";

const fixedNow = (): Date => new Date("2026-03-01T12:00:00.000Z");

function parse(...argv: readonly string[]) {
  return parseArguments(argv, fixedNow);
}

describe("naming what to upgrade", () => {
  it("reads a package and an exact version", () => {
    const parsed = parse("postcss@8.4.35");
    expect(parsed.packageName).toBe("postcss");
    expect(parsed.targetVersion).toBe("8.4.35");
  });

  it("keeps the scope of a scoped package", () => {
    // Split at the last `@`, so `@scope/name` survives.
    const parsed = parse("@babel/core@7.24.0");
    expect(parsed.packageName).toBe("@babel/core");
    expect(parsed.targetVersion).toBe("7.24.0");
  });

  it("reads a prerelease version", () => {
    expect(parse("vite@6.0.0-beta.3").targetVersion).toBe("6.0.0-beta.3");
  });

  it.each(["postcss@^8.0.0", "postcss@~8.4.0", "postcss@8.x", "postcss@latest", "postcss@8", "postcss@8.4"])(
    "refuses %s, which is not one version",
    (specifier) => {
      // Every claim a run makes is about one version whose manifest it read.
      expect(() => parse(specifier)).toThrow(/not an exact version/);
    },
  );

  it("refuses a package with no version at all", () => {
    expect(() => parse("postcss")).toThrow(UsageError);
  });

  it("refuses two packages, because a run establishes one claim", () => {
    expect(() => parse("postcss@8.4.35", "glob@9.3.5")).toThrow(/one package per run/);
  });

  it("refuses a name that is not a package name", () => {
    expect(() => parse("../../etc/passwd@1.0.0")).toThrow(/not a package name/);
  });
});

describe("secrets", () => {
  it.each(["--github-token", "--token", "--api-key", "--holder-secret"])(
    "refuses %s rather than ignoring it",
    (flag) => {
      // Ignoring it would leave the token in shell history and the user believing it was
      // used. The refusal says where to put it instead.
      expect(() => parse("postcss@8.4.35", flag, "ghp_secret")).toThrow(/shell history/);
    },
  );

  it("does not leak the value it refused", () => {
    try {
      parse("postcss@8.4.35", "--github-token", "ghp_do_not_print_me");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("ghp_do_not_print_me");
    }
  });
});

describe("approvals", () => {
  it("carries each approved id with who approved it and when", () => {
    const parsed = parse("postcss@8.4.35", "--approve", "abc123", "--approved-by", "alice");
    expect(parsed.approvals).toEqual([
      { id: "abc123", approvedBy: "alice", approvedAt: "2026-03-01T12:00:00.000Z" },
    ]);
  });

  it("takes more than one", () => {
    const parsed = parse("p@1.0.0", "--approve", "a", "--approve", "b", "--approved-by", "alice");
    expect(parsed.approvals.map((grant) => grant.id)).toEqual(["a", "b"]);
  });

  it("refuses an approval with nobody attached to it", () => {
    // An approval is a statement about who decided. Defaulting it to $USER would record the
    // account that ran the command as having agreed to something.
    expect(() => parse("p@1.0.0", "--approve", "abc")).toThrow(/needs --approved-by/);
  });

  it("refuses an approver with nothing to approve", () => {
    expect(() => parse("p@1.0.0", "--approved-by", "alice")).toThrow(/nothing to approve/);
  });
});

describe("publishing", () => {
  it("treats wanting a draft as separate from agreeing to push", () => {
    expect(parse("p@1.0.0", "--draft-pr").publishApproved).toBe(false);
    expect(parse("p@1.0.0", "--draft-pr").createDraftPullRequest).toBe(true);
  });

  it("reads approving the push as also wanting the draft", () => {
    const parsed = parse("p@1.0.0", "--publish");
    expect(parsed.publishApproved).toBe(true);
    expect(parsed.createDraftPullRequest).toBe(true);
  });

  it("refuses a repository that is not owner/name", () => {
    expect(() => parse("p@1.0.0", "--github-repository", "https://github.com/a/b")).toThrow(
      /must be owner\/name/,
    );
  });
});

describe("the rest of the command line", () => {
  it("accepts a value attached with = or separated by a space", () => {
    expect(parse("p@1.0.0", "--run-id=abc").runId).toBe("abc");
    expect(parse("p@1.0.0", "--run-id", "abc").runId).toBe("abc");
  });

  it("refuses an option it does not know, rather than ignoring it", () => {
    // A misspelled flag that is ignored is a flag the user believes took effect.
    expect(() => parse("p@1.0.0", "--no-verify")).toThrow(/unknown option/);
  });

  it("refuses a value given to a flag that takes none", () => {
    expect(() => parse("p@1.0.0", "--publish=yes")).toThrow(/takes no value/);
  });

  it("refuses a missing value instead of swallowing the next flag", () => {
    expect(() => parse("p@1.0.0", "--run-id", "--publish")).toThrow(/needs a value/);
  });

  it("resolves the repository to an absolute path", () => {
    expect(parse("p@1.0.0", "--repository", ".").repositoryPath).toBe(process.cwd());
  });

  it("refuses a format it cannot print", () => {
    expect(() => parse("p@1.0.0", "--format", "yaml")).toThrow(/markdown or json/);
  });
});

describe("who chooses the next step", () => {
  it("defaults to the deterministic order", () => {
    // A supported configuration rather than a placeholder: the route is then a pure function
    // of run state, which is the more defensible default for anything automated.
    expect(parse("p@1.0.0").engine).toBe("deterministic");
  });

  it("takes jev when asked for explicitly", () => {
    expect(parse("p@1.0.0", "--engine", "jev").engine).toBe("jev");
  });

  it("refuses an engine it does not have", () => {
    expect(() => parse("p@1.0.0", "--engine", "gpt")).toThrow(/jev or deterministic/);
  });

  it("refuses the api key as a flag, like every other secret", () => {
    expect(() => parse("p@1.0.0", "--typesafe-key", "sk_live")).toThrow(/shell history/);
  });

  it("takes a confidence threshold and bounds it", () => {
    expect(parse("p@1.0.0", "--confidence", "0.85").confidenceThreshold).toBeCloseTo(0.85);
    // The empty string is the one that mattered: Number("") is 0, which would have meant
    // never replacing the engine's answer.
    for (const bad of ["1.5", "-0.1", "high", "", "0.5x", "1e-1"]) {
      expect(() => parse("p@1.0.0", "--confidence", bad), bad).toThrow(UsageError);
    }
  });

  it("leaves the threshold alone when not given, rather than inventing one", () => {
    expect(parse("p@1.0.0").confidenceThreshold).toBeUndefined();
  });
});

describe("what the shell learns from the exit code", () => {
  const report = (status: RunReport["result"]["status"]): RunReport =>
    ({
      request: { packageName: "postcss", targetVersion: "8.4.35" },
      result: { status, reasons: ["because"] },
      artifactsDirectory: "/tmp/run",
    }) as unknown as RunReport;

  it("gives each status its own code", () => {
    // A run needing an approval and a run that failed are different events, and collapsing
    // them would make a non-zero exit uninformative.
    expect(new Set([EXIT.verified, EXIT.partial, EXIT.human_required, EXIT.blocked, EXIT.indeterminate]).size).toBe(5);
    expect(exitCodeFor(report("verified"), false)).toBe(0);
    expect(exitCodeFor(report("human_required"), false)).toBe(3);
    expect(exitCodeFor(report("blocked"), false)).toBe(4);
  });

  it("treats a partial result as acceptable only when it was asked for", () => {
    expect(exitCodeFor(report("partial"), false)).toBe(2);
    expect(exitCodeFor(report("partial"), true)).toBe(0);
  });

  it("does not let a usage error borrow a status code", () => {
    expect([EXIT.usage, EXIT.internal]).not.toContain(EXIT.blocked);
  });
});

describe("what it tells a person watching", () => {
  it("leads with the status, the package, and where the record is", () => {
    const report = {
      request: { packageName: "postcss", targetVersion: "8.4.35" },
      result: { status: "blocked", reasons: ["vendor is gone"] },
      artifactsDirectory: "/tmp/run",
    } as unknown as RunReport;
    expect(summarize(report)).toBe("blocked: postcss 8.4.35, artifacts in /tmp/run\n  vendor is gone");
  });

  it("offers help when asked, and when asked nothing", () => {
    expect(wantsHelp([])).toBe(true);
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["postcss@8.4.35"])).toBe(false);
  });

  it("documents every exit code it can return", () => {
    for (const code of Object.values(EXIT)) {
      expect(HELP, String(code)).toContain(`  ${String(code)} `.trimEnd());
    }
  });
});
