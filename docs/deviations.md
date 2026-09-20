# Deliberate departures from the spec

The spec in `docs/spec.md` is the contract. Where the implementation differs, it
is recorded here with the reason. Every item below narrows authority or moves a
check earlier; none of them relax a requirement.

## Booleans replaced by closed vocabularies for install behavior

The spec's `install_dependencies({ manager, frozen, ignoreScripts })` uses
booleans. Tenuo constraints can pin a boolean to one value (`exact(true)`) but
cannot express "either boolean", so a parent session that must permit both values
cannot be written, and the per-worker narrowing the spec asks for becomes
impossible.

The arguments are now `lockfile: "frozen" | "update"` and
`lifecycleScripts: "disabled" | "enabled"`. `oneOf` narrows these per worker, so
the verifier is restricted to `oneOf(["frozen"])` and no profile is granted
`"enabled"` at all. The audit log also reads better for it.

## `install` is its own capability, not a `run_check` kind

The spec's profile table folds `install` into `run_check`'s `kind` set. An install
carries different arguments and the lifecycle-script decision, so it is a separate
capability. A worker can then be allowed to run tests without being allowed to
install anything.

## The package manager is context, not an argument

The spec passes `manager` to the process tools. It is read from the run context
instead, so there is no per-call argument to tamper with and no possibility of a
worker driving `yarn` against an npm lockfile.

## No separate `update_manifest` tool

The spec lists `update_manifest` alongside lockfile updates. Since the spec also
forbids hand-editing lockfile resolution data, both changes must go through the
package manager anyway, so `update_dependency` performs them together and the
manifest is excluded from every text-write tool's allowed file classes. One
capability, and the manifest and lockfile cannot drift apart.

## Arguments are always flat scalars

Tenuo constraints evaluate scalar values; an array argument is denied. So
`read_git_diff({ paths })` became `read_git_diff({ pathspec })` and no tool takes
a list. Where the spec implied an optional argument, the argument is required with
an explicit sentinel, because a constraint rejects both `null` and an omitted
value.

`expectedBeforeHash` uses the sentinel `"absent"` to mean "this file should not
exist yet", which keeps optimistic concurrency expressible without a nullable
argument.

## Path classification lives in the tool, not the capability

`under()` is path algebra on the string it is given, so it cannot see through a
symlink, and it has no opinion about whether a path is a test or production code.
Capabilities therefore constrain the *root*, and the tool decides the file class
from the path alone and re-resolves it through `realpath`. A cross-class write is
refused as a `ToolExecutionError` rather than an authorization denial, which is
visible in the tests: the tool body is entered, and nothing is written.

## A failing baseline caps the result at `partial`

The spec allows a run to continue past a failing required baseline when
configuration permits a partial result. It does not say what the final status may
be. The classifier refuses `verified` in that case, because a passing check after
the change proves nothing when the same check was failing before it.
## Constraint choices worth explaining

Two arguments use something other than the obvious constraint, both because
`pattern()` is a glob over the whole value and its `*` is not path-aware:

- `fetch_release_document.url` uses `urlSafe({ allowDomains, schemes })`. This is
  the only capability that reaches the network, and any glob permitting the
  release hosts also permits `http://169.254.169.254/latest/meta-data/`. On top
  of the host allowlist the core refuses private, loopback, link-local, reserved,
  and metadata addresses, so an allowlisted name resolving inward is still denied.
  The tool additionally rejects odd ports and embedded credentials and re-checks
  the host on every redirect hop, none of which the constraint can see.
- `read_registry_metadata.version` uses `regex()`. Since `*` matches `/`,
  `pattern("*.*.*")` accepts `../../../etc/passwd`, which is the one value worth
  refusing when the version is interpolated into a registry URL. A regex may only
  be narrowed to an `Exact` during delegation, which costs nothing here because no
  profile narrows the version: a researcher needs metadata for both the installed
  version and the target.

Arguments that genuinely have no constraint use `wildcard()` rather than
`pattern("*")` — a file body or a PR description is any value at all, not a value
of any shape.

`tests/authorization/network-constraints.test.ts` asserts against real URLs and
requires each denial to arrive as an `AuthorizationError` rather than a
`ToolExecutionError`, which is what proves the capability refused the call and not
our own URL parsing afterwards.

## A zero-argument capability closes itself

