import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Version pinned by every `oven-sh/setup-bun` step in `.github/workflows`.
export const SETUP_BUN_VERSION = "1.4.4";
const SETUP_BUN_ACTION = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

function trackedFiles(patterns) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns], { encoding: "utf8" })
    .split("\0").filter(Boolean);
}

// Maps a workspace package name to its directory so a pnpm `--filter <name>`
// command can be rewritten to run inside that package.
async function workspaceDirectories(read) {
  const directories = new Map();
  for (const manifest of trackedFiles(["package.json", "*/*/package.json", "*/*/*/package.json"])) {
    let parsed;
    try { parsed = JSON.parse(await read(manifest, "utf8")); } catch { continue; }
    if (parsed?.name) directories.set(parsed.name, path.dirname(manifest));
  }
  return directories;
}

// Each rule below fixes a form that the earlier bulk rename produced and that
// Bun does not accept. The comment states the observed Bun 1.4.4 behavior.
export function migrationRules(directories) {
  return [
    [/\bnode (?=(?:\.\/|\.testops-trusted\/|packages\/|scripts\/|tests\/))/g, "bun "],
    [/\bpnpm storybook-visual:baseline/g, "bun run storybook-visual:baseline"],
    // `bun run --filter <pkg>` only runs package.json scripts, so pnpm's
    // `--filter <pkg> exec <bin>` fails with `Script "exec" not found`.
    // `bun x --cwd <dir>` resolves the binary from the declaring package.
    [/\bbun run --filter (\S+) exec (\S+)/g, (match, name, binary) => {
      const directory = directories.get(name);
      return directory ? `bun x --cwd ${directory} ${binary}` : match;
    }],
    // Bun accepts --store-dir but ignores its value, so a relocated cache
    // silently stays in the default location. --cache-dir moves it.
    [/\s--store-dir =?(\S+)/g, " --cache-dir $1"],
    // pnpm materialized a self-contained tree with `deploy --prod`; Bun has no
    // deploy and `bun run --cwd <dir> pack` looks for a `pack` script.
    [/\bbun run --cwd (\S+) pack (?=--pack-destination)/g, "bun pm pack --cwd $1 "],
    // `bun install --no-save` leaves a stale lockfile stale, so the frozen
    // install after it fails again. --lockfile-only rewrites the lockfile.
    [/\bbun install --no-save\n(\s+)bun install --frozen-lockfile/g,
      "bun install --lockfile-only\n$1bun install --frozen-lockfile"],
    // Bun reads a heredoc only with an explicit stdin operand. Without one it
    // prints its help text and exits 0, so the step passes without running.
    [/\bbun --input-type=(\S+) <<'/g, "bun --input-type=$1 - <<'"],
    // pnpm store maintenance has no Bun equivalent.
    [/^\s*pnpm store prune \|\| true\n/gm, ""],
    // Layout assertions from pnpm's isolated linker. bunfig.toml sets
    // `linker = "hoisted"`, so `node_modules/.pnpm` never exists.
    [/\/node_modules\/\.pnpm\//g, "/node_modules/"],
    // Remaining pnpm command spellings with direct Bun equivalents.
    [/\bpnpm run /g, "bun run "],
    [/\bpnpm --silent /g, "bun --silent run "],
    [/\bpnpm exec /g, "bun x "],
    [/\bpnpm install\b/g, "bun install"],
  ];
}

export async function migrateWorkflowText(text, directories) {
  let next = text
    .replaceAll(/pnpm\/action-setup@[^\s]+/g, SETUP_BUN_ACTION)
    .replaceAll(/name: Setup pnpm\b/g, "name: Setup Bun")
    .replaceAll(/\n\s+version: 9(?:\.15\.4)?(?=\n)/g, `\n          bun-version: ${SETUP_BUN_VERSION}`)
    .replaceAll(/\n\s+cache: pnpm(?=\n)/g, "");
  for (const [pattern, replacement] of migrationRules(directories)) next = next.replace(pattern, replacement);
  return next;
}

export async function migrateWorkflows({ files, read = readFile, write = writeFile } = {}) {
  const directories = await workspaceDirectories(read);
  const targets = files ?? trackedFiles([".github/workflows/*.yml", ".github/workflows/*.yaml"]);
  const changed = [];
  for (const file of targets) {
    const original = await read(file, "utf8");
    const next = await migrateWorkflowText(original, directories);
    if (next !== original) {
      await write(file, next);
      changed.push(file);
    }
  }
  return changed;
}

if (import.meta.main) {
  const changed = await migrateWorkflows();
  console.log(`Updated ${changed.length} workflow files for Bun setup.`);
  for (const file of changed) console.log(`  ${file}`);
}
