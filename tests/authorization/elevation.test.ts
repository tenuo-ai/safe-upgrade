/**
 * What an approval can and cannot do.
 *
 * The claims worth testing are the negative ones. An approval that could be
 * replayed against a neighbouring call, handed to a different worker, or used to
 * reach a capability the run never had would be worse than no approval mechanism,
 * because the audit trail would say a human agreed to something they did not.
 */

import { describe, expect, it } from "vitest";
import { AuthorizationError, elevationRequest, type ElevationGrant } from "@safe-upgrade/domain";
import { ToolExecutionError } from "@safe-upgrade/domain";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

function grantOf(id: string): ElevationGrant {
  return { id, approvedBy: "an-operator", approvedAt: new Date().toISOString() };
}

function requestFor(overrides: Record<string, string> = {}, worker = "implementer") {
  return elevationRequest({
    worker,
    capability: "update_manifest_field",
    arguments: { path: "package.json", field: "type", value: "module", ...overrides },
    reason: "the target is ESM only",
    findingIds: ["esm-only-at-target"],
  });
}

/** Attempt the call as `worker`, with `approved` request/grant pairs in effect. */
async function attempt(
  worker: "implementer" | "test_author",
  request: ReturnType<typeof requestFor>,
  grant: ElevationGrant,
  call: Record<string, string>,
) {
  const { broker } = harness.runtime;
  return broker.withWorker(
    worker,
    "implement",
    (handle) =>
      handle.tools.update_manifest_field({
        path: `${harness.root}/${String(call["path"])}`,
        field: String(call["field"]),
        value: String(call["value"]),
        expectedBeforeHash: String(call["expectedBeforeHash"]),
      }),
    { elevations: [{ request, grant }] },
  );
}

