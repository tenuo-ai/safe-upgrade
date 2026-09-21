# safe-upgrade

`safe-upgrade` upgrades a JavaScript or TypeScript dependency and establishes
what changed. It inspects the repository, researches the target release, works
in an isolated git worktree, and verifies the result against the repository's
own checks.

A successful install is only part of an upgrade. The repository may still use a
removed API, and the existing suite may never exercise the affected behavior.
`safe-upgrade` turns those gaps into findings, tests, source changes, and an
evidence-backed result you can review.

## Quick start

Requirements:

- Node 22.18 or newer and Git
- The package manager used by the repository being assessed
- macOS with `/usr/bin/sandbox-exec`, or Linux with `/usr/bin/bwrap`
- A git repository using `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`

```bash
npx @tenuo/safe-upgrade doctor
npx @tenuo/safe-upgrade assess --repository ~/src/app
```

The assessment ends with an id and a continuation command. If the findings look
right, continue from that exact repository state:

```bash
npx @tenuo/safe-upgrade apply <assessment-id>
```

The assessment selects an outdated direct dependency and shows the
repository-specific risk, affected files, existing verification coverage, and
the Tenuo warrant used by each specialist. It does not offer any writing worker
and finishes with a command you can copy to continue the upgrade. `apply`
refuses to reuse the assessment if the commit, manifest, lockfile, or working
tree has changed.

You can also assess a specific target:

```bash
npx @tenuo/safe-upgrade assess postcss@8.4.35 \
  --repository ~/src/app
```

Targets are always exact versions. Progress is written to stderr, the report to
stdout, and the full run record outside the repository under
`~/.local/state/safe-upgrade`. Set `SAFE_UPGRADE_HOME` to choose another state
directory.

For JSON output:

```bash
npx @tenuo/safe-upgrade assess postcss@8.4.35 \
  --repository ~/src/app \
  --format json \
  --quiet > report.json
```

## Handle a repository-specific migration

Built-in migrations cover common changes such as an ESM-only release or a
confirmed export rename. Add Jev and a coding model when the upgrade needs a
behavioral test and source change tailored to the repository:

```bash
OPENAI_API_KEY=your-openai-key \
TYPESAFE_API_KEY=your-jev-key \
NODE_ENV=development \
npx @tenuo/safe-upgrade postcss@8.4.35 \
  --repository ~/src/app \
  --engine jev \
  --patch-model your-model-id
```

The coding model receives the affected files, relevant release evidence, and
the findings it must address. It returns structured test and source proposals.
Jev assesses whether the test covers the reported break and whether the final
migration is complete.

## What the run does

1. Inspect the dependency declaration, lockfile, workspaces, tests, and CI.
2. Frozen-install the current repository and record its existing checks.
3. Compare the installed and target package surfaces and read release guidance.
4. Identify affected call sites and missing test coverage.
5. Add focused tests, update the dependency, and migrate affected source.
6. Frozen-install again, rerun the checks, and inspect the final diff.
7. Save the findings, evidence, route, authorization events, and result.

The source checkout is read but not modified. All candidate changes happen in a
temporary worktree. Merging remains part of the normal review process.

## How the pieces fit

| Component | Responsibility |
| --- | --- |
| **LangGraph** | Carries run state across inspection, research, test authoring, implementation, verification, and publishing. |
| **Jev** | Answers bounded semantic questions about test coverage, migration completeness, and the next eligible action. |
| **Coding model** | Proposes repository-specific behavioral tests and source migrations as structured patches. |
| **Tenuo** | Gives each specialist a warrant limited to the tools and arguments required for its step. |

The model receives no tool or warrant. Trusted worker code validates every
proposed path, file hash, and finding id before applying it. The test author and
implementer use separate Tenuo warrants, so each can write only its own file
class. Verification runs independently after both steps.

See [How a run is put together](docs/architecture.md) for the full worker model,
Jev decision boundaries, warrant constraints, sandboxing, and verification
policy.

## Reading the result

