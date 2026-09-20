/**
 * Test author, spec 13.3.
 *
 * Two jobs, one per phase, and the split matters: assessing whether existing tests
 * would catch a regression is a different question from writing a test, and the
 * router gets to decide between them.
 *
 * What this worker deliberately cannot do is write production source. A worker able
 * to write both the code and the test that checks it can always make the test pass,
 * and the separation is enforced by capability rather than by intent.
 *
 * It also does not claim a finding is verified. `verifiedFindingIds` is set by the
 * verifier, from a test run it performed itself, because "this test would catch it"
 * is a claim about a test that has not been executed yet.
 */

import { count } from "@safe-upgrade/domain";
import type { FileChange, MigrationFinding, TestAssessment } from "@safe-upgrade/domain";
import type { UpgradeStateUpdate, WorkerFn, WorkerInput } from "@safe-upgrade/graph";
import { inWorktree, type RunContext } from "./context.ts";
import { convertToEsm } from "./migrate/to-esm.ts";
import { findUsages, isSourceFile, isTestFile } from "./research/usages.ts";

export function createTestAuthor(context: RunContext): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> =>
    input.state.phase === "author_tests" ? authorTests(input, context) : assess(input, context);
}

/**
 * Does anything currently executing reach the affected code?
 *
 * Reachability, not coverage percentage. The question a finding raises is whether
 * the suite would have noticed, and for a module that stops loading the answer is
 * decided by whether any test imports it, transitively. A coverage tool would be
 * more precise about lines and would need the suite to run under instrumentation
 * this worker cannot configure.
 */
async function assess(input: WorkerInput, context: RunContext): Promise<UpgradeStateUpdate> {
  const graph = await moduleGraph(input, context);
  const uncovered: string[] = [];
  const explanations: string[] = [];

  for (const finding of input.state.findings) {
    if (finding.noSourceChangeRequired === true) {
      continue;
    }
    const unreached = finding.affectedFiles.filter((file) => !graph.reachableFromTests.has(file));
    if (unreached.length === 0) {
      continue;
    }
    uncovered.push(finding.id);
    explanations.push(`${finding.id}: no test reaches ${unreached.join(", ")}`);
  }

  const assessment: TestAssessment = {
    sufficient: uncovered.length === 0,
    uncoveredFindings: uncovered,
    rationale:
      uncovered.length === 0
        ? `every affected file is reachable from ${count(graph.testFiles.length, "test file")}`
        : explanations.join("; "),
  };

  input.audit.record({
    phase: "assess_verification",
    worker: "test_author",
    type: "test_assessment_recorded",
    payload: {
      sufficient: assessment.sufficient,
      uncoveredFindings: assessment.uncoveredFindings,
      rationale: assessment.rationale,
      testFiles: graph.testFiles,
      reachable: [...graph.reachableFromTests].sort(),
    },
  });

  return { testAssessment: assessment };
}

/**
 * Write what is missing.
 *
 * Two kinds of work, both of which are only ever about test files. Migrating a test
 * file that can no longer load the code it tests, and adding a test that reaches an
 * affected file nothing currently reaches.
 */
async function authorTests(input: WorkerInput, context: RunContext): Promise<UpgradeStateUpdate> {
  const esmFinding = input.state.findings.find((finding) => finding.id === "esm-only-at-target");

  // Assessed before anything is written as well as after. The before-assessment is
  // the record of what was missing, which is what a reviewer needs to see; on its
  // own, the after-assessment says everything is covered and does not say why it now
  // is. The spec's fallback order means the `assess_verification` phase is often
  // never reached, so this is where the gap gets recorded.
  await assess(input, context);

  const added = await addMissingTests(input, context, esmFinding !== undefined);
  const migrated = esmFinding === undefined ? [] : await migrateTests(input, context);

  // And re-assessed, so the router stops sending this worker to write a test it has
  // already written.
  const reassessed = await assess(input, context);
  const assessment = reassessed.testAssessment as TestAssessment | null;

  input.audit.record({
    phase: "author_tests",
    worker: "test_author",
    type: "tests_authored",
    payload: {
      migrated: migrated.map((change) => change.path),
      added: added.map((change) => change.path),
      nowSufficient: assessment?.sufficient ?? false,
    },
  });

  return {
    ...reassessed,
    fileChanges: [...added, ...migrated],
    ...(migrated.length === 0 && added.length === 0
      ? {
          // Nothing to write is not success. Saying so keeps a run from reporting
          // coverage that nobody added.
          highSeverityUncertainty: [
            "the test author had nothing it could write: the uncovered findings do not name a file it knows how to reach from a test",
          ],
        }
      : {}),
  };
}

