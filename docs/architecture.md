# How a run is put together

You name a package and an exact version. The command isolates a copy of the
repository, works there, and reports what it could establish. This page is
what happens in that copy, and which part of the run is allowed to do it.

How to invoke the command is in the [README](../README.md).

## The four roles

The architecture separates orchestration, semantic judgement, patch generation,
and authorization. Each role has a different input and a different kind of
control over the run.

| Component | Responsibility |
| --- | --- |
| **LangGraph** | Carries state through the workflow, exposes only eligible actions, records the route, and limits repeated attempts. |
| **Jev** | Judges test coverage, migration completeness, and the next eligible action from bounded evidence. |
| **Coding model** | Proposes complete test or source file contents for findings outside the built-in transforms. It receives no tool handle or warrant. |
| **Tenuo** | Issues a separate warrant to each specialist, constraining its tools and arguments for that invocation. |

The final result still comes from deterministic policy and repository checks.
Jev can require more work or prevent a `verified` result, while Tenuo decides
whether an operation is authorized to run.

### A removed API from finding to verification

With Jev and a patch model enabled, an unfamiliar API removal follows this
sequence:

1. The researcher records the removed API, release evidence, and affected
   repository files.
2. The coding model proposes a behavioral test from those bounded inputs.
3. The test author validates the proposal and writes it through a warrant limited
   to test paths.
4. Jev judges whether the new test exercises the reported break.
5. The coding model proposes the source migration.
6. The implementer validates the proposal and writes it through a separate
   warrant limited to production source.
7. LangGraph advances the candidate to the verifier, which installs the updated
   lockfile, runs the checks, inspects the diff, and accounts for every finding.

The audit log records the proposal, the specialist that applied it, the warrant
decision, the semantic assessments, and the final checks.

## Your checkout is not touched

The path you pass as `--repository` is read. A temporary git worktree is
created from a known commit, used for the upgrade, and removed when the
command exits. Uncommitted work in your checkout is left as it was. The run
says so if the source was dirty, because the result is then a statement about
the last commit, not about the files you have open.

## Specialists, not one agent

The run is a sequence of specialists coordinated by LangGraph. Jev can choose
the next eligible specialist and answer bounded semantic questions. Before each
specialist acts, Tenuo issues it a warrant scoped to the tools and arguments it
needs for that step. Calls outside that warrant are denied before the tool body
runs.

| Specialist | What it does | What it cannot do |
| --- | --- | --- |
| Inspector | Confirms the worktree, installs frozen, records which checks already pass or fail | Write anything |
| Researcher | Reads the two published versions, the repository's call sites, and allowlisted release notes | Write, install, or run tests |
| Test author | Adds a test when a call site has none; can apply a model-proposed behavioral test | Write production source, the manifest, or CI |
| Implementer | Moves the dependency and applies a built-in or model-proposed source migration | Write tests or CI |
| CI author | Adds a workflow that runs the checks this run verified | Edit an existing workflow, deploy, or publish |
| Verifier | Frozen-installs again, runs the checks, reads the diff | Write anything |
| Publisher | Pushes this run's branch and opens a draft pull request | Merge, mark ready, or push any other branch |

The test author cannot make a failing change pass by editing the test that
caught it. The implementer cannot weaken that test. The verifier cannot
adjust what it is verifying. No specialist can turn on dependency lifecycle
scripts.

The warrants constrain delegated tool calls. A separate operating system
sandbox restricts code launched by those tools. Package downloads may use the
network, while probes and repository checks cannot. Child processes see a
temporary empty home instead of the user's credentials and can write only to
the disposable worktree and scratch directory. The run fails closed if that
sandbox is unavailable.

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

## How repository-specific patches are produced

`--patch-model` adds a coding model as a proposal service outside the LangGraph
specialist set. It receives a bounded request assembled from trusted run state
and returns structured data. The service gets no Tenuo warrant or tool handle,
so all reads, commands, dependency updates, and writes remain with the
specialists.