A capability whose ceiling names at least one argument is closed-world: anything
unnamed is denied. An empty ceiling is not closed-world, because there is no
named argument to compare against, so an unexpected key reaches the tool body.
`read_git_status` is the only such tool, and it rejects unexpected arguments
itself via `defineTool`'s `expectedArguments`.

## The verifier does not provision its own worktree

Spec 13.6 opens with "start from a new worktree or clean copy". The verifier does
not do this, and should not: creating a worktree is not among its capabilities,
and a verifier able to provision its own environment could provision a
favourable one. Isolation belongs to trusted code, so a second worktree for
verification is the runner's job to supply. Today the verifier verifies in the
run's worktree, after a frozen clean install. It does hold `read_git_diff`, because
the diff policy is its responsibility and it cannot refuse a change that weakened a
test without seeing what changed.

## Detection runs before the inspector, not inside it

Spec 13.1 lists `RepositoryFacts` as an inspector output. They are produced by
`@safe-upgrade/bootstrap` before the graph starts, because the capability
ceilings are derived from them: the worktree root that `under()` contains, the
branch that `exact()` pins, the package manager whose executable gets spawned. A
worker whose output determined its own authority could widen it. The inspector
confirms the facts through its capabilities — it reads git status and checks the
worktree is clean and at the expected commit — and records them into state.

## Research derives findings from structure, not from prose

Spec 13.2 has the researcher read release notes and produce findings. It retrieves
them, stores them as hashed evidence, and quotes an extract — but the rules that
produce findings never read that text. They run on published manifest fields and on
call sites found in the repository's own source.

This is deliberate and it is a narrowing. Retrieved release prose is the most
attacker-reachable input in the system, and a rule that branches on what it says is a
rule an attacker can steer. Reading it is a semantic judgement, which belongs to the
decision engine; with no engine configured, the structural rules still run and
anything they cannot settle is recorded as uncertainty rather than as an absence of
problems. A major bump with no structural explanation says exactly that.

`tests/workers/research.test.ts` asserts that a release note containing "IGNORE ALL
PREVIOUS INSTRUCTIONS" produces identical reasoning to one that does not, and that
the note is still stored verbatim as evidence — a reviewer needs to see the part that
tried something.

## The codemod converts whole files or none of them

The ESM conversion recognises a small set of forms and refuses everything else,
naming the line. `exports.foo = ...`, computed or conditional `require`, `__dirname`,
and `require.resolve` are all refusals rather than guesses.

The failure mode being avoided is specific: a transform that converts most of a file
produces something that parses, imports cleanly, and behaves differently. That is the
worst possible outcome for a change whose entire purpose is to be verifiable, and it
is exactly what a test suite is least likely to catch. A refusal costs a run that
stops with a reason; a partial conversion costs a migration nobody can trust.

## The test author acts on the finding, not on the manifest

Test files have to become ES modules along with the code they import, and only the
test author may write them. The obvious trigger — wait until the manifest says
`"type": "module"` — deadlocks, because the implementer's migration is what sets that
field and the implementer cannot finish while a test file it may not touch still
loads the package the old way.

So the test author converts test files when the *finding* says the package is going to
move, before the implementer runs. The cost is a window between the two workers in
which the suite is inconsistent, and nothing runs it in that window.

## `author_tests` is not gated on an assessment existing

The spec's fallback order (10.3) puts `author_tests` ahead of both
`assess_verification` and `implement`. Requiring an assessment before authoring
therefore deadlocks: `implement` outranks the assessment, wins every round, and the
assessment never happens.

The test author assesses as part of authoring instead — once before writing, which is
the record of what was missing, and once after, which is what makes the rule stop
being true and keeps the router from sending it back to write a test it already
wrote. The `assess_verification` phase remains reachable and is simply not reached in
this shape of run.

## A finding that no edit can discharge says so

`node-requirement-raised` is marked `noSourceChangeRequired`. There is no edit that
addresses a raised Node floor; it is a fact to confirm against the versions CI runs.
Without the flag the implementer stays eligible forever over something it cannot act
on, and the run burns its attempt budget instead of verifying.

It still costs the run its `verified` status, and the report says why: the claim has
no corresponding change. Confirming it belongs to the CI author, which is not written
yet.

## Only the verifier marks a finding verified

`verifiedFindingIds` is set by the verifier alone, from checks it ran itself against a
clean frozen install. A finding whose affected files no test reaches is excluded even
when everything passed, because a green suite that never loads the changed code has
not established anything about it — the test author's assessment is what identifies
those.

"A test was written for it" is a claim about a test. This is a claim about a test that
executed.
