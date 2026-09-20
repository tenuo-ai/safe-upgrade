/**
 * The Jev adapter, spec 10.1 and 10.3.
 *
 * Driven with a stubbed client rather than the network, because what is being tested is not
 * whether the service answers. It is what this adapter does with an answer: the interesting
 * cases are a label nobody offered, a malformed response, a transport failure, and the
 * boundary where a probability becomes a yes or a no.
 *
 * The other property fixed here is what leaves the process. The adapter sends the state it is
 * handed, and the one thing that must never be true is that it sends more than that.
 */

import { describe, expect, it } from "vitest";
import { DecisionEngineError } from "@safe-upgrade/domain";
import { JevDecisionEngine } from "@safe-upgrade/jev";
import type { JevEngineOptions, RouteInput, TestCoverageInput } from "@safe-upgrade/jev";

// Taken from the adapter's own options rather than imported from the SDK: these tests are
// about the adapter, and nothing here should need the package it wraps.
type Client = NonNullable<JevEngineOptions["client"]>;

interface Call {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, unknown>>;
}

/** A client that answers from a script and records what it was asked. */
function stubClient(
  answer: unknown | (() => never),
): { readonly client: Client; readonly calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    systemOne(request: { state: unknown; questions: Record<string, unknown> }) {
      calls.push({ state: request.state, questions: request.questions });
      if (typeof answer === "function") {
        (answer as () => never)();
      }
      return Promise.resolve({ model: "jev-test", usage: {}, answers: answer });
    },
  } as unknown as Client;
  return { client, calls };
}

function engine(answer: unknown, yesThreshold = 0.7): JevDecisionEngine {
  return new JevDecisionEngine({ client: stubClient(answer).client, yesThreshold });
}

const routeInput: RouteInput = {
  currentPhase: "implement",
  eligibleActions: [
    { action: "implement", worker: "implementer", reason: "a finding is unresolved" },
    { action: "verify", worker: "verifier", reason: "changes are ready" },
  ],
  unresolvedFindings: [{ id: "esm-only-at-target", summary: "require() throws", affectedFileCount: 2, hasVerification: false }],
  baselinePassed: true,
  dependencyMoved: true,
  implementationChanged: false,
  testsChanged: false,
  ciSufficient: true,
  lastVerification: "not_run",
  attempts: {},
};

const choiceAnswer = (selected: string, confidence = 0.9): unknown => ({
  next: {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: { [selected]: confidence },
  },
});

describe("choosing the next action", () => {
  it("returns the selected action with its confidence", async () => {
    const decision = await engine(choiceAnswer("verify", 0.81)).chooseNextAction(routeInput);
    expect(decision.action).toBe("verify");
    expect(decision.confidence).toBeCloseTo(0.81);
  });

  it("rejects a label that was never offered", async () => {
    // The candidate list is the authority, not the response. A static type from an SDK is not
    // a runtime guarantee, and this is the one that would let an engine pick its own worker.
    await expect(engine(choiceAnswer("publish_draft")).chooseNextAction(routeInput)).rejects.toThrow(
      /not among the offered candidates/,
    );
  });

  it("rejects an action that is not an action at all", async () => {
    await expect(engine(choiceAnswer("rm -rf /")).chooseNextAction(routeInput)).rejects.toThrow(
      DecisionEngineError,
    );
  });

  it("rejects an answer of the wrong kind", async () => {
    await expect(engine({ next: { type: "noul", noul: 0.9 } }).chooseNextAction(routeInput)).rejects.toThrow(
      /expected a choice/,
    );
  });

  it("rejects an answer that is missing", async () => {
    await expect(engine({ other: { type: "choice", choice: "verify", confidence: 1, probabilities: {} } }).chooseNextAction(routeInput)).rejects.toThrow(
      /no answer named 'next'/,
    );
  });

  it("refuses to ask for a choice among fewer than two", async () => {
    // The router does not consult an engine for a list of one, so reaching here means the two
    // disagree about what is eligible, which is worth surfacing rather than papering over.
    const one: RouteInput = { ...routeInput, eligibleActions: [routeInput.eligibleActions[0]!] };
    await expect(engine(choiceAnswer("implement")).chooseNextAction(one)).rejects.toThrow(
      /at least two candidates/,
    );
  });

  it("offers each candidate's reason as its criterion", async () => {
    const { client, calls } = stubClient(choiceAnswer("verify"));
    await new JevDecisionEngine({ client }).chooseNextAction(routeInput);
    const question = calls[0]?.questions["next"] as { type: string; criteria: Record<string, string> };
    expect(question.type).toBe("choice");
    expect(question.criteria).toEqual({
      implement: "a finding is unresolved",
      verify: "changes are ready",
    });
  });
});

