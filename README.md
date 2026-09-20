# safe-upgrade

A service and CLI that prepares a single TypeScript dependency upgrade and can
actually show its work: which release notes it read, which code it changed, which
tests prove the change, and which claims it could not establish.

LangGraph coordinates the workflow. Jev picks the next eligible specialist and
answers bounded semantic questions. Tenuo gives each specialist a different,
narrower set of capabilities. Deterministic code does the authorizing, the file
and process work, and the final verdict.

The full engineering specification is in [`docs/spec.md`](docs/spec.md).

## Status

Implemented so far:

| Package | What it does |
| --- | --- |
| `@safe-upgrade/domain` | Closed unions, Zod validation, typed errors, deterministic result classification |
| `@safe-upgrade/evidence` | Content hashing, secret redaction, append-only audit log |
| `@safe-upgrade/tools` | Path safety, file, process, package, release, git, and GitHub tools |
| `@safe-upgrade/authorization` | Capability ceilings, worker profiles, session registry, delegation broker |
| `@safe-upgrade/jev` | Decision engine contract, response validation, deterministic fallback, offline engine |
| `@safe-upgrade/graph` | LangGraph state machine, transition allowlist, eligibility predicates, router |
| `@safe-upgrade/bootstrap` | Worktree isolation and repository detection, both trusted code |
| `@safe-upgrade/workers` | All seven: inspector, researcher, test author, implementer, CI author, verifier, publisher |
| `@safe-upgrade/runner` | Assembles a run and writes the evidence |

A run works end to end today against `fixtures/legacy-app`, which is pinned to
`escape-string-regexp` 4 and upgraded to 5. Nothing is mocked: a real worktree, a
real `npm ci`, the registry over the network, the repository's own scripts as child
processes, every tool call authorized, and a classified result with its evidence on
disk.

What the run works out for itself is worth stating, because none of it is
configured. From the two published manifests it derives that 5.0.0 is ESM-only and
that `require()` of it will throw, and cites the documents it read. It finds both
call sites in the repository's source. It notices that one of them has no test at
all and writes one. It converts the package to ESM, refusing any file it cannot
convert in full. Then it verifies from a clean frozen install.

