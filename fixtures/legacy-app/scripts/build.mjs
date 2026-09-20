// Stands in for a bundler: loads every entry point and writes a manifest. Enough
// to fail loudly when an entry point stops loading.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const entryPoints = ["src/index.js", "src/search.js", "src/highlight.js"];
for (const entry of entryPoints) {
  await import(pathToFileURL(join(root, entry)).href);
}

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(
  join(root, "dist", "manifest.json"),
  `${JSON.stringify({ entryPoints }, null, 2)}\n`,
);
console.log(`built ${String(entryPoints.length)} entry points`);
