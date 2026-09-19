# Safe Agent Delegation with Jev, LangGraph, and Tenuo

## Engineering implementation specification

## 1. Objective

Build a TypeScript service and CLI that can safely prepare a dependency upgrade for an existing TypeScript repository.

Given a repository, package name, and target version, the system must:

1. inspect the repository and determine its package manager, workspace layout, build system, and verification commands;
2. retrieve authoritative release information for the requested package version;
3. identify source files and APIs affected by the release;
4. determine whether the repository has sufficient tests to verify the migration;
5. add focused regression or characterization tests when verification is insufficient;
6. update the dependency, lockfile, and affected application code;
7. run an independent clean verification;
8. add or update a restricted CI workflow when no suitable workflow exists;
9. produce a structured report and, when explicitly approved, create a draft pull request.

LangGraph coordinates the workflow. Jev chooses the next eligible specialist and evaluates bounded semantic questions. Tenuo delegates a distinct, constrained set of capabilities to each specialist. Deterministic code performs validation, authorization, filesystem operations, command execution, and acceptance checks.

## 2. Required technical outcomes

The completed implementation must demonstrate all of the following:

- A real dependency migration that requires at least one application code change.
- Dynamic worker selection using Jev from an allowlisted set of graph transitions.
- A Tenuo child session created for every worker invocation.
- Different workers receiving observably different capabilities.
- An unauthorized tool call being denied before the underlying operation executes.
- Test creation when existing coverage is insufficient.
- Separation between the worker that changes production code and the worker that writes tests.
- Verification in a clean, isolated checkout or worktree.
- CI creation or repair without granting deploy, publish, secret-reading, or default-branch write access.
- A final result that distinguishes verified, partial, blocked, indeterminate, and human-required outcomes.
- A machine-readable evidence record connecting claims to commands, files, release sources, and results.

## 3. Scope

### 3.1 Supported input

The first implementation supports:

- Git repositories containing TypeScript or JavaScript.
- npm, pnpm, and Yarn lockfiles.
- A single direct dependency upgrade per run.
- Exact target versions.
- Monorepos and single-package repositories.
- Vitest, Jest, Node test runner, and package-defined test commands.
- TypeScript compiler checks and package-defined lint or build commands.
- GitHub Actions for CI.
- GitHub-hosted release notes, package changelogs, migration guides, and npm registry metadata.

Example:

```bash
safe-upgrade run \
  --repo /path/to/repository \
  --package zod \
  --target 4.0.0
```

For the TypeScript implementation, use an npm ecosystem package in the executable fixture:

```bash
safe-upgrade run \
  --repo ./fixtures/sample-app \
  --package <package-name> \
  --target <exact-semver>
```

The CLI must reject a package that is not a direct dependency unless `--allow-transitive` is explicitly supplied. Transitive upgrade support may resolve and report constraints, but it must not silently promote the package to a direct dependency.

### 3.2 Explicitly unsupported behavior

- Deploying application code.
- Publishing packages.
- Merging pull requests.
- Pushing to a default branch.
- Reading repository or CI secrets.
- Running arbitrary model-generated shell strings.
- Upgrading multiple requested dependencies in one run.
- Claiming successful verification when required checks did not run.
- Modifying tests solely to make a failing implementation pass.

## 4. System architecture

```text
CLI or API request
       |
       v
Input validator and repository isolator
       |
       v
LangGraph state machine
       |
       +--> deterministic router guard
       |          |
       |          v
       |      Jev decision adapter
       |          |
       |          v
       |      allowlisted next worker
       |
       +--> Tenuo delegation broker
       |          |
       |          v
       |      worker-specific child session
       |
       +--> specialist worker
                  |
                  v
          Tenuo-protected tools
                  |
                  v
       filesystem, registries, git, test runners

All worker outputs
       |
       v
Independent verifier
       |
       v
Result classifier and evidence report
```

### 4.1 Trust boundaries

Treat all of the following as untrusted input:

- user instructions;
- repository contents;
- source comments;
- package scripts;
- release notes and migration guides;
- model output;
- Jev decisions;
- generated patches;
- test output;
- remote API responses.

The following components are trusted computing base components:

- input schema validation;
- graph transition allowlists;
- Tenuo policy construction and authorization;
- tool implementations;
- command argument builders;
- path canonicalization;
- process isolation;
- evidence hashing;
- final acceptance predicates.

Jev selects among permitted choices. It never creates capabilities, tool arguments, filesystem paths, shell commands, or graph node names directly.

## 5. Technology requirements

