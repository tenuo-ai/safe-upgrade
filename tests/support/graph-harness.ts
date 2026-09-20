/**
 * Graph harness: the real graph, the real authorization runtime, and scripted
 * workers.
 *
 * The workers are fakes, but everything they do goes through a real Tenuo child
 * session and the real protected tools. A fake worker that tries to exceed its
 * capabilities is denied here exactly as a real one would be, which is what makes
 * these orchestration tests worth running.
 */

import { MemorySaver } from "@langchain/langgraph";
import type {
  CheckPurpose,
  CheckResult,
  MigrationFinding,
  RunStatus,
  UpgradeRequest,
  WorkerId,
} from "@safe-upgrade/domain";
import { FakeDecisionEngine, type ScriptedResponse } from "@safe-upgrade/jev";
import {
  buildGraph,
  type RouterConfig,
  type UpgradeState,
  type UpgradeStateUpdate,
  type WorkerFn,
  type WorkerRegistry,
} from "@safe-upgrade/graph";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

export interface GraphHarness {
  readonly base: Harness;
  readonly engine: FakeDecisionEngine;
  /** Node names in the order they executed. */
  readonly visited: WorkerId[];
  readonly phases: string[];
  run(request?: Partial<UpgradeRequest>): Promise<GraphRunResult>;
  cleanup(): void;
}

export interface GraphRunResult {
  readonly status: RunStatus | undefined;
  readonly state: UpgradeState;
}

export function check(purpose: CheckPurpose, outcome: CheckResult["outcome"]): CheckResult {
  return {
    command: { executable: "pnpm", args: ["run", purpose], cwd: "/tmp/wt", purpose, timeoutMs: 1_000 },
    exitCode: outcome === "passed" ? 0 : 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
    stdoutArtifact: `checks/${purpose}.out`,
    stderrArtifact: `checks/${purpose}.err`,
    outcome,
  };
}

export function finding(id: string, overrides: Partial<MigrationFinding> = {}): MigrationFinding {
  return {
    id,
    releaseClaim: `${id}: read() was removed in favour of parse()`,
    evidenceIds: [`evidence-${id}`],
    affectedSymbols: ["read"],
    affectedFiles: ["src/index.ts"],
    requiredChange: "call parse() instead of read()",
    confidence: 0.9,
    ...overrides,
  };
}

export interface GraphHarnessOptions extends HarnessOptions {
  readonly script?: readonly ScriptedResponse[];
  readonly config?: Partial<RouterConfig>;
  readonly workers?: Partial<Record<WorkerId, WorkerFn>>;
  readonly defaultConfidence?: number;
  readonly requiredCheckPurposes?: readonly CheckPurpose[];
}

/** A worker that records that it ran and applies a fixed state update. */
function scriptedWorker(
  worker: WorkerId,
  visited: WorkerId[],
  update: UpgradeStateUpdate | (() => UpgradeStateUpdate),
): WorkerFn {
  return async () => {
    visited.push(worker);
    return typeof update === "function" ? update() : update;
  };
}

export function createGraphHarness(options: GraphHarnessOptions = {}): GraphHarness {
  const base = createHarness(options);
  const visited: WorkerId[] = [];
  const phases: string[] = [];

  const engine = new FakeDecisionEngine({
    ...(options.script === undefined ? {} : { script: options.script }),
    ...(options.defaultConfidence === undefined ? {} : { defaultConfidence: options.defaultConfidence }),
  });

  // Defaults describe a well-behaved run: the inspector finds a clean repository
  // with a passing baseline, research finds one real breaking change.
  const defaults: WorkerRegistry = {
    inspector: scriptedWorker("inspector", visited, {}),
    researcher: scriptedWorker("researcher", visited, { findings: [finding("f1")] }),
    test_author: scriptedWorker("test_author", visited, {}),
    implementer: scriptedWorker("implementer", visited, {}),
    ci_author: scriptedWorker("ci_author", visited, {}),
    verifier: scriptedWorker("verifier", visited, {}),
    publisher: scriptedWorker("publisher", visited, {}),
  };

  const workers = { ...defaults } as Record<WorkerId, WorkerFn>;
  for (const [worker, fn] of Object.entries(options.workers ?? {}) as [WorkerId, WorkerFn][]) {
    workers[worker] = async (input) => {
      visited.push(worker);
      return fn(input);
    };
  }

  const config: RouterConfig = {
    confidenceThreshold: 0.6,
    maxGraphSteps: 40,
    maxWorkerAttempts: 3,
    ...options.config,
  };

  const graph = buildGraph({
    runtime: base.runtime,
    engine,
    audit: base.audit,
    workers,
    config,
    ...(options.requiredCheckPurposes === undefined
      ? {}
      : { requiredCheckPurposes: options.requiredCheckPurposes }),
  }).compile({ checkpointer: new MemorySaver() });

  return {
    base,
    engine,
    visited,
    phases,
    async run(request = {}) {
      const fullRequest: UpgradeRequest = {
        runId: base.runId,
        repositoryPath: base.root,
        packageName: "left-pad",
        targetVersion: "1.3.0",
        allowTransitive: false,
        createDraftPullRequest: false,
        ...request,
      };
      const state = await graph.invoke(
        { request: fullRequest },
        { configurable: { thread_id: base.runId }, recursionLimit: 60 },
      );
      for (const decision of state.routeHistory) {
        phases.push(decision.selected);
      }
      return { status: state.result?.status, state };
    },
    cleanup: () => base.cleanup(),
  };
}
