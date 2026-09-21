# safe-upgrade

`safe-upgrade` is an agentic dependency-upgrade workflow for JavaScript and
TypeScript repositories. Point it at a repository and an exact package version.
It inspects the codebase, researches the release, prepares the migration in an
isolated worktree, and verifies the result against the repository's own checks.

Changing a package entry is easy. Establishing that the upgrade is safe is the
hard part. A green install leaves open whether the repository still uses a
removed API and whether the relevant behavior was actually tested. Automating
the work raises another concrete question: which files, commands, network
connections, and Git operations were each agent allowed to use?

The run applies the changes it can justify and produces an evidence-backed
result. It is also a working example of safe agent delegation with LangGraph,
Jev, and Tenuo.

## What happens during an upgrade

A run follows the same path you would want from a careful engineer:

1. Inspect the repository, dependency declaration, lockfile, workspaces, tests,
   and CI configuration.
2. Record a baseline with a frozen install and the repository's existing checks.
3. Compare the installed and target package surfaces and read available release
   guidance.
4. Work in a temporary git worktree while the source checkout stays untouched.
5. Add focused tests when an affected path lacks coverage, then apply supported
   source and dependency changes.
6. Install from the updated lockfile, rerun the checks, inspect the final diff,
   and account for every finding.
7. Save the report, evidence, route history, and authorization events for review.

Each step belongs to a specialist with a narrow Tenuo capability. LangGraph
coordinates the workflow. Jev can make bounded semantic judgements about test
coverage, migration completeness, and the next eligible action.

The result is a patch you can inspect and a clear explanation of what the run
established. `safe-upgrade` leaves merging and release decisions with your
normal review process.

## Quick start

The CLI currently runs from this checkout.

### Requirements

- Node 22.18 or newer
- pnpm
- macOS with `/usr/bin/sandbox-exec`, or Linux with Bubblewrap at
  `/usr/bin/bwrap`
- A git repository with one supported lockfile: `package-lock.json`,
  `pnpm-lock.yaml`, or `yarn.lock`
- A target package declared directly by the root project or a workspace

```bash
git clone https://github.com/tenuo-ai/safe-upgrade.git
cd safe-upgrade
pnpm install
```

Run a local trial by naming the dependency and its exact target version:

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 \
  --repository ~/src/app
```

Progress appears on stderr. The report appears on stdout, which makes JSON
output easy to pipe into another tool:

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 \
  --repository ~/src/app \
  --format json \
  --quiet > report.json
```

Run artifacts are stored in `artifacts/<run-id>` by default. Use `--artifacts`
to choose another location.

## Reading the result

The status answers a practical question: how much confidence did the run earn?

| Status | Exit | Meaning |
| --- | ---: | --- |
| `verified` | 0 | The exact target is installed, required checks pass, the diff satisfies policy, and every finding has verification. |
| `partial` | 2 | The run established part of the result and records the remaining gaps. `--partial-allowed` accepts this status with exit 0. |
| `human_required` | 3 | A specific change needs explicit approval. The report includes an approval id. |
| `blocked` | 4 | Available evidence or capabilities are insufficient to complete the upgrade safely. |
| `indeterminate` | 5 | The run could not classify the outcome. Treat the upgrade as unverified. |
| `usage` | 64 | The command arguments are invalid. |
| `unusable` | 65 | The repository does not meet a run precondition, such as having one supported lockfile. |
| `internal` | 70 | The run itself could not complete. |

The Markdown and JSON reports include findings, check results, changed files,
remaining uncertainty, and paths to the supporting evidence.

## Where Jev adds judgement

The default engine follows a deterministic action order. Add `--engine jev` to
use Jev for questions that benefit from semantic reasoning:

- Does an existing test actually exercise the breaking behavior described by a
  finding?
- Does the candidate patch address every migration finding?
- Which currently eligible specialist should act next?

```bash
TYPESAFE_API_KEY=your-key \
NODE_ENV=development \
pnpm safe-upgrade cookie@1.0.2 \
  --repository ~/src/app \
  --engine jev
```

Jev chooses from actions already made eligible by trusted workflow code. Tenuo
continues to enforce the specialist, tool, path, and argument boundaries. A
low-confidence routing answer falls back to the deterministic order. Configure
the threshold with `--confidence`, whose default is `0.6`.

Semantic assessment sends bounded excerpts from relevant tests and changed-file
patches to the configured Jev API. The request excludes process environment
variables, credentials, warrants, command output, unrelated tests, and complete
repository files. Choose the deterministic engine when repository source must
stay local.

