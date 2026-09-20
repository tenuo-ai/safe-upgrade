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

Not built yet: the Jev SDK adapter, the specialist worker implementations, the
report generator, and the end-to-end fixture. The graph runs today against
scripted workers and the deterministic decision engine, which is how the routing
tests exercise it without network access.

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