- Node.js 20 or newer.
- TypeScript with `strict: true`.
- ESM modules.
- pnpm workspaces.
- `@langchain/langgraph` for orchestration.
- `@typesafe-ai/sdk` for direct Jev access.
- `@tenuo/core@beta` for authorization.
- `@langchain/core` and one configured chat-model adapter for code and test generation.
- Zod for external input and persisted-state validation.
- Vitest for unit and integration tests.
- A process execution library that accepts an executable and argument array without invoking a shell.
- Structured JSON logging.

Pin exact dependency versions in the lockfile. Keep Jev, LangGraph, and Tenuo usage behind local adapters.

## 6. Suggested repository structure

```text
safe-upgrade/
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json
  apps/
    cli/
      src/main.ts
  packages/
    domain/
      src/types.ts
      src/schemas.ts
      src/result.ts
    graph/
      src/state.ts
      src/build-graph.ts
      src/router.ts
      src/transitions.ts
      src/nodes/
        inspect.ts
        research.ts
        assess-verification.ts
        author-tests.ts
        implement.ts
        configure-ci.ts
        verify.ts
        publish-draft.ts
        finalize.ts
    jev/
      src/decision-engine.ts
      src/typesafe-client.ts
      src/questions.ts
    authorization/
      src/tenuo.ts
      src/profiles.ts
      src/session-registry.ts
      src/protected-tools.ts
    tools/
      src/files.ts
      src/git.ts
      src/packages.ts
      src/process.ts
      src/releases.ts
      src/github.ts
    workers/
      src/worker.ts
      src/generative-model.ts
      src/researcher.ts
      src/test-author.ts
      src/implementer.ts
      src/ci-author.ts
      src/verifier.ts
    evidence/
      src/store.ts
      src/hash.ts
      src/report.ts
    runtime/
      src/worktree.ts
      src/sandbox.ts
      src/config.ts
  fixtures/
    sample-app/
  tests/
    authorization/
    graph/
    integration/
    e2e/
```

## 7. Domain model

Use closed unions rather than free-form status strings.

```ts
export type RunStatus =
  | "verified"
  | "partial"
  | "blocked"
  | "indeterminate"
  | "human_required";

export type WorkerId =
  | "inspector"
  | "researcher"
  | "test_author"
  | "implementer"
  | "ci_author"
  | "verifier"
  | "publisher";

export type Phase =
  | "inspect"
  | "baseline_verify"
  | "research"
  | "route"
  | "assess_verification"
  | "author_tests"
  | "implement"
  | "configure_ci"
  | "verify"
  | "publish_draft"
  | "finalize";

export type RoutableAction = Exclude<
  Phase,
  "inspect" | "baseline_verify" | "research" | "route"
>;

export interface UpgradeRequest {
  runId: string;
  repositoryPath: string;
  packageName: string;
  targetVersion: string;
  allowTransitive: boolean;
  createDraftPullRequest: boolean;
}

export interface RepositoryFacts {
  worktreePath: string;
  defaultBranch: string;
  packageManager: "npm" | "pnpm" | "yarn";
  workspaceRoots: string[];
  manifests: string[];
  lockfile: string;
  currentVersion: string;
  verificationCommands: CommandSpec[];
  existingCiFiles: string[];
}

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  purpose: "install" | "test" | "typecheck" | "lint" | "build";
  timeoutMs: number;
}

export interface ReleaseEvidence {
  sourceUrl: string;
  sourceType: "registry" | "release" | "changelog" | "migration_guide";
  retrievedAt: string;
  contentHash: string;
  relevantExtract: string;
}

export interface MigrationFinding {
  id: string;
  releaseClaim: string;
  evidenceIds: string[];
  affectedSymbols: string[];
  affectedFiles: string[];
  requiredChange: string;
  confidence: number;
}

export interface CheckResult {
  command: CommandSpec;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
  stdoutArtifact: string;
  stderrArtifact: string;
  outcome: "passed" | "failed" | "timed_out" | "not_run";
}

export interface FileChange {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  owner: WorkerId;
  reason: string;
}
```

## 8. LangGraph state

Persist only serializable, non-secret values in graph state. Never persist holder private keys, Tenuo session objects, API keys, or GitHub tokens.

```ts
export interface UpgradeState {
  request: UpgradeRequest;
  phase: Phase;
  repository?: RepositoryFacts;
  releaseEvidence: ReleaseEvidence[];
  findings: MigrationFinding[];
  baselineChecks: CheckResult[];
  postChangeChecks: CheckResult[];
  fileChanges: FileChange[];
  testAssessment?: {
    sufficient: boolean;
    uncoveredFindings: string[];
    rationale: string;
  };
  ciAssessment?: {
    sufficient: boolean;
    selectedWorkflow?: string;
    missingChecks: CommandSpec["purpose"][];
  };
  routeHistory: RouteDecision[];
  workerAttempts: Partial<Record<WorkerId, number>>;
  activeSessionRef?: string;
  approval?: {
    draftPullRequestApproved: boolean;
  };
  result?: FinalResult;
}
```

