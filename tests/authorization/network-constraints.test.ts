/**
 * SSRF containment on the one capability that reaches the network.
 *
 * These assert against real URLs rather than against the shape of the constraint
 * object, deliberately. `urlSafe` is written out by hand because `@tenuo/core`
 * exports no helper for it, and a misspelled option on a recognised kind is
 * silently ignored rather than rejected: `{ kind: "urlSafe", domains: [...] }`
 * constructs a session quite happily and then permits `https://evil.example/`.
 * A shape assertion would pass in exactly that case. A URL assertion cannot.
 *
 * Every case here must fail with AuthorizationError, never ToolExecutionError.
 * The tool body also refuses these, so a ToolExecutionError would mean the
 * capability had stopped carrying its own weight and the test had started
 * measuring the wrong layer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationError } from "@safe-upgrade/domain";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ requestedPackage: "left-pad", targetVersion: "1.3.0" });
});

afterEach(() => {
  harness.cleanup();
});

function fetchDocument(url: string): Promise<unknown> {
  const { broker, toolset } = harness.runtime;
  return broker.withWorker("researcher", "research", (handle) =>
    handle.tools.fetch_release_document({ url }),
  );
}

describe("fetch_release_document", () => {
  const blocked = [
    ["the cloud metadata service", "http://169.254.169.254/latest/meta-data/iam/"],
    ["the metadata service as an IPv4-mapped IPv6 address", "http://[::ffff:169.254.169.254]/latest/"],
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["loopback by name", "http://localhost/admin"],
    ["a private range", "http://10.0.0.5/internal"],
    ["an internal hostname", "https://vault.internal/v1/secret"],
    ["an unrelated host", "https://evil.example/release-notes"],
    ["a host that merely starts with an allowlisted name", "https://api.github.com.evil.example/x"],
    ["a subdomain of an allowlisted host", "https://internal.api.github.com/x"],
    ["plaintext http to an allowlisted host", "http://api.github.com/repos/o/r/releases"],
    ["a non-http scheme", "file:///etc/passwd"],
  ] as const;

  for (const [label, url] of blocked) {
    it(`denies ${label}`, async () => {
      await expect(fetchDocument(url)).rejects.toBeInstanceOf(AuthorizationError);
      // Denied before the tool body, so no request was ever constructed.
      expect(harness.invocations).toEqual([]);
    });
  }

  /**
   * The constraint checks host and scheme but not the port or the userinfo
   * section, which is why the tool still validates both. Reaching the tool body
   * is the expected outcome here, not a gap.
   */
  it("reaches the tool body for an allowlisted host so the tool can judge port and credentials", async () => {
    await expect(fetchDocument("https://api.github.com:8443/repos/o/r/releases")).rejects.toThrow(
      /port/i,
    );
    expect(harness.invocations).toEqual(["fetch_release_document"]);
  });

  it("refuses credentials embedded in an otherwise allowlisted URL", async () => {
    await expect(fetchDocument("https://user:pw@api.github.com/repos/o/r/releases")).rejects.toThrow(
      /credential/i,
    );
    expect(harness.invocations).toEqual(["fetch_release_document"]);
  });
});
