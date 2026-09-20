/**
 * What a reading of release prose is allowed to do.
 *
 * The asymmetry is the property under test: an answer of "this affects you" adds a finding, and
 * an answer of "it does not" leaves the caution exactly where it was. Without that, a confidently
 * wrong reading of a changelog would be the one thing in this system able to turn a real break
 * into a verified run, and it would do it silently.
 */

import { describe, expect, it } from "vitest";

import { deriveFindings, type ProseAssessment } from "../../packages/workers/src/research/derive.ts";
import type { PublishedShape } from "@safe-upgrade/tools";

const cjs: PublishedShape = {
  moduleType: "commonjs",
  hasExportsField: true,
  hasCommonJsEntry: true,
  requiredNodeRange: null,
  deprecated: null,
};

/** A major bump that no structural rule explains, which is the only case prose is read for. */
function majorBumpInput(proseAssessment?: ProseAssessment) {
  return {
    packageName: "cookie",
    currentVersion: "0.7.2",
    targetVersion: "1.0.2",
    currentShape: cjs,
    targetShape: cjs,
    usages: [
      { file: "lib/response.js", style: "require" as const, line: 12, excerpt: 'require("cookie")' },
    ],
    removedMembers: [],
    addedNames: [],
    surfaceRead: true,
    shapeEvidenceIds: ["registry:cookie@1.0.2"],
    documentEvidenceIds: ["release:jshttp/cookie@v1.0.0"],
    ...(proseAssessment === undefined ? {} : { proseAssessment }),
  };
}

describe("reading release prose", () => {
  it("flags the bump as unexplained so the researcher knows to ask", () => {
    expect(deriveFindings(majorBumpInput()).unexplainedMajorBump).toBe(true);
  });

  it("does not ask when structure already explains the break", () => {
    const explained = deriveFindings({
      ...majorBumpInput(),
      currentShape: cjs,
      // ESM-only at the target, which the `require` above cannot load. A structural break, so
      // there is nothing left for a paragraph to explain.
      targetShape: { ...cjs, moduleType: "module", hasCommonJsEntry: false },
    });
    expect(explained.unexplainedMajorBump).toBe(false);
  });

  it("reports the prose as uninterpreted when no engine answered", () => {
    const { findings, uncertainty } = deriveFindings(majorBumpInput());

    expect(findings).toHaveLength(0);
    expect(uncertainty.join(" ")).toContain("which was not interpreted");
  });

  it("raises a finding, cited to the note, when the reading says the break reaches a call site", () => {
    const { findings } = deriveFindings(
      majorBumpInput({
        affects: true,
        confidence: 0.87,
        evidenceId: "release:jshttp/cookie@v1.0.0",
        documentVersion: "1.0.0",
      }),
    );

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.id).toBe("prose-break-at-target");
    expect(finding?.evidenceIds).toContain("release:jshttp/cookie@v1.0.0");
    expect(finding?.affectedFiles).toEqual(["lib/response.js"]);
    // Nothing here can act on a paragraph, so the implementer has to stop rather than attempt it.
    expect(finding?.needsHuman).toBe(true);
  });

  it("names the release it read, which is the major boundary and not the target", () => {
    const { findings } = deriveFindings(
      majorBumpInput({
        affects: true,
        confidence: 0.87,
        evidenceId: "release:jshttp/cookie@v1.0.0",
        documentVersion: "1.0.0",
      }),
    );

    // A reviewer sent to the 1.0.2 note would not find the break they were told about.
    expect(findings[0]?.releaseClaim).toContain("release note for 1.0.0");
    expect(findings[0]?.releaseClaim).not.toContain("release note for 1.0.2");
  });

  it("keeps the caution when the reading finds nothing, rather than discharging it", () => {
    const { findings, uncertainty } = deriveFindings(
      majorBumpInput({
        affects: false,
        confidence: 0.61,
        evidenceId: "release:jshttp/cookie@v1.0.2",
        documentVersion: "1.0.2",
      }),
    );

    expect(findings).toHaveLength(0);
    // Still uncertain, and explicit that a reading is not a demonstration.
    expect(uncertainty).toHaveLength(1);
    expect(uncertainty[0]).toContain("a reading of prose rather than a demonstration");
  });
});
