/**
 * Whether this run is willing to trigger a repository's own script as a check.
 *
 * Worth being precise about what this does and does not protect, because an earlier version of
 * this screen was built on a misunderstanding and it made the tool useless on real code.
 *
 * It is not a sandbox and it is not an authorization decision. `run_check` passes a script
 * *name* to the package manager, never a body, and the manager then runs that body through a
 * shell of its own. So nothing here can prevent shell interpretation, and a screen that
 * rejected `&&` bought no safety — it only meant that `npm run test && npm run lint`, which is
 * what a great many repositories write, silently produced no gate at all. That failure is not
 * conservative. A run with no gates cannot detect a regression, so refusing to look is the
 * least safe outcome available.
 *
 * Running a repository's tests means running its code. That is inherent to verifying an
 * upgrade, and it is bounded elsewhere: a disposable worktree, no shell from this process, an
 * environment allowlist, a timeout, and a killed process tree.
 *
 * What is left for this screen is a narrower and more answerable question: does the script
 * plainly do something whose effect outlives the worktree? Publishing, deploying, uploading,
 * and removing things outside the tree are all visible in the text, and none of them belong in
 * a check. Those are refused. Ordinary tooling is not.
 */

/** Why a script will not be used as a check, or null when it will be. */
export function screenScript(body: string): string | null {
  const text = body.trim();
  if (text.length === 0) {
    return "it is empty";
  }

  // Comments are stripped first so a marker inside one is not read as an action.
  const code = withoutComments(text);

  for (const [pattern, reason] of MARKERS) {
    if (pattern.test(code)) {
      return reason;
    }
  }
  if (removesOutsideTheTree(code)) {
    return "it removes a path outside the repository";
  }
  return null;
}

/** True when the script is usable as a check. */
export function isScriptBodyRunnable(body: string): boolean {
  return screenScript(body) === null;
}

/**
 * Effects that outlive the worktree.
 *
 * Each entry names something a check has no reason to do. The list is deliberately about
 * actions rather than about tools: `vitest`, `mocha`, `jest`, `tsc`, `eslint`, `nyc`, and
 * whatever a repository uses next are all fine, and enumerating them would be a losing game.
 */
const MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:npm|pnpm|yarn)\s+publish\b/, "it publishes a package"],
  [/\bsemantic-release\b|\bnp\s|\brelease-it\b/, "it runs a release tool"],
  [/\bgh\s+release\b/, "it creates a GitHub release"],
  [/\bgit\s+(?:push|tag)\b/, "it writes to a git remote or tags the repository"],
  [/\bdocker\s+push\b/, "it pushes a container image"],
  [/\b(?:coveralls|codecov|nyc\s+report\s+--reporter=lcovonly\s*\|)/, "it uploads coverage"],
  [/\b(?:curl|wget)\b/, "it transfers data over the network itself"],
  [/\b(?:netlify|vercel|now|surge|gh-pages|firebase)\b/, "it deploys"],
  [/\b(?:aws|gcloud|az|kubectl|helm|terraform)\b/, "it talks to cloud infrastructure"],
  [/\bsudo\b/, "it asks for elevated privileges"],
  [/\bssh\b|\bscp\b|\brsync\b/, "it reaches another host"],
  // A token in a script body is a credential being handed to something. A check does not
  // need one, and a check that uses one is doing more than checking.
  [/\$\{?(?:NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|NODE_AUTH_TOKEN)\b/, "it uses a publish credential"],
  // A single `&` backgrounds. The manager returns when the foreground command finishes, and
  // whatever was backgrounded is still running with nothing left to wait for it. The process
  // tree is killed on a timeout, but a check that passes has no timeout to fire.
  [/(?<!&)&(?!&)/, "it backgrounds a process that would outlive the check"],
];

/**
 * `rm -rf dist` inside a disposable worktree is housekeeping. `rm -rf /` or `rm -rf ~/.cache`
 * is not, and the difference is legible: an absolute path or a home-relative one.
 */
function removesOutsideTheTree(code: string): boolean {
  for (const match of code.matchAll(/\brm\s+(-[a-zA-Z]+\s+)*([^\s;&|]+)/g)) {
    const target = match[2] ?? "";
    if (target.startsWith("/") || target.startsWith("~") || target.startsWith("..")) {
      return true;
    }
  }
  return false;
}

/** Shell comments, so a marker mentioned in one does not count as an action. */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}
