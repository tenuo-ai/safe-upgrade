# How a run is put together

You name a package and an exact version. The command isolates a copy of the
repository, works there, and reports what it could establish. This page is
what happens in that copy, and which part of the run is allowed to do it.

How to invoke the command is in the [README](../README.md).

## Your checkout is not touched

The path you pass as `--repository` is read. A temporary git worktree is
created from a known commit, used for the upgrade, and removed when the
command exits. Uncommitted work in your checkout is left as it was. The run
says so if the source was dirty, because the result is then a statement about
the last commit, not about the files you have open.

## Specialists, not one agent

The run is a sequence of specialists. Each one is handed the same tools.
What differs is the permission it holds for that step. A specialist that
calls a tool it does not hold is denied before the tool body runs.

| Specialist | What it does | What it cannot do |
| --- | --- | --- |
| Inspector | Confirms the worktree, installs frozen, records which checks already pass or fail | Write anything |
| Researcher | Reads the two published versions, the repository's call sites, and allowlisted release notes | Write, install, or run tests |
| Test author | Adds a test when a call site has none | Write production source, the manifest, or CI |
| Implementer | Moves the dependency and migrates source it has a rule for | Write tests or CI |
| CI author | Adds a workflow that runs the checks this run verified | Edit an existing workflow, deploy, or publish |
| Verifier | Frozen-installs again, runs the checks, reads the diff | Write anything |
| Publisher | Pushes this run's branch and opens a draft pull request | Merge, mark ready, or push any other branch |

The test author cannot make a failing change pass by editing the test that
caught it. The implementer cannot weaken that test. The verifier cannot
adjust what it is verifying. No specialist can turn on dependency lifecycle
scripts.

## What research has to establish

Every finding cites a document the run fetched (registry metadata or a
release note) and the files it actually opened. The researcher compares the
installed version to the target:

- whether the target can still be `require`d
- which exports disappeared, and which of those this repository reaches
- whether a disappeared name and a new name are the same rename in both the
  new surface and the release note
- whether the target declares a peer this run did not name

A release note can raise a concern. It cannot, by itself, mark the upgrade
safe. A name the note mentions that is not in both surfaces is ignored.

## What gets written

The package manager updates the named package(s) and the lockfile. Source
edits are the migrations above: ESM conversion when `require` would throw,
or a rename both observations agree on. A new test file is added when a
reached symbol has no test. A new workflow file is added when CI does not
run a check this run used.

The run will not invent a replacement for a removed export, rewrite an
existing workflow in place, or treat a green suite as proof when the broken
call site is not in that suite.

## What "verified" means

The classifier is not a model. `verified` means all of these held:

- a baseline was recorded before any change
- the manifest names the exact target version
- every finding is addressed or explicitly left for a person
- the same required checks that ran at baseline pass after the change
- the diff did not weaken a test (skip, `.only`, a deleted test file)

Anything short of that is `partial`, `blocked`, `human_required`, or
`indeterminate`. Exit codes are in the README.

## Approvals

A few writes belong to an upgrade and are still not in any specialist's
standing permission. Setting `package.json`'s `"type"` to `"module"` is the
one that comes up: the implementer records an id, writes nothing, and the
run exits `human_required`.

`--approve <id> --approved-by <who>` on the next command permits that one
call — that field, that value, that file, that worker. It does not grant
the capability in general.

## Drafts and comments

`--draft-pr` is offered only after verification. The draft flag is part of
the permission, not a courtesy in the GitHub client. `--from-event` comments
on an existing Dependabot pull request for every status, including `blocked`
and `human_required`, because those runs never reach the publisher.

## Who chooses the next step

By default the next step is a fixed function of the current state. That is
intentional: a pipeline can replay a run and get the same route.

`--engine jev` asks Jev to pick from the steps that are already eligible.
It cannot invent a step, authorize a tool, or publish before verification.
A low-confidence answer is replaced by the default order.

## Authority for the process itself

Locally, `NODE_ENV=development` lets this process mint the permission it
then narrows for each specialist. The command says so on stderr. In
production, `TENUO_ROOT_PUBLIC_KEY`, `TENUO_RUN_WARRANT`, and
`TENUO_RUN_HOLDER_SECRET` must all be set: the process narrows a warrant
someone else issued, and cannot grant itself one.
