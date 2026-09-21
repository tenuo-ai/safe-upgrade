/**
 * Provider-neutral contract for repository-specific migrations.
 *
 * A coding model proposes complete file contents. It receives no tool handle,
 * shell, filesystem object, warrant, or credential. The worker validates the
 * proposal and applies it through its own Tenuo-scoped write tools.
 */

import {
  modelPatchProposalSchema,
  modelPatchProposalJsonSchema,
  parseOrThrow,
  type CheckPurpose,
  type MigrationFinding,
  type ModelPatchProposal,
  type ReleaseEvidence,
  type TestFramework,
  ToolExecutionError,
} from "@safe-upgrade/domain";

export interface PatchFileSnapshot {
  readonly path: string;
  readonly hash: string;
  readonly content: string;
}

export interface PatchGenerationRequest {
  readonly kind: "source" | "tests";
  readonly packageName: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly findings: readonly MigrationFinding[];
  readonly evidence: readonly Pick<ReleaseEvidence, "id" | "sourceType" | "relevantExtract">[];
  /** The complete and exclusive set of existing files the proposal may modify. */
  readonly editableFiles: readonly PatchFileSnapshot[];
  /** Existing read-only context that may explain how an editable file is used. */
  readonly contextFiles: readonly PatchFileSnapshot[];
  readonly testFramework?: TestFramework;
  readonly previousChecks: readonly {
    readonly purpose: CheckPurpose;
    readonly outcome: "passed" | "failed" | "timed_out" | "not_run";
  }[];
}

export interface PatchGenerator {
  propose(request: PatchGenerationRequest): Promise<unknown>;
}

/**
 * The small structural surface used from a LangChain chat model.
 *
 * Keeping this interface local lets callers use any provider implementing
 * `withStructuredOutput` without making workers depend on that provider SDK.
 */
export interface LangChainStructuredModel {
  withStructuredOutput(
    schema: unknown,
    options: { readonly name: string },
  ): { invoke(input: string): Promise<unknown> };
}

export class LangChainPatchGenerator implements PatchGenerator {
  private readonly model: LangChainStructuredModel;

  constructor(model: LangChainStructuredModel) {
    this.model = model;
  }

  async propose(request: PatchGenerationRequest): Promise<ModelPatchProposal> {
    const runnable = this.model.withStructuredOutput(modelPatchProposalSchema, {
      name: request.kind === "source" ? "propose_source_migration" : "propose_regression_tests",
    });
    const raw = await runnable.invoke(promptFor(request));
    return parseOrThrow(modelPatchProposalSchema, raw, "coding model patch proposal");
  }
}

export interface OpenAIPatchGeneratorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * A narrow Responses API adapter for the CLI.
 *
 * It sends only the bounded request assembled by a worker and asks for one
 * structured patch proposal. It enables no model tools and stores no response.
 */
