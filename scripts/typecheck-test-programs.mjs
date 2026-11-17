#!/usr/bin/env bun
// Typechecks the test files that no build or package typecheck reads.
//
// Most package tsconfigs exclude tests so that `tsc` does not emit them, and
// Vitest strips types, so a type error in those tests fails nothing. Each program
// in PROGRAMS reads them without emitting. Sandbox providers are outside the
// workspace, so the root install has none of their dependencies. They install from
// typecheck-sandbox-providers/bun.lock here, because their SDK types are part
// of what a test checks. A provider with its own lockfile (LOCKED_PROVIDERS) installs
// from that lockfile instead, so each lockfile has one owner and one Dependabot entry.
//
// The script then fails if a tracked test file is in no program. tsc decides that,
// not a glob: `include` silently drops foo.test.tsx when foo.test.ts exists.
//
// Usage: bun scripts/typecheck-test-programs.mjs [--low-memory] [tsconfig ...]
// Naming a tsconfig runs only that program and skips the coverage check.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkExcludedPlugins } from "./link-plugin-dev-sdk.mjs";
import { resolveTscPath } from "./lib/tsc-path.mjs";
import { listWorkspaceDirectories } from "./lib/workspace-packages.mjs";
import { LOW_MEMORY_VARIABLE, runTsc } from "./run-tsc.mjs";
import { PROJECTS } from "./typecheck-test-projects.mjs";

export const PROVIDER_WORKSPACE = "scripts/typecheck-sandbox-providers";

export const SANDBOX_PROVIDERS = [
  "packages/plugins/sandbox-providers/boxd",
  "packages/plugins/sandbox-providers/cloudflare",
  "packages/plugins/sandbox-providers/cloudflare/bridge-template",
  "packages/plugins/sandbox-providers/createos",
  "packages/plugins/sandbox-providers/daytona",
  "packages/plugins/sandbox-providers/e2b",
  "packages/plugins/sandbox-providers/exe-dev",
  "packages/plugins/sandbox-providers/kubernetes",
  "packages/plugins/sandbox-providers/modal",
  "packages/plugins/sandbox-providers/novita",
];

// Providers that commit their own bun.lock. The release build and the Daytona
// end-to-end job install it frozen, so the shared workspace leaves them out.
export const LOCKED_PROVIDERS = ["packages/plugins/sandbox-providers/daytona"];

export const PROGRAMS = [
  "packages/db/tsconfig.test.json",
  "packages/kv-demo-mcp-server/tsconfig.test.json",
  "packages/paperclip-runner/tsconfig.browser.test.json",
  "packages/paperclip-runner/tsconfig.surfaces.test.json",
  "packages/paperclip-runner/tsconfig.test.json",
  "packages/plugins/examples/plugin-orchestration-smoke-example/tsconfig.test.json",
  "packages/plugins/plugin-workspace-diff/tsconfig.test.json",
  "packages/plugins/sdk/tsconfig.test.json",
  ...SANDBOX_PROVIDERS.map((directory) => `${directory}/tsconfig.test.json`),
  "scripts/scale-ramp/tsconfig.json",
  "tests/runner-acceptance/tsconfig.json",
  "tests/tsconfig.playwright.json",
];

// server/scripts/typecheck-layers.mjs reads this tree. Everything else must be in a program.
export const CHECKED_ELSEWHERE = ["server/src/"];

