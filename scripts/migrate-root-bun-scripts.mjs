import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const remoteTools = new Set(["mintlify", "promptfoo@0.103.3"]);

export function migratePackageScript(command) {
  return command
    .replace("ci-profile/run.mjs bun x playwright playwright", "ci-profile/run.mjs playwright bun x playwright")
    .replace(/\bbun x (?:(?:--bun|--no-install)\s+)*bun\s+/g, "bun ")
    .replace(/(^|(?:&&|\|\||;)\s*)(vp|vite|vitest|tsc|playwright|storybook|drizzle-kit)(?=\s|$)/g,
      (_, prefix, tool) => `${prefix}bun x ${tool === "vite" ? "vp" : tool}`)
    .replace(/\bbun x (?:(?:--bun|--no-install)\s+)*([^\s]+)/g,
      (_, tool) => `bun x --bun ${remoteTools.has(tool) ? "" : "--no-install "}${tool}`)
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
      const next = migratePackageScript(command);
      if (next !== command) { manifest.scripts[name] = next; modified = true; changed++; }
    }
    if (modified) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`Migrated ${changed} package scripts to native Bun tool execution.`);
}