export class OpenAIPatchGenerator implements PatchGenerator {
  private readonly options: OpenAIPatchGeneratorOptions;
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: OpenAIPatchGeneratorOptions) {
    if (options.apiKey === "") {
      throw new Error("OpenAI API key must not be empty");
    }
    if (options.model === "") {
      throw new Error("OpenAI patch model must not be empty");
    }
    this.options = options;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async propose(request: PatchGenerationRequest): Promise<ModelPatchProposal> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          instructions: "Return one bounded repository patch proposal. Do not call tools or describe changes outside the schema.",
          input: promptFor(request),
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: request.kind === "source" ? "source_migration_patch" : "regression_test_patch",
              strict: true,
              schema: modelPatchProposalJsonSchema,
            },
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new ToolExecutionError("coding model request failed", { cause: error });
    }

    if (!response.ok) {
      throw new ToolExecutionError(`coding model request returned HTTP ${String(response.status)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ToolExecutionError("coding model returned an unreadable response", { cause: error });
    }

    const text = responseText(body);
    let proposal: unknown;
    try {
      proposal = JSON.parse(text);
    } catch (error) {
      throw new ToolExecutionError("coding model returned invalid structured JSON", { cause: error });
    }
    return validatePatchProposal(proposal);
  }
}

function responseText(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new ToolExecutionError("coding model response did not contain output text");
  }
  const response = value as {
    readonly output_text?: unknown;
    readonly output?: readonly {
      readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
    }[];
  };
  if (typeof response.output_text === "string" && response.output_text !== "") {
    return response.output_text;
  }
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string" && content.text !== "") {
        return content.text;
      }
    }
  }
  throw new ToolExecutionError("coding model response did not contain output text");
}

function promptFor(request: PatchGenerationRequest): string {
  const task = request.kind === "source"
    ? "Propose the smallest production-source migration that addresses every finding."
    : "Propose focused behavioral tests that fail before the required migration and pass after it.";

  return [
    "You are preparing one bounded dependency-upgrade patch.",
    task,
    "Return complete file contents through the supplied structured schema.",
    "Only modify paths listed in editableFiles. Test proposals may also create a new conventional test path by using expectedBeforeHash 'absent'.",
    "Preserve unrelated behavior. Do not propose commands, dependency changes, manifests, lockfiles, CI files, generated output, or credentials.",
    "Every change and addressedFindingId must refer to a finding in this request.",
    JSON.stringify(request),
  ].join("\n\n");
}

export function validatePatchProposal(value: unknown): ModelPatchProposal {
  return parseOrThrow(modelPatchProposalSchema, value, "coding model patch proposal");
}

export interface PatchScope {
  readonly existingFiles: ReadonlyMap<string, string>;
  readonly requiredFindingIds: ReadonlySet<string>;
  readonly allowCreate: (path: string) => boolean;
  /** Optional source-file scope for each finding. */
  readonly allowedPathsByFinding?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Validate model claims against facts selected by trusted worker code. */
export function validatePatchScope(value: unknown, scope: PatchScope): ModelPatchProposal {
  const proposal = validatePatchProposal(value);
  const seen = new Set<string>();
  const claimed = new Set<string>();

  for (const id of proposal.addressedFindingIds) {
    if (!scope.requiredFindingIds.has(id)) {
      throw new ToolExecutionError(`coding model claimed an unknown finding: ${id}`);
    }
    if (claimed.has(id)) {
      throw new ToolExecutionError(`coding model claimed a finding more than once: ${id}`);
    }
    claimed.add(id);
  }
  for (const id of scope.requiredFindingIds) {
    if (!proposal.addressedFindingIds.includes(id)) {
      throw new ToolExecutionError(`coding model did not address required finding: ${id}`);
    }
  }

  for (const change of proposal.changes) {
    if (seen.has(change.path)) {
      throw new ToolExecutionError(`coding model proposed ${change.path} more than once`);
    }
    seen.add(change.path);

    const expected = scope.existingFiles.get(change.path);
    if (expected === undefined) {
      if (change.expectedBeforeHash !== "absent" || !scope.allowCreate(change.path)) {
        throw new ToolExecutionError(`coding model proposed a path outside its patch scope: ${change.path}`);
      }
    } else if (change.expectedBeforeHash !== expected) {
      throw new ToolExecutionError(`coding model used a stale or invented hash for ${change.path}`);
    }

    for (const id of change.findingIds) {
      if (!scope.requiredFindingIds.has(id)) {
        throw new ToolExecutionError(`coding model linked ${change.path} to an unknown finding: ${id}`);
      }
      const allowedPaths = scope.allowedPathsByFinding?.get(id);
      if (allowedPaths !== undefined && !allowedPaths.has(change.path)) {
        throw new ToolExecutionError(
          `coding model linked ${change.path} to finding ${id}, which did not identify that file`,
        );
      }
    }
  }

  const linked = new Set(proposal.changes.flatMap((change) => change.findingIds));
  for (const id of scope.requiredFindingIds) {
    if (!linked.has(id)) {
      throw new ToolExecutionError(`coding model did not link any file change to required finding: ${id}`);
    }
  }

  return proposal;
}