describe("a capability nobody holds by default", () => {
  it("is denied to the implementer without an approval", async () => {
    harness = createHarness();
    const { broker } = harness.runtime;
    await expect(
      broker.withWorker("implementer", "implement", (handle) =>
        handle.tools.update_manifest_field({
          path: `${harness.root}/package.json`,
          field: "type",
          value: "module",
          expectedBeforeHash: "absent",
        }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // Denied before the tool body, so nothing was read or written.
    expect(harness.invocations).toEqual([]);
  });

  it("is in the ceiling even so, which is what makes approving it possible", () => {
    harness = createHarness();
    expect(Object.keys(harness.runtime.ceilings)).toContain("update_manifest_field");
  });
});

describe("an approval permits exactly the call it named", () => {
  it("allows the approved call through", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    const request = requestFor();
    const result = await attempt("implementer", request, grantOf(request.id), {
      path: "package.json",
      field: "type",
      value: "module",
      expectedBeforeHash: harness.hashOf("package.json"),
    });
    expect(result.value).toBe("module");
    expect(result.previousValue).toBe(null);
  });

  it("denies the opposite value, even though the field was approved", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    const request = requestFor();
    await expect(
      attempt("implementer", request, grantOf(request.id), {
        path: "package.json",
        field: "type",
        value: "commonjs",
        expectedBeforeHash: harness.hashOf("package.json"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("denies a different manifest in the same worktree", async () => {
    harness = createHarness({
      manifest: { name: "fixture", version: "1.0.0" },
      extraManifests: ["packages/other/package.json"],
    });
    const request = requestFor();
    await expect(
      attempt("implementer", request, grantOf(request.id), {
        path: "packages/other/package.json",
        field: "type",
        value: "module",
        expectedBeforeHash: harness.hashOf("packages/other/package.json"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("an approval cannot be moved", () => {
  it("does not apply to a worker it was not given to", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    // A grant for the implementer, presented while the test author is running.
    const request = requestFor({}, "implementer");
    await expect(
      attempt("test_author", request, grantOf(request.id), {
        path: "package.json",
        field: "type",
        value: "module",
        expectedBeforeHash: harness.hashOf("package.json"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const refusal = harness.events.find((event) => event.type === "elevation_refused");
    expect(refusal?.payload["reason"]).toBe("the approval is for implementer");
  });

  it("does not apply to a request that borrowed its id", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    const approved = requestFor({ value: "module" });
    // Same id, different arguments: the id is recomputed from the request, so the
    // two no longer agree and the grant matches nothing.
    const forged = { ...requestFor({ value: "commonjs" }), id: approved.id };
    await expect(
      attempt("implementer", forged, grantOf(approved.id), {
        path: "package.json",
        field: "type",
        value: "commonjs",
        expectedBeforeHash: harness.hashOf("package.json"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const refusal = harness.events.find((event) => event.type === "elevation_refused");
    expect(refusal?.payload["reason"]).toBe("the grant does not match the request it is attached to");
  });

  it("cannot reach a capability the run never had", async () => {
    harness = createHarness();
    const request = elevationRequest({
      worker: "implementer",
      capability: "launch_missiles",
      arguments: { target: "everything" },
      reason: "why not",
      findingIds: [],
    });
    await harness.runtime.broker.withWorker(
      "implementer",
      "implement",
      async () => undefined,
      { elevations: [{ request, grant: grantOf(request.id) }] },
    );
    const refusal = harness.events.find((event) => event.type === "elevation_refused");
    expect(refusal?.payload["reason"]).toBe("the capability is not in the run's ceiling");
  });
});

describe("what the audit records", () => {
  it("names the approved call, who approved it, and what it serves", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    const request = requestFor();
    await attempt("implementer", request, grantOf(request.id), {
      path: "package.json",
      field: "type",
      value: "module",
      expectedBeforeHash: harness.hashOf("package.json"),
    });

    const granted = harness.events.find((event) => event.type === "elevation_granted");
    expect(granted?.payload["request"]).toBe(
      "implementer calling update_manifest_field with field=type path=package.json value=module",
    );
    expect(granted?.payload["approvedBy"]).toBe("an-operator");
    expect(granted?.payload["findingIds"]).toEqual(["esm-only-at-target"]);

    // And the delegation records that this session held more than the profile.
    const delegated = harness.events.find((event) => event.type === "session_delegated");
    expect(delegated?.payload["capabilities"]).toContain("update_manifest_field");
    expect(delegated?.payload["elevatedCapabilities"]).toEqual([request.id]);
  });

  it("records nothing as elevated when no grant applied", async () => {
    harness = createHarness();
    await harness.runtime.broker.withWorker("implementer", "implement", async () => undefined);
    const delegated = harness.events.find((event) => event.type === "session_delegated");
    expect(delegated?.payload["elevatedCapabilities"]).toEqual([]);
  });
});

describe("the tool's own allowlist, independent of any approval", () => {
  it("refuses a field that is not editable even when the capability permits the call", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    // `scripts` is the escalation this tool exists to avoid, so it is refused by the
    // tool as well as by the capability. Approving it is not possible, but the tool
    // does not depend on that being true.
    const request = requestFor({ field: "scripts", value: "module" });
    await expect(
      attempt("implementer", request, grantOf(request.id), {
        path: "package.json",
        field: "scripts",
        value: "module",
        expectedBeforeHash: harness.hashOf("package.json"),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a stale hash, so two writers cannot silently overwrite each other", async () => {
    harness = createHarness({ manifest: { name: "fixture", version: "1.0.0" } });
    const request = requestFor();
    await expect(
      attempt("implementer", request, grantOf(request.id), {
        path: "package.json",
        field: "type",
        value: "module",
        expectedBeforeHash: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("leaves every other field byte-identical", async () => {
    harness = createHarness({
      manifest: {
        name: "fixture",
        version: "1.0.0",
        scripts: { test: "node --test" },
        dependencies: { left: "1.0.0" },
      },
    });
    const before = harness.read("package.json");
    const request = requestFor();
    await attempt("implementer", request, grantOf(request.id), {
      path: "package.json",
      field: "type",
      value: "module",
      expectedBeforeHash: harness.hashOf("package.json"),
    });
    const after = harness.read("package.json");

    expect(JSON.parse(after)).toEqual({ ...JSON.parse(before), type: "module" });
    // One line added, nothing reordered: a diff that reformats the manifest hides
    // the change inside noise.
    expect(after.split("\n").length).toBe(before.split("\n").length + 1);
  });
});