| Status | Exit | Meaning |
| --- | ---: | --- |
| `verified` | 0 | The exact target is installed, required checks pass, the diff satisfies policy, and every finding has verification. |
| `partial` | 2 | Part of the result was established and the remaining gaps are recorded. |
| `human_required` | 3 | A specific change needs an explicit approval. |
| `blocked` | 4 | Evidence or delegated authority was insufficient to finish safely. |
| `indeterminate` | 5 | The run could not classify the outcome as safe. |

The Markdown and JSON reports include findings, check results, changed files,
remaining uncertainty, and links to supporting evidence. Run
`npx @tenuo/safe-upgrade --help` for all exit codes and CLI options.

## Supported changes

Without a patch model, `safe-upgrade` can:

- Move named direct dependencies to exact versions and refresh the lockfile.
- Convert CommonJS callers and tests for an ESM-only target.
- Apply an export rename supported by both the package surface and release
  guidance.
- Add focused load tests for Node test, Vitest, Jest, or Mocha.
- Add a CI workflow that runs checks established during verification.

With `--patch-model`, it can propose a repository-specific behavioral test and
source migration for findings outside those built-in rules. The same path
validation, warrants, sandboxed checks, and final diff policy apply.

Useful examples live in `fixtures/legacy-app` and `fixtures/prefix-tool`.

## Common workflows

### Approve a sensitive change

A run may return `human_required` with an approval id when a necessary operation
falls outside a specialist's initial warrant. Approve that exact operation on a
new run:

```bash
NODE_ENV=development pnpm safe-upgrade escape-string-regexp@5.0.0 \
  --repository ~/src/app \
  --approve 4f3c2b1a \
  --approved-by alice
```

### Upgrade a workspace or companion package

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 \
  --repository ~/src/app \
  --workspace packages/app \
  --companion nanoid@5.0.0
```

Use `--allow-transitive` when the intended upgrade also moves transitive
lockfile entries.

### Open or assess a pull request

[`tenuo-ai/safe-upgrade-action`](https://github.com/tenuo-ai/safe-upgrade-action)
assesses Dependabot and Renovate pull requests, adds the result to the job
summary, annotates affected files, and attaches the evidence record. The
workflow checks out the base revision and leaves the caller's checkout
untouched.

`--draft-pr` remains available for CLI runs that should open a draft after a
verified result. `--from-event` reads a Dependabot pull request event and can
comment with any result.

See [Dependabot assessment](examples/dependabot-assess.yml) and
[scheduled draft upgrades](examples/scheduled-draft.yml) for complete workflows.

## Execution boundaries

Each specialist receives a Tenuo warrant for its delegated operations. An
operating system sandbox separately contains package and repository code:

- Package downloads have network access with lifecycle scripts disabled.
- Tests, builds, typechecks, and package probes run without network access.
- Child processes receive an empty temporary home directory.
- Writes are limited to the disposable worktree and run scratch space.
- Verification detects commands that change the candidate under review.

The command stops when the operating system sandbox is unavailable.
`SAFE_UPGRADE_ALLOW_UNSANDBOXED=1` is reserved for test infrastructure that
already provides equivalent isolation.

## Environment

| Variable | Purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Enable `--engine jev`. |
| `OPENAI_API_KEY` | Enable patch proposals with `--patch-model`. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Authenticate draft pull requests and comments. |
| `TENUO_ROOT_PUBLIC_KEY` | Identify the production authorization root. |
| `TENUO_RUN_WARRANT` | Supply the production run warrant. |
| `TENUO_RUN_HOLDER_SECRET` | Prove possession of the production run warrant. |
| `NODE_ENV=development` | Allow a local trial to create and report its own authority. |
| `SAFE_UPGRADE_HOME` | Choose where assessment records and run artifacts are stored. |

The three Tenuo production variables are used together. The patch-model mode
sends selected source and test files to the OpenAI Responses API with response
storage disabled.

## License

[Apache License 2.0](LICENSE)