The first run of that upgrade stops at `human_required`, because the migration needs
`package.json`'s `type` field set and no worker holds that capability by default. It
reports what it wants approved, by id, and changes nothing while it waits. Approving
that id and re-running completes the migration and verifies it. See
[capability elevation](#capabilities-a-human-has-to-approve).

The fixture's own workflow runs the tests and never the build, on purpose: a
dependency that breaks at build time would reach main behind a green tick. The run
notices, and adds a workflow that runs the checks it was verified against, on a Node
version that satisfies the floor the upgraded package states. It adds a file rather
than editing `ci.yml`, because a step accidentally dropped from an existing workflow
removes a gate while leaving the tick.

With that, the approved run reaches `verified` and states the five conditions that
earned it. Publishing is a further decision: the run commits to its own branch,
pushes it, and opens a draft pull request only when a person has approved that
separately. It cannot merge, cannot mark a draft ready, and cannot push any branch
but its own.

A second fixture, `fixtures/prefix-tool`, covers the harder shape: a break that no
manifest announces. It is pinned to `postcss` 7 and upgraded to 8, and both versions
publish as CommonJS with the same entry point — the difference is that
`postcss.vendor` exists in 7 and does not in 8. The run finds that by installing both
versions and comparing what they export, then finds which of the repository's files
reach the missing name and which do not.

It then refuses to fix it. What replaced a removed export is not a structural
question, and a set difference cannot tell a rename from a removal, so the run ends
`blocked` naming the symbol, the file, and the names the target added as somewhere to
look. That is the point of the fixture: its test suite *passes* at the target
version, because the only covered call site is one that survives, so a run that
trusted a green suite would have reported success on code that does not build.

Not built yet: the Jev SDK adapter. With no engine configured the router uses the
deterministic priority order, which is a supported configuration rather than a
placeholder — the route is then a pure function of graph state.

## The shape of the security argument

Three things carry the guarantee, and none of them depend on a model behaving.

**Capabilities differ per worker, and a tool reference is not authority.** Every
worker receives the same object graph of protected tools. What differs is the
session it runs under. The test author can call `write_source_file` — it just gets
denied, before the function body runs.

**Every argument is named in a policy.** Tenuo runs a capability in zero-trust
mode once its ceiling is non-empty: an argument the policy does not mention is a
denial rather than a silent pass. The ceilings are typed against each tool's
argument record, so forgetting one is a build error instead of a surprise at run
time.

**Narrowing is one-directional.** A child session is derived from the parent with
`narrow()`, which refuses to add a capability the parent lacks. The parent holds
exactly the union of the ceilings, so the maximum authority of the whole run is
one object you can read.

<h3 id="capabilities-a-human-has-to-approve">Capabilities a human has to approve</h3>

Some writes belong to an upgrade and are still too consequential to hand a worker by
default. Setting `package.json`'s `type` is the case that forced the question: it is
exactly what a CommonJS-to-ESM upgrade needs, and it changes how every file in the
package loads. Letting `write_source_file` accept manifests would have been the easy
answer and the wrong one, since a worker able to write that file can give itself a
`postinstall` script and a `test` script that always passes.

So the capability exists in the run's ceiling, in no worker's standing profile, and a
worker that needs it records a request and stops. Four properties do the work:

- **The approval names the call, not the capability.** A request carries the worker,
  the capability, and the exact argument values; the grant carries only a digest of
  those. Approving `type: "module"` cannot be replayed as `type: "commonjs"`, cannot
  be pointed at another manifest, and cannot be handed to another worker.
- **The approval becomes the constraint.** The broker narrows the ceiling's own
  constraints with an `exact()` per approved argument, so the session permits
  precisely the approved call. An approval for something outside the ceiling produces
  a chain Tenuo refuses to build, which is recorded as a refusal rather than crashing
  the run.
- **Asking and answering are separate.** The request comes from a worker and lives in
  graph state; the grant is run configuration from outside. Nothing a worker returns
  can approve anything.
- **The request outlives the run.** Its arguments are worktree-relative, so an
  approval still means something after the temporary worktree it referred to is gone.

`tests/authorization/elevation.test.ts` asserts the negative cases, which are the
ones that matter: an approval that could be moved between workers or nudged to a
neighbouring value would be worse than no approval at all, because the audit trail
would claim a human agreed to something they did not.

**The decision engine chooses, but it doesn't authorizes.** The router computes the
eligible actions deterministically, the engine picks one from that exact list, the
response is validated against the same list, and trusted code maps the chosen
action to a worker. An engine that returns an action nobody offered is rejected
rather than retried, and a low-confidence answer is replaced by a fixed priority
order. There is no wording that gets `publish_draft` offered before verification
passed, and no response that supplies a worker identity.

A few consequences:

- No profile can enable dependency lifecycle scripts. That is a human decision,
  and the run reports `human_required` instead of granting it.
- The verifier holds no write capability, so it cannot influence what it verifies.
- `create_draft_pr` pins `draft` to `true` in the capability, not in a code path.
- Sessions live in an in-memory registry that throws if anything tries to
  serialize it, which is what keeps warrants out of LangGraph checkpoints.

## Working on it

```bash
pnpm install
pnpm typecheck
pnpm test
```

Tests run against the real Tenuo WASM core, not a mock. `createTenuo.devRoot()`
requires `NODE_ENV` to be `development` or `test`; the vitest config sets it.

Production runs must import a warrant from a trusted issuer rather than minting
their own root. Both paths are in `packages/authorization/src/tenuo.ts`, and the
difference between them is the difference between a demo and a deployment.