const PREPARE_STEPS = [
  ["run", "--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
  ["run", "--filter", "@paperclipai/paperclip-runner", "ensure:eval-build-deps"],
];
const INSTALL_ARGS = ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"];
const LOCKED_INSTALL_ARGS = ["install", "--ignore-workspace", ...INSTALL_ARGS.slice(1)];
// Contributors do not commit provider lockfiles: the lockfile refresh workflow regenerates them after
// merge, as it does the root bun.lock. Until then a changed manifest leaves the lockfile stale,
// so rewrite the lockfile in place, like the root install in CI. Bun's equivalent of pnpm's
// `--resolution-only` is `--lockfile-only`, which writes the lockfile without installing.
export const RESOLVE_ARGS = ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"];
const LOCKED_RESOLVE_ARGS = ["install", "--ignore-workspace", ...RESOLVE_ARGS.slice(1)];

export function findUncheckedTests({ trackedFiles, checkedFiles, checkedElsewhere = CHECKED_ELSEWHERE }) {
  const checked = new Set(checkedFiles);
  return trackedFiles.filter(
    (file) =>
      /\.(test|spec)\.tsx?$/.test(file) &&
      !checked.has(file) &&
      !checkedElsewhere.some((prefix) => file.startsWith(prefix)),
  );
}

function runBun(args, { cwd, env }) {
  const result = spawnSync("bun", args, {
    cwd,
    env,
    stdio: "inherit",
    // A bare `bun` on Windows is bun.exe, which needs the shell to resolve.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function listProgramFiles(config, { cwd, env }) {
  const result = spawnSync(process.execPath, [resolveTscPath(cwd), "-p", config, "--listFilesOnly"], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    output: result.stdout,
    files: result.stdout
      .split("\n")
      .filter(Boolean)
      .map((file) => path.relative(cwd, file).split(path.sep).join("/")),
  };
}

function listWorkspaceConfigs(root) {
  return listWorkspaceDirectories({ root })
    .map((directory) => `${directory}/tsconfig.json`)
    .filter((config) => config !== "server/tsconfig.json" && existsSync(path.join(root, config)));
}

function listTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Unable to list tracked files.");
  return result.stdout.split("\0").filter(Boolean);
}

/** Returns the test files in no program, or null if a program could not be listed. */
export function checkCoverage({
  root,
  env = process.env,
  programs = PROGRAMS,
  workspaceConfigs = listWorkspaceConfigs,
  trackedFiles = listTrackedFiles,
  listFiles = listProgramFiles,
  logError = console.error,
}) {
  const checkedFiles = [];
  // `bun run build` and `typecheck:build-gaps` check each workspace's tsconfig.json.
  // scripts/typecheck-test-projects.mjs checks these same files through tsconfig.layers.json.
  const projectConfigs = PROJECTS.map((project) => `${project}/tsconfig.json`);
  for (const config of [...workspaceConfigs(root), ...projectConfigs, ...programs]) {
    const listing = listFiles(config, { cwd: root, env });
    if (listing.status !== 0) {
      logError(`typecheck:test-programs: could not list the files of ${config}\n${listing.output ?? ""}`);
      return null;
    }
    checkedFiles.push(...listing.files);
  }
  return findUncheckedTests({ trackedFiles: trackedFiles(root), checkedFiles });
}

export function prepareTestPrograms({
  root,
  env = process.env,
  bun = runBun,
  linkPlugins = linkExcludedPlugins,
  log = console.log,
  logError = console.error,
}) {
  for (const args of PREPARE_STEPS) {
    const status = bun(args, { cwd: root, env });
    if (status !== 0) return status;
  }
  const install = (directory, frozenArgs, resolveArgs) => {
    const cwd = path.join(root, directory);
    let status = bun(frozenArgs, { cwd, env });
    if (status !== 0) {
      log(
        `typecheck:test-programs: ${directory}/bun.lock does not match its manifests. ` +
          `Resolving it in place. Do not commit it: the lockfile refresh workflow updates it after merge.`,
      );
      status = bun(resolveArgs, { cwd, env });
      if (status === 0) status = bun(frozenArgs, { cwd, env });
    }
    if (status !== 0) logError(`typecheck:test-programs: could not install the sandbox providers in ${directory}`);
    return status;
  };
  const installed = install(PROVIDER_WORKSPACE, INSTALL_ARGS, RESOLVE_ARGS);
  if (installed !== 0) return installed;
  for (const provider of LOCKED_PROVIDERS) {
    const status = install(provider, LOCKED_INSTALL_ARGS, LOCKED_RESOLVE_ARGS);
    if (status !== 0) return status;
  }
  // The installs remove the SDK link from each provider's node_modules.
  linkPlugins();
  return 0;
}

export function typecheckTestPrograms({
  root,
  env = process.env,
  programs = PROGRAMS,
  coverage = true,
  prepare = true,
  bun = runBun,
  linkPlugins = linkExcludedPlugins,
  run = runTsc,
  checkFiles = checkCoverage,
  log = console.log,
  logError = console.error,
}) {
  if (prepare) {
    const prepared = prepareTestPrograms({ root, env, bun, linkPlugins, log, logError });
    if (prepared !== 0) return prepared;
  }

  let exitCode = 0;
  for (const config of programs) {
    log(`typecheck:test-programs: ${config}`);
    const { status, signal } = run(["-p", config], { cwd: root, env });
    if (signal) return status || 1;
    if (status !== 0) exitCode = status;
  }
  if (!coverage) return exitCode;

  const unchecked = checkFiles({ root, env, logError });
  if (unchecked === null) return exitCode || 1;
  if (unchecked.length > 0) {
    logError(
      `typecheck:test-programs: ${unchecked.length} test files are in no typechecked program. ` +
        `Add them to a program in scripts/typecheck-test-programs.mjs. A foo.test.tsx beside a foo.test.ts needs a new name.\n` +
        unchecked.map((file) => `  ${file}`).join("\n"),
    );
    return exitCode || 1;
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith("--"));
  const programs = args.filter((arg) => !arg.startsWith("--"));
  const unknownFlags = flags.filter((flag) => !["--low-memory", "--prepare-only", "--skip-prepare"].includes(flag));
  const unknown = programs.filter((program) => !PROGRAMS.includes(program));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = flags.includes("--low-memory") ? { ...process.env, [LOW_MEMORY_VARIABLE]: "1" } : process.env;
  if (unknownFlags.length > 0) {
    console.error(`Unknown option: ${unknownFlags.join(", ")}`);
    process.exitCode = 2;
  } else if (flags.includes("--prepare-only") && (flags.includes("--skip-prepare") || programs.length > 0)) {
    console.error("--prepare-only takes no programs and cannot be combined with --skip-prepare");
    process.exitCode = 2;
  } else if (unknown.length > 0) {
    console.error(`Unknown program: ${unknown.join(", ")}. Known programs:\n  ${PROGRAMS.join("\n  ")}`);
    process.exitCode = 2;
  } else if (flags.includes("--prepare-only")) {
    process.exitCode = prepareTestPrograms({ root, env });
  } else {
    process.exitCode = typecheckTestPrograms({
      root,
      env,
      programs: programs.length > 0 ? programs : PROGRAMS,
      coverage: programs.length === 0,
      prepare: !flags.includes("--skip-prepare"),
    });
  }
}
