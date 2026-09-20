import type { CheckPurpose, RepositoryFacts } from "@safe-upgrade/domain";
import type { WorkerRegistry } from "@safe-upgrade/graph";
import { createInspector } from "./inspector.ts";
import { createVerifier } from "./verifier.ts";
import { unimplementedWorker } from "./unimplemented.ts";

export type { InspectorOptions } from "./inspector.ts";
export { createInspector } from "./inspector.ts";
export type { VerifierOptions } from "./verifier.ts";
export { createVerifier, diffPolicyViolations } from "./verifier.ts";
export { unimplementedWorker } from "./unimplemented.ts";
export { checkOrder, recordCheck } from "./checks.ts";

export interface RegistryOptions {
  readonly facts: RepositoryFacts;
  readonly checkScripts: Readonly<Partial<Record<CheckPurpose, string>>>;
  readonly absentChecks: readonly CheckPurpose[];
  readonly startCommit: string;
  readonly sourceClean: boolean;
  readonly detectionWarnings: readonly string[];
  readonly packageName: string;
  readonly targetVersion: string;
}

/**
 * Every worker id the graph requires. The five that are not written yet report a
 * blocking condition, so a run that reaches one finishes as `blocked` with the
 * reason naming the gap, rather than appearing to have done the work.
 */
export function createWorkerRegistry(options: RegistryOptions): WorkerRegistry {
  return {
    inspector: createInspector({
      facts: options.facts,
      checkScripts: options.checkScripts,
      absentChecks: options.absentChecks,
      startCommit: options.startCommit,
      sourceClean: options.sourceClean,
      detectionWarnings: options.detectionWarnings,
    }),
    verifier: createVerifier({
      checkScripts: options.checkScripts,
      packageName: options.packageName,
      targetVersion: options.targetVersion,
    }),
    researcher: unimplementedWorker(
      "researcher",
      "retrieving cited release evidence and deriving breaking-change findings",
    ),
    test_author: unimplementedWorker(
      "test_author",
      "assessing test sufficiency and writing tests that would detect the regression",
    ),
    implementer: unimplementedWorker(
      "implementer",
      "moving the dependency to the target version and migrating affected code",
    ),
    ci_author: unimplementedWorker("ci_author", "adding the missing checks to CI"),
    publisher: unimplementedWorker("publisher", "pushing the run branch and opening a draft pull request"),
  };
}
