import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
/**
 * The digest the pack manifest records for a directory tree: `distDigest` and
 * each provider asset tree. The server recomputes it with the same walk
 * (remote-provider-pack-verification.ts), so the entry order and the record
 * format are part of the pack contract.
 */
export function sha256Tree(root) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\n`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const file = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
        hash.update(`file\0${relativePath}\0sha256:${file}\n`);
      } else if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${readlinkSync(absolutePath)}\n`,
        );
      } else {
        throw new Error(
          `Provider pack tree contains unsupported entry ${relativePath}`,
        );
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}

export function removeControllerArtifactsFromProviderPack(packRoot) {
  for (const directory of ["bin", "remote-provider-packs"]) {
    rmSync(join(packRoot, "dist", directory), { recursive: true, force: true });
  }
}

/** libc family of the Node copied into the pack; undefined where npm has no libc field. */
export function providerPackLibc(platform = process.platform, report = () => process.report.getReport()) {
  if (platform !== "linux") return undefined;
  return report().header.glibcVersionRuntime ? "glibc" : "musl";
}

const inside = (root, candidate) => {
  const value = relative(root, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
};

const toPosix = path => path.split(sep).join("/");

/**
 * Every installed package below the pack's node_modules, whatever the install
 * layout hoisted it into. The key comes from `installedPackageKeyOf`, so this
 * walk and the removal guard agree on how a package is named.
 */
function installedPackages(packRoot) {
  const modules = realpathSync(join(packRoot, "node_modules"));
  const found = new Map();
  const walk = directory => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".cache") continue;
      const path = join(directory, entry.name);
      const manifest = join(path, "package.json");
      if (existsSync(manifest)) {
        const key = installedPackageKeyOf(packRoot, path);
        if (!found.has(key)) found.set(key, { key, path, manifest });
        // A package's own nested install is a separate closure member.
        if (existsSync(join(path, "node_modules"))) walk(join(path, "node_modules"));
      } else {
        walk(path);
      }
    }
  };
  walk(modules);
  return [...found.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * The removal key that names the installed package containing `path`. A pnpm
 * virtual store names a whole entry; a hoisted install names the package's own
 * path. Both are pack-relative, so a key can never name anything outside.
 */
export function installedPackageKeyOf(packRoot, path) {
  const modules = realpathSync(join(packRoot, "node_modules"));
  let resolved = realpathSync(path);
  if (!inside(modules, resolved)) {
    throw new Error(`${path} is not inside the provider pack's node_modules`);
  }
  // Callers pass a resolved file as often as a package directory, so walk up to
  // the nearest installed package before naming it.
  while (!existsSync(join(resolved, "package.json"))) {
    const parent = dirname(resolved);
    if (parent === resolved || !inside(modules, parent)) {
      throw new Error(`${path} is not inside a package of the provider pack`);
    }
    resolved = parent;
  }
  const store = join(modules, ".pnpm");
  if (existsSync(store)) {
    const real = realpathSync(store);
    if (inside(real, resolved)) {
      const parts = relative(real, resolved).split(sep);
      // A store entry owns <entry>/node_modules/<name>. The aggregate
      // <entry>/node_modules directory is not itself a package.
      if (parts[0] !== "node_modules" && parts.length >= 2 && parts[1] === "node_modules" && parts[0]) return parts[0];
      if (parts[0] === "node_modules") throw new Error(`${path} is not inside a package of the provider pack`);
    }
  }
  return toPosix(relative(modules, resolved));
}

function pruneDanglingCommands(modules) {
  const bin = join(modules, ".bin");
  if (!existsSync(bin)) return;
  for (const entry of readdirSync(bin, { withFileTypes: true })) {
    const path = join(bin, entry.name);
    if (!entry.isSymbolicLink()) continue;
    if (!existsSync(resolve(bin, readlinkSync(path)))) unlinkSync(path);
  }
}

/**
 * Whether a removal key names exactly one installed package: a hoisted package
 * (`name`, `@scope/name`, or the same after a `node_modules` segment) or a pnpm
 * virtual-store entry (`tool@1.0.0`, `@scope+tool@1.0.0`).
 */
function namesOnePackage(parts) {
  if (parts.length === 0) return false;
  if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) return false;
  // A pnpm store entry is a single flattened directory name.
  if (parts.length === 1) return parts[0] !== "node_modules" && !parts[0].startsWith(".");
  // Otherwise every shape ends in a package name, each `node_modules` separates
  // an owner from the package it installed, and a scope owns exactly one name.
  let index = 0;
  if (parts[0].startsWith("@") && !parts[0].includes("+")) {
    if (parts.length < 2) return false;
    index = 2;
  } else index = 1;
  while (index < parts.length) {
    if (parts[index] !== "node_modules" || index + 1 >= parts.length) return false;
    index += parts[index + 1].startsWith("@") ? 3 : 2;
  }
  return index === parts.length;
}

/**
 * Remove installed packages by removal key and repair what pointed at them, so
 * no dangling dependency slot or command survives into the immutable pack.
 */
export function removeInstalledPackages(packRoot, keys) {
  const modules = join(packRoot, "node_modules");
  const removed = [];
  for (const key of keys) {
    const parts = typeof key === "string" ? key.split("/") : [];
    if (!namesOnePackage(parts)) throw new Error(`Refusing to remove provider pack path ${key}`);
    const candidates = [resolve(modules, ".pnpm", ...parts), resolve(modules, ...parts)];
    if (!candidates.every(candidate => inside(modules, candidate))) {
      throw new Error(`Refusing to remove provider pack path ${key}`);
    }
    const path = candidates.find(candidate => existsSync(candidate));
    if (path) removed.push(path);
  }
  if (!removed.length) return;
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const pruned = target => removed.some(path => target === path || target.startsWith(`${path}${sep}`));
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (pruned(resolve(directory, readlinkSync(path)))) unlinkSync(path);
      } else if (entry.isDirectory()) {
        visit(path);
        if (entry.name.startsWith("@") && readdirSync(path).length === 0) rmdirSync(path);
      }
    }
  };
  visit(modules);
  pruneDanglingCommands(modules);
}

/**
 * Optional platform packages for another libc are installed beside the ones this
 * pack can run, because the installer filters on os and cpu but not libc. The
 * pack only runs its own copied Node, so packages built for the other libc can
 * never load; the Claude and OpenCode musl builds add 400-600 MB per pack.
 */
export function removeForeignLibcPackagesFromProviderPack(packRoot, libc) {
  if (!libc) return [];
  const foreign = installedPackages(packRoot)
    .map(entry => ({ ...entry, metadata: JSON.parse(readFileSync(entry.manifest, "utf8")) }))
    .filter(entry => Array.isArray(entry.metadata.libc) && !entry.metadata.libc.includes(libc));
  if (!foreign.length) return [];
  removeInstalledPackages(packRoot, foreign.map(({ key }) => key));
  return foreign.map(entry => entry.metadata.name ?? entry.key).sort((left, right) => left.localeCompare(right));
}
