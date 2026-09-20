import type { WorkerRegistry } from "@safe-upgrade/graph";
import type { RunContext } from "./context.ts";
import { createImplementer } from "./implementer.ts";
import { createInspector } from "./inspector.ts";
import { createResearcher } from "./research/researcher.ts";
import { createTestAuthor } from "./test-author.ts";
import { createVerifier } from "./verifier.ts";
import { unimplementedWorker } from "./unimplemented.ts";

export type { RunContext } from "./context.ts";
export { inWorktree } from "./context.ts";
export { createImplementer } from "./implementer.ts";
export { createInspector } from "./inspector.ts";
export { convertToEsm } from "./migrate/to-esm.ts";
export type { Conversion, ConversionResult, Refusal } from "./migrate/to-esm.ts";
export { createTestAuthor, exportedNames, loadTest, testPathFor } from "./test-author.ts";
export { createVerifier, diffPolicyViolations } from "./verifier.ts";
export { createResearcher, githubRepository } from "./research/researcher.ts";
export { deriveFindings, relevantExtract } from "./research/derive.ts";
export type { Derivation, DerivationInput } from "./research/derive.ts";
export { findUsages, isSourceFile, isTestFile } from "./research/usages.ts";
export type { LoadStyle, Usage } from "./research/usages.ts";
export { unimplementedWorker } from "./unimplemented.ts";
export { checkOrder, recordCheck } from "./checks.ts";

/**
 * Every worker id the graph requires. The ones that are not written yet report a
 * blocking condition, so a run that reaches one finishes as `blocked` with the
 * reason naming the gap, rather than appearing to have done the work.
 */
export function createWorkerRegistry(context: RunContext): WorkerRegistry {
  return {
    inspector: createInspector(context),
    researcher: createResearcher(context),
    verifier: createVerifier(context),
    test_author: createTestAuthor(context),
    implementer: createImplementer(context),
    ci_author: unimplementedWorker("ci_author", "adding the missing checks to CI"),
    publisher: unimplementedWorker(
      "publisher",
      "pushing the run branch and opening a draft pull request",
    ),
  };
}