`activeSessionRef` is an opaque, short-lived lookup key. The corresponding session remains in an in-memory or encrypted runtime registry and is deleted after the node completes.

## 9. Graph definition

### 9.1 Nodes

```text
START
  -> inspect
  -> baseline_verify
  -> research
  -> route

route
  -> assess_verification
  -> author_tests
  -> implement
  -> configure_ci
  -> verify
  -> publish_draft
  -> finalize

author_tests -> route
implement -> route
configure_ci -> route
verify -> route or finalize
publish_draft -> finalize
finalize -> END
```

`inspect`, `baseline_verify`, and `research` are mandatory deterministic stages. Jev routing begins only after the system has repository facts, a baseline, and release evidence.

### 9.2 Transition allowlist

Define legal transitions in code:

```ts
export const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  inspect: ["baseline_verify", "finalize"],
  baseline_verify: ["research", "finalize"],
  research: ["route", "finalize"],
  route: ["assess_verification", "author_tests", "implement", "configure_ci", "verify", "publish_draft", "finalize"],
  assess_verification: ["route", "finalize"],
  author_tests: ["route", "finalize"],
  implement: ["route", "finalize"],
  configure_ci: ["route", "finalize"],
  verify: ["route", "finalize"],
  publish_draft: ["finalize"],
  finalize: [],
};
```

The router must intersect legal transitions with deterministic eligibility predicates before presenting choices to Jev.

Examples:

- `author_tests` is ineligible if every finding has a meaningful existing verification path.
- `implement` is ineligible until research has produced at least one cited finding or concluded that no source migration is required.
- `publish_draft` is ineligible unless verification passed and explicit approval is recorded.
- `finalize` is always eligible after a blocking condition is recorded.

## 10. Jev decision layer

### 10.1 Adapter contract

```ts
export interface DecisionEngine {
  chooseNextAction(input: RouteInput): Promise<RouteDecision>;
  assessTestCoverage(input: TestCoverageInput): Promise<TestCoverageDecision>;
  assessMigrationCompleteness(
    input: MigrationCompletenessInput,
  ): Promise<MigrationCompletenessDecision>;
}
```

The official SDK is confined to one adapter:

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

export class JevDecisionEngine implements DecisionEngine {
  constructor(private readonly client = new TypeSafeClient()) {}

