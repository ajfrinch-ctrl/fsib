/* Build step for Netlify: copy the app shell into public/.
   Denylist-based so a new static asset is published without editing this file. */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "public");

const SKIP = new Set([
  ".git",
  ".gitignore",
  ".smoke",
  ".tmp",
  "build.mjs",
  "dev-server.mjs",
  "netlify",
  "netlify.toml",
  "node_modules",
  "package-lock.json",
  "package.json",
  "public",
  "server",
  "src",
  "tests",
  "tsconfig.json"
]);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const entries = await readdir(ROOT, { withFileTypes: true });
const published = [];

for (const entry of entries) {
  if (SKIP.has(entry.name)) continue;
  const from = path.join(ROOT, entry.name);
  const to = path.join(OUT, entry.name);
  await cp(from, to, { recursive: true });
  published.push(entry.name);
}

console.log(`published ${published.length} entr${published.length === 1 ? "y" : "ies"} to public/: ${published.join(", ")}`);
