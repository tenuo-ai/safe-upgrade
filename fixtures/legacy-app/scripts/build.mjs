// Stands in for a bundler: loads every entry point and writes a manifest. Enough
// to fail loudly when a dependency stops being requirable.
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const entryPoints = ["src/index.js", "src/search.js", "src/highlight.js"];
for (const entry of entryPoints) {
  require(join(root, entry));
}

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(
  join(root, "dist", "manifest.json"),
  `${JSON.stringify({ entryPoints }, null, 2)}\n`,
);
console.log(`built ${String(entryPoints.length)} entry points`);