  async chooseNextAction(input: RouteInput): Promise<RouteDecision> {
    const candidates = input.eligibleActions.map((candidate) => candidate.action);
    const criteria = Object.fromEntries(
      input.eligibleActions.map((candidate) => [candidate.action, candidate.reason]),
    );

    const response = await this.client.systemOne({
      state: input,
      questions: {
        next: choice(
          "Choose the next eligible action that most directly reduces the unresolved upgrade risk.",
          criteria,
        ),
      },
    });

    return validateRouteResponse(response, candidates);
  }
}
```

Adapt the response accessors to the pinned SDK version. Validate the returned choice against the exact candidate list even if the SDK provides static types.

### 10.2 Routing input

Do not send the entire repository or raw logs. Construct a compact factual state:

```ts
export interface RouteInput {
  currentPhase: Phase;
  eligibleActions: Array<{
    action: RoutableAction;
    worker: WorkerId;
    reason: string;
  }>;
  unresolvedFindings: Array<{
    id: string;
    summary: string;
    affectedFileCount: number;
    hasVerification: boolean;
  }>;
  baselinePassed: boolean;
  implementationChanged: boolean;
  testsChanged: boolean;
  ciSufficient: boolean;
  lastVerification: "not_run" | "passed" | "failed";
  attempts: Partial<Record<WorkerId, number>>;
}
```

Map the selected action to a worker in trusted code:

```ts
export const ACTION_WORKER: Record<RoutableAction, WorkerId | null> = {
  assess_verification: "test_author",
  author_tests: "test_author",
  implement: "implementer",
  configure_ci: "ci_author",
  verify: "verifier",
  publish_draft: "publisher",
  finalize: null,
};
```

The router validates the selected action, resolves its worker using this map, and only then asks the delegation broker for that worker's child session. Jev cannot supply or override the worker identity.

### 10.3 Confidence and fallback

Store the selected choice and returned probability data when exposed by the SDK. Apply these rules deterministically:

- Reject choices outside the candidate set.
- Retry once for malformed transport or schema responses.
- On a second malformed response, choose the deterministic fallback.
- If top-choice confidence is below the configured threshold, choose the deterministic fallback and mark the route as `indeterminate` evidence.
- Never interpret generated text as a route.
- Cap attempts per worker and total graph steps.

The deterministic fallback order is:

1. resolve failed verification;
2. cover an unverified migration finding;
3. implement an unresolved migration finding;
4. configure missing CI checks;
5. independently verify;
6. finalize.

### 10.4 Appropriate Jev responsibilities

Use Jev for bounded semantic judgments:

- which eligible specialist should run next;
- whether existing tests meaningfully cover a described breaking change;
- whether the evidence and patch address every identified migration concern;
- which of a closed set of failure categories best describes a verification failure.

Do not use Jev to:

- produce source code;
- produce shell commands;
- authorize tools;
- select arbitrary paths;
- decide whether a Tenuo denial should be bypassed;
- declare the final run verified.

### 10.5 Generative model boundary

Jev is not the code-generation model. Workers that need to propose tests, source changes, or CI use a separate provider-neutral generative model interface:

```ts
export interface GenerativeModel {
  generateTestPlan(input: TestPlanInput): Promise<TestPlan>;
  generatePatch(input: PatchRequest): Promise<PatchProposal>;
  explainFailure(input: FailureInput): Promise<FailureAnalysis>;
}
```

Requirements:

- Keep the concrete model provider behind an adapter.
- Require structured output validated with Zod.
- Treat every response as an untrusted proposal.
- Do not give the model raw filesystem, process, network, Git, or GitHub clients.
- Let the worker translate a validated proposal into calls to its Tenuo-protected tools.
- Reject proposed paths outside the worker's allowed file class.
- Reject patches that touch files absent from the proposal's declared file list.
- Never pass Tenuo holder keys, API keys, environment secrets, or authorization headers to the model.
- Bound context to the relevant evidence, files, test output, and migration findings.
- Record the model identifier and response artifact hash, but not secrets or hidden reasoning.

A worker may use a tool-calling model loop, but the available tool list must contain only that worker's protected tools. Authorization remains mandatory even when a tool is omitted from the prompt-visible list.

## 11. Tenuo authorization model

### 11.1 Root session

Create one run-scoped parent session with the union of capabilities that the workflow may delegate. Use `createTenuo({ root: createTenuo.devRoot() })` only in fixtures and local tests. Production execution must import a warrant rooted in an explicitly trusted issuer.

```ts
import { createTenuo } from "@tenuo/core";

const tenuo = createTenuo({
  trustedRoots: [createTenuo.publicKeyFromEnv("TENUO_ROOT_PUBLIC_KEY")],
});

const parentSession = tenuo.sessionFromWire({
  warrant: process.env.TENUO_RUN_WARRANT!,
  holderKey: createTenuo.holderKeyFromEnv("TENUO_RUN_HOLDER_SECRET"),
});
```

### 11.2 Worker delegation

Create a child session immediately before invoking a worker:

```ts
const childSession = tenuo.narrow(parentSession, WORKER_PROFILES[workerId].allow);

