import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/store.ts";
import { REDACTED, canonicalJson, redact, sha256Canonical } from "../src/hash.ts";

describe("redact", () => {
  it("drops values whose key names a credential", () => {
    const redacted = redact({
      githubToken: "ghp_realtokenvalue1234567890",
      holderKey: "deadbeef",
      apiKey: "x",
      Authorization: "Bearer abc",
      packageName: "left-pad",
    }) as Record<string, unknown>;

    expect(redacted.githubToken).toBe(REDACTED);
    expect(redacted.holderKey).toBe(REDACTED);
    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.Authorization).toBe(REDACTED);
    expect(redacted.packageName).toBe("left-pad");
  });

  it("scrubs secret-shaped values even under an innocent key", () => {
    const redacted = redact({
      note: "run it with ghp_abcdefghijklmnopqrstuvwxyz123456 and sk-abcdefghijklmnopqrst",
      pem: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
    }) as Record<string, string>;

    expect(redacted.note).not.toContain("ghp_");
    expect(redacted.note).not.toContain("sk-abcdef");
    expect(redacted.pem).toBe(REDACTED);
  });

  it("reduces byte arrays to a digest instead of emitting them", () => {
    const unnamed = redact({ blob: new Uint8Array([1, 2, 3]) }) as Record<string, string>;
    expect(unnamed.blob).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A credential-named byte array is dropped outright rather than digested.
    const named = redact({ holderKey: new Uint8Array([1, 2, 3]) }) as Record<string, string>;
    expect(named.holderKey).toBe(REDACTED);
  });

  it("stops at a bounded depth rather than recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});

describe("canonical hashing", () => {
  it("ignores key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(sha256Canonical({ path: "/a", content: "x" })).toBe(sha256Canonical({ content: "x", path: "/a" }));
  });

  it("distinguishes different values", () => {
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
});

describe("AuditLog", () => {
  it("redacts payloads as they are recorded", () => {
    const log = new AuditLog({ runId: "run-1" });
    log.record({
      phase: "publish_draft",
      worker: "publisher",
      type: "tool_allowed",
      payload: { capability: "create_draft_pr", token: "ghp_secretvalue1234567890" },
    });
    const event = log.events[0];
    expect(event?.payload.token).toBe(REDACTED);
    expect(JSON.stringify(log.events)).not.toContain("ghp_secretvalue");
  });

  it("is append-only and keeps events in order", () => {
    const log = new AuditLog({ runId: "run-1" });
    log.record({ phase: "inspect", type: "tool_allowed", payload: { capability: "read_file" } });
    log.record({ phase: "inspect", type: "tool_denied", payload: { capability: "write_source_file" } });
    expect(log.events.map((event) => event.type)).toEqual(["tool_allowed", "tool_denied"]);
    expect(log.ofType("tool_denied")).toHaveLength(1);
  });

  it("references a large artifact by digest instead of inlining it", () => {
    const log = new AuditLog({ runId: "run-1" });
    const stored = log.writeArtifact("checks/test.txt", "x".repeat(10_000));
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.path).toBe("memory:checks/test.txt");
  });
});
