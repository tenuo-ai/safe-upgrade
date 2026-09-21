/** Usage text. Kept beside the parser so a flag cannot be added without a line about it. */

export const VERSION = "0.0.0";

export const HELP = `safe-upgrade: upgrade one dependency, and establish what that did

Usage
  safe-upgrade assess [name@exact-version] [options]
  safe-upgrade <name>@<exact-version> [options]

Run \`assess\` without a package to select an outdated direct dependency, establish
the current baseline, research its latest release, and report repository-specific
risk and test coverage. Assessment does not offer any writing worker.

The version is exact. A range or a tag resolves to whatever the registry serves at the
time, and every claim a run makes is about one version whose manifest it read.

Options
  --repository <path>         Repository to upgrade. Read, never written. Default: cwd.
  --artifacts <dir>           Where to write the run's record. Default: artifacts/<run-id>.
  --run-id <id>               Name this run. Default: a fresh UUID.
  --approve <id>              Approve one call a previous run asked about, by id.
                              Repeatable. Needs --approved-by.
  --approved-by <who>         Who approved it. Recorded in the audit log.
  --draft-pr                  If verification passes, push the run branch and open
                              a draft pull request. Needs --github-repository or
                              GITHUB_REPOSITORY. Does not merge.
  --publish                   Same as --draft-pr. Kept so existing scripts work.
  --comment-pr <n>            Leave this run's verdict on an existing pull request.
                              For blocked and human_required as well as verified.
  --from-event                Read package, version, workspace, companions, and
                              pull number from a Dependabot pull_request event
                              (GITHUB_EVENT_PATH). Comments on that pull request.
  --companion <name@ver>      A further exact package this run may move. Repeatable.
  --workspace <path>          Workspace to upgrade in (packages/app). Also read
                              from a Dependabot title's "in /path".
  --github-repository <o/n>   Where the draft goes. Needs GITHUB_TOKEN in the environment.
  --allow-transitive          Permit other lockfile versions to move as a
                              consequence of this upgrade. Without it, an extra
                              move stops the run.
  --partial-allowed           Exit 0 on a partial result instead of 2.
  --format markdown|json      What to print. Default: markdown.
  --quiet                     Do not print per-step progress. Progress goes to
                              stderr, so stdout stays parseable either way.
  --engine jev|deterministic  Who chooses the next step. Default: deterministic, which
                              makes the route a pure function of run state. jev needs
                              TYPESAFE_API_KEY.
  --patch-model <model-id>    Let an OpenAI coding model propose repository-specific tests
                              and source changes. Requires --engine jev and OPENAI_API_KEY.
  --confidence <0..1>         Below this, the engine's answer is replaced by the
                              deterministic order and the route says so. Default: 0.6.
  --version, --help

Environment
  GITHUB_TOKEN                Required for publishing. Never accepted as a flag: an
                              argument ends up in shell history and in process listings.
  TYPESAFE_API_KEY            Required by --engine jev. Never accepted as a flag.
  OPENAI_API_KEY              Required by --patch-model. Never accepted as a flag.
  TENUO_ROOT_PUBLIC_KEY       The issuer this run trusts.
  TENUO_RUN_WARRANT           The warrant this run holds.
  TENUO_RUN_HOLDER_SECRET     The secret proving it holds it.
                              All three together mean the run narrows authority it was
                              given. None of them means it mints its own, which is for
                              local trials only and is reported when it happens.

Exit codes
  0   verified, or partial with --partial-allowed
  2   partial
  3   human_required: something needs approving; run again with --approve
  4   blocked
  5   indeterminate
  64  the command line could not be understood
  65  the repository cannot be upgraded by this run: no lockfile, the package is
      not a direct dependency, or its installed version cannot be determined
  70  the run could not complete

Examples
  safe-upgrade assess --repository ~/src/app
  safe-upgrade assess postcss@8.4.35 --repository ~/src/app --engine jev
  safe-upgrade postcss@8.4.35 --repository ~/src/app
  safe-upgrade postcss@8.4.35 --workspace packages/app --companion nanoid@5.0.0
  safe-upgrade postcss@8.4.35 --engine jev --patch-model your-model-id
  safe-upgrade escape-string-regexp@5.0.0 --approve 4f3c2b1a --approved-by alice
  safe-upgrade left-pad@1.3.0 --draft-pr --github-repository acme/app
  safe-upgrade --from-event
`;
