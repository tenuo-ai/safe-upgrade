import { describe, expect, it } from "vitest";
import {
  LangChainPatchGenerator,
  OpenAIPatchGenerator,
  validatePatchScope,
  type PatchGenerationRequest,
} from "@safe-upgrade/workers";

const hash = "a".repeat(64);
const request: PatchGenerationRequest = {
  kind: "source",
  packageName: "example",
  currentVersion: "1.0.0",
  targetVersion: "2.0.0",
  findings: [
    {
      id: "removed:old",
      releaseClaim: "old was removed",
      evidenceIds: ["release:2"],
      affectedSymbols: ["old"],
      affectedFiles: ["src/client.ts"],
      requiredChange: "use the replacement API",
      confidence: 1,
      needsHuman: true,
    },
  ],
  evidence: [{ id: "release:2", sourceType: "release", relevantExtract: "Use new instead." }],
  editableFiles: [{ path: "src/client.ts", hash, content: "old();\n" }],
  contextFiles: [],
  previousChecks: [],
};

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    summary: "replace the removed call",
    addressedFindingIds: ["removed:old"],
    changes: [
      {
        path: "src/client.ts",
        expectedBeforeHash: hash,
        content: "new_();\n",
        reason: "use the replacement API",
        findingIds: ["removed:old"],
      },
    ],
    ...overrides,
  };
}

describe("coding-model patch scope", () => {
  const scope = {
    existingFiles: new Map([["src/client.ts", hash]]),
    requiredFindingIds: new Set(["removed:old"]),
    allowCreate: () => false,
  };

  it("accepts a complete proposal for the selected file and finding", () => {
    expect(validatePatchScope(proposal(), scope).changes[0]?.path).toBe("src/client.ts");
  });

  it("rejects a path the trusted worker did not select", () => {
    expect(() =>
      validatePatchScope(
        proposal({ changes: [{ ...proposal().changes[0], path: "src/admin.ts" }] }),
        scope,
      ),
    ).toThrow(/outside its patch scope/);
  });

  it("rejects stale hashes and invented finding ids", () => {
    expect(() =>
      validatePatchScope(
        proposal({ changes: [{ ...proposal().changes[0], expectedBeforeHash: "b".repeat(64) }] }),
        scope,
      ),
    ).toThrow(/stale or invented hash/);
    expect(() =>
      validatePatchScope(proposal({ addressedFindingIds: ["something-else"] }), scope),
    ).toThrow(/unknown finding/);
  });

  it("requires every finding claim to be attached to a concrete file change", () => {
    const twoFindingScope = {
      ...scope,
      requiredFindingIds: new Set(["removed:old", "changed:behavior"]),
    };
    expect(() =>
      validatePatchScope(
        proposal({ addressedFindingIds: ["removed:old", "changed:behavior"] }),
        twoFindingScope,
      ),
    ).toThrow(/did not link any file change to required finding: changed:behavior/);
  });

  it("keeps a source change within the files identified by its finding", () => {
    expect(() =>
      validatePatchScope(proposal(), {
        ...scope,
        allowedPathsByFinding: new Map([["removed:old", new Set(["src/other.ts"])]]),
      }),
    ).toThrow(/did not identify that file/);
  });
});

describe("LangChain adapter", () => {
  it("asks for structured output and validates the returned proposal", async () => {
    const calls: { prompt?: string; name?: string } = {};
    const generator = new LangChainPatchGenerator({
      withStructuredOutput: (_schema, options) => {
        calls.name = options.name;
        return {
          invoke: async (prompt) => {
            calls.prompt = prompt;
            return proposal();
          },
        };
      },
    });

    const result = await generator.propose(request);
    expect(calls.name).toBe("propose_source_migration");
    expect(calls.prompt).toContain("src/client.ts");
    expect(result.addressedFindingIds).toEqual(["removed:old"]);
  });
});

describe("OpenAI Responses adapter", () => {
  it("requests strict structured output without model tools or storage", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    const generator = new OpenAIPatchGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({ output_text: JSON.stringify(proposal()) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await generator.propose(request);

    expect(authorization).toBe("Bearer test-key");
    expect(requestBody?.model).toBe("gpt-test");
    expect(requestBody?.store).toBe(false);
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).toMatchObject({
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(result.addressedFindingIds).toEqual(["removed:old"]);
  });

  it("reads output text from the REST response output array", async () => {
    const generator = new OpenAIPatchGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify(proposal()) }] }],
      })),
    });

    await expect(generator.propose(request)).resolves.toMatchObject({
      addressedFindingIds: ["removed:old"],
    });
  });

  it("reports an API failure without including the response body", async () => {
    const generator = new OpenAIPatchGenerator({
      apiKey: "test-key",
      model: "gpt-test",
      fetch: async () => new Response("sensitive upstream details", { status: 400 }),
    });

    await expect(generator.propose(request)).rejects.toThrow("HTTP 400");
    await expect(generator.propose(request)).rejects.not.toThrow("sensitive upstream details");
  });
});
