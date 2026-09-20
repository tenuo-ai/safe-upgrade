/**
 * Turning evidence into findings, without a model.
 *
 * Deliberately not "read the changelog and decide". Retrieved release prose is
 * attacker-reachable text, and a rule that branches on what it says is a rule an
 * attacker can steer. Every finding here is derived from *structured* facts —
 * published manifest fields and call sites in the repository — and the prose only
 * ever appears as a quoted extract attached to evidence.
 *
 * That leaves real judgements undone: whether a paragraph describes a break that
 * affects this caller is a semantic question, and it belongs to the decision
 * engine. When the engine is unavailable these rules still run, and anything they
 * cannot settle is reported as uncertainty rather than as an absence of problems.
 */

import type { MigrationFinding } from "@safe-upgrade/domain";
import type { PublishedShape } from "@safe-upgrade/tools";
import type { Usage } from "./usages.ts";

export interface DerivationInput {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly currentShape: PublishedShape;
  readonly targetShape: PublishedShape;
  readonly usages: readonly Usage[];
  /** Evidence ids for the two registry documents the shapes came from. */
  readonly shapeEvidenceIds: readonly string[];
  /** Evidence ids for any release prose that was retrieved. */
  readonly documentEvidenceIds: readonly string[];
}

export interface Derivation {
  readonly findings: readonly MigrationFinding[];
  readonly uncertainty: readonly string[];
}

/**
 * Confidence is a claim about *this* rule, not a general score. A structural fact
 * read out of a published manifest is not a guess, so it is 1; a major bump we
 * could not explain is close to a guess, and says so.
 */
export function deriveFindings(input: DerivationInput): Derivation {
  const findings: MigrationFinding[] = [];
  const uncertainty: string[] = [];
  const cite = [...input.shapeEvidenceIds, ...input.documentEvidenceIds];

  const requireSites = input.usages.filter((usage) => usage.style === "require");
  const loadBreaks =
    input.targetShape.moduleType === "module" &&
    !input.targetShape.hasCommonJsEntry &&
    requireSites.length > 0;

  if (loadBreaks) {
    findings.push({
      id: "esm-only-at-target",
      releaseClaim: `${input.packageName} ${input.targetVersion} publishes as an ES module with no CommonJS entry point, so require() of it throws ERR_REQUIRE_ESM.`,
      evidenceIds: cite,
      affectedSymbols: [input.packageName],
      affectedFiles: unique(requireSites.map((usage) => usage.file)),
      requiredChange:
        `Each require() of ${input.packageName} has to become an import. Converting a file to ESM changes how the whole file loads, so its own exports and its relative requires move with it, and every module that loads it is affected in turn.`,
      confidence: 1,
    });
  }

  if (input.targetShape.deprecated !== null) {
    findings.push({
      id: "deprecated-at-target",
      releaseClaim: `${input.packageName} ${input.targetVersion} is published with a deprecation notice: ${input.targetShape.deprecated}`,
      evidenceIds: input.shapeEvidenceIds,
      affectedSymbols: [input.packageName],
      affectedFiles: [],
      requiredChange:
        "Upgrading onto a deprecated version is a decision for a person, not a mechanical migration.",
      confidence: 1,
    });
  }

  const nodeBump = nodeRequirementChanged(input.currentShape, input.targetShape);
  if (nodeBump !== null) {
    findings.push({
      id: "node-requirement-raised",
      releaseClaim: `${input.packageName} ${input.targetVersion} requires Node ${nodeBump.target}, where ${input.currentVersion} required ${nodeBump.current}.`,
      evidenceIds: input.shapeEvidenceIds,
      affectedSymbols: [],
      affectedFiles: [],
      requiredChange:
        "Confirm CI and the repository's engines field allow the required Node version before shipping this.",
      confidence: 1,
      // There is no edit that discharges this. It is a fact to confirm against the
      // versions CI runs, and marking it as needing a source change would keep the
      // implementer eligible forever over something it cannot do anything about.
      noSourceChangeRequired: true,
    });
  }

  if (findings.length === 0 && input.usages.length === 0) {
    findings.push({
      id: "no-call-sites",
      releaseClaim: `No file in the repository loads ${input.packageName}.`,
      evidenceIds: input.shapeEvidenceIds,
      affectedSymbols: [],
      affectedFiles: [],
      requiredChange: "Update the manifest and lockfile. No source change follows from this upgrade.",
      confidence: 1,
      noSourceChangeRequired: true,
    });
    // A dependency nothing imports may still be reached at runtime by a
    // configuration file, a plugin lookup, or a bare string, none of which this
    // scan sees.
    uncertainty.push(
      `${input.packageName} has no textual call site, so the conclusion that no source change is needed rests on a source scan that cannot see dynamic or configuration-driven loading.`,
    );
  }

  if (isMajorBump(input.currentVersion, input.targetVersion) && !loadBreaks) {
    // A major bump asserts a break somewhere. Finding none from structure means
    // the break is described in prose, which is exactly what these rules cannot
    // read.
    uncertainty.push(
      `${input.packageName} ${input.currentVersion} to ${input.targetVersion} is a major bump, and no structural rule explains what it breaks. Whatever changed is described in prose that was not interpreted, so the ${String(input.usages.length)} call site(s) found were not assessed against it.`,
    );
  }

  if (input.documentEvidenceIds.length === 0) {
    uncertainty.push(
      `No release note, changelog, or migration guide was retrieved for ${input.packageName} ${input.targetVersion}, so findings rest on published manifest fields alone.`,
    );
  }

  for (const usage of input.usages) {
    if (usage.style === "dynamic_import") {
      uncertainty.push(
        `${usage.file}:${String(usage.line)} loads ${input.packageName} dynamically, so what it does with the module is decided at runtime and was not assessed.`,
      );
    }
  }

  return { findings, uncertainty };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function nodeRequirementChanged(
  current: PublishedShape,
  target: PublishedShape,
): { readonly current: string; readonly target: string } | null {
  if (target.requiredNodeRange === null || target.requiredNodeRange === current.requiredNodeRange) {
    return null;
  }
  return { current: current.requiredNodeRange ?? "nothing in particular", target: target.requiredNodeRange };
}

function isMajorBump(current: string, target: string): boolean {
  const currentMajor = Number.parseInt(current.split(".")[0] ?? "", 10);
  const targetMajor = Number.parseInt(target.split(".")[0] ?? "", 10);
  return Number.isInteger(currentMajor) && Number.isInteger(targetMajor) && targetMajor > currentMajor;
}

/**
 * Quote the part of a retrieved document that mentions the version, for the
 * evidence record.
 *
 * Quoting only. Nothing downstream branches on this text, and it is bounded so a
 * large document cannot become a large prompt or a large checkpoint.
 */
export function relevantExtract(text: string, targetVersion: string, limit = 2000): string {
  const needle = text.indexOf(targetVersion);
  if (needle === -1) {
    return text.slice(0, limit);
  }
  const start = Math.max(0, needle - limit / 4);
  return text.slice(start, start + limit);
}
