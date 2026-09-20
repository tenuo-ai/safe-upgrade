/**
 * Which authorization root a command-line run trusts, spec 11 and 18.
 *
 * Two roots exist and they are not interchangeable. A warrant issued elsewhere means this
 * process can narrow authority it was given and cannot grant itself any; the development
 * root mints its own, which makes every capability ceiling in the codebase a statement
 * about intent rather than a constraint anybody checked.
 *
 * So the choice is explicit, read from the environment, and reported. What it must never be
 * is silent: Tenuo's own refusal to use a development root outside development is correct,
 * but it arrives as a message suggesting `TENUO_ALLOW_DEV=1`, which is the wrong thing for a
 * person to reach for when what they actually lack is a warrant.
 */

import type { ProductionAuthorization } from "@safe-upgrade/runner";

/** Spec 18's configuration, by the names it gives them. */
export const ROOT_PUBLIC_KEY_ENV = "TENUO_ROOT_PUBLIC_KEY";
export const WARRANT_ENV = "TENUO_RUN_WARRANT";
export const HOLDER_SECRET_ENV = "TENUO_RUN_HOLDER_SECRET";

export interface AuthorizationChoice {
  /** Absent means the development root. */
  readonly authorization: ProductionAuthorization | undefined;
  /** Said on stderr before the run, when there is something a person should know. */
  readonly warning: string | undefined;
  /**
   * Set when the run must not start. Present instead of letting Tenuo refuse, because its
   * refusal suggests `TENUO_ALLOW_DEV=1` — which is the right answer to the question it was
   * asked and the wrong thing to reach for when what is missing is a warrant.
   */
  readonly refusal: string | undefined;
}

/** Environments where a self-minted root is a reasonable thing to be using. */
function isDevelopment(env: Readonly<Record<string, string | undefined>>): boolean {
  const mode = env["NODE_ENV"];
  return mode === "development" || mode === "test" || env["TENUO_ALLOW_DEV"] === "1";
}

export function chooseAuthorization(
  env: Readonly<Record<string, string | undefined>>,
): AuthorizationChoice {
  const present = [ROOT_PUBLIC_KEY_ENV, WARRANT_ENV, HOLDER_SECRET_ENV].filter(
    (name) => (env[name] ?? "") !== "",
  );

  if (present.length === 3) {
    return {
      authorization: {
        rootPublicKeyEnv: ROOT_PUBLIC_KEY_ENV,
        // The only one passed by value, because it is what gets verified rather than what
        // does the verifying. The key and the secret stay in the environment.
        warrant: env[WARRANT_ENV] ?? "",
        holderSecretEnv: HOLDER_SECRET_ENV,
      },
      warning: undefined,
      refusal: undefined,
    };
  }

  if (present.length > 0) {
    // Half a configuration is more dangerous than none: someone set out to run under a
    // warrant, and falling back to a self-minted root would quietly give them the opposite
    // of what they were configuring.
    const missing = [ROOT_PUBLIC_KEY_ENV, WARRANT_ENV, HOLDER_SECRET_ENV].filter(
      (name) => !present.includes(name),
    );
    return {
      authorization: undefined,
      warning: undefined,
      refusal: `${present.join(", ")} is set but ${missing.join(" and ")} is not. All three are needed to run under a warrant, and falling back to a self-minted root would be the opposite of what you were configuring.`,
    };
  }

  const setThem = `Set ${ROOT_PUBLIC_KEY_ENV}, ${WARRANT_ENV}, and ${HOLDER_SECRET_ENV} to run under a warrant an issuer granted`;
  if (!isDevelopment(env)) {
    return {
      authorization: undefined,
      warning: undefined,
      refusal: `${setThem}. For a local trial without one, set NODE_ENV=development, which runs with authority this process minted for itself.`,
    };
  }

  return {
    authorization: undefined,
    warning: `NODE_ENV is ${String(env["NODE_ENV"] ?? "unset")} and no warrant is configured, so this run minted its own authority. Every capability limit still applies, but nothing outside this process attested to them. ${setThem}.`,
    refusal: undefined,
  };
}
