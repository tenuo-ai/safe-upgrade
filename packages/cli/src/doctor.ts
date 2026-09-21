import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function doctorChecks(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly DoctorCheck[] {
  const node = process.versions.node;
  const [major = 0, minor = 0] = node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  const git = spawnSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const gitOk = git.status === 0;
  const override = env["SAFE_UPGRADE_ALLOW_UNSANDBOXED"] === "1";
  const sandboxPath = process.platform === "darwin"
    ? "/usr/bin/sandbox-exec"
    : process.platform === "linux"
      ? "/usr/bin/bwrap"
      : "";
  const sandboxOk = override || (sandboxPath !== "" && existsSync(sandboxPath));
  return [
    {
      name: "Node.js",
      ok: nodeOk,
      detail: nodeOk ? `${node} supports type stripping` : `${node} is installed; 22.18 or newer is required`,
    },
    {
      name: "Git",
      ok: gitOk,
      detail: gitOk ? git.stdout.trim() : "git was not found on PATH",
    },
    {
      name: "Process sandbox",
      ok: sandboxOk,
      detail: override
        ? "disabled by SAFE_UPGRADE_ALLOW_UNSANDBOXED for isolated test infrastructure"
        : sandboxOk
          ? sandboxPath
          : process.platform === "linux"
            ? "install Bubblewrap at /usr/bin/bwrap"
            : process.platform === "darwin"
              ? "sandbox-exec was not found at /usr/bin/sandbox-exec"
              : `unsupported platform ${process.platform}`,
    },
  ];
}

export function renderDoctor(checks: readonly DoctorCheck[]): string {
  return `${checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`).join("\n")}\n`;
}
