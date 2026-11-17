// Stage the portable provider pack from the workspace's already-installed tree.
//
// `pnpm deploy --prod` used to materialize this directory. Bun has no deploy
// command, and a second install would resolve the registry again, drop the
// reviewed lockfile's patches, and ship different bytes than the qualified
// graph. Instead, walk the installed production closure of the Runner and copy
// every package to the relative path Node resolution gives it, so the pack's
// node_modules is the workspace's own installed graph, byte for byte.
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const inside = (root, candidate) => {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};

/**
 * Resolve `name` from `fromDirectory` with Node's lookup order, bounded by the
 * workspace install. Nothing outside that install may supply package bytes, and
 * an absent optional dependency stays absent instead of failing the build.
 */
export function resolveInstalledPackage(fromDirectory, name, workspaceRoot, { optional = false } = {}) {
  const workspace = realpathSync(workspaceRoot);
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    if (directory !== workspace && !inside(workspace, directory)) {
      throw new Error(`Provider pack dependency ${name} resolves outside the workspace install`);
    }
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      // A link may still point out of the install, so admit only the real path.
      const resolved = realpathSync(candidate);
      if (!inside(workspace, resolved)) {
        throw new Error(`Provider pack dependency ${name} resolves outside the workspace install`);
      }
      return resolved;
    }
    if (directory === workspace) {
      if (optional) return null;
      throw new Error(`Provider pack dependency ${name} is not installed under ${workspace}`);
    }
  }
}

/**
 * The path an installed package occupies below `node_modules`. Hoisted installs
 * keep shared packages at <install>/node_modules/<name>; a package that needs an
 * overridden version keeps it in a nested node_modules, which mirrors too.
 */
export function installedPackagePath(workspaceRoot, packageRoot, source) {
  const base = [join(realpathSync(workspaceRoot), "node_modules"), join(realpathSync(packageRoot), "node_modules")]
    .find(candidate => existsSync(candidate) && inside(candidate, source));
  if (!base) throw new Error(`Provider pack package ${source} is outside the workspace install`);
  const path = relative(base, source).split(sep).join("/");
  if (!path || path.split("/").includes("..")) {
    throw new Error(`Provider pack package ${source} is outside the workspace install`);
  }
  return path;
}

function copyTree(source, destination) {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) throw new Error(`Provider pack tree entry ${source} is a symbolic link`);
  if (stats.isFile()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    copyFileSync(source, destination);
    return;
  }
  if (!stats.isDirectory()) throw new Error(`Provider pack tree entry ${source} is not a regular file or directory`);
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    // A nested install is its own closure member and the walk stages it at the
    // resolved location; copying it here would duplicate the tree.
    if (entry.isDirectory() && entry.name === "node_modules") continue;
    copyTree(join(source, entry.name), join(destination, entry.name));
  }
}

/**
 * Materialize the deployed package root: the published `files` entries, the
 * readme and license npm always packs, and the installed manifest that the
 * runtime binds as PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST.
 */
export function stageProviderPackPackageRoot({ packageRoot, destinationRoot }) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || !manifest.name || !Array.isArray(manifest.files)) {
    throw new Error("Provider pack package must declare its name and published files");
  }
  mkdirSync(destinationRoot, { recursive: true, mode: 0o755 });
  for (const entry of [...manifest.files, "README.md", "LICENSE", "LICENSE.md"]) {
    const source = resolve(packageRoot, entry);
    if (!inside(packageRoot, source)) throw new Error(`Provider pack published file ${entry} escapes its package`);
    if (existsSync(source)) copyTree(source, resolve(destinationRoot, entry));
  }
  copyFileSync(resolve(packageRoot, "package.json"), resolve(destinationRoot, "package.json"));
  return manifest;
}

/**
 * Copy the Runner's installed production closure into `destinationRoot`. Bytes
 * come from the install, including the reviewed patches; no package manager runs
 * and nothing is resolved against a registry. `packageManager` records the
 * staged graph so the pack documents what it contains.
 */
