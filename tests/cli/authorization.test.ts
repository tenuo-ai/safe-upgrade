/**
 * Which root a command-line run trusts, spec 11 and 18.
 *
 * The property being fixed here is that the choice is never made by accident. A run under a
 * warrant and a run that minted its own authority are different things, and the difference
 * is invisible in the result: both produce the same report, and every capability ceiling
 * reads the same either way. So the only protection is that nothing slides between them
 * quietly.
 */

import { describe, expect, it } from "vitest";
import {
  chooseAuthorization,
  HOLDER_SECRET_ENV,
  ROOT_PUBLIC_KEY_ENV,
  WARRANT_ENV,
} from "@safe-upgrade/cli";

const complete = {
  [ROOT_PUBLIC_KEY_ENV]: "deadbeef",
  [WARRANT_ENV]: "warrant-blob",
  [HOLDER_SECRET_ENV]: "secret",
};

describe("running under a warrant", () => {
  it("uses it when all three are set", () => {
    const choice = chooseAuthorization(complete);
    expect(choice.authorization).toEqual({
      rootPublicKeyEnv: ROOT_PUBLIC_KEY_ENV,
      warrant: "warrant-blob",
      holderSecretEnv: HOLDER_SECRET_ENV,
    });
    expect(choice.refusal).toBeUndefined();
    expect(choice.warning).toBeUndefined();
  });

  it("passes the key and the secret by name, not by value", () => {
    // They stay in the environment. What it hands on is where to look, so neither reaches an
    // options object that gets checkpointed and reported on.
    const choice = chooseAuthorization(complete);
    expect(JSON.stringify(choice.authorization)).not.toContain("deadbeef");
    expect(JSON.stringify(choice.authorization)).not.toContain("secret");
  });

  it("does not care what NODE_ENV says", () => {
    // A warrant is a warrant. The environment only decides whether minting your own is
    // acceptable, which is a different question.
    expect(chooseAuthorization({ ...complete, NODE_ENV: "production" }).authorization).toBeDefined();
    expect(chooseAuthorization({ ...complete, NODE_ENV: "development" }).authorization).toBeDefined();
  });
});

describe("a configuration left half-finished", () => {
  it.each([ROOT_PUBLIC_KEY_ENV, WARRANT_ENV, HOLDER_SECRET_ENV])("refuses when %s is the only one set", (name) => {
    // Falling back to a self-minted root here would give someone the opposite of what they
    // were in the middle of configuring.
    const choice = chooseAuthorization({ [name]: "x" });
    expect(choice.authorization).toBeUndefined();
    expect(choice.refusal).toMatch(/All three are needed/);
  });

  it("names what is missing rather than what is wrong", () => {
    const choice = chooseAuthorization({ [ROOT_PUBLIC_KEY_ENV]: "x", [WARRANT_ENV]: "y" });
    expect(choice.refusal).toContain(HOLDER_SECRET_ENV);
  });

  it("treats an empty value as unset", () => {
    expect(chooseAuthorization({ ...complete, [WARRANT_ENV]: "" }).refusal).toBeDefined();
  });
});

describe("no warrant at all", () => {
  it("allows an explicitly requested local assessment outside development", () => {
    const choice = chooseAuthorization({}, { allowSelfAuthorizedLocalTrial: true });
    expect(choice.refusal).toBeUndefined();
    expect(choice.warning).toMatch(/minted its own authority/);
  });

  it("refuses outside a development environment", () => {
    // Rather than letting Tenuo refuse, whose message suggests TENUO_ALLOW_DEV=1 — the right
    // answer to the question it was asked, and the wrong thing to reach for when what is
    // missing is a warrant.
    const choice = chooseAuthorization({});
    expect(choice.authorization).toBeUndefined();
    expect(choice.refusal).toContain(ROOT_PUBLIC_KEY_ENV);
    expect(choice.refusal).toContain("NODE_ENV=development");
    expect(choice.refusal).not.toContain("TENUO_ALLOW_DEV");
  });

  it.each(["development", "test"])("allows it when NODE_ENV is %s, and says so", (mode) => {
    const choice = chooseAuthorization({ NODE_ENV: mode });
    expect(choice.refusal).toBeUndefined();
    expect(choice.warning).toMatch(/minted its own authority/);
    // Still says the limits held, because they did.
    expect(choice.warning).toMatch(/Every capability limit still applies/);
  });

  it("allows an explicit override, and still says so", () => {
    const choice = chooseAuthorization({ TENUO_ALLOW_DEV: "1" });
    expect(choice.refusal).toBeUndefined();
    expect(choice.warning).toBeDefined();
  });

  it("never both warns and refuses", () => {
    for (const env of [{}, { NODE_ENV: "test" }, complete, { [WARRANT_ENV]: "y" }]) {
      const choice = chooseAuthorization(env);
      expect([choice.warning, choice.refusal].filter((value) => value !== undefined).length).toBeLessThan(2);
    }
  });
});
