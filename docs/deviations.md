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
## Two constraints are written out by hand

`@tenuo/core` 0.3.0-beta.0 exports six constraint helpers — `under`, `oneOf`,
`pattern`, `exact`, `max`, `email` — and types `ConstraintExpr` as a union of
those six. The Rust core it calls through WASM understands more than that, and
parses them from the same plain objects the helpers produce. Two of those matter
enough here to write out and cast:

- `urlSafe` on `fetch_release_document`. This is the only capability that reaches
  the network, and `pattern` is the wrong tool for it: the glob is a match over
  the whole URL string, and any glob permitting the release hosts also permits
  `http://169.254.169.254/latest/meta-data/`. `urlSafe` takes a host allowlist
  and additionally refuses private, loopback, link-local, reserved, and
  metadata addresses, so an allowlisted name resolving inward is still denied.
- `regex` for the `version` argument. The glob is not path-aware — `*` matches
  `/` — so `pattern("*.*.*")` accepts `../../../etc/passwd`, which is the one
  value worth refusing when the version is interpolated into a registry URL.

An unknown constraint `kind` is rejected when the session is constructed, so a
future release that stops understanding either one fails the run immediately
rather than running unconstrained. An unknown *option* on a known kind is a
different matter: it is silently ignored, and it widens the constraint.
`{ kind: "urlSafe", domains: [...] }` builds a session and then allows
`https://evil.example/`, because the option is spelled `allowDomains`. That
failure mode is invisible to any assertion about the constraint object, so
`tests/authorization/network-constraints.test.ts` asserts against real URLs and
requires each denial to arrive as an `AuthorizationError` — proving the capability
refused it, not our own URL parsing afterwards.

The tool still checks the port, rejects embedded credentials, and re-checks the
host on every redirect hop, none of which the constraint can see.

## A zero-argument capability closes itself

A capability whose ceiling names at least one argument is closed-world: anything
unnamed is denied. An empty ceiling is not closed-world, because there is no
named argument to compare against, so an unexpected key reaches the tool body.
`read_git_status` is the only such tool, and it rejects unexpected arguments
itself via `defineTool`'s `expectedArguments`.
