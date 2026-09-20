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

It is discharged by the CI author instead, and only in one specific way: the workflow
it writes pins a Node version, and the finding is claimed as addressed when that
version satisfies the floor the researcher read. A floor that cannot be parsed leaves
the finding unaddressed and the run short of `verified`, which is the honest outcome —
nobody has established that CI runs a version the package accepts.

## Only the verifier marks a finding verified

`verifiedFindingIds` is set by the verifier alone, from checks it ran itself against a
clean frozen install. A finding whose affected files no test reaches is excluded even
when everything passed, because a green suite that never loads the changed code has
not established anything about it — the test author's assessment is what identifies
those.

"A test was written for it" is a claim about a test. This is a claim about a test that
executed.

## The CI author adds a workflow and never edits one

Editing `ci.yml` is text surgery on the file that decides what gates a merge, and the
failure mode is quiet: a step dropped from an existing workflow removes a gate and
leaves the green tick that says it is still there. Adding a file cannot do that. The
new checks arrive where a reviewer sees them next to the old ones, and folding them
together is a decision this system does not make.

It also means a repository accumulates a second workflow rather than a tidier first
one. That is the trade, taken deliberately.

## A runtime requirement is discharged only when both halves hold

Pinning a Node version in CI is not on its own enough to settle a raised requirement.
The repository's own `engines.node` has to agree: a package declaring `>=10` while its
dependency needs 12 is broken for whoever installs it on Node 10, whatever CI runs. The
CI author can read `engines` but cannot edit it, so a disagreement leaves the finding
unaddressed and the run short of `verified` with that as the reason.

Version ranges are compared at major granularity, because `node-version: "22"` resolves
to whichever 22.x is newest. That makes lower bounds safe to read loosely and forces
upper bounds to be read strictly: `<22.5` is treated as unsatisfied, because the version
that actually runs is not pinned that finely. Ranges in forms the comparison does not
fully cover — `~`, `x` ranges, hyphen ranges, bare versions — return "unknown" rather
than an approximation, and unknown leaves the finding unaddressed. An approximation here
would become a claim that a runtime requirement is met.

## CI coverage is read from `run:` lines, and errs towards missing

There is no YAML parser here, and a real one would not settle the question anyway: a
`run: npm run ci` whose script invokes the build is covered, and nothing short of
executing it can tell. The reading looks at `run:` lines for the check's own command,
which means an indirectly reached check is reported as missing.

The bias is the point. Reporting a gap that is not there costs a duplicated step in
CI. Reporting coverage that is not there costs a gate nobody knows is gone. The unit
tests pin which way it errs, including the `npm run ci` case it gets wrong.

## Nothing can commit except the publisher, and only on the run branch

`commit_changes` exists because a pushed branch with no commits is worse than no
branch: it looks, from the outside, like an upgrade that worked. Only the publisher
holds it, it refuses to run unless HEAD is the run branch, and it passes `--no-verify`
— repository hooks are code the repository supplies, and this system does not run
repository code as a side effect of an unrelated action.

The commit identity is the run's own rather than the user's git config, so a commit is
never misattributed to whoever's machine it happened on.

## An approval takes effect in the pass that asked for it

A worker's request for elevation only reaches graph state as a result of the pass that
made it, so an approval supplied up front cannot be matched during that pass. Left
alone, approving something would cost a whole routing round that did nothing, and a
run that had been given the answer would look as though it had ignored it.

The graph retries the worker once when a request it just made has a grant. This is
sound only because a worker that asks for elevation returns without writing anything:
the retry replaces a pass that did nothing rather than repeating a pass that did
something. It happens at most once, because the second attempt is handed the approval
and has no reason to ask again.

## Publishing is a separate approval from wanting a draft

`createDraftPullRequest` says a draft is wanted. `publishApproved` says someone agreed
to push. The second is never inferred from the first, and neither is inferred from the
run's own verdict: `verified` is this system's opinion of its own work, and treating it
as permission to push would let the thing being checked decide it had passed.

A verified run that nobody approved for publishing says where the branch is and stops.

## Reading a package's exports means loading it

Spec section 12 lists the protected tools, and none of them executes a dependency. Finding
an API change requires one that does, so this is a deliberate addition.

