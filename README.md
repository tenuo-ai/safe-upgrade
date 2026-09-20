# safe-upgrade

Upgrade one exact dependency in a JavaScript or TypeScript repository, and
establish what that did. The run isolates a worktree, reads the two published
versions, changes only what it can justify, verifies from a frozen install, and
says so when it cannot finish.

It does not merge. It does not publish. A version that is a range or a tag is
refused: every claim is about one version whose manifest it read.

The CLI is not on npm yet. Run it from this checkout.

## Requirements

- Node 22.18 or newer (the binary loads TypeScript sources)
- A git repository with exactly one of `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`
- The package is a direct dependency of the root or of one workspace
- `NODE_ENV=development` for a local trial without a Tenuo warrant

```bash
git clone https://github.com/tenuo-ai/safe-upgrade.git
cd safe-upgrade
pnpm install
```

## Run an upgrade

Name the package and an exact version. The repository is read, never written;
work happens in a temporary worktree.

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 --repository ~/src/app
```

Progress goes to stderr. The report goes to stdout, so this stays pipeable:

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 --repository ~/src/app --format json --quiet > report.json
```

A record of the run lands in `artifacts/<run-id>` unless you pass `--artifacts`.

### What you will see

| Status | Exit | Meaning |
| --- | --- | --- |
| `verified` | 0 | The target is installed, the checks that already existed still pass, and every finding is accounted for. |
| `partial` | 2 | Some of that is true. `--partial-allowed` makes this exit 0. |
| `human_required` | 3 | A change needs a capability no worker holds. Re-run with `--approve`. |
| `blocked` | 4 | The run will not make the change. The report names the symbol, the files, and what to look at. |
| `indeterminate` | 5 | It could not classify the result. Treat it as unverified. |
| *(usage)* | 64 | The command line could not be understood. |
| *(unusable)* | 65 | This repository cannot be upgraded by this run — no lockfile, not a direct dependency, or the installed version cannot be determined. |
| *(internal)* | 70 | The run could not complete. |

## When a person has to approve

Some upgrades need `package.json`'s `"type": "module"`. No worker holds that
capability. The first run stops at `human_required`, writes nothing, and prints
an approval id.

```bash
NODE_ENV=development pnpm safe-upgrade escape-string-regexp@5.0.0 \
  --repository ~/src/app \
  --approve 4f3c2b1a \
  --approved-by alice
```

`--approved-by` is required. The approval names that exact call: it cannot be
replayed as a different field, path, or worker.

## Open a draft pull request

If verification passes, `--draft-pr` pushes the run branch and opens a draft.
It cannot merge, cannot mark the draft ready, and cannot push any other branch.
`GITHUB_TOKEN` comes from the environment, never from a flag.

```bash
NODE_ENV=development pnpm safe-upgrade left-pad@1.3.0 \
  --repository ~/src/app \
  --draft-pr \
  --github-repository acme/app
```

`--publish` is the same flag under the older name.

## Assess a Dependabot pull request

Checkout the **base** branch, not Dependabot's head. The run applies the upgrade
itself; a head that is already at the target is a no-op and is refused.

```bash
NODE_ENV=development pnpm safe-upgrade --from-event
```

`--from-event` reads the package, version, workspace (`in /packages/app`),
grouped `Updates \`pkg\` from x to y` lines, and pull number from
`GITHUB_EVENT_PATH`. It comments the verdict on that pull request for
`verified`, `blocked`, and `human_required`.

Copy [`examples/dependabot-assess.yml`](examples/dependabot-assess.yml) into
`.github/workflows`. For a version you already know,
[`examples/scheduled-draft.yml`](examples/scheduled-draft.yml) opens a draft
from `workflow_dispatch`.

## Workspaces and more than one package

```bash
NODE_ENV=development pnpm safe-upgrade postcss@8.4.35 \
  --repository ~/src/app \
  --workspace packages/app \
  --companion nanoid@5.0.0
```

- `--workspace` scopes the declaring manifest, the update, and the checks. A
  Dependabot title's `in /path` fills this in. `packages/*` is expanded.
- `--companion name@version` (repeatable) names further exact packages this run
  may move. Grouped Dependabot bodies become companions the same way.
- A peer the target declares that you did not name is reported and needs a
  person. It is not moved.
- Without `--allow-transitive`, any other lockfile version change stops the run.

## What it will change, and what it will not

It will update the named package(s) to the exact versions, refresh the lockfile,
add a test when a call site has none, convert CommonJS to ESM when the target
cannot be `require`d, add a workflow that runs the checks it verified, and
rename a call site when the old export is gone, the new one exists, and the
release note says one became the other.

It will not invent a replacement for a removed export, enable dependency
lifecycle scripts, edit an existing workflow in place, or treat a green test
suite as proof when the broken call site is uncovered.

Try `fixtures/legacy-app` (`escape-string-regexp@5.0.0`) for an ESM migration
that asks for approval, and `fixtures/prefix-tool` (`postcss@8.4.35`) for a
removed export the suite does not catch.

## Engine

The default route is deterministic: a pure function of run state. That is a
supported configuration.

```bash
NODE_ENV=development pnpm safe-upgrade cookie@1.0.2 \
  --repository ~/src/app \
  --engine jev
```

`--engine jev` needs `TYPESAFE_API_KEY` in the environment. Below
`--confidence` (default 0.6) the engine's answer is replaced by the
deterministic order.

## Environment

| Variable | Used for |
| --- | --- |
| `GITHUB_TOKEN` or `GH_TOKEN` | Draft pull requests and PR comments. Never a flag. |
| `TYPESAFE_API_KEY` | `--engine jev`. Never a flag. |
| `TENUO_ROOT_PUBLIC_KEY`, `TENUO_RUN_WARRANT`, `TENUO_RUN_HOLDER_SECRET` | Production: narrow a warrant an issuer granted. All three, or none. |
| `NODE_ENV=development` | Local trial that mints its own authority. Reported on stderr. |

`pnpm safe-upgrade --help` is the flag list.

How a run is split across specialists, and what each of them is allowed to
do, is in [`docs/architecture.md`](docs/architecture.md).
