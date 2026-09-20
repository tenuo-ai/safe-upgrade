/** Usage text. Kept beside the parser so a flag cannot be added without a line about it. */

export const VERSION = "0.0.0";

export const HELP = `safe-upgrade — upgrade one dependency, and establish what that did

Usage
  safe-upgrade <name>@<exact-version> [options]

The version is exact. A range or a tag resolves to whatever the registry serves at the
time, and every claim a run makes is about one version whose manifest it read.

Options
  --repository <path>         Repository to upgrade. Read, never written. Default: cwd.
  --artifacts <dir>           Where to write the run's record. Default: artifacts/<run-id>.
  --run-id <id>               Name this run. Default: a fresh UUID.
  --approve <id>              Approve one call a previous run asked about, by id.
                              Repeatable. Needs --approved-by.
  --approved-by <who>         Who approved it. Recorded in the audit log.
  --draft-pr                  Want a draft pull request. Does not authorise pushing.
  --publish                   Approve pushing the run branch and opening the draft.
                              Needs --github-repository.
  --github-repository <o/n>   Where the draft goes. Needs GITHUB_TOKEN in the environment.
  --allow-transitive          Permit a transitive dependency to move as a consequence.
  --partial-allowed           Exit 0 on a partial result instead of 2.
  --format markdown|json      What to print. Default: markdown.
  --quiet                     Do not print per-step progress. Progress goes to
                              stderr, so stdout stays parseable either way.
  --engine jev|deterministic  Who chooses the next step. Default: deterministic, which
                              makes the route a pure function of run state. jev needs
                              TYPESAFE_API_KEY.
  --confidence <0..1>         Below this, the engine's answer is replaced by the
                              deterministic order and the route says so. Default: 0.6.
  --version, --help

Environment
  GITHUB_TOKEN                Required for publishing. Never accepted as a flag: an
                              argument ends up in shell history and in process listings.
  TYPESAFE_API_KEY            Required by --engine jev. Never accepted as a flag.
  TENUO_ROOT_PUBLIC_KEY       The issuer this run trusts.
  TENUO_RUN_WARRANT           The warrant this run holds.
  TENUO_RUN_HOLDER_SECRET     The secret proving it holds it.
                              All three together mean the run narrows authority it was
                              given. None of them means it mints its own, which is for
                              local trials only and is reported when it happens.

Exit codes
  0   verified, or partial with --partial-allowed
  2   partial
  3   human_required — something needs approving; run again with --approve
  4   blocked
  5   indeterminate
  64  the command line could not be understood
  65  the repository cannot be upgraded by this run — no lockfile, the package is
      not a direct dependency, or its installed version cannot be determined
  70  the run could not complete

Examples
  safe-upgrade postcss@8.4.35 --repository ~/src/app
  safe-upgrade escape-string-regexp@5.0.0 --approve 4f3c2b1a --approved-by alice
  safe-upgrade left-pad@1.3.0 --publish --github-repository acme/app
`;
