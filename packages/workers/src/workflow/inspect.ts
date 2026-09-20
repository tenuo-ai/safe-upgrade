/**
 * Static validation of CI workflows, spec 14.9 and acceptance criterion 15.
 *
 * Two different questions, which is why the caller says which one it is asking.
 *
 * For the workflow this run *writes*, the standard is absolute: spec 13.6 says grant
 * `contents: read`, request no secrets, and add no deploy, release, publish, or write
 * steps, so anything flagged here is a bug in the CI author and the run refuses to write
 * it. A workflow with no `permissions:` block at all counts, because an unstated block
 * means the repository default, which is frequently write.
 *
 * For workflows that were *already there*, the standard is to report rather than refuse.
 * A repository with a deploy workflow is a normal repository, and holding an upgrade
 * hostage to CI hygiene it did not cause would be useless. What matters is narrower: when
 * this run credits an existing workflow with gating a check, a reviewer should know if that
 * gate also holds write permissions or reads secrets, because then triggering the gate is
 * worth more to an attacker than the check is worth to the reviewer.
 *
 * This reads text. YAML has more ways to spell any of this than a regular expression can
 * follow, so it errs towards reporting: a comment that looks like a publish step is
 * reported, and the cost of that is a sentence in a report rather than a wrong claim.
 */

export type WorkflowRiskKind =
  | "write_permission"
  | "permissions_unstated"
  | "secret_read"
  | "deploy_step";

export interface WorkflowRisk {
  readonly path: string;
  readonly kind: WorkflowRiskKind;
  /** Written for a reviewer, naming what was seen rather than the rule that saw it. */
  readonly detail: string;
  /** 1-based, or 0 for a risk that is about the absence of something. */
  readonly line: number;
}

/**
 * Steps that do something other than check the code.
 *
 * Names rather than verbs where possible: `uses: actions/deploy-pages` is unambiguous,
 * where the word "deploy" on its own is a job name as often as an action.
 */
const DEPLOY_MARKERS: readonly { readonly pattern: RegExp; readonly detail: string }[] = [
  { pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/, detail: "publishes a package" },
  { pattern: /\bnpm\s+dist-tag\b/, detail: "moves a published dist-tag" },
  { pattern: /\bdocker\s+(?:push|login)\b/, detail: "pushes or authenticates to a container registry" },
  { pattern: /\bgh\s+release\s+(?:create|upload|edit)\b/, detail: "creates or edits a release" },
  { pattern: /\bgit\s+push\b/, detail: "pushes to a repository" },
  { pattern: /\bterraform\s+apply\b/, detail: "applies infrastructure changes" },
  { pattern: /\bkubectl\s+(?:apply|set|rollout)\b/, detail: "changes a cluster" },
  { pattern: /\baws\s+(?:s3\s+(?:cp|sync)|deploy|cloudformation|lambda)\b/, detail: "changes cloud resources" },
  { pattern: /uses:\s*\S*(?:deploy-pages|actions-gh-pages|semantic-release|changesets\/action)/, detail: "runs a publishing action" },
  { pattern: /uses:\s*\S*upload-pages-artifact/, detail: "prepares a pages deployment" },
];

/** `id-token: write` is how a workflow mints a cloud credential, so it is read as one. */
const WRITE_PERMISSION = /^\s*([a-z-]+)\s*:\s*write\b/;
const WRITE_ALL = /^\s*permissions\s*:\s*write-all\b/;
const PERMISSIONS_BLOCK = /^\s*permissions\s*:/;
const SECRET_REFERENCE = /\$\{\{\s*secrets\.([A-Za-z_][\w-]*)/g;

export interface InspectOptions {
  /**
   * True for a workflow this run wrote. Adds the requirement that permissions be stated,
   * which is only actionable for a file the run controls.
   */
  readonly authored: boolean;
}

export function inspectWorkflow(
  path: string,
  content: string,
  options: InspectOptions,
): readonly WorkflowRisk[] {
  const risks: WorkflowRisk[] = [];
  const lines = content.split("\n");
  let sawPermissions = false;

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    // Comments are stripped for permissions and step matching but the line is still read
    // for secrets: a commented-out secret reference is a template someone will uncomment.
    const code = raw.replace(/#.*$/, "");

    if (PERMISSIONS_BLOCK.test(code)) {
      sawPermissions = true;
    }
    if (WRITE_ALL.test(code)) {
      risks.push({ path, kind: "write_permission", line, detail: "grants write-all" });
    } else {
      const write = WRITE_PERMISSION.exec(code);
      // Only inside a permissions block would `contents: write` mean a permission, but a
      // scope name followed by `write` is not a plausible step either way.
      if (write !== null && write[1] !== undefined && write[1] !== "permissions") {
        risks.push({
          path,
          kind: "write_permission",
          line,
          detail: `grants ${write[1]}: write`,
        });
      }
    }

    for (const match of raw.matchAll(SECRET_REFERENCE)) {
      risks.push({
        path,
        kind: "secret_read",
        line,
        detail: `reads secrets.${match[1] ?? "?"}`,
      });
    }

    for (const marker of DEPLOY_MARKERS) {
      if (marker.pattern.test(code)) {
        risks.push({ path, kind: "deploy_step", line, detail: marker.detail });
      }
    }
  }

  if (options.authored && !sawPermissions) {
    risks.push({
      path,
      kind: "permissions_unstated",
      line: 0,
      detail: "states no permissions, so it inherits the repository default",
    });
  }

  return risks;
}

/** One sentence per workflow, for a report a person reads rather than a machine. */
export function describeRisks(risks: readonly WorkflowRisk[]): readonly string[] {
  const byPath = new Map<string, WorkflowRisk[]>();
  for (const risk of risks) {
    const existing = byPath.get(risk.path);
    if (existing === undefined) {
      byPath.set(risk.path, [risk]);
    } else {
      existing.push(risk);
    }
  }
  return [...byPath.entries()].map(([path, found]) => {
    const details = [...new Set(found.map((risk) => risk.detail))].join(", ");
    return `${path} ${details}`;
  });
}