/**
 * Bring test files along when the package is going to change module system.
 *
 * Driven by the finding, not by what the manifest currently says. Waiting for the
 * manifest would mean waiting for the implementer, and then the implementer would be
 * waiting for this: a test file it cannot write is the one thing standing between its
 * migration and a suite that runs. Acting on the finding breaks the cycle, and costs
 * only that the suite is briefly inconsistent between this worker and the next —
 * a window in which nothing runs it.
 */
async function migrateTests(
  input: WorkerInput,
  context: RunContext,
): Promise<readonly FileChange[]> {
  const changes: FileChange[] = [];
  for (const path of await testFilePaths(input, context)) {
    const source = await input.handle.tools.read_file({ path });
    const outcome = convertToEsm(source.content);
    if (outcome.kind !== "converted") {
      continue;
    }
    const written = await input.handle.tools.write_test_file({
      path,
      expectedBeforeHash: source.hash,
      content: outcome.result.converted,
    });
    changes.push({
      path: relativize(path, context.facts.worktreePath),
      beforeHash: source.hash,
      afterHash: written.afterHash,
      owner: "test_author" as const,
      reason: `converted to an ES module so it can load the package it tests: ${outcome.result.applied.join("; ")}`,
    });
  }
  return changes;
}

/**
 * Add a test for an affected file nothing reaches.
 *
 * The test asserts that the module loads and that its exports are callable, which
 * is a modest claim and exactly the one the finding is about: a package that becomes
 * ESM-only breaks its CommonJS callers at load time, before any behaviour runs. A
 * generated test that asserted something about behaviour would be asserting
 * something nobody established.
 */
async function addMissingTests(
  input: WorkerInput,
  context: RunContext,
  targetIsEsm: boolean,
): Promise<readonly FileChange[]> {
  const graph = await moduleGraph(input, context);
  const changes: FileChange[] = [];

  for (const finding of input.state.findings) {
    for (const file of unreachedFiles(finding, graph)) {
      const target = await input.handle.tools.read_file({ path: inWorktree(context, file) });
      const exported = exportedNames(target.content);
      if (exported.length === 0) {
        continue;
      }
      const testPath = inWorktree(context, testPathFor(file));
      // Written in the module system the package is *going* to use, since the
      // implementer's migration is what this test has to survive.
      const content = loadTest(file, exported, targetIsEsm || isEsm(target.content));
      const written = await input.handle.tools.write_test_file({
        path: testPath,
        // Absent rather than a hash: this file is being created, and claiming a
        // before-hash for a file that does not exist would overwrite one that does.
        expectedBeforeHash: "absent",
        content,
      });
      changes.push({
        path: testPathFor(file),
        beforeHash: null,
        afterHash: written.afterHash,
        owner: "test_author" as const,
        reason: `${file} was not reachable from any test, so ${finding.id} could not have been caught`,
      });
    }
  }
  return changes;
}

function unreachedFiles(finding: MigrationFinding, graph: ModuleGraph): readonly string[] {
  if (finding.noSourceChangeRequired === true) {
    return [];
  }
  return finding.affectedFiles.filter((file) => !graph.reachableFromTests.has(file));
}

