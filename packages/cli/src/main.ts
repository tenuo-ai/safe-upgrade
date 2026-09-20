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
import { renderReport, runUpgrade, type RunOptions, type RunReport } from "@safe-upgrade/runner";
import { parseArguments, UsageError, wantsHelp, wantsVersion, type ParsedArguments } from "./arguments.ts";
import { chooseAuthorization } from "./authorization.ts";
import { HELP, VERSION } from "./help.ts";

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
  readonly internal: number;
} = {
  verified: 0,
  partial: 2,
  human_required: 3,
  blocked: 4,
  indeterminate: 5,
  usage: 64,
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

  let report: RunReport;
  try {
    report = await runUpgrade(options);
  } catch (error) {
    // A run that could not start is not a verdict on the upgrade, so it does not borrow one
    // of the status codes.
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
  const token = streams.env["GITHUB_TOKEN"] ?? streams.env["GH_TOKEN"];
  const wantsGitHub = parsed.githubRepository !== undefined;
  if (wantsGitHub && (token === undefined || token === "")) {
    throw new UsageError(
      "--github-repository needs GITHUB_TOKEN in the environment. It is not accepted as a flag.",
    );
  }
  if (parsed.publishApproved && !wantsGitHub) {
    throw new UsageError("--publish needs --github-repository, naming where the draft goes");
  }

  return {
    repositoryPath: parsed.repositoryPath,
    packageName: parsed.packageName,
    targetVersion: parsed.targetVersion,
    runId,
    // Defaulted rather than optional: a run that wrote no record is one nobody can check,
    // and the spec's artifact layout is `artifacts/<run-id>`.
    artifactsDirectory: parsed.artifactsDirectory ?? join(process.cwd(), "artifacts", runId),
    approvals: parsed.approvals,
    publishApproved: parsed.publishApproved,
    createDraftPullRequest: parsed.createDraftPullRequest,
    allowTransitive: parsed.allowTransitive,
    partialAllowed: parsed.partialAllowed,
    ...(wantsGitHub && token !== undefined && parsed.githubRepository !== undefined
      ? { github: { repository: parsed.githubRepository, token } }
      : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
