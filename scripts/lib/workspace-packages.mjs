// Reads the root workspace membership from `package.json#workspaces`.
//
// Bun reads that key for `bun install` and every `bun run --workspaces`, so it
// is the single place that decides which directories are workspace packages.
// A `!glob` entry excludes matches and the last matching entry wins, which is
// how `packages/plugins/*` and `!packages/plugins/sandbox-providers/**` coexist.
//
// Only the scripts that need the list as data use this module.
// scripts/typecheck-test-programs.mjs `pnpm ls -r` replacement and
// scripts/run-typecheck-build-gaps.mjs both need it; nothing else should grow a
// second workspace glob implementation.

import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

/** Extracts the `workspaces` array from a package.json, or a YAML block sequence. */
export function parseWorkspaceEntries(workspaceText) {
  let patterns;
  try {
    patterns = JSON.parse(workspaceText).workspaces;
  } catch {
    // Not JSON: fall back to the `- entry` block-sequence shape.
    patterns = workspaceText
      .split("\n")
      .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
      .filter(Boolean)
      .map((entry) => entry.replace(/^(['"])(.*)\1$/, "$2"));
  }
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
    throw new Error(`Expected a "workspaces" array of glob strings, got ${JSON.stringify(patterns)}.`);
  }
  return patterns.map((pattern) => ({
    pattern: pattern.startsWith("!") ? pattern.slice(1) : pattern,
    negated: pattern.startsWith("!"),
  }));
}

/** The workspace entries of the repository at `root`. */
export function readWorkspaceEntries(root) {
  return parseWorkspaceEntries(readFileSync(path.join(root, "package.json"), "utf8"));
}

/**
 * Whether a directory relative to the workspace root is a workspace package.
 * The last entry that matches decides, so an exclusion can follow an inclusion.
 */
export function isWorkspacePackage(pkgDir, workspaceEntries) {
  let included = false;
  for (const entry of workspaceEntries) {
    if (path.matchesGlob(pkgDir, entry.pattern)) included = !entry.negated;
  }
  return included;
}

/**
 * The workspace package directories, relative to `root`, sorted. A directory is
 * a package only when it has a package.json, so `packages/*` matching
 * `packages/plugins` does not add that grouping directory.
 */
export function listWorkspaceDirectories({ root, workspaceEntries = readWorkspaceEntries(root) }) {
  const directories = new Set();
  for (const entry of workspaceEntries.filter((candidate) => !candidate.negated)) {
    for (const match of globSync(entry.pattern, { cwd: root })) directories.add(match);
  }
  return [...directories]
    .filter((directory) => isWorkspacePackage(directory, workspaceEntries))
    .filter((directory) => existsSync(path.join(root, directory, "package.json")))
    .sort();
}
