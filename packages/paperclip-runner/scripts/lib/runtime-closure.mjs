// Enumerate the Runner's installed runtime closure and describe it as the
// override rules a clean consumer installs from.
//
// Two facts drive the shape. Bun's hoisted linker puts the whole workspace
// install in one `node_modules`, so the graph is enumerated with Node's real
// resolution from each package root rather than from a `.pnpm` virtual store
// that no longer exists. And a clean consumer must install from tarballs alone:
// every edge becomes a `parent>dependency` rule pointing at the packed tarball,
// which keeps each edge's resolved version instead of flattening versions by
// name. The Runner's own tarball keeps its committed manifest untouched, so the
// install also proves the published dependency ranges resolve to packed bytes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const manifestAt = async (directory) => JSON.parse(await readFile(join(directory, "package.json"), "utf8"));

/** A build-time link, not packed runtime bytes. */
const isBuildLink = (specifier) =>
  typeof specifier === "string" && (specifier.startsWith("workspace:") || specifier.startsWith("file:"));

/**
 * Every package the published graph reaches from `packageRoot`, with each
 * resolved edge. `resolveInstalled(fromDirectory, dependencyName)` returns the
 * installed directory or `null`; it is injected so a caller can bound the
 * lookup to its own install and a test can drive a synthetic tree.
 */
export async function enumerateRuntimeClosure({ packageRoot, resolveInstalled }) {
  const nodes = new Map();
  const edges = [];
  const queue = [];
  const enqueue = async (directory, manifest) => {
    const identity = `${manifest.name}@${manifest.version}`;
    if (!nodes.has(identity)) {
      nodes.set(identity, { packageRoot: directory, manifest });
      queue.push(identity);
    }
    return identity;
  };

  const rootManifest = await manifestAt(packageRoot);
  for (const dependencyName of Object.keys({ ...(rootManifest.dependencies ?? {}), ...(rootManifest.optionalDependencies ?? {}) }).sort()) {
    const dependencyRoot = await resolveInstalled(packageRoot, dependencyName);
    if (dependencyRoot === null) {
      if (Object.hasOwn(rootManifest.optionalDependencies ?? {}, dependencyName)) continue;
      throw new Error(`Required runtime dependency ${dependencyName} is not installed`);
    }
    edges.push({
      parentName: rootManifest.name,
      dependencyName,
      child: await enqueue(dependencyRoot, await manifestAt(dependencyRoot)),
      peer: false,
    });
  }

  while (queue.length > 0) {
    const current = nodes.get(queue.shift());
    const { dependencies = {}, optionalDependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = current.manifest;
    for (const dependencyName of Object.keys({ ...dependencies, ...optionalDependencies }).sort()) {
      const specifier = dependencies[dependencyName] ?? optionalDependencies[dependencyName];
      if (isBuildLink(specifier)) continue;
      const dependencyRoot = await resolveInstalled(current.packageRoot, dependencyName);
      if (dependencyRoot === null) {
        if (Object.hasOwn(optionalDependencies, dependencyName)) continue;
        throw new Error(`${current.manifest.name}@${current.manifest.version} dependency ${dependencyName} is not installed`);
      }
      edges.push({
        parentName: current.manifest.name,
        dependencyName,
        child: await enqueue(dependencyRoot, await manifestAt(dependencyRoot)),
        peer: false,
      });
    }
    for (const dependencyName of Object.keys(peerDependencies).sort()) {
      const dependencyRoot = await resolveInstalled(current.packageRoot, dependencyName);
      if (dependencyRoot === null) {
        if (peerDependenciesMeta[dependencyName]?.optional === true) continue;
        throw new Error(`${current.manifest.name}@${current.manifest.version} peer dependency ${dependencyName} is not installed`);
      }
      edges.push({
        parentName: current.manifest.name,
        dependencyName,
        declared: peerDependencies[dependencyName],
        child: await enqueue(dependencyRoot, await manifestAt(dependencyRoot)),
        peer: true,
      });
    }
  }
  return { nodes, edges, rootManifest };
}

/**
 * Turn an enumerated closure into consumer install inputs.
 *
 * Bun applies a `parent>dependency` rule to the parent's direct dependency,
 * which is exactly one resolved edge. A repeated selector would mean one parent
 * name reaches two versions of one dependency, which this rule form cannot
 * express, so that fails instead of silently collapsing the graph.
 *
 * Bun resolves a peer dependency against the install root rather than against
 * the package that declares it, so every satisfied peer also has to be a root
 * dependency. One root slot per name means several dependents may have resolved
 * different versions, so the highest is chosen and must satisfy every declaring
 * range; a range nothing satisfies fails closed.
 */
export function deriveConsumerInputs({ nodes, edges, tarballFor, semver }) {
  const bySelector = new Map();
  for (const edge of edges.filter((candidate) => !candidate.peer)) {
    const selector = `${edge.parentName}>${edge.dependencyName}`;
    const previous = bySelector.get(selector);
    if (previous !== undefined && previous !== edge.child) {
      throw new Error(`Cannot express ${selector} as one override: ${previous} and ${edge.child}`);
    }
    bySelector.set(selector, edge.child);
  }
  const overrides = {};
  for (const [selector, identity] of bySelector) overrides[selector] = `file:${tarballFor(identity)}`;

  const peerRanges = new Map();
  for (const edge of edges.filter((candidate) => candidate.peer)) {
    const ranges = peerRanges.get(edge.dependencyName) ?? [];
    ranges.push(edge.declared);
    peerRanges.set(edge.dependencyName, ranges);
  }
  const highest = new Map();
  for (const edge of edges.filter((candidate) => candidate.peer)) {
    const previous = highest.get(edge.dependencyName);
    const version = nodes.get(edge.child).manifest.version;
    if (previous === undefined || semver.order(version, nodes.get(previous).manifest.version) > 0) {
      highest.set(edge.dependencyName, edge.child);
    }
  }
  const peerDependencies = {};
  for (const [dependencyName, identity] of [...highest].sort(([left], [right]) => left.localeCompare(right))) {
    const version = nodes.get(identity).manifest.version;
    const unsatisfied = peerRanges.get(dependencyName).filter((range) => !semver.satisfies(version, range));
    if (unsatisfied.length > 0) {
      throw new Error(
        `Peer dependency ${dependencyName}@${version} does not satisfy the packed graph's ranges ${unsatisfied.join(", ")}`,
      );
    }
    peerDependencies[dependencyName] = `file:${tarballFor(identity)}`;
  }
  return { overrides, peerDependencies };
}
