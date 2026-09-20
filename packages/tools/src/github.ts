/**
 * GitHub tools.
 *
 * Exactly one write operation exists here, and it can only produce a draft pull
 * request. There is no merge, no review approval, and no way to flip `draft` to
 * false: the argument is checked here and pinned by the publisher's capability,
 * and the request body is built by this file rather than by a caller.
 */

import { ToolExecutionError } from "@safe-upgrade/domain";
import { defineTool, type RawTool, type ToolContext } from "./context.ts";

const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

export type CreateDraftPrArgs = {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  /** Must be true. Pinned by the publisher's capability and re-checked here. */
  readonly draft: boolean;
}

export interface DraftPullRequest {
  readonly url: string;
  readonly number: number;
  readonly draft: boolean;
}

export interface GitHubToolOptions {
  readonly repository: string;
  /** Read from runtime configuration. Never placed in graph state or a prompt. */
  readonly token: string;
  readonly apiBaseUrl?: string;
}

export interface PullRequestComment {
  readonly url: string;
  readonly number: number;
}

/**
 * Leave a comment on an existing pull request.
 *
 * Trusted code after the graph, not a worker tool. A Dependabot pull request is
 * already the review surface; the verdict has to land there for blocked and
 * human_required runs as well as verified ones, and the publisher only runs after
 * verification. The body is composed from the report. The token is the same one
 * used to open a draft, and is never written into the comment.
 */
export async function commentOnPullRequest(
  options: GitHubToolOptions,
  pullNumber: number,
  body: string,
): Promise<PullRequestComment> {
  if (!REPOSITORY.test(options.repository)) {
    throw new ToolExecutionError(`not a valid owner/name repository: ${options.repository}`);
  }
  if (!Number.isInteger(pullNumber) || pullNumber < 1) {
    throw new ToolExecutionError(`not a pull request number: ${String(pullNumber)}`);
  }
  if (body.trim().length === 0) {
    throw new ToolExecutionError("comment body is empty");
  }
  if (body.length > 60_000) {
    throw new ToolExecutionError("comment exceeds the 60000 character limit");
  }

  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const response = await fetch(
    `${apiBaseUrl}/repos/${options.repository}/issues/${String(pullNumber)}/comments`,
    {
      method: "POST",
      headers: githubHeaders(options.token),
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw new ToolExecutionError(`GitHub refused the comment with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { html_url?: unknown; id?: unknown };
  return {
    url: typeof payload.html_url === "string" ? payload.html_url : "",
    number: typeof payload.id === "number" ? payload.id : -1,
  };
}

function githubHeaders(token: string): Readonly<Record<string, string>> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

export function createGitHubTools(
  context: ToolContext,
  options: GitHubToolOptions,
): { readonly createDraftPr: RawTool<CreateDraftPrArgs, DraftPullRequest> } {
  if (!REPOSITORY.test(options.repository)) {
    throw new ToolExecutionError(`not a valid owner/name repository: ${options.repository}`);
  }
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";

  return {
    createDraftPr: defineTool<CreateDraftPrArgs, DraftPullRequest>(
      context,
      "create_draft_pr",
      "Open a draft pull request from the run branch.",
      async (args) => {
        if (args.draft !== true) {
          throw new ToolExecutionError("only draft pull requests may be created");
        }
        if (!REF.test(args.base) || !REF.test(args.head)) {
          throw new ToolExecutionError("base and head must be plain ref names");
        }
        if (args.head !== context.runBranch) {
          throw new ToolExecutionError(`head must be the run branch ${context.runBranch}`);
        }
        if (args.head === args.base) {
          throw new ToolExecutionError("head and base must differ");
        }
        if (args.title.trim().length === 0 || args.title.length > 256) {
          throw new ToolExecutionError("title must be between 1 and 256 characters");
        }
        if (args.body.length > 60_000) {
          throw new ToolExecutionError("body exceeds the 60000 character limit");
        }

        const response = await fetch(`${apiBaseUrl}/repos/${options.repository}/pulls`, {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({
            base: args.base,
            head: args.head,
            title: args.title,
            body: args.body,
            draft: true,
            maintainer_can_modify: false,
          }),
        });

        if (!response.ok) {
          // The status is enough to act on, and the body can quote the token back.
          throw new ToolExecutionError(`GitHub refused the draft pull request with HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { html_url?: unknown; number?: unknown; draft?: unknown };
        if (payload.draft !== true) {
          throw new ToolExecutionError("GitHub reported the created pull request is not a draft");
        }
        return {
          url: typeof payload.html_url === "string" ? payload.html_url : "",
          number: typeof payload.number === "number" ? payload.number : -1,
          draft: true,
        };
      },
    ),
  };
}
