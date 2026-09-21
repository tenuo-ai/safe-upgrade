#!/usr/bin/env node
/**
 * The installed entry point.
 *
 * Plain JavaScript and as short as it can be, because it runs before anything is known
 * about the environment. Its one job beyond calling `main` is to fail legibly on a Node
 * older than the runtime this release supports.
 */

if (process.features.typescript !== "strip") {
  process.stderr.write(
    `safe-upgrade needs Node 22.18 or newer. This is ${process.version}.\n`,
  );
  process.exit(70);
}

// The npm package contains a bundled build. A source checkout falls back to the
// TypeScript entry so contributors do not need to build before every local run.
let main;
try {
  ({ main } = await import("../dist/main.js"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  ({ main } = await import("../src/main.ts"));
}

// Assigned rather than passed to process.exit(). Writing to a pipe is asynchronous, and
// process.exit() does not wait for the buffer to drain, so exiting that way truncates a
// report at the pipe size — which only shows up when someone redirects it to a file.
process.exitCode = await main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
});
