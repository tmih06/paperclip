import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files", "-z", "--", ".github", "scripts", "tests", "server", "cli", "packages", "ui", "docker", "Dockerfile*", "package.json", "*.sh"], { encoding: "utf8" })
  .split("\0").filter(Boolean)
  .filter(file => !file.includes("/node_modules/") && !file.includes("/dist/") && !/^\.github\/.*\.json$/.test(file));
const replacements = [
  ["pnpm-lock.yaml", "bun.lock"],
  ["pnpm-workspace.yaml", "bunfig.toml"],
  ["pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile", "bun install --no-save"],
  ["pnpm install --ignore-workspace --resolution-only --ignore-scripts --no-frozen-lockfile", "bun install --no-save"],
  ["pnpm install --ignore-workspace --no-lockfile", "bun install --no-save"],
  ["pnpm install --frozen-lockfile", "bun install --frozen-lockfile"],
  ["pnpm install", "bun install"],
  ["pnpm --filter ", "bun run --filter "],
  ["pnpm --dir ", "bun run --cwd "],
  ["pnpm exec ", "bun x "],
  ["pnpm -r --if-present run ", "bun run --workspaces --if-present "],
  ["pnpm -r typecheck", "bun run --workspaces --if-present typecheck"],
  ["pnpm run ", "bun run "],
  ["pnpm test:run", "bun run test:run"],
  ["pnpm test", "bun run test"],
  ["pnpm build", "bun run build"],
  ["node --test ", "bun test "],
  ["node cli/node_modules/tsx/dist/cli.mjs ", "bun "],
  ["node scripts/", "bun scripts/"],
  ["node tests/", "bun tests/"],
];
let changed = 0;
for (const file of files) {
  const original = await readFile(file, "utf8");
  let next = original;
  for (const [from, to] of replacements) next = next.replaceAll(from, to);
  next = next.replaceAll("#!/usr/bin/env node", "#!/usr/bin/env bun")
    .replaceAll(/\bnode (?=(?:scripts\/|tests\/|\.github\/|--input-type|[\"']))/g, "bun ")
    .replaceAll(/\bpnpm (?=(?:check:|test:|build|typecheck))/g, "bun run ");
  if (next !== original) {
    await writeFile(file, next);
    changed++;
  }
}
console.log(`Migrated ${changed} first-party files to Bun references.`);