await tenuo.withSession(childSession, async () => {
  await workers[workerId].run(input);
});
```

Each child session must:

- have only the selected worker's capabilities;
- expire within a short configured TTL inherited from the parent;
- be registered under a random opaque reference;
- be destroyed from the runtime registry after node completion;
- never be serialized into LangGraph checkpoints;
- produce allow and deny audit events.

### 11.3 Capability profiles

Use distinct tools rather than an unrestricted shell capability.

| Worker | Allowed capabilities | Explicitly absent |
|---|---|---|
| Inspector | repository metadata read, manifest read, git status, approved baseline commands | file writes, network release lookup, PR creation |
| Researcher | manifest/source read, registry metadata read, allowlisted HTTPS release fetch | file writes, process execution, git writes |
| Test author | source read, test read/write, fixture read/write, approved test execution | production source write, manifest write, lockfile write, CI write |
| Implementer | source read/write, manifest update, lockfile update, approved install/typecheck/test/build | test write, CI write, GitHub write |
| CI author | repository read, `.github/workflows` write, workflow validation | source/test write, secret read, workflow execution with deploy scopes |
| Verifier | full worktree read, clean install, approved test/typecheck/lint/build | all repository writes, GitHub write |
| Publisher | git diff read, branch push, draft PR create | repository write, merge, non-draft PR, default-branch push |

Example profile shape:

```ts
export const WORKER_PROFILES = {
  researcher: {
    allow: {
      read_file: { root: "<canonical-worktree-root>" },
      fetch_release: { hosts: ["registry.npmjs.org", "api.github.com", "github.com"] },
    },
  },
  test_author: {
    allow: {
      read_file: { root: "<canonical-worktree-root>" },
      write_test_file: { root: "<canonical-worktree-root>" },
      run_check: { kind: ["test"] },
    },
  },
  implementer: {
    allow: {
      read_file: { root: "<canonical-worktree-root>" },
      write_source_file: { root: "<canonical-worktree-root>" },
      update_manifest: { package: "<requested-package>" },
      update_lockfile: { packageManager: "<detected-manager>" },
      run_check: { kind: ["install", "test", "typecheck", "lint", "build"] },
    },
  },
  verifier: {
    allow: {
      read_file: { root: "<canonical-verification-root>" },
      run_check: { kind: ["install", "test", "typecheck", "lint", "build"] },
    },
  },
} as const;
```

Translate these conceptual policies into the exact `@tenuo/core` `allow` structure used by each protected tool. Tool ceilings must independently validate all arguments.

### 11.4 Required denial demonstration

Include an integration test in which the test-author worker attempts `write_source_file`. Assert that:

- Tenuo returns an authorization denial;
- the underlying write function is not called;
- the target file hash is unchanged;
- a denial event records the worker, capability, arguments hash, and warrant/session identifier;
- the workflow transitions to a controlled failure or replanning state.

## 12. Protected tool design

Every side effect must pass through a Tenuo-protected tool. Do not expose raw filesystem, process, GitHub, or network clients to workers.

### 12.1 File tools

Provide separate operations:

```ts
read_file({ path })
list_files({ root, glob })
write_source_file({ path, expectedBeforeHash, content })
write_test_file({ path, expectedBeforeHash, content })
write_ci_file({ path, expectedBeforeHash, content })
```

Each operation must:

- resolve the real path and confirm it remains below the canonical worktree root;
- reject symlink escapes;
- reject `.git`, `.env*`, credential files, and configured sensitive paths;
- use optimistic concurrency through `expectedBeforeHash`;
- write atomically;
- record before and after hashes;
- enforce path classification inside the tool implementation.

Path classification must be deterministic. A worker cannot relabel `src/index.test.ts` as production code or `src/index.ts` as a test merely through an argument.

### 12.2 Process tools

Expose intent-specific tools:

```ts
install_dependencies({ manager, frozen, ignoreScripts })
update_dependency({ manager, packageName, targetVersion })
run_test({ script, workspace })
run_typecheck({ script, workspace })
run_lint({ script, workspace })
run_build({ script, workspace })
```

Requirements:

- Spawn an executable with an argument array and `shell: false`.
- Resolve commands from detected package metadata and an allowlist.
- Reject command substitution, pipes, redirection, environment assignment, and arbitrary flags.
- Set time, CPU, memory, and output limits.
- Use a minimal environment allowlist.
- Disable lifecycle scripts during the initial clean install.
- Require a separate policy decision before any install that enables lifecycle scripts.
- Capture stdout and stderr as bounded artifacts.
- Kill the complete process tree on timeout.

Package scripts are untrusted. Parse the selected script before execution and block scripts containing unsupported executables or shell control syntax. Prefer direct known executables such as `pnpm exec vitest run` and `pnpm exec tsc --noEmit` over arbitrary script bodies.

### 12.3 Release tools

```ts
read_registry_metadata({ packageName, version })
fetch_release_document({ url })
```

Requirements:

- Allowlist schemes and hosts.
- Resolve redirects and revalidate the final host.
- Block local, link-local, private, and metadata-service addresses.
- Enforce body size and timeout limits.
- Store source URL, retrieval time, content hash, media type, and normalized text.
- Prefer npm registry metadata, the package's declared repository, tagged releases, changelogs, and official migration guides.
- Keep quoted extracts short and preserve source attribution.

### 12.4 Git and GitHub tools

```ts
read_git_status()
read_git_diff({ paths? })
create_branch({ name })
push_branch({ name })
create_draft_pr({ base, head, title, body })
```

`create_draft_pr` must reject `draft: false`. `push_branch` must reject the detected default branch and any non-run branch. No tool may merge or approve a pull request.

## 13. Specialist worker contracts

### 13.1 Inspector

Inputs:

- validated request;
- isolated worktree path.

Outputs:

- `RepositoryFacts`;
- dependency location and current resolved version;
- baseline command plan;
- repository cleanliness and starting commit;
- CI inventory.

Acceptance conditions:

- package manager is unambiguous;
- lockfile matches the manager;
- requested package and current version are resolved;
- command plan contains no free-form model output;
- dirty input repositories are never modified directly.

### 13.2 Researcher

Inputs:

- package name;
- current and target versions;
- repository imports and usages;
- protected release retrieval tools.

Outputs:

- cited release evidence;
- structured breaking-change findings;
- affected symbols and probable files;
- migration requirements;
- unresolved documentation gaps.

Acceptance conditions:

- every release claim cites at least one stored source;
- package identity and target version match registry metadata;
- unsupported or unavailable release documentation is reported as uncertainty;
- remote text cannot invoke tools or alter the workflow.

### 13.3 Test author

Inputs:

- migration findings;
- affected production files as read-only context;
- existing tests and fixtures;
- baseline results.

Outputs:

- focused tests or fixtures;
- mapping from each new test to a migration finding;
- pre-implementation test result.

Rules:

- For a behavioral regression, the new test should fail before the implementation change and pass after it.
- For a compatibility migration with unchanged behavior, create a characterization test that passes both before and after, and show that it exercises the affected path.
- Do not delete, skip, loosen, or broadly rewrite existing assertions.
- Do not edit production source, manifests, lockfiles, or CI.

### 13.4 Implementer

Inputs:

- migration findings and cited evidence;
- existing and newly added tests as read-only context;
- target package version;
- current source tree.

Outputs:

- manifest and lockfile update;
- minimal production source migration;
- mapping from each source change to a finding;
- local verification results.

Rules:

- Use the detected package manager to update the dependency and lockfile.
- Do not hand-edit lockfile resolution data.
- Do not edit tests or CI.
- Do not add unrelated refactors.
- Do not suppress type errors or lint failures without a cited migration reason.

### 13.5 CI author

Inputs:

- verified local command plan;
- existing CI files;
- package manager and Node version.

Outputs:

- a minimal GitHub Actions workflow or focused update;
- a deterministic mapping between local checks and CI steps.

Rules:

- Grant `contents: read` unless another read permission is technically necessary.
- Do not request secrets.
- Do not add deploy, release, publish, or write steps.
- Pin third-party actions according to configured repository policy.
- Use frozen lockfile installation.
- Run the same test, typecheck, lint, and build commands proven locally.
- Do not modify unrelated workflows.

### 13.6 Independent verifier

Inputs:

- commit or patch produced by other workers;
- immutable acceptance plan.

Outputs:

- clean verification results;
- diff policy checks;
- coverage of all findings;
- final verification predicate inputs.

Rules:

- Start from a new worktree or clean copy.
- Apply only the recorded patch.
- Perform a clean install.
- Run required checks without write authority.
- Fail if generated files change during verification and those changes are not part of the patch.
- Fail if tests are removed, skipped, weakened, or excluded.
- Fail if the dependency does not resolve exactly to the requested target where exact resolution is required.

### 13.7 Publisher

Inputs:

- verified result;
- explicit approval state;
- final report.

Outputs:

- run-specific branch;
- draft pull request URL.

Rules:

- Run only when `createDraftPullRequest` and `draftPullRequestApproved` are both true.
- Push only the run-specific branch.
- Create only a draft pull request.
- Include evidence summary, commands run, findings addressed, residual uncertainty, and generated-test disclosure.

## 14. Upgrade workflow behavior

### 14.1 Isolation

1. Resolve the input repository to a canonical path.
2. Read and record the starting commit and working-tree status.
3. Create a run-specific Git worktree from the requested starting commit.
4. Perform all modifications in that worktree.
5. Never clean, reset, stash, or overwrite the user's original checkout.

### 14.2 Baseline

Before changing files:

1. install dependencies with lifecycle scripts disabled;
2. run detected test, typecheck, lint, and build commands;
3. record each result;
4. if a required baseline check fails, classify it as pre-existing;
5. continue only if the run configuration permits a partial result, otherwise finalize as blocked.

### 14.3 Research and impact analysis

1. Confirm current and target versions.
2. Retrieve official metadata and release documentation.
3. Search static imports, dynamic imports, configuration, types, and referenced symbols.
4. Create a finding for every applicable breaking or behaviorally significant change.
5. Link findings to files and evidence.
6. Record an explicit `no_source_change_required` finding when only manifest and lockfile changes are required.

### 14.4 Test sufficiency

For every finding, determine whether an existing test:

- reaches the affected code path;
- makes an assertion that would detect the relevant regression;
- runs under the selected verification command;
- was passing at baseline.

Jev may assess semantic relevance. Deterministic code confirms file existence, test discovery, command execution, and coverage artifacts when available.

### 14.5 Implementation and iteration

1. Add necessary tests under the test-author session.
2. Run the focused tests against the pre-migration code.
3. Update the dependency and production code under the implementer session.
4. Run focused checks.
5. Route verification failures back to an eligible worker.
6. Stop when attempt or graph-step limits are reached.

### 14.6 Clean verification

The final verifier must execute:

1. frozen clean dependency install;
2. full test suite;
3. TypeScript typecheck;
4. lint when the repository defines it;
5. build when the repository defines it;
6. focused migration tests;
7. manifest and lockfile consistency checks;
8. diff policy checks;
9. CI workflow static validation.

## 15. Final result classification

Final classification is deterministic.

### `verified`

All conditions are true:

- baseline state is known;
- target version is resolved correctly;
- every applicable migration finding is addressed;
- every finding has a meaningful verification path;
- all required clean checks pass;
- diff policy passes;
- no unresolved high-severity uncertainty remains;
- CI is sufficient or was successfully created;
- no prohibited action occurred.

### `partial`

Useful changes were prepared, but one or more noncritical checks could not be completed. The report must identify exactly which claims remain unverified. A partial result must never be described as safe or verified.

### `blocked`

Progress cannot continue due to a concrete condition such as an unresolvable dependency graph, unsupported package manager, failing required baseline, or denied required authority.

### `indeterminate`

Available evidence cannot establish whether the migration is correct, for example missing release documentation or ambiguous behavioral changes.

### `human_required`

A technically valid next operation requires explicit approval, such as enabling install lifecycle scripts or publishing the draft pull request.

## 16. Evidence and audit record

Write one append-only JSON Lines event stream per run plus a summarized JSON report.

```ts
export interface AuditEvent {
  eventId: string;
  runId: string;
  timestamp: string;
  phase: Phase;
  worker?: WorkerId;
  type:
    | "route_decision"
    | "session_delegated"
    | "tool_allowed"
    | "tool_denied"
    | "file_changed"
    | "command_completed"
    | "evidence_retrieved"
    | "finding_created"
    | "verification_completed"
    | "result_classified";
  payload: Record<string, unknown>;
}
```

Requirements:

- Hash artifacts and large outputs instead of embedding them in every event.
- Redact credentials, authorization headers, environment secrets, and holder keys.
- Record Jev candidate choices, selected choice, confidence data, and fallback reason.
- Record Tenuo allow and deny decisions without serializing secret key material.
- Link every final report claim to evidence event IDs.

## 17. Error handling

Use typed errors:

```ts
type UpgradeError =
  | AuthorizationError
  | InputValidationError
  | RepositoryError
  | PackageResolutionError
  | ReleaseEvidenceError
  | DecisionEngineError
  | ToolExecutionError
  | VerificationError
  | ApprovalRequiredError;
