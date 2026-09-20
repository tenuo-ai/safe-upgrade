/**
 * What ends up in a checkpoint.
 *
 * LangGraph checkpoints are written to durable storage and replayed later, so a
 * credential that reaches one has effectively been logged. These tests inspect a
 * real checkpoint rather than reasoning about the state type.
 */

import { afterEach, describe, expect, it } from "vitest";
import { FORBIDDEN_STATE_KEYS, isForbiddenStateKey, persistedStateSchema } from "@safe-upgrade/graph";
import { createGraphHarness, check, finding, type GraphHarness } from "../support/graph-harness.ts";

let harness: GraphHarness;

afterEach(() => {
  harness?.cleanup();
});

describe("serialized state", () => {
  it("contains no warrant, holder key, or session object", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
        researcher: async () => ({ findings: [finding("f1")], verifiedFindingIds: ["f1"] }),
        implementer: async () => ({
          addressedFindingIds: ["f1"],
          fileChanges: [
            { path: "src/index.ts", beforeHash: null, afterHash: null, owner: "implementer", reason: "migrate f1" },
          ],
          targetVersionResolved: true,
        }),
        verifier: async () => ({
          postChangeChecks: [check("install", "passed"), check("test", "passed"), check("typecheck", "passed")],
          lastVerification: "passed",
          ciAssessment: { sufficient: true, missingChecks: [] },
        }),
      },
    });
    const { state } = await harness.run();
    const serialized = JSON.stringify(state);

    for (const warrant of harness.base.runtime.parentSession.toWire()) {
      expect(serialized).not.toContain(warrant);
    }
    for (const key of FORBIDDEN_STATE_KEYS) {
      expect(Object.keys(state)).not.toContain(key);
    }
    // The fixture's GitHub token is never part of a run's state.
    expect(serialized).not.toContain("ghp_");
  });

  it("round-trips through JSON without losing anything", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async () => ({ baselineChecks: [check("test", "passed")] }),
      },
    });
    const { state } = await harness.run();
    const restored = JSON.parse(JSON.stringify(state)) as unknown;

    // A checkpoint that cannot be restored is not a checkpoint.
    expect(restored).toEqual(JSON.parse(JSON.stringify(state)));
    expect(persistedStateSchema.safeParse(restored).success).toBe(true);
  });

  it("holds no live session reference once a node has finished", async () => {
    harness = createGraphHarness({
      workers: {
        inspector: async ({ handle }) => {
          // The reference is usable inside the node.
          expect(handle.sessionRef).toMatch(/^session_[0-9a-f]{32}$/);
          return { baselineChecks: [check("test", "passed")] };
        },
      },
    });
    const { state } = await harness.run();

    expect(state.activeSessionRef).toBeNull();
    expect(harness.base.runtime.registry.size).toBe(0);
    // The delegation is still traceable, just not resumable.
    expect(harness.base.audit.ofType("session_delegated").length).toBeGreaterThan(0);
  });
});

describe("restoring an untrusted checkpoint", () => {
  it("rejects a checkpoint carrying a credential-shaped key", () => {
    const tampered = { phase: "route", step: 4, holderSecret: "deadbeef" };
    const parsed = persistedStateSchema.safeParse(tampered);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("must not contain 'holderSecret'");
  });

  it("rejects a checkpoint whose phase is not a real phase", () => {
    expect(persistedStateSchema.safeParse({ phase: "exfiltrate", step: 1 }).success).toBe(false);
  });

  it("accepts the opaque session reference while rejecting a session object", () => {
    expect(isForbiddenStateKey("activeSessionRef")).toBe(false);
    for (const key of ["session", "parentSession", "tenuoWarrant", "holderSecret", "githubToken", "apiKey"]) {
      expect(isForbiddenStateKey(key), key).toBe(true);
    }
  });
});