For a test proposal, the test author selects existing test files that may be
edited and affected source files that may be read as context. A new path is
accepted only when it is recognized as a test file. For a source proposal, the
implementer selects the affected production files, and no new source path may be
created. Every proposed edit names the current file hash and the migration
finding it addresses.

The worker validates the complete proposal before making the first write. It
rejects stale hashes, unselected paths, duplicate paths, missing findings, and
invented finding ids. Accepted writes still pass through the worker's normal
Tenuo-protected tool. The test author and implementer therefore apply separate
parts of the migration with separate warrants.

Jev remains responsible for semantic judgement. It evaluates whether the new
tests cover the reported break and whether the final candidate accounts for the
findings. LangGraph uses those results and deterministic state to decide what
work is eligible next. Verification then executes the repository's checks in
the operating system sandbox.

## What gets written

The package manager updates the named package(s) and the lockfile. Source
edits are the migrations above: ESM conversion when `require` would throw,
or a rename both observations agree on. A new test file is added when a
reached symbol has no test. A new workflow file is added when CI does not
run a check this run used.

Without a patch model, the run does not invent a replacement for a removed
export. With one, it can apply a bounded repository-specific proposal to files
the finding already identified. The run does not rewrite an existing workflow
in place or treat a green suite as proof when the broken call site is not in
that suite.

## What "verified" means

The final status is computed by deterministic policy. `verified` means all of
these held:

- a baseline was recorded before any change
- the manifest names the exact target version
- every finding is addressed or explicitly left for a person
- the same required checks that ran at baseline pass after the change
- the diff did not weaken a test (skip, `.only`, a deleted test file)
- verification commands did not change the candidate they were checking
- when Jev is enabled, its bounded completeness review found no unresolved
  migration finding

Anything short of that is `partial`, `blocked`, `human_required`, or
`indeterminate`. Exit codes are in the README.

## Approvals

A few writes belong to an upgrade and still fall outside the specialists'
initial warrants. Setting `package.json`'s `"type"` to `"module"` is the one
that comes up: the implementer records an id, writes nothing, and the run exits
`human_required`.

`--approve <id> --approved-by <who>` on the next command extends the warrant for
that one call, bound to that field, value, file, and worker.

## Drafts and comments

`--draft-pr` is offered only after verification. The publisher's warrant
includes the draft flag and the exact run branch. `--from-event` comments on an
existing Dependabot pull request for every status, including `blocked` and
`human_required`, because those runs never reach the publisher.

## Who chooses the next step

By default the next step is a fixed function of the current state. That is
intentional: a pipeline can replay a run and get the same route.

`--engine jev` asks Jev to pick from the steps that are already eligible. It
also judges whether candidate tests semantically cover a finding and whether
the final migration accounts for every finding. These judgements can require
more work or veto a `verified` result. They cannot authorize a tool, add a new
step, or publish before deterministic verification. A low-confidence routing
answer is replaced by the default order.

Semantic assessment needs semantic evidence. When Jev is explicitly selected,
the request includes at most 4,000 characters from each relevant test and each
changed-file patch. Unrelated tests, full repository files, command output,
environment variables, warrants, and credentials are not sent. The
deterministic engine keeps all repository source local.

When `--patch-model` is selected, the affected source files and selected test
files are sent to the OpenAI Responses API. The request enables no model tools
and asks the API not to store the response. This mode requires Jev because the
generated tests and source migration need semantic review in addition to
deterministic validation.

## Authority for the process itself

Locally, `NODE_ENV=development` lets this process mint the run warrant it then
narrows for each specialist. The command says so on stderr. In production,
`TENUO_ROOT_PUBLIC_KEY`, `TENUO_RUN_WARRANT`, and
`TENUO_RUN_HOLDER_SECRET` must all be set: the process narrows a warrant
someone else issued, and cannot grant itself one.
