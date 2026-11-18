import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve an installed package directory from `fromDirectory` the way Node
 * module resolution does, without letting the package's own `exports` map hide
 * it. Bun's hoisted linker keeps dependencies in the workspace `node_modules`
 * rather than beside the consumer, so a package-local lookup alone cannot see
 * them; createRequire walks the real install. `exports` maps routinely omit
 * `./package.json` (skillflag does), so the manifest probe falls back to the
 * filesystem walk Node would do after the exports check.
 */
export async function resolveInstalledPackageRoot(fromDirectory, name, { stopAt } = {}) {
  const require = createRequire(join(fromDirectory, "package.json"));
  for (const specifier of [`${name}/package.json`, name]) {
    let target;
    try {
      target = require.resolve(specifier);
    } catch (error) {
      if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && error?.code !== "MODULE_NOT_FOUND") throw error;
      continue;
    }
    for (let directory = dirname(target); ; directory = dirname(directory)) {
      try {
        if (JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name === name) {
          return await realpath(directory);
        }
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EISDIR" && error?.code !== "ENOTDIR") throw error;
      }
      if (directory === dirname(directory)) break;
    }
  }
  // Walk the filesystem the way Node does when `exports` hides the manifest.
  // Only ENOENT means "not installed"; ENOTDIR and other filesystem faults are
  // real breakage and must not be reported as an absent optional package.
  const boundary = stopAt === undefined ? undefined : resolve(stopAt);
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    try {
      await stat(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (directory === boundary || directory === dirname(directory)) return null;
  }
}

/** Seed every installed runtime root before traversing its dependency graph. */
export async function collectRunnerRuntimeDependencyRoots(runnerRoot, { resolveInstalled } = {}) {
  const resolveRoot = resolveInstalled ?? ((fromDirectory, dependencyName) => resolveInstalledPackageRoot(fromDirectory, dependencyName));
  const manifest = JSON.parse(await readFile(resolve(runnerRoot, "package.json"), "utf8"));
  const required = manifest.dependencies ?? {};
  const optional = manifest.optionalDependencies ?? {};
  const roots = [];
  for (const dependencyName of Object.keys({ ...required, ...optional }).sort()) {
    const packageRoot = await resolveRoot(runnerRoot, dependencyName);
    if (packageRoot === null || packageRoot === undefined) {
      // Platform-filtered optional packages may be absent. Malformed installed
      // roots and required dependencies must still fail the distribution check.
      if (Object.hasOwn(optional, dependencyName) && !Object.hasOwn(required, dependencyName)) continue;
      const error = new Error(`Required runtime dependency ${dependencyName} is not installed`);
      error.code = "ENOENT";
      throw error;
    }
    roots.push({ dependencyName, packageRoot });
  }
  return roots;
}
