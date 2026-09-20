/**
 * CI author, spec 13.5.
 *
 * Answers one question: if this change merged, would CI re-run the checks that just
 * passed locally? A green local run whose gates do not exist in CI proves something
 * about one machine at one moment.
 *
 * It adds a workflow rather than editing one. Editing means text surgery on the file
 * that decides what gates a merge, and a bad edit there is both easy to make and
 * hard to see: a step silently dropped from `ci.yml` removes a gate while leaving a
 * green tick. Adding a file cannot damage what is already there, and whether to fold
 * the new steps into an existing workflow is a reviewer's call, not this worker's.
 *
 * Its only write capability is `write_ci_file`, which the ceiling bounds to
 * `.github/workflows`. It cannot touch source, tests, or the manifest.
 */

import type { CheckPurpose, CiAssessment, FileChange, PackageManager } from "@safe-upgrade/domain";
import type { UpgradeStateUpdate, WorkerFn, WorkerInput } from "@safe-upgrade/graph";
import { inWorktree, type RunContext } from "./context.ts";
import { checkOrder } from "./checks.ts";

/**
 * The Node version the generated workflow pins.
 *
 * Fixed rather than derived from the repository, because the question this answers is
 * whether the upgraded dependency's requirement is met, and an active LTS is the
 * least surprising answer that satisfies any floor a package is likely to state.
 */
const WORKFLOW_NODE_MAJOR = 22;

const WORKFLOW_FILE = "safe-upgrade-checks.yml";

export function createCiAuthor(context: RunContext): WorkerFn {
  return async (input: WorkerInput): Promise<UpgradeStateUpdate> => {
    const required = requiredPurposes(context);
    const existing = await readWorkflows(input, context);
    const covered = coveredPurposes(existing, context.facts.packageManager);
    const missing = required.filter((purpose) => !covered.has(purpose));

    if (missing.length === 0) {
      const assessment: CiAssessment = { sufficient: true, missingChecks: [] };
      recordAssessment(input, assessment, existing, []);
      return { ciAssessment: assessment };
    }

    const path = inWorktree(context, ".github", "workflows", WORKFLOW_FILE);
    const existingWorkflow = existing.find((workflow) => workflow.path.endsWith(WORKFLOW_FILE));
    const written = await input.handle.tools.write_ci_file({
      path,
      // A previous round may have written this file. Its hash rather than `absent`,
      // so a concurrent change is a refusal instead of an overwrite.
      expectedBeforeHash: existingWorkflow?.hash ?? "absent",
      content: workflowFor(context, required),
    });

    // Re-assessed from what is now on disk rather than assumed, so the claim that CI
    // covers these checks is made against the file that will run them.
    const after = await readWorkflows(input, context);
    const stillMissing = required.filter(
      (purpose) => !coveredPurposes(after, context.facts.packageManager).has(purpose),
    );
    const assessment: CiAssessment = {
      sufficient: stillMissing.length === 0,
      selectedWorkflow: `.github/workflows/${WORKFLOW_FILE}`,
      missingChecks: stillMissing,
    };

    const changes: FileChange[] = [
      {
        path: `.github/workflows/${WORKFLOW_FILE}`,
        beforeHash: written.beforeHash,
        afterHash: written.afterHash,
        owner: "ci_author",
        reason: `CI did not run ${missing.join(", ")}, so the checks this upgrade was verified against now run there too`,
      },
    ];
    recordAssessment(input, assessment, existing, missing);

    return {
      ciAssessment: assessment,
      fileChanges: changes,
      // The raised Node floor is discharged here or nowhere: there is no edit that
      // addresses it, only a statement of which version CI runs. Claimed only when
      // the pinned version actually satisfies the floor the researcher found.
      addressedFindingIds: nodeFindingsSatisfied(input),
    };
  };
}

function recordAssessment(
  input: WorkerInput,
  assessment: CiAssessment,
  existing: readonly Workflow[],
  missing: readonly CheckPurpose[],
): void {
  input.audit.record({
    phase: "configure_ci",
    worker: "ci_author",
    type: "ci_assessment_recorded",
    payload: {
      sufficient: assessment.sufficient,
      missingChecks: assessment.missingChecks,
      wasMissing: missing,
      inspectedWorkflows: existing.map((workflow) => workflow.path),
      pinnedNodeMajor: WORKFLOW_NODE_MAJOR,
    },
  });
}

/** Install always counts, plus every check the repository actually defines. */
function requiredPurposes(context: RunContext): readonly CheckPurpose[] {
  return ["install", ...checkOrder(context.checkScripts).map(({ purpose }) => purpose)];
}

interface Workflow {
  readonly path: string;
  readonly hash: string;
  readonly content: string;
}

async function readWorkflows(input: WorkerInput, context: RunContext): Promise<readonly Workflow[]> {
  const listed = await input.handle.tools.list_files({
    root: inWorktree(context, ".github", "workflows"),
    glob: "**/*",
  }).catch(() => []);

  const workflows: Workflow[] = [];
  for (const path of listed.filter((file) => /\.ya?ml$/.test(file))) {
    const file = await input.handle.tools.read_file({ path });
    workflows.push({ path: relativize(path, context.facts.worktreePath), hash: file.hash, content: file.content });
  }
  return workflows;
}