An API change is invisible in a package manifest. postcss 7 and 8 both publish as
CommonJS, with the same entry point and the same callable export; the difference is that
`postcss.vendor` exists in 7 and does not in 8. No comparison of manifest fields finds
that, and the only other place it is written down is release prose, which this system does
not derive decisions from. What remains is to install both versions and look at what they
export, which means running their top-level code.

So `read_package_exports` does that, bounded:

- a scratch directory outside the run's worktree, installed with `--ignore-scripts`, so no
  lifecycle script runs;
- a child process with the run's usual bounds — no shell, an environment allowlist, an
  output cap, a timeout, process-tree termination;
- the child is handed the installed directory and nothing else: no repository path, no
  argument a worker chose. It prints names and exits;
- the researcher alone holds the capability, bounded to the one package the run may
  upgrade and to a version matching a semver pattern rather than a glob, because the
  version reaches an installer argument;
- an unreadable surface is recorded as a limit on what the run can conclude, not raised as
  a failure.

The authority is not new in kind. The repository is about to depend on this exact version,
and the verifier already runs a clean install and the repository's own scripts, which load
it anyway. What changes is that it happens earlier, so that a break is found by name
instead of from a stack trace.

## A removed export is found structurally and then refused

The finding that an export is gone is certain: the name was present in one installed
version and absent in the other, so its confidence is 1. What replaced it is not a
structural question at all. A set difference cannot distinguish a rename from a removal,
and "one name left and another arrived" is a coincidence often enough that acting on it
would be guessing — guessing that puts an API which does not exist into source that has to
compile.

So the implementer does not attempt these. It reports the symbol, the files that reach it,
and the names the target added as somewhere to look, and the run ends `blocked`. That is a
worse-sounding outcome than a rewritten lockfile and a green test suite, and a better one:
the fixture for this case passes its tests at the target version, because the only covered
call site is one that survives.

Counting uses excludes the line that imports the name. That line has to change too, which
is why it is left out rather than reported: "reaches it in two places" should mean two
uses, not one use and its import.

## What the export comparison does not see

It reads text, not types. A name reached through a computed access, through a local alias,
or through a re-export is not found, so "no reference found" means "none visible here"
rather than "none". It also says nothing about a change in what an export *does* or in the
arguments it takes, which is why a major bump with an unchanged export surface still
reports that its call sites were not assessed — now saying that the exports were compared
and none this repository uses were removed, which is a narrower and more useful statement
than the one it replaces.

## The engine writes no prose, so the rationale is ours

Spec 10.1 gives `assessTestCoverage` a `rationale` string, and the natural reading is
that the engine explains itself. The adapter does not ask it to. `systemOne` answers
bounded questions — a label from a list, or a probability — and an explanation would be
generated text, which spec 10.4 puts outside what this project acts on. So the rationale
is composed in trusted code from the question asked and the number returned: what the
probability was about, what the threshold was, and which side of it the answer fell on.
That is what an audit record needs. It is deliberately not a model's account of its own
reasoning, because such an account is unfalsifiable and would read, in a pull request, as
evidence.

## Completeness is asked one finding at a time

Spec 10.4 lists "whether the evidence and patch address every identified migration
concern" as a single judgment. The adapter asks one yes/no per finding instead, in one
round trip. A single answer over a set can say that something is unaddressed but not
which thing, and the finding id is the only part a worker can act on. The set's
confidence is then the weakest of the answers rather than their average, because a set is
no more addressed than its least addressed member.

## The adapter neither retries nor falls back

Both belong to the router, which already implements spec 10.3: one retry for a malformed
answer, the deterministic order after that, and the confidence threshold on top. An
adapter that also retried would turn one attempt into four without saying so, and one that
fell back on its own would hide from the audit that the engine had failed at all. So every
transport failure and every unexpected shape becomes a single `DecisionEngineError` and
leaves the adapter immediately.

## The live service is not exercised

The adapter is tested against a stubbed client. That covers what the adapter is for —
rejecting a label nobody offered, refusing a partial answer set, keeping the SDK's error
classes from escaping, and bounding what crosses the wire — but it measures nothing about
how the real model scores these particular questions. The confidence threshold and the
yes/no threshold are therefore set from first principles rather than from observation, and
should be revisited once there is a run against the service to observe.
