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
import { ABSENT } from "@safe-upgrade/tools";
import { inWorktree, type RunContext } from "./context.ts";
import { checkOrder } from "./checks.ts";
import { describeRisks, inspectWorkflow } from "./workflow/inspect.ts";

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

    const credited = creditedRisks(existing, required, context);

    if (missing.length === 0) {
      const assessment: CiAssessment = { sufficient: true, missingChecks: [] };
      recordAssessment(input, assessment, existing, []);
      return { ciAssessment: assessment, ...(credited.length > 0 ? { ciWorkflowRisks: credited } : {}) };
    }

    const relativePath = `.github/workflows/${WORKFLOW_FILE}`;
    const path = inWorktree(context, ".github", "workflows", WORKFLOW_FILE);
    const existingWorkflow = existing.find((workflow) => workflow.path === relativePath);
    const content = workflowFor(context, required);

    // Checked before it is written, not after. Spec 13.6 requires this workflow to grant
    // `contents: read`, request no secrets, and add no deploy, release, publish, or write
    // steps, and a workflow that failed that would be a hole this run had opened itself.
    // Nothing should ever reach this, which is why it refuses rather than repairs: a
    // template that drifted is a bug to fix in the template.
    const selfRisks = inspectWorkflow(relativePath, content, { authored: true });
    if (selfRisks.length > 0) {
      return {
        blockingConditions: [
          `the workflow this run would add is not safe to add: ${describeRisks(selfRisks).join("; ")}`,
        ],
      };
    }

    const written = await input.handle.tools.write_ci_file({
      path,
      // A previous round may have written this file. Its hash rather than `absent`,
      // so a concurrent change is a refusal instead of an overwrite.
      expectedBeforeHash: existingWorkflow?.hash ?? ABSENT,
      content,
    });

    // Re-assessed from what is now on disk rather than assumed, so the claim that CI
    // covers these checks is made against the file that will run them.
    const after = await readWorkflows(input, context);
    const stillMissing = required.filter(
      (purpose) => !coveredPurposes(after, context.facts.packageManager).has(purpose),
    );
    const assessment: CiAssessment = {
      sufficient: stillMissing.length === 0,
      selectedWorkflow: relativePath,
      missingChecks: stillMissing,
    };

    const changes: FileChange[] = [
      {
        path: relativePath,
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
      ...(credited.length > 0 ? { ciWorkflowRisks: credited } : {}),
      // The raised Node floor is discharged here or nowhere: there is no edit that
      // addresses it, only a statement of which version CI runs. Claimed only when
      // the pinned version actually satisfies the floor the researcher found.
      addressedFindingIds: nodeFindingsSatisfied(input, await declaredNodeEngines(input, context)),
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
/**
 * Risks in the workflows this run credits with gating a check.
 *
 * Scoped to those on purpose. A repository with a deploy workflow is a normal repository,
 * and reporting it here would be reporting on CI hygiene this upgrade did not cause and
 * cannot fix. What is worth a reviewer's attention is narrower: when this run says a check
 * is gated in CI, and that gate also holds write permissions or reads secrets, then
 * triggering the gate is worth more to an attacker than the check is worth to the reviewer.
 *
 * Stated rather than blocking, unlike the workflow this run writes itself.
 */
export function creditedRisks(
  existing: readonly Workflow[],
  required: readonly CheckPurpose[],
  context: RunContext,
): readonly string[] {
  const statements: string[] = [];
  for (const workflow of existing) {
    const covers = coveredPurposes([workflow], context.facts.packageManager);
    if (!required.some((purpose) => covers.has(purpose))) {
      continue;
    }
    const risks = inspectWorkflow(workflow.path, workflow.content, { authored: false });
    for (const statement of describeRisks(risks)) {
      statements.push(
        `${statement}, and this run credits it with gating ${[...covers].sort().join(", ")}`,
      );
    }
  }
  return statements;
}

function requiredPurposes(context: RunContext): readonly CheckPurpose[] {
  return ["install", ...checkOrder(context.checkScripts).map(({ purpose }) => purpose)];
}

export interface Workflow {
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

/**
 * The command part of every `run:` step, including continuation lines of a block.
 *
 * A block scalar's content indent is set by its first line, and every later line has to
 * match it. Anything shallower ends the block — which is how a sibling key of the same
 * step is kept out. Accepting any line merely deeper than the `- run:` line pulled in
 * things like an `env:` mapping that follows, and an environment value mentioning a
 * command would then read as though the step ran it.
 */
function runLines(content: string): readonly string[] {
  const lines: string[] = [];
  let stepIndent: number | null = null;
  let contentIndent: number | null = null;

  for (const raw of content.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    if (stepIndent !== null) {
      if (raw.trim().length === 0) {
        continue;
      }
      if (contentIndent === null && indent > stepIndent) {
        contentIndent = indent;
      }
      if (contentIndent !== null && indent >= contentIndent) {
        lines.push(raw.trim());
        continue;
      }
      stepIndent = null;
      contentIndent = null;
    }
    const inline = /^\s*-?\s*run:\s*(.*)$/.exec(raw);
    if (inline === null) {
      continue;
    }
    const value = (inline[1] ?? "").trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      stepIndent = indent;
      contentIndent = null;
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
 * Findings about a raised Node requirement that this workflow actually discharges.
 *
 * Two things have to hold, and both are checked rather than assumed. The version the
 * workflow pins must satisfy the range the package states, and the repository must not
 * itself advertise support for a version below that range — a package whose `engines`
 * says `>=10` while its dependency needs 12 is still broken for the people installing
 * it, whatever CI runs.
 *
 * Anything this cannot decide leaves the finding unaddressed, and the run falls short
 * of `verified` with that as the stated reason. "We could not tell" and "it is fine"
 * are different answers and only one of them is true.
 */
function nodeFindingsSatisfied(
  input: WorkerInput,
  declaredEngines: string | null,
): readonly string[] {
  return input.state.findings
    .filter((finding) => finding.id === "node-requirement-raised")
    .filter(
      (finding) =>
        finding.requiredNodeRange !== undefined &&
        dischargedByWorkflow(finding.requiredNodeRange, declaredEngines, WORKFLOW_NODE_MAJOR),
    )
    .map((finding) => finding.id);
}

/**
 * Whether pinning `pinnedMajor` in CI settles a raised runtime requirement.
 *
 * Both halves have to hold. The pinned version must satisfy the range the dependency
 * states, and the repository's own `engines.node` must not still admit a version that
 * range rejects — a package declaring `>=10` while its dependency needs 12 is broken for
 * whoever installs it, whatever CI runs.
 *
 * No `engines` field is not a problem: a package that promises nothing has nothing to
 * contradict. A range either side cannot be read is, because then this is a guess.
 */
export function dischargedByWorkflow(
  required: string,
  declaredEngines: string | null,
  pinnedMajor: number,
): boolean {
  if (satisfies(required, pinnedMajor) !== true) {
    return false;
  }
  if (declaredEngines === null) {
    return true;
  }
  const declaredFloor = lowestAdmitted(declaredEngines);
  const requiredFloor = lowestAdmitted(required);
  return declaredFloor !== null && requiredFloor !== null && declaredFloor >= requiredFloor;
}

/** The lowest major version a range admits, or null when that cannot be read. */
export function lowestAdmitted(range: string): number | null {
  const alternatives = range.split("||").map(parseConjunction);
  if (alternatives.some((alternative) => alternative === null)) {
    return null;
  }
  const floors = alternatives.flatMap((alternative) =>
    (alternative ?? []).filter((term) => term.kind === "lower").map((term) => term.major),
  );
  return floors.length === 0 ? null : Math.min(...floors);
}

interface Term {
  readonly kind: "lower" | "upper";
  readonly major: number;
}

/**
 * Whether a pinned major satisfies a range.
 *
 * `true`, `false`, and `null` for "this range is in a form we do not fully understand",
 * which is the answer that matters: the previous version of this took the largest
 * number it could find and ignored upper bounds entirely, so `>=12 <20` read as
 * "12 or above" and Node 22 looked fine.
 *
 * The comparison is at major granularity because `node-version: "22"` resolves to the
 * newest 22.x. That makes lower bounds safe to read loosely — any `>=22.4` is met by
 * the newest 22.x — and forces upper bounds to be read strictly: `<22.5` cannot be
 * relied on, because the version that runs is whatever 22.x is newest.
 */
export function satisfies(range: string, pinnedMajor: number): boolean | null {
  const alternatives = range.split("||").map(parseConjunction);
  if (alternatives.some((alternative) => alternative === null)) {
    return null;
  }
  return alternatives.some((alternative) =>
    (alternative ?? []).every((term) =>
      term.kind === "lower" ? pinnedMajor >= term.major : pinnedMajor < term.major,
    ),
  );
}

const TERM = /^(>=|<=|>|<|\^)\s*v?(\d+)(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * One `||` alternative as a list of bounds, or null if any part is unrecognised.
 *
 * Deliberately short on syntax. `~`, bare versions, `x` ranges and hyphen ranges are
 * all left unrecognised rather than approximated, because an approximation here turns
 * into a claim that a runtime requirement is met.
 */
function parseConjunction(alternative: string): readonly Term[] | null {
  const parts = alternative
    // `>= 18` and `>=18` mean the same thing, and both are written in the wild. Closing
    // the gap before splitting keeps the operator attached to what it bounds.
    .replace(/([<>]=?|[\^~])\s+/g, "$1")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  const terms: Term[] = [];
  for (const part of parts) {
    const match = TERM.exec(part);
    if (match === null) {
      return null;
    }
    const operator = match[1] ?? "";
    const major = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isInteger(major)) {
      return null;
    }
    if (operator === "^") {
      // `^20.1.0` is 20.x and nothing else, which is both a floor and a ceiling.
      terms.push({ kind: "lower", major });
      terms.push({ kind: "upper", major: major + 1 });
      continue;
    }
    terms.push(
      operator === ">" || operator === ">="
        ? { kind: "lower", major }
        : { kind: "upper", major },
    );
  }
  return terms;
}

/** The repository's own declared Node support, if it declares any. */
async function declaredNodeEngines(input: WorkerInput, context: RunContext): Promise<string | null> {
  const manifest = await input.handle.tools
    .read_file({ path: inWorktree(context, "package.json") })
    .catch(() => null);
  if (manifest === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(manifest.content) as { engines?: { node?: unknown } };
    const node = parsed.engines?.node;
    return typeof node === "string" && node.trim().length > 0 ? node : null;
  } catch {
    return null;
  }
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
    "# Stated rather than inherited. A workflow with no permissions block gets the",
    "# repository default, which in many repositories is write, and these steps run the",
    "# repository's own build script. Reading the code is all a check needs.",
    "permissions:",
    "  contents: read",
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