describe("failures the router has to see", () => {
  it("turns a transport failure into the one error type the router retries", async () => {
    // The SDK's own error classes stay inside the adapter. If they escaped, the router's
    // single retry and its fallback would not recognise them.
    const throwing = new JevDecisionEngine({
      client: stubClient(() => {
        throw new Error("socket hang up");
      }).client,
    });
    const failure = await throwing.chooseNextAction(routeInput).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecisionEngineError);
    expect(String(failure)).toMatch(/unreachable or refused/);
  });

  it("does not retry on its own", async () => {
    // One attempt per call. The router owns the retry, and an adapter that also retried would
    // turn one attempt into four.
    const { client, calls } = stubClient(() => {
      throw new Error("nope");
    });
    await new JevDecisionEngine({ client }).chooseNextAction(routeInput).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("does not fall back on its own", async () => {
    // A fallback here would hide from the audit that the engine failed at all.
    const failing = new JevDecisionEngine({
      client: stubClient(() => {
        throw new Error("nope");
      }).client,
    });
    await expect(failing.chooseNextAction(routeInput)).rejects.toThrow();
  });
});

describe("assessing whether tests cover a break", () => {
  const coverage: TestCoverageInput = {
    finding: { id: "esm-only-at-target", summary: "require() throws", affectedFileCount: 1, hasVerification: false },
    requiredChange: "convert to import",
    candidateTests: [{ file: "test/search.test.js", title: "findLines matches" }],
    baselinePassed: true,
  };

  it("reads a probability at or above the threshold as sufficient", async () => {
    const decision = await engine({ covered: { type: "noul", noul: 0.7 } }).assessTestCoverage(coverage);
    expect(decision.sufficient).toBe(true);
    expect(decision.confidence).toBeCloseTo(0.7);
  });

  it("reads one below the threshold as not sufficient", async () => {
    const decision = await engine({ covered: { type: "noul", noul: 0.69 } }).assessTestCoverage(coverage);
    expect(decision.sufficient).toBe(false);
  });

  it("does not treat a coin flip as an assessment", async () => {
    expect((await engine({ covered: { type: "noul", noul: 0.5 } }).assessTestCoverage(coverage)).sufficient).toBe(false);
  });

  it("writes its own rationale rather than repeating generated text", async () => {
    // The engine returns a number. This sentence says what the number was about, which is what
    // an audit record needs; an explanation from a model is generated text, and generated text
    // is not something this project repeats as a finding.
    const decision = await engine({ covered: { type: "noul", noul: 0.42 } }).assessTestCoverage(coverage);
    expect(decision.rationale).toContain("0.42");
    expect(decision.rationale).toContain("below the 0.70 threshold");
    expect(decision.rationale).toContain("1 candidate test");
  });
});

describe("assessing whether the change addresses every finding", () => {
  const findings = [
    { id: "a", summary: "first", affectedFileCount: 1, hasVerification: true },
    { id: "b", summary: "second", affectedFileCount: 2, hasVerification: false },
  ];
  const input = { findings, changedFiles: ["src/a.js"], checksPassed: ["test" as const] };

  it("names which finding is unaddressed, not just that one is", async () => {
    // The only part of the answer a worker can act on.
    const decision = await engine({
      finding_0: { type: "noul", noul: 0.95 },
      finding_1: { type: "noul", noul: 0.2 },
    }).assessMigrationCompleteness(input);
    expect(decision.complete).toBe(false);
    expect(decision.unaddressedFindingIds).toEqual(["b"]);
  });

  it("reports the weakest answer as the confidence", async () => {
    // A set is as addressed as its least addressed member. Averaging would let one confident
    // yes carry an uncertain no.
    const decision = await engine({
      finding_0: { type: "noul", noul: 0.99 },
      finding_1: { type: "noul", noul: 0.75 },
    }).assessMigrationCompleteness(input);
    expect(decision.complete).toBe(true);
    expect(decision.confidence).toBeCloseTo(0.75);
  });

  it("asks nothing when there is nothing to ask about", async () => {
    const { client, calls } = stubClient({});
    const decision = await new JevDecisionEngine({ client }).assessMigrationCompleteness({
      ...input,
      findings: [],
    });
    expect(decision).toEqual({ complete: true, confidence: null, unaddressedFindingIds: [] });
    expect(calls).toEqual([]);
  });

  it("refuses a set too large for one request", async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      id: `f${String(index)}`,
      summary: "x",
      affectedFileCount: 1,
      hasVerification: false,
    }));
    await expect(engine({}).assessMigrationCompleteness({ ...input, findings: many })).rejects.toThrow(
      /more than one request carries/,
    );
  });

  it("refuses a partial set of answers rather than assuming the rest", async () => {
    // A missing answer read as a yes would report a finding addressed that nobody assessed.
    await expect(
      engine({ finding_0: { type: "noul", noul: 0.9 } }).assessMigrationCompleteness(input),
    ).rejects.toThrow(/no yes\/no answer came back for b/);
  });
});

describe("what crosses the wire", () => {
  it("sends the state it was given and nothing more", async () => {
    const { client, calls } = stubClient(choiceAnswer("verify"));
    await new JevDecisionEngine({ client }).chooseNextAction(routeInput);
    expect(calls[0]?.state).toEqual(JSON.parse(JSON.stringify(routeInput)));
  });

  it("drops anything that is not JSON, rather than carrying it along", async () => {
    // The projection is what actually crosses the wire, so a caller that attached something
    // unserializable to the object cannot have it forwarded.
    const { client, calls } = stubClient(choiceAnswer("verify"));
    const withExtras = {
      ...routeInput,
      secret: undefined,
      leak: () => "holder key",
    } as unknown as RouteInput;
    await new JevDecisionEngine({ client }).chooseNextAction(withExtras);
    const sent = calls[0]?.state as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain("secret");
    expect(Object.keys(sent)).not.toContain("leak");
  });

  it("asks a yes/no rather than anything that returns prose", async () => {
    // Spec 10.4: bounded judgments only. A question that came back as text would be text this
    // project would then have to decide whether to act on.
    const { client, calls } = stubClient({ covered: { type: "noul", noul: 0.9 } });
    await new JevDecisionEngine({ client }).assessTestCoverage({
      finding: { id: "a", summary: "s", affectedFileCount: 1, hasVerification: false },
      requiredChange: "x",
      candidateTests: [],
      baselinePassed: true,
    });
    const asked = Object.values(calls[0]?.questions ?? {}) as { type: string }[];
    expect(asked.map((question) => question.type)).toEqual(["noul"]);
  });
});
