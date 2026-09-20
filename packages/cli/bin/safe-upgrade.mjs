#!/usr/bin/env node
/**
 * The installed entry point.
 *
 * Plain JavaScript and as short as it can be, because it runs before anything is known
 * about the environment. Its one job beyond calling `main` is to fail legibly on a Node
 * that cannot load the rest: this package ships TypeScript sources, so a runtime without
 * type stripping would otherwise produce a syntax error from a file the user did not write.
 */

if (process.features.typescript !== "strip") {
  process.stderr.write(
    `safe-upgrade needs a Node that strips TypeScript types, which is 22.18 or newer. This is ${process.version}.\n`,
  );
  process.exit(70);
}

const { main } = await import("../src/main.ts");

// Assigned rather than passed to process.exit(). Writing to a pipe is asynchronous, and
// process.exit() does not wait for the buffer to drain, so exiting that way truncates a
// report at the pipe size — which only shows up when someone redirects it to a file.
process.exitCode = await main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
});
