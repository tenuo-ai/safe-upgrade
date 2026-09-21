/**
 * The command line entry point, spec criterion 1.
 *
 * Thin on purpose. Everything a person can say on a command line becomes `RunOptions`, and
 * everything the run concludes becomes an exit code and a report; nothing here decides
 * anything about the upgrade itself.
 *
 * The exit code is the part worth being careful about, because it is what a pipeline reads.
 * A run that needs an approval and a run that failed are not the same event, and collapsing
 * both into 1 would mean the only safe reaction to a non-zero exit is to ignore it.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RunStatus } from "@safe-upgrade/domain";
import {
  formatProgress,
  renderReport,
  runUpgrade,
  type RunOptions,
  type RunReport,
} from "@safe-upgrade/runner";
import { parseArguments, UsageError, wantsHelp, wantsVersion, type ParsedArguments } from "./arguments.ts";
import { readPullRequestEvent } from "./event.ts";
import { chooseAuthorization } from "./authorization.ts";
import { DeterministicEngine, JevDecisionEngine } from "@safe-upgrade/jev";
import { PackageResolutionError, RepositoryError } from "@safe-upgrade/domain";
import { HELP, VERSION } from "./help.ts";
import { OpenAIPatchGenerator } from "@safe-upgrade/workers";

export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Exit codes.
 *
 * Distinct per status so that a pipeline can tell "this needs a person" from "this failed",
 * and 64/70 from sysexits for the two kinds of not-even-a-run.
 */
export const EXIT: Readonly<Record<RunStatus, number>> & {
  readonly usage: number;
  readonly unusable: number;
  readonly internal: number;
} = {
  verified: 0,
  partial: 2,
  human_required: 3,
  blocked: 4,
  indeterminate: 5,
  usage: 64,
  // The repository cannot be run against: no lockfile, the package is not a dependency, a
  // version that cannot be resolved. Separate from 70 because it is not a defect in this tool
  // and there is something the caller can do about it.
  unusable: 65,
  internal: 70,
};

export async function main(argv: readonly string[], streams: Streams): Promise<number> {
  if (wantsVersion(argv)) {
    streams.out(`${VERSION}\n`);
    return 0;
  }
  if (wantsHelp(argv)) {
    streams.out(HELP);
    return 0;
  }

  const choice = chooseAuthorization(streams.env);
  if (choice.refusal !== undefined) {
    streams.err(`safe-upgrade: ${choice.refusal}\n`);
    return EXIT.usage;
  }

  let parsed: ParsedArguments;
  let options: RunOptions;
  try {
    parsed = parseArguments(argv);
    options = toRunOptions(parsed, parsed.runId ?? randomUUID(), streams);
    if (choice.authorization !== undefined) {
      options = { ...options, authorization: choice.authorization };
    }
  } catch (error) {
    if (error instanceof UsageError) {
      streams.err(`safe-upgrade: ${error.message}\n`);
      return EXIT.usage;
    }
    throw error;
  }

  if (choice.warning !== undefined) {
    // Before the run, not after: it changes how the result should be read.
    streams.err(`safe-upgrade: ${choice.warning}\n`);
  }
  if (streams.env["SAFE_UPGRADE_ALLOW_UNSANDBOXED"] === "1") {
    streams.err(
      "safe-upgrade: WARNING: OS process isolation is disabled. Use SAFE_UPGRADE_ALLOW_UNSANDBOXED=1 only inside isolated test infrastructure.\n",
    );
  }

  let report: RunReport;
  try {
    report = await runUpgrade({
      ...options,
      // To stderr, because stdout carries the report and is routinely piped into something that
      // parses it. A reader watching the terminal sees both; `--format json | jq` sees neither
      // this nor the summary line that already went there.
      ...(parsed.quiet
        ? {}
        : { onProgress: (event) => streams.err(`  ${formatProgress(event)}\n`) }),
    });
  } catch (error) {
    // A run that could not start is not a verdict on the upgrade, so it does not borrow one
    // of the status codes.
    if (isPrecondition(error)) {
      streams.err(`safe-upgrade: this repository cannot be upgraded by this run: ${messageOf(error)}\n`);
      return EXIT.unusable;
    }
    streams.err(`safe-upgrade: the run could not complete: ${messageOf(error)}\n`);
    return EXIT.internal;
  }

  streams.out(format(report, parsed.format));
  streams.err(`${summarize(report)}\n`);
  return exitCodeFor(report, parsed.partialAllowed);
}

export function exitCodeFor(report: RunReport, partialAllowed: boolean): number {
  const status = report.result.status;
  if (status === "partial" && partialAllowed) {
    // Asking for partial means accepting it, so it is not an error to have got one.
    return 0;
  }
  return EXIT[status];
}

