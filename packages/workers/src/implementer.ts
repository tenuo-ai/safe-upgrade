/**
 * Implementer, spec 13.4.
 *
 * Moves the dependency and migrates the code that the researcher's findings say
 * has to move. Three properties shape it:
 *
 * It writes production source and nothing else. Test files are excluded by
 * capability, not by convention, so the worker that makes the change cannot also
 * adjust the test that is supposed to catch it.
 *
 * It asks rather than assumes. Setting a manifest's module type is part of this
 * migration and is not in this worker's standing authority, so it records an
 * elevation request and stops. The run reports `human_required` and changes
 * nothing, which is a better outcome than a partial migration left in a worktree.
 *
 * And it refuses partial work. A file it cannot convert in full is reported, not
 * half-written: a codemod that gets most of a file right produces something that
 * imports cleanly and behaves differently, which is exactly what verification is
 * least likely to catch.
 */

import { elevationRequest, type ElevationRequest, type FileChange, type MigrationFinding } from "@safe-upgrade/domain";
import type { UpgradeStateUpdate, WorkerFn, WorkerInput } from "@safe-upgrade/graph";
import { inWorktree, type RunContext } from "./context.ts";
import { convertToEsm, type Refusal } from "./migrate/to-esm.ts";
import { isSourceFile, isTestFile } from "./research/usages.ts";

/** Files converted in one pass. Bounded so a large repository cannot stall the run. */
const MAX_CONVERTED_FILES = 200;

export function createImplementer(context: RunContext): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> => {
    const esmFinding = input.state.findings.find((finding) => finding.id === "esm-only-at-target");
    if (esmFinding === undefined) {
      return moveDependencyOnly(input, context);
    }
    return migrateToEsm(input, context, esmFinding);
  };
}

/**
 * The case where research concluded the manifest and lockfile are the whole change.
 */
async function moveDependencyOnly(
  input: WorkerInput,
  context: RunContext,
): Promise<UpgradeStateUpdate> {
  const { packageName, targetVersion } = context.request;
  const outcome = await input.handle.tools.update_dependency({ packageName, targetVersion });
  if (outcome.outcome !== "passed") {
    return {
      blockingConditions: [
        `moving ${packageName} to ${targetVersion} failed with exit code ${String(outcome.exitCode)}`,
      ],
    };
  }
  return {
    addressedFindingIds: input.state.findings
      .filter((finding) => finding.noSourceChangeRequired === true)
      .map((finding) => finding.id),
    fileChanges: [
      {
        path: context.facts.lockfile,
        // Hashes are the package manager's business: it rewrote the lockfile, and
        // this worker never read it.
        beforeHash: null,
        afterHash: null,
        owner: "implementer",
        reason: `moved to ${packageName} ${targetVersion}`,
      },
    ],
  };
}

/**
 * The CommonJS-to-ESM case.
 *
 * Every file in the package moves together, not only the ones that name the
 * package. A module converted to ESM can no longer be `require`d by its neighbour,
 * so converting `search.js` alone would break `index.js`, which does not mention
 * the dependency at all.
 */