export function stageProviderPack({ packageRoot, workspaceRoot, destinationRoot }) {
  const root = realpathSync(packageRoot);
  const workspace = realpathSync(workspaceRoot);
  const { dependencies, optionalDependencies } = stageProviderPackPackageRoot({ packageRoot: root, destinationRoot });
  const staged = new Map();
  const pending = [];
  // Hoisted installs keep the runner's dependencies in the workspace
  // node_modules, so seed the closure with Node's lookup from the package root
  // rather than assuming a node_modules beside it.
  for (const name of Object.keys(dependencies ?? {})) pending.push(resolveInstalledPackage(root, name, workspace));
  for (const name of Object.keys(optionalDependencies ?? {})) {
    const source = resolveInstalledPackage(root, name, workspace, { optional: true });
    if (source) pending.push(source);
  }
  while (pending.length) {
    const source = pending.shift();
    const path = installedPackagePath(workspace, root, source);
    if (staged.has(path)) continue;
    const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    staged.set(path, installed.version);
    copyTree(source, join(destinationRoot, "node_modules", ...path.split("/")));
    // Workspace links belong to the runner package itself, which is the pack
    // root; a sibling workspace package is never part of the runtime closure.
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [name, specifier] of Object.entries(installed[section] ?? {})) {
        if (typeof specifier === "string" && specifier.startsWith("workspace:")) continue;
        const resolved = resolveInstalledPackage(source, name, workspace, {
          optional: section === "optionalDependencies",
        });
        if (resolved) pending.push(resolved);
      }
    }
  }
  return [...staged.keys()].sort().map(path => ({ path, version: staged.get(path) }));
}

function readShebang(path) {
  const descriptor = openSync(path, "r");
  try {
    const head = Buffer.alloc(128);
    return head.subarray(0, readSync(descriptor, head, 0, head.length, 0)).toString("utf8").split("\n", 1)[0];
  } finally { closeSync(descriptor); }
}

/**
 * Expose the commands of the pack root's direct production dependencies, which
 * is the set `pnpm deploy` linked. Launchers stay pack-relative and run node
 * scripts on the pack's own pinned interpreter, so the build directory never
 * enters the pack and a relocated pack still works.
 */
export function writeInstalledCommandShims(packRoot, { packageRoot }) {
  const modules = join(packRoot, "node_modules");
  const directory = join(modules, ".bin");
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const names = [];
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
    const packageDirectory = join(modules, name);
    const manifestPath = join(packageDirectory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bin = typeof installed.bin === "string" ? { [basename(name)]: installed.bin } : installed.bin ?? {};
    for (const [command, target] of Object.entries(bin).sort(([left], [right]) => left.localeCompare(right))) {
      const path = resolve(packageDirectory, target);
      if (!inside(packageDirectory, path) || !existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error(`Provider pack command ${command} of ${name} is not a regular file inside its package`);
      }
      const relativePath = relative(directory, path).split(sep).join("/");
      const launcher = /^#!.*\bnode(?:js)?\b/.test(readShebang(path))
        ? `"$basedir/../node/bin/node" "$basedir/${relativePath}"`
        : `"$basedir/${relativePath}"`;
      writeFileSync(join(directory, command), [
        "#!/bin/sh", "set -eu",
        'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        `exec ${launcher} "$@"`, "",
      ].join("\n"));
      chmodSync(join(directory, command), 0o755);
      names.push(command);
    }
  }
  return names.sort();
}

/**
 * The Bun version the workspace pins as its package manager, so a staged
 * runtime is the reviewed toolchain rather than whatever is on PATH.
 */
export function pinnedBunVersion(workspaceRoot) {
  const manifest = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8"));
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
  if (!match) throw new Error("The workspace package.json must pin its Bun version as packageManager");
  return match[1];
}
