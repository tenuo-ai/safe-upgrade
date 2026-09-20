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

import { count } from "@safe-upgrade/domain";
import type { MigrationFinding } from "@safe-upgrade/domain";
import type { PublishedShape } from "@safe-upgrade/tools";
import type { MemberReference } from "./members.ts";
import type { Usage } from "./usages.ts";

export interface DerivationInput {
  readonly packageName: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly currentShape: PublishedShape;
  readonly targetShape: PublishedShape;
  readonly usages: readonly Usage[];
  /**
   * Exports the target version no longer has, that this repository reaches.
   *
   * Empty both when nothing was removed and when the surface could not be read, which
   * are different situations: `surfaceRead` tells them apart.
   */
  readonly removedMembers: readonly MemberReference[];
  /** Names the target added, for a reviewer looking for the replacement. */
  readonly addedNames: readonly string[];
  /** Whether both versions' export surfaces were observed. */
  readonly surfaceRead: boolean;
  /** Evidence ids for the two registry documents the shapes came from. */
  readonly shapeEvidenceIds: readonly string[];
  /** Evidence ids for any release prose that was retrieved. */
  readonly documentEvidenceIds: readonly string[];
  /**
   * The engine's reading of the release prose, when one was obtained.
   *
   * Absent means nobody read it, which is a different statement from "it was read and named
   * nothing", and the two produce different text below. Derivation stays pure: the researcher
   * asks the engine and calls this again with the answer.
   */
  readonly proseAssessment?: ProseAssessment;
}

export interface ProseAssessment {
  readonly affects: boolean;
  readonly confidence: number | null;
  readonly evidenceId: string;
  /**
   * The version whose note was read, which is not always the target.
   *
   * An upgrade crossing a major reads the `x.0.0` note, because that is where the break is
   * written down. Saying "the note for 1.0.2" while citing the one for 1.0.0 sends a reviewer to
   * a document that does not contain what they were told it contains.
   */
  readonly documentVersion: string;
}

export interface Derivation {
  readonly findings: readonly MigrationFinding[];
  readonly uncertainty: readonly string[];
  /**
   * A major bump that no structural rule explains.
   *
   * True means the only remaining account of what broke is prose, which is the one question the
   * decision engine can answer and these rules cannot.
   */
  readonly unexplainedMajorBump: boolean;
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
      // Every file in the package moves together, and a package's tests are among its files.
      // The implementer may not write tests, so this finding takes two workers in a fixed
      // order, which routing enforces rather than prefers.
      spansTestFiles: true,
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
      requiredNodeRange: nodeBump.target,
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

  // An export this repository uses that the target does not have. Structural and
  // certain: the name was present in one installed version and absent in the other.
  const byMember = groupByMember(input.removedMembers);
  for (const [member, references] of byMember) {
    findings.push({
      id: `export-removed-at-target:${member}`,
      releaseClaim: `${input.packageName} ${input.currentVersion} exports ${member}, and ${input.targetVersion} does not. This repository reaches it in ${count(references.length, "place")}.`,
      evidenceIds: cite,
      affectedSymbols: [`${input.packageName}.${member}`],
      affectedFiles: unique(references.map((reference) => reference.file)),
      // Deliberately not a proposed edit. The replacement is a semantic question: the
      // name that took over, if any, is not derivable from a set difference, and
      // guessing it would put an invented API into source that has to compile.
      requiredChange: `Replace every use of ${input.packageName}.${member}. ${describeCandidates(input.addedNames)}`,
      confidence: 1,
      needsHuman: true,
    });
  }

  if (!input.surfaceRead) {
    uncertainty.push(
      `The export surface of ${input.packageName} could not be compared across ${input.currentVersion} and ${input.targetVersion}, so a renamed or removed export would not have been noticed.`,
    );
  }

  const unexplainedMajorBump =
    isMajorBump(input.currentVersion, input.targetVersion) && !loadBreaks && byMember.size === 0;
  if (unexplainedMajorBump) {
    // A major bump asserts a break somewhere. Finding none from structure means
    // the break is described in prose, which is exactly what these rules cannot
    // read.
    // Only said when nothing else explains the bump. A run that found an ESM break or a
    // removed export has an explanation, and adding "we might be in the dark" to it
    // would mean no upgrade could ever be verified, whatever was established.
    const bump = `${input.packageName} ${input.currentVersion} to ${input.targetVersion} is a major bump, and no structural rule explains what it breaks.`;
    const sites =
      input.usages.length === 1
        ? "the 1 call site found here"
        : `the ${String(input.usages.length)} call sites found here`;

    if (input.proseAssessment?.affects === true) {
      // A finding rather than an uncertainty, because something was established: a reading of
      // the published note says this release reaches how this repository calls the package. It
      // is cited to the document and marked for a person, since no rule here can act on prose.
      findings.push({
        id: "prose-break-at-target",
        releaseClaim: `${bump} The release note for ${input.proseAssessment.documentVersion} was read against how this repository uses it, and describes a change that reaches ${sites}.`,
        evidenceIds: [input.proseAssessment.evidenceId, ...input.shapeEvidenceIds],
        affectedSymbols: [input.packageName],
        affectedFiles: unique(input.usages.map((usage) => usage.file)),
        requiredChange: `Read the cited release note against ${sites} and decide what the change requires. This was a reading of prose, not a structural observation, so the note is the authority and the reading is a pointer to it.`,
        confidence: input.proseAssessment.confidence ?? 0,
        needsHuman: true,
      });
    } else if (input.proseAssessment?.affects === false) {
      // The caution stays. A model reading a changelog and not finding this call site is a
      // reading, not a proof, and letting it discharge the uncertainty would mean a confident
      // misreading could carry a real break into a verified run.
      uncertainty.push(
        `${bump} The release note for ${input.proseAssessment.documentVersion} was read against ${sites} and nothing in it named them, which is a reading of prose rather than a demonstration that nothing changed.`,
      );
    } else {
      uncertainty.push(
        input.surfaceRead
          ? `${bump} Its exports were compared across both versions and this repository uses none that were removed, so whatever changed is a change in behaviour or in argument handling. That kind of change is described only in prose, which was not interpreted, so ${sites} ${input.usages.length === 1 ? "was" : "were"} not assessed against it.`
          : `${bump} Its exports could not be compared across the two versions, so whatever changed was not observed here and is described only in prose, which was not interpreted, so ${sites} ${input.usages.length === 1 ? "was" : "were"} not assessed against it.`,
      );
    }
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

  return { findings, uncertainty, unexplainedMajorBump };
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

function groupByMember(references: readonly MemberReference[]): ReadonlyMap<string, readonly MemberReference[]> {
  const grouped = new Map<string, MemberReference[]>();
  for (const reference of references) {
    const existing = grouped.get(reference.member);
    if (existing === undefined) {
      grouped.set(reference.member, [reference]);
    } else {
      existing.push(reference);
    }
  }
  return grouped;
}

/**
 * What the target added, as a lead rather than an answer.
 *
 * Offered because a reviewer looking for the replacement will look here first, and
 * withheld as a recommendation because "one name went and another arrived" is a
 * coincidence often enough that acting on it would be guessing.
 */
function describeCandidates(added: readonly string[]): string {
  if (added.length === 0) {
    return "The target version adds no new top-level export, so the replacement is not in this package.";
  }
  const shown = added.slice(0, 8).join(", ");
  const rest = added.length > 8 ? `, and ${String(added.length - 8)} more` : "";
  return `The target version adds ${shown}${rest}, which is where to look for a replacement; which one applies is not something a list of names can settle.`;
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