/** One line for a person watching, separate from the report so it survives a pipe. */
export function summarize(report: RunReport): string {
  const { request, result } = report;
  const head = `${result.status}: ${request.packageName} ${request.targetVersion}`;
  const where =
    report.artifactsDirectory === undefined ? "" : `, artifacts in ${report.artifactsDirectory}`;
  const first = result.reasons[0];
  return first === undefined ? `${head}${where}` : `${head}${where}\n  ${first}`;
}

function format(report: RunReport, shape: "markdown" | "json"): string {
  return shape === "json" ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}\n`;
}

function toRunOptions(
  parsed: ParsedArguments,
  runId: string,
  streams: Streams,
): RunOptions {
  const event = parsed.fromEvent ? readPullRequestEvent(streams.env) : undefined;
  const packageName = parsed.packageName ?? event?.packageName;
  const targetVersion = parsed.targetVersion ?? event?.targetVersion;
  if (packageName === undefined || targetVersion === undefined) {
    throw new UsageError("name the package to upgrade, as name@version");
  }
  const companions = parsed.companions.length > 0 ? parsed.companions : (event?.companions ?? []);
  const workspace = parsed.workspace ?? event?.workspace;

  const commentPullRequest = parsed.commentPullRequest ?? event?.pullRequestNumber;
  const wantsGitHub = parsed.createDraftPullRequest || commentPullRequest !== undefined;
  const githubRepository = wantsGitHub
    ? (parsed.githubRepository ?? event?.repository ?? streams.env["GITHUB_REPOSITORY"])
    : parsed.githubRepository;
  const token = streams.env["GITHUB_TOKEN"] ?? streams.env["GH_TOKEN"];
  if (wantsGitHub && (githubRepository === undefined || githubRepository === "")) {
    throw new UsageError(
      "--draft-pr and --comment-pr need --github-repository (or GITHUB_REPOSITORY), naming where the draft or comment goes",
    );
  }
  if (wantsGitHub && (token === undefined || token === "")) {
    throw new UsageError(
      "talking to GitHub needs GITHUB_TOKEN in the environment. It is not accepted as a flag.",
    );
  }

  const openAiKey = streams.env["OPENAI_API_KEY"];
  if (parsed.patchModel !== undefined && (openAiKey === undefined || openAiKey === "")) {
    throw new UsageError(
      "--patch-model needs OPENAI_API_KEY in the environment. It is not accepted as a flag.",
    );
  }

  return {
    engine: buildEngine(parsed, streams),
    ...(parsed.patchModel === undefined || openAiKey === undefined
      ? {}
      : { patchGenerator: new OpenAIPatchGenerator({ apiKey: openAiKey, model: parsed.patchModel }) }),
    ...(parsed.confidenceThreshold === undefined
      ? {}
      : { router: { confidenceThreshold: parsed.confidenceThreshold } }),
    repositoryPath: parsed.repositoryPath,
    packageName,
    targetVersion,
    companions,
    ...(workspace === undefined || workspace === "" ? {} : { workspace }),
    runId,
    // Defaulted rather than optional: a run that wrote no record is one nobody can check,
    // and the spec's artifact layout is `artifacts/<run-id>`.
    artifactsDirectory: parsed.artifactsDirectory ?? join(process.cwd(), "artifacts", runId),
    approvals: parsed.approvals,
    publishApproved: parsed.publishApproved,
    createDraftPullRequest: parsed.createDraftPullRequest,
    ...(commentPullRequest === undefined ? {} : { commentPullRequest }),
    allowTransitive: parsed.allowTransitive,
    partialAllowed: parsed.partialAllowed,
    ...(wantsGitHub && token !== undefined && githubRepository !== undefined
      ? { github: { repository: githubRepository, token } }
      : {}),
  };
}

/**
 * Who chooses the next step.
 *
 * The deterministic engine is the default, and it is a supported configuration rather than a
 * placeholder: with it, the route is a pure function of run state, which is the more
 * defensible position for anything automated. Asking for `jev` is asking for a judgement, so
 * it is explicit, and the key comes from the environment.
 */
function buildEngine(parsed: ParsedArguments, streams: Streams) {
  if (parsed.engine === "deterministic") {
    return new DeterministicEngine();
  }
  if ((streams.env["TYPESAFE_API_KEY"] ?? "") === "") {
    throw new UsageError(
      "--engine jev needs TYPESAFE_API_KEY in the environment. It is not accepted as a flag.",
    );
  }
  return new JevDecisionEngine();
}

/**
 * Whether the repository, rather than this tool, is why the run did not start.
 *
 * The distinction is the whole point of a separate code: a missing lockfile is something the
 * caller fixes in a minute, and reporting it as an internal error sends them to read a stack
 * trace looking for a bug that is not there.
 */
function isPrecondition(error: unknown): boolean {
  return error instanceof PackageResolutionError || error instanceof RepositoryError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
