import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files", "-z", "Dockerfile*", "docker/**/Dockerfile*", ".github/*.Dockerfile"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const replacements = [
  ["pnpm -C \"$dir\" install --ignore-workspace --no-lockfile", "bun install --cwd \"$dir\" --no-save"],
  ["bun install --frozen-lockfile", "bun install --frozen-lockfile"],
  ["bun install --no-save", "bun install --no-save"],
  ["bun install --no-save", "bun install --cwd"],
  ["bun run --filter ", "bun run --filter "],
  ["pnpm -C ", "bun run --cwd "],
  ["bun.lock", "bun.lock"],
  ["bunfig.toml", "bunfig.toml"],
  ["bun scripts/", "bun scripts/"],
  ["node server/", "bun server/"],
  ["node -e ", "bun -e "],
  ["node -p ", "bun -p "],
];
let changed = 0;
for (const file of files) {
  const original = await readFile(file, "utf8");
  let next = original;
  for (const [from, to] of replacements) next = next.replaceAll(from, to);
  if (next !== original) {
    await writeFile(file, next);
    changed++;
  }
}
console.log(`Migrated ${changed} Dockerfiles to Bun commands.`);
