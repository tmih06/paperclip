import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const remoteTools = new Set(["mintlify", "promptfoo@0.103.3"]);

export function migratePackageScript(command, { workspaceRoot = ".", syntaxChecker = "scripts/check-js-syntax.mjs" } = {}) {
  return command
    .replace(/\bpnpm -w exec\s+/g, `bun x --cwd ${workspaceRoot} `)
    .replace(/\bpnpm -C (\S+)\s+/g, "bun run --cwd $1 ")
    .replace(/\bpnpm --filter (\S+)\s+(?:run\s+)?/g, "bun run --filter $1 ")
    .replace(/\bpnpm exec\s+/g, "bun x ")
    .replace(/\bpnpm -r\s+/g, "bun run --workspaces --if-present ")
    .replace(/\bpnpm run\s+/g, "bun run ")
    .replace(/\bnode --check\s+/g, `bun ${syntaxChecker} `)
    .replace(/\bnode --test\s+/g, "bun test ")
    .replace(/\bnode (?:--import\s+\S*tsx\S*|\S*node_modules\/tsx\/dist\/cli\.mjs)\s+/g, "bun ")
    .replace(/\bnode (?:\.\/)?node_modules\/typescript\/bin\/tsc\s+/g, "bun x tsc ")
    .replace(/\bbun x ((?:(?:--bun|--no-install|--cwd\s+\S+)\s+)*)tsx\s+/g, (_, flags) => `bun ${flags.match(/--cwd\s+\S+\s*/)?.[0] ?? ""}`)
    .replace(/(^|(?:&&|\|\||;)\s*)(?:node|tsx)\s+/g, "$1bun ")
    .replace("ci-profile/run.mjs bun x playwright playwright", "ci-profile/run.mjs playwright bun x playwright")
    .replace(/\bbun x (?:(?:--bun|--no-install)\s+)*bun\s+/g, "bun ")
    .replace(/(^|(?:&&|\|\||;)\s*)(vp|vite|vitest|tsc|playwright|storybook|drizzle-kit)(?=\s|$)/g,
      (_, prefix, tool) => `${prefix}bun x ${tool === "vite" ? "vp" : tool}`)
    .replace(/\bbun x ((?:(?:--bun|--no-install|--cwd\s+\S+)\s+)*)([^\s]+)/g,
      (_, flags, tool) => `bun x --bun ${flags.match(/--cwd\s+\S+\s*/)?.[0] ?? ""}${remoteTools.has(tool) ? "" : "--no-install "}${tool}`)
    .replace(/(^|(?:&&|\|\||;)\s*)cross-env\s+/g, "$1");
}

if (import.meta.main) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "**/package.json", "package.json"], { encoding: "utf8" })
    .split("\0").filter(file => file && !/(?:^|\/)(?:node_modules|vendor|fixtures|test-fixtures|generated)\//.test(file));
  let changed = 0;
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    let modified = false;
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      const directory = path.dirname(file);
      const next = migratePackageScript(command, {
        workspaceRoot: path.relative(directory, ".") || ".",
        syntaxChecker: path.relative(directory, "scripts/check-js-syntax.mjs"),
      });
      if (next !== command) { manifest.scripts[name] = next; modified = true; changed++; }
    }
    if (modified) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`Migrated ${changed} package scripts to native Bun tool execution.`);
}
