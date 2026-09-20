/**
 * Worker capability profiles.
 *
 * Each profile is a narrowing of `capabilityCeilings`, and the separations here
 * are the point of the whole design:
 *
 * - the test author can write tests but not production code, so it cannot make
 *   a failing implementation pass by editing the test that caught it;
 * - the implementer can write production code but not tests, so it cannot
 *   weaken the check that is supposed to prove its change;
 * - the verifier can run everything and write nothing, so its verdict cannot be
 *   influenced by the thing it is verifying;
 * - the publisher can push one branch and open one draft, and nothing else.
 *
 * No profile grants `lifecycleScripts: "enabled"`. Running dependency lifecycle
 * scripts is a human decision, and the run reports `human_required` rather than
 * quietly granting it.
 */

import type { WorkerId } from "@safe-upgrade/domain";
import type { AllowPolicy, SessionAllow } from "@tenuo/core";
import { oneOf } from "@tenuo/core";
import { CAPABILITIES, capabilityCeilings, type Capability, type CeilingContext } from "./capabilities.ts";

export interface WorkerProfile {
  readonly worker: WorkerId;
  readonly allow: SessionAllow;
  readonly ttlSeconds: number;
  /** Why this worker holds these capabilities. Quoted in the evidence report. */
  readonly rationale: string;
}

function pick(ceilings: SessionAllow, capabilities: readonly Capability[]): SessionAllow {
  const allow: Record<string, AllowPolicy> = {};
  for (const capability of capabilities) {
    const ceiling = ceilings[capability];
    if (ceiling === undefined) {
      throw new Error(`capability ${capability} has no ceiling`);
    }
    allow[capability] = ceiling;
  }
  return allow;
}

/** Replace one field's constraint with a tighter one. */
function tighten(allow: SessionAllow, capability: Capability, field: string, constraint: AllowPolicy[string]): SessionAllow {
  const existing = allow[capability];
  if (existing === undefined) {
    throw new Error(`cannot tighten ${capability}: not present in this profile`);
  }
  return { ...allow, [capability]: { ...existing, [field]: constraint } };
}

const READ_ONLY: readonly Capability[] = ["read_file", "list_files"];

export function workerProfiles(context: CeilingContext): Readonly<Record<WorkerId, WorkerProfile>> {
  const ceilings = capabilityCeilings(context);

  const noLifecycleScripts = (allow: SessionAllow): SessionAllow =>
    tighten(allow, "install_dependencies", "lifecycleScripts", oneOf(["disabled"]));

  const inspector = noLifecycleScripts(
    tighten(
      pick(ceilings, [...READ_ONLY, "read_git_status", "install_dependencies", "run_check"]),
      "install_dependencies",
      "lockfile",
      oneOf(["frozen"]),
    ),
  );

  const testAuthor = tighten(
    pick(ceilings, [...READ_ONLY, "write_test_file", "run_check"]),
    "run_check",
    // Running the build or lint is not this worker's job, and a narrower kind
    // set means a mistaken call is denied rather than merely unhelpful.
    "kind",
    oneOf(["test"]),
  );

  const implementer = noLifecycleScripts(
    pick(ceilings, [
      ...READ_ONLY,
      "write_source_file",
      "update_dependency",
      "install_dependencies",
      "run_check",
    ]),
  );

  const verifier = noLifecycleScripts(
    tighten(
      // `read_git_diff` because the diff policy is this worker's responsibility: it
      // has to see what changed to refuse a change that weakened a test rather than
      // satisfied it. Read-only, like everything else it holds.
      pick(ceilings, [...READ_ONLY, "read_git_diff", "install_dependencies", "run_check"]),
      "install_dependencies",
      // A verification install that is allowed to rewrite the lockfile is not a
      // verification of the lockfile we are shipping.
      "lockfile",
      oneOf(["frozen"]),
    ),
  );

  return {
    inspector: {
      worker: "inspector",
      allow: inspector,
      ttlSeconds: 900,
      rationale: "Reads repository facts and runs the baseline. Holds no write capability.",
    },
    researcher: {
      worker: "researcher",
      allow: pick(ceilings, [...READ_ONLY, "read_registry_metadata", "fetch_release_document"]),
      ttlSeconds: 300,
      rationale:
        "Reads the repository and allowlisted release sources. Cannot write, execute, or touch git.",
    },
    test_author: {
      worker: "test_author",
      allow: testAuthor,
      ttlSeconds: 600,
      rationale:
        "Writes tests and runs the test suite. Cannot write production source, manifests, lockfiles, or CI.",
    },
    implementer: {
      worker: "implementer",
      allow: implementer,
      ttlSeconds: 900,
      rationale:
        "Writes production source and moves the dependency to the requested version. Cannot write tests or CI.",
    },
    ci_author: {
      worker: "ci_author",
      allow: pick(ceilings, [...READ_ONLY, "write_ci_file"]),
      ttlSeconds: 300,
      rationale:
        "Writes workflow files under .github/workflows. Cannot write source or tests, and cannot run anything.",
    },
    verifier: {
      worker: "verifier",
      allow: verifier,
      ttlSeconds: 1_800,
      rationale:
        "Installs from the lockfile and runs every check. Holds no write capability of any kind.",
    },
    publisher: {
      worker: "publisher",
      allow: pick(ceilings, [
        "read_git_status",
        "read_git_diff",
        "create_branch",
        "commit_changes",
        "push_branch",
        "create_draft_pr",
      ]),
      ttlSeconds: 300,
      rationale:
        "Pushes the run branch and opens a draft pull request. Cannot modify the repository or merge.",
    },
  };
}

/** Capabilities a profile deliberately lacks. Asserted directly by the tests. */
export function absentCapabilities(profile: WorkerProfile): readonly Capability[] {
  return CAPABILITIES.filter((capability) => profile.allow[capability] === undefined);
}
