/**
 * The denial demonstration required by section 11.4 of the spec.
 *
 * A test author attempts to edit production code. Everything below is asserted
 * about that single attempt, because "it threw" is a much weaker claim than
 * "nothing happened and we can prove it".
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AuthorizationError } from "@safe-upgrade/domain";
import { sha256Canonical, sha256Hex } from "@safe-upgrade/evidence";
import { ABSENT } from "@safe-upgrade/tools";
import { createHarness, type Harness } from "../support/harness.ts";

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.cleanup();
});

it("denies a test author writing production code, and nothing happens", async () => {
  const { broker, toolset } = harness.runtime;
  const target = harness.path("src", "index.ts");
  const hashBefore = sha256Hex(readFileSync(target, "utf8"));

  const args = {
    path: target,
    expectedBeforeHash: ABSENT,
    content: "export const greeting = 'owned';\n",
  };

  const outcome = await broker
    .withWorker("test_author", "author_tests", (handle) =>
      handle.invoke("write_source_file", toolset.write_source_file, args),
    )
    .then(
      () => null,
      (caught: unknown) => caught,
    );

  // 1. Tenuo denies the call, surfaced as a typed authorization failure.
  expect(outcome).toBeInstanceOf(AuthorizationError);
  const error = outcome as AuthorizationError;
  expect(error.detail.worker).toBe("test_author");
  expect(error.detail.capability).toBe("write_source_file");
  expect(error.detail.code).toBe("TENUO_TOOL_NOT_AUTHORIZED");
  // An authorization denial must never invite a retry with more authority.
  expect(error.retryable).toBe(false);

  // 2. The underlying write function never ran.
  expect(harness.invocations).not.toContain("write_source_file");

  // 3. The target file is byte-for-byte unchanged.
  expect(sha256Hex(readFileSync(target, "utf8"))).toBe(hashBefore);

  // 4. A denial event records who, what, and which session, without the payload.
  const denials = harness.audit.ofType("tool_denied");
  expect(denials).toHaveLength(1);
  const denial = denials[0];
  expect(denial?.worker).toBe("test_author");
  expect(denial?.phase).toBe("author_tests");
  expect(denial?.payload.capability).toBe("write_source_file");
  expect(denial?.payload.argumentsHash).toBe(sha256Canonical(args));
  expect(denial?.payload.sessionDigest).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
  expect(denial?.payload.code).toBe("TENUO_TOOL_NOT_AUTHORIZED");
  // The attempted file content is referenced by hash, never copied into the log.
  expect(JSON.stringify(denial?.payload)).not.toContain("owned");

  // 5. The session was delegated and then destroyed, leaving nothing live.
  expect(harness.audit.ofType("session_delegated")).toHaveLength(1);
  expect(harness.audit.ofType("session_destroyed")).toHaveLength(1);
  expect(harness.runtime.registry.size).toBe(0);
});

it("still allows the test author its own write after being denied", async () => {
  const { broker, toolset } = harness.runtime;

  await expect(
    broker.withWorker("test_author", "author_tests", (handle) =>
      handle.invoke("write_source_file", toolset.write_source_file, {
        path: harness.path("src", "index.ts"),
        expectedBeforeHash: ABSENT,
        content: "nope",
      }),
    ),
  ).rejects.toBeInstanceOf(AuthorizationError);

  // A denial is a routing signal, not a poisoned runtime: the worker can still
  // do the job it is actually authorized for.
  const written = await broker.withWorker("test_author", "author_tests", (handle) =>
    handle.invoke("write_test_file", toolset.write_test_file, {
      path: harness.path("src", "regression.test.ts"),
      expectedBeforeHash: ABSENT,
      content: "test('regression', () => {});\n",
    }),
  );
  expect(written.beforeHash).toBeNull();
  expect(harness.invocations).toEqual(["write_test_file"]);
});
