/**
 * The Jev adapter, spec 10.1.
 *
 * The only file in the project that imports the SDK. Everything else — the router, the
 * fallback, the validation, the workers — talks to `DecisionEngine`, so nothing outside this
 * file can tell a real engine from the deterministic one, and no test needs a network.
 *
 * What the engine is asked is narrow by construction. `systemOne` answers bounded questions:
 * a choice among labels that trusted code computed, or a probability for a yes/no. It does
 * not return prose, and this adapter does not ask it to. That is the property spec 10.4
 * requires — no source, no commands, no paths, no worker identities, and nothing that could
 * be read back as a route the router never offered.
 *
 * Two consequences worth stating, because they look like omissions.
 *
 * The rationale on a coverage decision is written here, from the question and the number that
 * came back. It is not the engine's explanation of itself: an explanation is generated text,
 * and generated text is the one thing this project does not act on or repeat as a finding.
 *
 * Nothing here retries, and nothing here falls back. The router owns both — one retry for a
 * malformed answer, then the deterministic order, plus the confidence threshold — so an
 * adapter that quietly retried would turn one attempt into four and an adapter that quietly
 * fell back would hide from the audit that the engine had failed.
 */

import { choice, noul, TypeSafeClient, type EntryType } from "@typesafe-ai/sdk";
import { DecisionEngineError } from "@safe-upgrade/domain";
import type {
  DecisionEngine,
  MigrationCompletenessDecision,
  MigrationCompletenessInput,
  RouteChoice,
  RouteInput,
  TestCoverageDecision,
  TestCoverageInput,
} from "./contract.ts";
import { validateRouteChoice } from "./validate.ts";

export interface JevEngineOptions {
  /**
   * A configured client, for tests and for callers with their own retry and logging.
   * Omitted means one built from the environment, which is where the key belongs.
   */
  readonly client?: TypeSafeClient;
  /**
   * Probability at or above which a yes/no answer counts as a yes.
   *
   * Separate from the router's confidence threshold, which decides whether to trust the
   * engine at all. This decides what a number means once trusted, and it is not 0.5: saying
   * "these tests cover the break" on a coin flip is not an assessment.
   */
  readonly yesThreshold?: number;
}

const DEFAULT_YES_THRESHOLD = 0.7;

/** Findings asked about in one round trip. Bounded so one request cannot become enormous. */
const MAX_FINDINGS_PER_REQUEST = 20;

export class JevDecisionEngine implements DecisionEngine {
  private readonly client: TypeSafeClient;
  private readonly yesThreshold: number;

  constructor(options: JevEngineOptions = {}) {
    // Constructed eagerly so a missing key fails when the engine is built rather than
    // halfway through a run, where the fallback would absorb it and the run would look
    // like it had made an unattended decision.
    this.client = options.client ?? new TypeSafeClient();
    this.yesThreshold = options.yesThreshold ?? DEFAULT_YES_THRESHOLD;
  }

  /**
   * Which eligible action to take next.
   *
   * The candidate list is the criteria, so the engine can only answer with a label trusted
   * code put there, and the answer is validated against that list anyway — a static type
   * from an SDK is not a runtime guarantee.
   */
  async chooseNextAction(input: RouteInput): Promise<RouteChoice> {
    const criteria: Record<string, string> = {};
    for (const candidate of input.eligibleActions) {
      criteria[candidate.action] = candidate.reason;
    }
    if (Object.keys(criteria).length < 2) {
      // `choice` needs alternatives, and the router does not consult an engine for a list of
      // one, so reaching here means the two disagree about what is eligible.
      throw new DecisionEngineError(
        `a choice needs at least two candidates, and ${String(Object.keys(criteria).length)} were offered`,
      );
    }

    const answer = await this.ask("next", input, {
      next: choice(
        "Choose the eligible action that most directly reduces the unresolved risk in this upgrade. Every option is already permitted; pick the most useful one.",
        criteria,
      ),
    });
    if (answer.type !== "choice") {
      throw new DecisionEngineError(`expected a choice for the route and got ${answer.type}`);
    }

    // Through the same validator the fake and any future engine go through.
    return validateRouteChoice(
      {
        action: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      },
      input.eligibleActions.map((candidate) => candidate.action),
    );
  }

