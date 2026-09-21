#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED_BUMPS = new Set(["patch", "minor", "major"]);

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  process.stdout.write(`\n> ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function output(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function nextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (match === null) fail(`package version ${current} is not a plain semantic version`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((argument) => argument !== "--dry-run");
if (positional.length !== 1 || !ALLOWED_BUMPS.has(positional[0])) {
  fail("usage: pnpm release <patch|minor|major> [--dry-run]");
}
const bump = positional[0];

if (output("git", ["branch", "--show-current"]) !== "main") {
  fail("releases must start from the main branch");
}
if (output("git", ["status", "--porcelain=v1"]) !== "") {
  fail("the working tree must be clean");
}

run("git", ["fetch", "--tags", "origin", "main"]);
const head = output("git", ["rev-parse", "HEAD"]);
const remoteMain = output("git", ["rev-parse", "FETCH_HEAD"]);
if (head !== remoteMain) {
  fail("main must exactly match origin/main before releasing");
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = nextVersion(manifest.version, bump);
const tag = `v${version}`;

const tagCheck = spawnSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], {
  stdio: "ignore",
});
if (tagCheck.status === 0) fail(`${tag} already exists`);

const registryCheck = spawnSync("npm", ["view", `${manifest.name}@${version}`, "version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (registryCheck.status === 0) fail(`${manifest.name}@${version} is already published`);
if (!registryCheck.stderr.includes("E404")) {
  fail(`could not verify that ${manifest.name}@${version} is available: ${registryCheck.stderr.trim()}`);
}

process.stdout.write(`\nPreparing ${manifest.name}@${version}\n`);
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("npm", ["pack", "--dry-run"]);

if (dryRun) {
  process.stdout.write(`\nDry run complete. ${tag} is available and the release checks passed.\n`);
  process.exit(0);
}

run("npm", ["version", bump, "--message", "Release %s"]);
run("git", ["push", "--atomic", "origin", "main", tag]);

process.stdout.write(
  `\n${tag} was pushed. Approve the npm-publish environment in GitHub Actions to publish it.\n`,
);
