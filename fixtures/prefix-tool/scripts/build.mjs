// Stands in for a bundler: loads every entry point and exercises the public one, so
// a break in either usage fails the build rather than only a break in loading.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const entryPoints = ["src/index.js", "src/prefix.js", "src/declarations.js"];
const loaded = [];
for (const entry of entryPoints) {
  loaded.push(await import(pathToFileURL(join(root, entry)).href));
}

const summary = loaded[0].summarize("a { -moz-tab-size: 4; color: red }");

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist", "manifest.json"), `${JSON.stringify({ entryPoints, summary }, null, 2)}\n`);
console.log(`summarized ${String(summary.length)} prefixed declaration(s)`);