async function migrateToEsm(
  input: WorkerInput,
  context: RunContext,
  finding: MigrationFinding,
): Promise<UpgradeStateUpdate> {
  const manifestPath = inWorktree(context, "package.json");
  const manifest = await input.handle.tools.read_file({ path: manifestPath });

  const request = elevationRequest({
    worker: "implementer",
    capability: "update_manifest_field",
    // Worktree-relative, so the same approval still applies on the next run.
    arguments: { path: "package.json", field: "type", value: "module" },
    reason: `${context.request.packageName} ${context.request.targetVersion} can only be loaded as an ES module, and this package is CommonJS. Every file in it has to load as ESM, which is what this field decides.`,
    findingIds: [finding.id],
  });

  const approved = input.handle.capabilities.includes("update_manifest_field");
  if (!approved) {
    // Nothing is written. A dependency moved without the migration leaves a worktree
    // that does not install, and a run that ends in `human_required` should end with
    // the repository as it was found.
    input.audit.record({
      phase: "implement",
      worker: "implementer",
      type: "elevation_requested",
      payload: {
        elevationId: request.id,
        capability: request.capability,
        reason: request.reason,
        findingIds: request.findingIds,
      },
    });
    return { elevationRequests: [request] };
  }

  const plan = await planConversions(input, context);
  if (plan.refused.length > 0) {
    return {
      blockingConditions: plan.refused.map(
        ({ file, refusals }) =>
          `${file} cannot be converted to an ES module mechanically: ${describeRefusals(refusals)}`,
      ),
    };
  }

  const { packageName, targetVersion } = context.request;
  const moved = await input.handle.tools.update_dependency({ packageName, targetVersion });
  if (moved.outcome !== "passed") {
    return {
      blockingConditions: [
        `moving ${packageName} to ${targetVersion} failed with exit code ${String(moved.exitCode)}`,
      ],
    };
  }

  const changes: FileChange[] = [];
  for (const { file, path, hash, converted, applied } of plan.convert) {
    const written = await input.handle.tools.write_source_file({
      path,
      expectedBeforeHash: hash,
      content: converted,
    });
    changes.push({
      path: file,
      beforeHash: hash,
      afterHash: written.afterHash,
      owner: "implementer",
      reason: `converted to an ES module: ${applied.join("; ")}`,
    });
  }

  // Last, so a failure above leaves a package whose manifest still matches its
  // files. `update_dependency` rewrote the manifest, so it is re-read rather than
  // hashed from the copy taken at the start.
  const current = await input.handle.tools.read_file({ path: manifestPath });
  const typeSet = await input.handle.tools.update_manifest_field({
    path: manifestPath,
    field: "type",
    value: "module",
    expectedBeforeHash: current.hash,
  });
  changes.push({
    path: "package.json",
    beforeHash: typeSet.hashBefore,
    afterHash: typeSet.hashAfter,
    owner: "implementer",
    reason: `set type to module, from ${typeSet.previousValue ?? "unset"}`,
  });

  input.audit.record({
    phase: "implement",
    worker: "implementer",
    type: "migration_applied",
    payload: {
      findingId: finding.id,
      converted: plan.convert.map(({ file }) => file),
      deferredToTestAuthor: plan.tests,
      manifestHashBefore: typeSet.hashBefore,
      manifestHashAfter: typeSet.hashAfter,
      // The manifest read at the start is recorded too, so the audit shows the
      // dependency move happening between the two.
      manifestHashAtStart: manifest.hash,
    },
  });

  return {
    fileChanges: changes,
    addressedFindingIds: [finding.id],
    // Test files are call sites this worker is not allowed to touch. Saying so
    // keeps the reason for the verification failure that follows legible.
    ...(plan.tests.length > 0
      ? {
          highSeverityUncertainty: [
            `${plan.tests.join(", ")} still load this package as CommonJS, and only the test author may write them.`,
          ],
        }
      : {}),
  };
}

interface PlannedConversion {
  readonly file: string;
  readonly path: string;
  readonly hash: string;
  readonly converted: string;
  readonly applied: readonly string[];
}

interface Plan {
  readonly convert: readonly PlannedConversion[];
  readonly refused: readonly { readonly file: string; readonly refusals: readonly Refusal[] }[];
  /** Test files that need the same conversion, which this worker cannot write. */
  readonly tests: readonly string[];
}

/**
 * Work out every file's conversion before writing any of them.
 *
 * A refusal anywhere means nothing is written. Half a package converted to ESM is
 * not a state anyone wants to inspect, and the whole point of the manifest flag is
 * that the package's files agree with each other.
 */
async function planConversions(input: WorkerInput, context: RunContext): Promise<Plan> {
  const listed = await input.handle.tools.list_files({
    root: context.facts.worktreePath,
    glob: "**/*",
  });

  const convert: PlannedConversion[] = [];
  const refused: { file: string; refusals: readonly Refusal[] }[] = [];
  const tests: string[] = [];

  for (const path of listed.filter(isSourceFile).slice(0, MAX_CONVERTED_FILES)) {
    const file = relativize(path, context.facts.worktreePath);
    if (isTestFile(file)) {
      const source = await input.handle.tools.read_file({ path });
      if (convertToEsm(source.content).kind !== "unchanged") {
        tests.push(file);
      }
      continue;
    }

    const source = await input.handle.tools.read_file({ path });
    const outcome = convertToEsm(source.content);
    if (outcome.kind === "refused") {
      refused.push({ file, refusals: outcome.refusals });
      continue;
    }
    if (outcome.kind === "converted") {
      convert.push({
        file,
        path,
        hash: source.hash,
        converted: outcome.result.converted,
        applied: outcome.result.applied,
      });
    }
  }

  return { convert, refused, tests };
}

function describeRefusals(refusals: readonly Refusal[]): string {
  return refusals.map((refusal) => `line ${String(refusal.line)} ${refusal.reason}`).join("; ");
}

function relativize(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

export type { ElevationRequest };