## Supported changes

The current implementation handles a deliberately focused set of migrations:

- Move one or more named direct dependencies to exact versions and refresh the
  lockfile.
- Convert CommonJS callers and tests when a target becomes ESM-only.
- Rename a removed export when the new package surface and release guidance
  agree on the replacement.
- Add focused load tests for Node test, Vitest, Jest, or Mocha repositories.
- Add a new CI workflow that runs the checks established during verification.

When the evidence does not support a mechanical edit, the run records the
affected symbols, files, and missing decision for a person. Existing workflows
and ambiguous API replacements stay in the review path. Dependency lifecycle
scripts remain disabled throughout installs and updates.

Two fixtures make useful first examples:

- `fixtures/legacy-app` with `escape-string-regexp@5.0.0` demonstrates an ESM
  migration that asks for approval.
- `fixtures/prefix-tool` with `postcss@8.4.35` demonstrates a removed export
  that the existing test suite does not catch.

## Approving a sensitive change

Some changes sit outside every specialist's standing authority. Setting
`package.json` to `"type": "module"` is one example. The first run returns
`human_required` with an approval id and leaves that change pending.

```bash
NODE_ENV=development pnpm safe-upgrade escape-string-regexp@5.0.0 \
  --repository ~/src/app \
  --approve 4f3c2b1a \
  --approved-by alice
```

The approval is bound to the exact worker, tool call, path, field, and value
reported by the original run.

## Workspaces and companion upgrades

Use `--workspace` for the package that declares the dependency. Repeat
`--companion` when a compatible upgrade requires additional exact package
versions.

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 \
  --repository ~/src/app \
  --workspace packages/app \
  --companion nanoid@5.0.0
```

Workspace globs such as `packages/*` are expanded during inspection. Peer
dependencies outside the named upgrade set are reported for human review.
`--allow-transitive` permits additional lockfile version movement.

## Use it in CI

### Open a draft pull request

After a verified run, `--draft-pr` pushes the run branch and opens a draft pull
request. The publisher capability is scoped to that branch and draft operation.
Provide `GITHUB_TOKEN` or `GH_TOKEN` through the environment.

```bash
NODE_ENV=development pnpm safe-upgrade left-pad@1.3.0 \
  --repository ~/src/app \
  --draft-pr \
  --github-repository acme/app
```

`--publish` remains available as an older name for the same option.

### Assess a Dependabot pull request

Run from the pull request's base branch:

```bash
NODE_ENV=development pnpm safe-upgrade --from-event
```

`--from-event` reads the package, target version, workspace, grouped companion
updates, and pull request number from `GITHUB_EVENT_PATH`. It can post the
result for `verified`, `blocked`, and `human_required` runs.

See [`examples/dependabot-assess.yml`](examples/dependabot-assess.yml) for event
assessment and [`examples/scheduled-draft.yml`](examples/scheduled-draft.yml)
for a manually triggered draft upgrade.

## How repository code is contained

Tenuo controls which operations each specialist can request. An operating
system sandbox contains the package and repository code launched by those
operations.

- Package downloads have network access with lifecycle scripts disabled.
- Tests, builds, typechecks, and package surface probes run without network
  access.
- Child processes receive an empty temporary home directory.
- Writes are limited to the disposable worktree and run-local scratch space.
- Verification detects any command that changes the candidate under review.

The command stops if the operating-system sandbox is unavailable.
`SAFE_UPGRADE_ALLOW_UNSANDBOXED=1` supports test infrastructure that already
provides equivalent isolation. The CLI prints a prominent warning when this
setting is active.

## Environment configuration

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` or `GH_TOKEN` | Authenticate draft pull requests and pull request comments. |
| `TYPESAFE_API_KEY` | Enable `--engine jev`. |
| `TENUO_ROOT_PUBLIC_KEY` | Identify the production authorization root. |
| `TENUO_RUN_WARRANT` | Supply the production run warrant. |
| `TENUO_RUN_HOLDER_SECRET` | Prove possession for the production run warrant. |
| `NODE_ENV=development` | Allow a local trial to mint and clearly report its own authority. |
| `SAFE_UPGRADE_ALLOW_UNSANDBOXED=1` | Disable process isolation inside pre-isolated test infrastructure. |

The three Tenuo production variables are used together. Run
`pnpm safe-upgrade --help` for the complete CLI reference.

For the worker boundaries, routing rules, verification policy, and authorization
model, read [`docs/architecture.md`](docs/architecture.md).