interface ModuleGraph {
  readonly testFiles: readonly string[];
  /** Worktree-relative files a test reaches, directly or through a relative import. */
  readonly reachableFromTests: ReadonlySet<string>;
}

/**
 * Which files a test can reach, following relative imports only.
 *
 * Relative specifiers are what a repository's own module graph is made of; a bare
 * specifier leaves the repository. Extensionless specifiers are resolved against
 * the files that exist, which is as much resolution as this needs.
 */
async function moduleGraph(input: WorkerInput, context: RunContext): Promise<ModuleGraph> {
  const listed = await input.handle.tools.list_files({
    root: context.facts.worktreePath,
    glob: "**/*",
  });
  const sources = listed.filter(isSourceFile);
  const relativePaths = new Set(sources.map((path) => relativize(path, context.facts.worktreePath)));

  const contents = new Map<string, string>();
  for (const path of sources) {
    const file = relativize(path, context.facts.worktreePath);
    contents.set(file, (await input.handle.tools.read_file({ path })).content);
  }

  const testFiles = [...relativePaths].filter(isTestFile).sort();
  const reachable = new Set<string>();
  const queue = [...testFiles];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const specifier of relativeSpecifiers(contents.get(current) ?? "")) {
      const resolved = resolveRelative(current, specifier, relativePaths);
      if (resolved !== null && !reachable.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return { testFiles, reachableFromTests: reachable };
}

const RELATIVE_SPECIFIER = /(?:require\s*\(\s*|from\s*|import\s*\(\s*|import\s*)(['"])(\.[^'"]*)\1/g;

function relativeSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(RELATIVE_SPECIFIER)].map((match) => match[2] ?? "");
}

function resolveRelative(
  from: string,
  specifier: string,
  existing: ReadonlySet<string>,
): string | null {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") {
      continue;
    }
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const base = segments.join("/");
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`]) {
    if (existing.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isEsm(source: string): boolean {
  return /^\s*(?:import|export)\s/m.test(source);
}

/** Exported names, from either module system. */
export function exportedNames(source: string): readonly string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*export\s+\{([^}]*)\}/gm)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name.length > 0) {
        names.add(name);
      }
    }
  }
  for (const match of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1] ?? "");
  }
  for (const match of source.matchAll(/^\s*module\.exports\s*=\s*\{([^}]*)\}/gm)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(":")[0]?.trim();
      if (name !== undefined && name.length > 0) {
        names.add(name);
      }
    }
  }
  return [...names].filter((name) => name.length > 0).sort();
}

/** `src/highlight.js` becomes `test/highlight.load.test.js`. */
export function testPathFor(file: string): string {
  const base = file.split("/").pop() ?? file;
  const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
  return `test/${stem}.load.test.js`;
}

/**
 * A test that fails if the module cannot be loaded or its exports are not callable.
 *
 * Written against `node:test` because that is what the repository already uses; a
 * generated test that needed a framework the repository does not have would not run.
 */
export function loadTest(file: string, exported: readonly string[], esm: boolean): string {
  const specifier = `../${file}`;
  const header = `// Added because ${file} was not reachable from any test, so a change that\n// stopped it loading would not have failed the suite.\n`;
  const assertions = exported
    .map((name) => `test("${name} is callable from ${file}", () => {\n  assert.equal(typeof module_.${name}, "function");\n});`)
    .join("\n\n");

  if (esm) {
    return `${header}import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as module_ from "${specifier}";\n\n${assertions}\n`;
  }
  return `${header}"use strict";\n\nconst test = require("node:test");\nconst assert = require("node:assert/strict");\nconst module_ = require("${specifier}");\n\n${assertions}\n`;
}

async function testFilePaths(input: WorkerInput, context: RunContext): Promise<readonly string[]> {
  const listed = await input.handle.tools.list_files({
    root: context.facts.worktreePath,
    glob: "**/*",
  });
  return listed
    .filter(isSourceFile)
    .filter((path) => isTestFile(relativize(path, context.facts.worktreePath)));
}

function relativize(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
