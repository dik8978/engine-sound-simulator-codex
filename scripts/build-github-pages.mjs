import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "public");
const outputDir = path.join(root, "docs");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of await readdir(sourceDir)) {
  await cp(path.join(sourceDir, entry), path.join(outputDir, entry), {
    recursive: true,
  });
}

await writeFile(path.join(outputDir, ".nojekyll"), "");
console.log("GitHub Pages assets written to docs/");