```

Rules:

- Authorization denial is not retried with broader authority.
- Jev transport failure may be retried once, then uses deterministic fallback.
- A timed-out process is terminated and recorded as failed.
- Network retries use bounded exponential backoff only for retryable responses.
- A stale file hash causes replanning, not overwrite.
- Tool implementation exceptions are normalized and must not leak secrets.
- The graph has maximum worker-attempt and total-step limits.

## 18. Configuration

Validate configuration at startup:

```ts
export interface RuntimeConfig {
  typesafeApiKey: string;
  tenuoRootPublicKey: string;
  tenuoRunWarrant: string;
  tenuoRunHolderSecret: string;
  githubToken?: string;
  jevConfidenceThreshold: number;
  maxGraphSteps: number;
  maxWorkerAttempts: number;
  maxCommandOutputBytes: number;
  commandTimeoutMs: number;
  artifactDirectory: string;
}
```

Secrets must be passed through runtime configuration and never graph state, prompts, logs, reports, patches, or CI files.

## 19. Implementation breakdown

### A. Domain and validation

- Define Zod schemas and TypeScript types for requests, graph state, evidence, findings, checks, routes, and final results.
- Implement path, package-name, exact-version, and command validation.
- Implement deterministic final result classification.

### B. Repository isolation and inspection

- Implement run-specific Git worktree creation.
- Detect package manager, workspaces, manifests, lockfile, scripts, CI, and default branch.
- Resolve the requested dependency and baseline command plan.

### C. Protected tools

- Implement file tools with canonical-path and symlink checks.
- Implement typed package and verification commands without a shell.
- Implement release retrieval with SSRF protections.
- Implement restricted Git and GitHub operations.
- Add artifact capture and hashing.

### D. Tenuo integration

- Initialize development and production Tenuo clients.
- Wrap every side-effecting tool.
- Define worker capability profiles.
- Implement child-session delegation and short-lived session registry.
- Emit authorization audit events.
- Add negative authorization tests for every worker profile.

### E. Jev integration

- Implement `DecisionEngine` and official SDK adapter.
- Define bounded routing and semantic assessment questions.
- Validate all Jev responses.
- Implement confidence handling, retry, and deterministic fallback.
- Add a fake deterministic decision engine for tests.

### F. LangGraph orchestration

- Define typed graph state and reducers.
- Implement nodes and transition eligibility predicates.
- Add Jev-backed conditional routing.
- Inject a worker-specific Tenuo child session at each node boundary.
- Enforce attempt limits and terminal conditions.
- Ensure checkpoint serialization contains no secrets or live session objects.

### G. Specialist workers

- Implement inspector and baseline verifier.
- Implement cited release researcher and usage scanner.
- Implement test-sufficiency assessor and test author.
- Implement dependency and code migration worker.
- Implement restricted CI author.
- Implement clean independent verifier.
- Implement approval-gated draft PR publisher.

### H. Reporting

- Implement append-only audit events.
- Generate machine-readable and Markdown reports.
- Link findings, changes, test results, commands, and release evidence.
- Include residual uncertainty and prohibited-action checks.

### I. Fixture and end-to-end path

- Create a small TypeScript application pinned to an older dependency version.
- Include at least two affected API usages.
- Include incomplete test coverage.
- Omit CI or include CI missing required checks.
- Select a real target release requiring a code migration.
- Run the full workflow through clean verification.
- Optionally exercise draft PR creation against a disposable repository.

## 20. Test requirements

### 20.1 Unit tests

- Schema validation and invalid input rejection.
- Path traversal and symlink escape rejection.
- Package command argument construction.
- Package script rejection.
- Graph transition eligibility.
- Jev response validation and fallback.
- Final result classification.
- Evidence hashing and secret redaction.
- File optimistic-concurrency behavior.

### 20.2 Authorization tests

For each worker, test at least one allowed and one denied capability. Also test argument constraints, including:

- path outside the worktree;
- writing a production file with the test tool;
- updating a package other than the requested package;
- running a command kind absent from the worker profile;
- writing outside `.github/workflows` with the CI tool;
- attempting a non-draft PR;
- pushing the default branch.

Assert that denied operations do not invoke the underlying side effect.

### 20.3 Graph tests

- Successful route from inspection to verified result.
- Existing tests sufficient, so test author is skipped.
- Tests insufficient, so test author runs before implementer.
- Implementation failure routes back to implementer.
- Verification reveals missing coverage and routes to test author.
- CI missing and routes to CI author.
- Low-confidence Jev decision uses deterministic fallback.
- Invalid Jev choice is rejected.
- Repeated failure reaches attempt limit and finalizes.
- No secret value appears in serialized graph checkpoints.

### 20.4 End-to-end tests

- Full real fixture upgrade reaches `verified`.
- Regression test fails before the migration and passes after it.
- Independent verifier starts from a clean worktree.
- Generated CI executes the same checks as local verification.
- Unauthorized cross-role file write is denied.
- Missing release evidence produces `indeterminate`, not `verified`.
- Required baseline failure produces `blocked` or explicitly configured `partial`.
- Draft PR publishing pauses at `human_required` without approval.

## 21. Acceptance criteria

The implementation is complete when all of the following are demonstrated by automated tests or a reproducible fixture run:

1. The CLI accepts a repository, package, and exact target version.
2. The original checkout remains unchanged.
3. The system retrieves and cites authoritative release information.
4. It locates affected usage and records structured migration findings.
5. Jev selects only from dynamically eligible, allowlisted actions, each mapped to a worker in trusted code.
6. LangGraph persists the workflow and routes until a terminal result.
7. Tenuo creates a narrower child session for every selected worker.
8. Cross-role actions are denied before execution.
9. Missing verification causes focused tests to be created.
10. The test author cannot modify production code.
11. The implementer cannot modify tests or CI.
12. The verifier has no repository write capability.
13. The target dependency, application code, and lockfile are updated consistently.
14. Clean install, tests, typecheck, lint, and build run as applicable.
15. CI is present and contains no deploy, publish, secret, or write permissions.
16. The final status is produced by deterministic predicates.
17. Every material final claim is linked to evidence.
18. Draft PR creation requires explicit approval and always creates a draft.

## 22. Required final output

Each run produces:

```text
artifacts/<run-id>/
  request.json
  repository-facts.json
  release-evidence.json
  findings.json
  route-history.json
  authorization-events.jsonl
  audit.jsonl
  checks/
    baseline/*.json
    focused/*.json
    final/*.json
  patch.diff
  report.json
  report.md
```

`report.md` must include:

- requested and resolved versions;
- source release documents;
- affected usages;
- tests added and what they prove;
- production changes;
- CI changes;
- commands executed and outcomes;
- authorization denials, if any;
- residual uncertainty;
- final status;
- draft pull request URL when created.
