/**
 * Child session lifecycle.
 *
 * The rules being tested are the ones that keep credentials out of persisted
 * state: a session lives only for the duration of one node, graph state holds
 * nothing but an opaque reference, and narrowing can only ever remove authority.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationDeniedError } from "@tenuo/core";
import { SessionRegistry } from "@safe-upgrade/authorization";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

describe("per-invocation delegation", () => {
  it("creates a distinct child session for every worker invocation", async () => {
    const { broker, toolset } = harness.runtime;
    const refs: string[] = [];
    for (const worker of ["inspector", "researcher", "inspector"] as const) {
      await broker.withWorker(worker, "inspect", async (handle) => {
        refs.push(handle.sessionRef);
        return handle.tools.read_file({ path: harness.path("package.json") });
      });
    }
    expect(new Set(refs).size).toBe(3);

    const delegations = harness.audit.ofType("session_delegated");
    expect(delegations).toHaveLength(3);
    // The same worker asked twice gets the same capability set but a new session.
    const [first, , third] = delegations;
    expect(first?.payload.capabilities).toEqual(third?.payload.capabilities);
    expect(first?.payload.sessionDigest).not.toBe(third?.payload.sessionDigest);
  });

  it("destroys the session even when the worker throws", async () => {
    const { broker, registry } = harness.runtime;
    await expect(
      broker.withWorker("inspector", "inspect", async () => {
        throw new Error("worker failed");
      }),
    ).rejects.toThrow("worker failed");
    expect(registry.size).toBe(0);
    expect(harness.audit.ofType("session_destroyed")).toHaveLength(1);
  });

  it("leaves the reference unusable after the node completes", async () => {
    const { broker, registry } = harness.runtime;
    let captured = "";
    await broker.withWorker("inspector", "inspect", async (handle) => {
      captured = handle.sessionRef;
      expect(() => registry.resolve(captured)).not.toThrow();
    });
    expect(() => registry.resolve(captured)).toThrow(/unknown or has already been destroyed/);
  });

  it("gives out references that carry no information about the session", async () => {
    const { broker } = harness.runtime;
    await broker.withWorker("implementer", "implement", async (handle) => {
      expect(handle.sessionRef).toMatch(/^session_[0-9a-f]{32}$/);
      expect(handle.sessionRef).not.toContain("implementer");
    });
  });
});

describe("attenuation only ever narrows", () => {
  it("refuses to add a capability the parent does not hold", () => {
    const { tenuo, profiles, parentSession, ceilings } = harness.runtime;
    const publisherSession = tenuo.narrow(parentSession, profiles.publisher.allow);
    expect(() => tenuo.narrow(publisherSession, { write_source_file: ceilings.write_source_file })).toThrow(
      AuthorizationDeniedError,
    );
  });

  it("keeps the parent session unchanged when a child is narrowed", async () => {
    const { tenuo, profiles, parentSession, toolset } = harness.runtime;
    const researcher = tenuo.narrow(parentSession, profiles.researcher.allow);
    await expect(
      toolset.write_source_file.execute(
        { path: harness.path("src", "index.ts"), expectedBeforeHash: "absent", content: "x" },
        { session: researcher },
      ),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);

    // The parent still holds the capability the child was denied.
    const written = await toolset.write_source_file.execute(
      { path: harness.path("src", "parent.ts"), expectedBeforeHash: "absent", content: "export const p = 1;\n" },
      { session: parentSession },
    );
    expect(written.fileClass).toBe("source");
  });

  /**
   * Read from the session rather than from the profile we passed in. Asking the
   * profile what it requested only proves we can echo our own arguments back.
   */
  it("delegates to leaves that cannot delegate again", async () => {
    const { broker } = harness.runtime;
    for (const worker of ["researcher", "implementer", "publisher"] as const) {
      const granted = await broker.withWorker(worker, "research", async (handle) => {
        expect(handle.worker).toBe(worker);
        return handle.grant;
      });
      expect(granted.terminal).toBe(true);
      expect(granted.depth).toBe(1);
      expect(granted.canAuthorize).toBe(true);
    }
  });

  it("gives every worker a shorter life than the run that delegated to it", async () => {
    const { broker, parentSession, profiles } = harness.runtime;
    const parentExpiry = parentSession.inspect().expiresAt;
    for (const worker of ["researcher", "verifier", "publisher"] as const) {
      const granted = await broker.withWorker(worker, "research", async (handle) =>
        handle.grant,
      );
      expect(granted.expiresAt).toBeLessThanOrEqual(parentExpiry);
      // Near enough to the profile's TTL to show the narrow honoured it rather
      // than silently inheriting the parent's remaining hour.
      const lifetime = granted.expiresAt - Math.floor(Date.now() / 1000);
      expect(lifetime).toBeLessThanOrEqual(profiles[worker].ttlSeconds);
    }
  });
});

describe("registry", () => {
  it("refuses to be serialized into a checkpoint", () => {
    const registry = new SessionRegistry();
    expect(() => JSON.stringify({ registry })).toThrow(/must never be serialized/);
  });

  it("expires a reference once its TTL has passed", async () => {
    let now = 1_000_000;
    const registry = new SessionRegistry({ now: () => now });
    const { tenuo, parentSession, profiles } = harness.runtime;
    const session = tenuo.narrow(parentSession, profiles.researcher.allow);

    const ref = registry.register("researcher", session, 60);
    expect(() => registry.resolve(ref)).not.toThrow();
    now += 61_000;
    expect(() => registry.resolve(ref)).toThrow(/expired/);
  });

  it("rejects a session with no TTL", () => {
    const registry = new SessionRegistry();
    const { tenuo, parentSession, profiles } = harness.runtime;
    const session = tenuo.narrow(parentSession, profiles.researcher.allow);
    expect(() => registry.register("researcher", session, 0)).toThrow(/positive TTL/);
  });
});

describe("what reaches persisted state", () => {
  it("records no warrant or holder material in the audit log", async () => {
    const { broker, toolset, parentSession } = harness.runtime;
    await broker.withWorker("inspector", "inspect", (handle) =>
      handle.tools.read_file({ path: harness.path("package.json") }),
    );

    const serialized = JSON.stringify(harness.audit.events);
    for (const warrant of parentSession.toWire()) {
      expect(serialized).not.toContain(warrant);
    }
    // Sessions are referred to by short digests, which are not warrants.
    expect(serialized).toContain("sessionDigest");
  });
});