  /**
   * Whether existing tests meaningfully cover a described break.
   *
   * A yes/no, not a rubric: the question is whether a regression would be caught, and a
   * score between two undescribed ends would invite reading a number as a grade.
   */
  async assessTestCoverage(input: TestCoverageInput): Promise<TestCoverageDecision> {
    const answer = await this.ask("covered", input, {
      covered: noul(
        "Would at least one of these existing tests fail if the described breaking change were left unhandled? Answer about these tests as listed, not about tests that could be written.",
      ),
    });
    if (answer.type !== "noul") {
      throw new DecisionEngineError(`expected a yes/no for coverage and got ${answer.type}`);
    }

    const sufficient = answer.noul >= this.yesThreshold;
    return {
      sufficient,
      confidence: answer.noul,
      // Composed here rather than asked for. What the engine produced is a number; this
      // sentence says what the number was about, which is what an audit record needs.
      rationale: `the engine put the probability that one of the ${String(input.candidateTests.length)} candidate test(s) would fail without the change at ${answer.noul.toFixed(2)}, ${sufficient ? "at or above" : "below"} the ${this.yesThreshold.toFixed(2)} threshold for treating coverage as sufficient`,
    };
  }

  /**
   * Whether the change addresses every finding.
   *
   * One question per finding in a single round trip, rather than one question about the set.
   * A single yes/no over several findings cannot say *which* one is unaddressed, and that is
   * the only part of the answer a worker can act on.
   */
  async assessMigrationCompleteness(
    input: MigrationCompletenessInput,
  ): Promise<MigrationCompletenessDecision> {
    if (input.findings.length === 0) {
      // Nothing to be incomplete about, and an empty request is not worth a round trip.
      return { complete: true, confidence: null, unaddressedFindingIds: [] };
    }
    if (input.findings.length > MAX_FINDINGS_PER_REQUEST) {
      throw new DecisionEngineError(
        `${String(input.findings.length)} findings is more than one request carries; the caller should narrow the set`,
      );
    }

    const questions: Record<string, ReturnType<typeof noul>> = {};
    const keys = new Map<string, string>();
    for (const [index, finding] of input.findings.entries()) {
      // Positional keys, because a finding id contains characters a question name should not
      // have to carry, and the mapping back is kept here.
      const key = `finding_${String(index)}`;
      keys.set(key, finding.id);
      questions[key] = noul(
        `Do the listed changed files address this concern: ${finding.summary}`,
      );
    }

    const result = await this.request(input, questions);
    const unaddressed: string[] = [];
    const probabilities: number[] = [];
    for (const [key, id] of keys) {
      const answer = result[key];
      if (answer === undefined || answer.type !== "noul") {
        throw new DecisionEngineError(`no yes/no answer came back for ${id}`);
      }
      probabilities.push(answer.noul);
      if (answer.noul < this.yesThreshold) {
        unaddressed.push(id);
      }
    }

    return {
      complete: unaddressed.length === 0,
      // The weakest answer, not the average: a set is as addressed as its least addressed
      // member, and averaging would let one confident yes carry an uncertain no.
      confidence: Math.min(...probabilities),
      unaddressedFindingIds: unaddressed,
    };
  }

  /** One question, returning its answer. */
  private async ask(
    name: string,
    state: unknown,
    questions: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice>>,
  ): Promise<Answer> {
    const answers = await this.request(state, questions);
    const answer = answers[name];
    if (answer === undefined) {
      throw new DecisionEngineError(`the engine returned no answer named '${name}'`);
    }
    return answer;
  }

  private async request(
    state: unknown,
    questions: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice>>,
  ): Promise<Readonly<Record<string, Answer>>> {
    try {
      const result = await this.client.systemOne({
        // The compact factual state the caller assembled, per spec 10.2. Never a repository,
        // never a log, never release prose.
        state: asEntry(state),
        questions,
      });
      return result.answers as Readonly<Record<string, Answer>>;
    } catch (cause) {
      // Every transport failure becomes the one error type the router knows how to retry
      // once and then fall back from. The SDK's own classes stay inside this file.
      throw new DecisionEngineError(`the decision engine was unreachable or refused: ${messageOf(cause)}`, {
        cause,
      });
    }
  }
}

/** The shapes `systemOne` returns for the two question kinds this adapter asks. */
type Answer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: "score" };

/**
 * The one place state becomes a payload.
 *
 * A round trip through JSON rather than a cast. It is what actually crosses the wire, so
 * anything not representable as JSON — a function, a class instance, an undefined — is gone
 * by construction rather than by review, and the conversion cannot quietly pass along
 * something a caller attached to the object it handed over.
 */
function asEntry(state: unknown): EntryType {
  return JSON.parse(JSON.stringify(state ?? null)) as EntryType;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