/**
 * Which checks an existing workflow already runs.
 *
 * Decided from `run:` lines, because a `run:` line is the only place a check
 * executes. This cannot see a check reached indirectly — a `run: npm run ci` whose
 * script happens to invoke the build is not recognised — and the bias is deliberate:
 * an unrecognised check is reported as missing, so the failure mode is a workflow
 * that runs the build twice rather than a gap reported as covered. Wasted CI minutes
 * are recoverable; a missing gate reported as present is not.
 */
export function coveredPurposes(
  workflows: readonly Workflow[],
  packageManager: PackageManager,
): ReadonlySet<CheckPurpose> {
  const covered = new Set<CheckPurpose>();
  for (const workflow of workflows) {
    for (const line of runLines(workflow.content)) {
      for (const purpose of ["install", "test", "typecheck", "lint", "build"] as const) {
        if (lineRuns(line, purpose, packageManager)) {
          covered.add(purpose);
        }
      }
    }
  }
  return covered;
}

/** The command part of every `run:` step, including continuation lines of a block. */
function runLines(content: string): readonly string[] {
  const lines: string[] = [];
  let blockIndent: number | null = null;

  for (const raw of content.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent !== null) {
      if (raw.trim().length === 0) {
        continue;
      }
      if (indent > blockIndent) {
        lines.push(raw.trim());
        continue;
      }
      blockIndent = null;
    }
    const inline = /^\s*-?\s*run:\s*(.*)$/.exec(raw);
    if (inline === null) {
      continue;
    }
    const value = (inline[1] ?? "").trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      blockIndent = indent;
      continue;
    }
    lines.push(value);
  }
  return lines;
}

function lineRuns(line: string, purpose: CheckPurpose, packageManager: PackageManager): boolean {
  if (purpose === "install") {
    return new RegExp(String.raw`\b${packageManager}\s+(?:ci|install)\b`).test(line);
  }
  // `npm test` and `npm run test` are the same thing; `npm run build` has no short
  // form. Word-bounded so `npm run test:unit` does not count as the `test` script.
  return new RegExp(String.raw`\b${packageManager}\s+(?:run\s+)?${purpose}(?![\w:.-])`).test(line);
}

/**
 * Findings about a raised Node floor that the pinned version satisfies.
 *
 * A finding is only claimed when the floor could be read and is met. An unparseable
 * range leaves the finding unaddressed and the run short of `verified`, which is the
 * correct outcome: nobody has established that CI runs a version the package accepts.
 */
function nodeFindingsSatisfied(input: WorkerInput): readonly string[] {
  return input.state.findings
    .filter((finding) => finding.id === "node-requirement-raised")
    .filter((finding) => {
      const floor = minimumMajor(finding.releaseClaim);
      return floor !== null && WORKFLOW_NODE_MAJOR >= floor;
    })
    .map((finding) => finding.id);
}

/** The largest lower bound stated anywhere in a range, as a major version. */
export function minimumMajor(range: string): number | null {
  const bounds = [...range.matchAll(/>=?\s*(\d+)|\^\s*(\d+)|~\s*(\d+)/g)].map((match) =>
    Number.parseInt(match[1] ?? match[2] ?? match[3] ?? "", 10),
  );
  const valid = bounds.filter((bound) => Number.isInteger(bound));
  return valid.length === 0 ? null : Math.max(...valid);
}

/** Install command per package manager, frozen and with lifecycle scripts off. */
function installSteps(packageManager: PackageManager): readonly string[] {
  switch (packageManager) {
    case "pnpm":
      return [
        "      - uses: pnpm/action-setup@v4",
        "      - run: pnpm install --frozen-lockfile --ignore-scripts",
      ];
    case "yarn":
      return ["      - run: yarn install --immutable"];
    default:
      return ["      - run: npm ci --ignore-scripts"];
  }
}

export function workflowFor(context: RunContext, required: readonly CheckPurpose[]): string {
  const { packageManager } = context.facts;
  const checks = required
    .filter((purpose) => purpose !== "install")
    .map((purpose) => `      - run: ${packageManager} run ${purpose}`);

  return [
    `# Added by a safe-upgrade run for ${context.request.packageName} ${context.request.targetVersion}.`,
    "#",
    "# Runs the same checks the upgrade was verified against, so the gates that passed",
    "# locally also gate a merge. Node is pinned because the upgraded dependency states",
    "# a minimum, and a workflow on an older runtime would pass here and fail for users.",
    "#",
    "# A separate workflow rather than an edit to an existing one: adding a file cannot",
    "# remove a gate by accident. Folding these steps into another workflow is a",
    "# reviewer's decision.",
    "name: safe-upgrade checks",
    "",
    "on:",
    "  push:",
    "  pull_request:",
    "",
    "jobs:",
    "  checks:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    `          node-version: "${String(WORKFLOW_NODE_MAJOR)}"`,
    ...installSteps(packageManager),
    ...checks,
    "",
  ].join("\n");
}

function relativize(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
