import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deriveConsumerInputs, enumerateRuntimeClosure } from "./lib/runtime-closure.mjs";

/** A synthetic installed tree: one flat `node_modules`, exactly like a hoisted install. */
async function install(t, packages) {
  const root = await mkdtemp(join(tmpdir(), "runtime-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  await mkdir(modules, { recursive: true });
  const directories = new Map();
  for (const [name, manifest] of Object.entries(packages)) {
    const directory = join(modules, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, ...manifest }));
    directories.set(name, directory);
  }
  return { root, directories };
}

const resolveFrom = (directories) => (_from, name) => directories.get(name) ?? null;

test("enumerates a hoisted graph by resolving each package from its own root", async (t) => {
  const { root, directories } = await install(t, {
    "@scope/dep": { version: "2.0.0", dependencies: { leaf: "^1.0.0" } },
    leaf: { version: "1.0.0" },
  });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { "@scope/dep": "^2.0.0" },
  }));
  const { nodes, edges } = await enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: resolveFrom(directories) });
  assert.deepEqual([...nodes.keys()].sort(), ["@scope/dep@2.0.0", "leaf@1.0.0", "runner@0.0.0"].sort().filter((id) => id !== "runner@0.0.0"));
  assert.deepEqual(
    edges.map((edge) => `${edge.parentName}>${edge.dependencyName}=${edge.child}`),
    ["runner>@scope/dep=@scope/dep@2.0.0", "@scope/dep>leaf=leaf@1.0.0"],
  );
});

test("keeps two resolved versions of one dependency apart under different parents", async (t) => {
  // The real graph has this: two @agentclientprotocol/sdk versions in the
  // closure. A name-only override would flatten them; the parent-qualified rule
  // keeps both.
  const { root, directories } = await install(t, {
    "bridge-a": { version: "1.0.0", dependencies: { sdk: "1.4.0" } },
    "bridge-b": { version: "1.0.0", dependencies: { sdk: "^1.9.0" } },
    "sdk": { version: "1.9.0" },
  });
  await mkdir(join(directories.get("bridge-a"), "node_modules/sdk"), { recursive: true });
  await writeFile(
    join(directories.get("bridge-a"), "node_modules/sdk/package.json"),
    JSON.stringify({ name: "sdk", version: "1.4.0" }),
  );
  const nested = (from, name) => {
    if (from === directories.get("bridge-a") && name === "sdk") return join(directories.get("bridge-a"), "node_modules/sdk");
    return directories.get(name) ?? null;
  };
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { "bridge-a": "1.0.0", "bridge-b": "1.0.0" },
  }));
  const { nodes, edges } = await enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: nested });
  const { overrides } = deriveConsumerInputs({
    nodes,
    edges,
    tarballFor: (identity) => `/artifacts/${identity}.tgz`,
    semver: Bun.semver,
  });
  assert.equal(overrides["bridge-a>sdk"], "file:/artifacts/sdk@1.4.0.tgz");
  assert.equal(overrides["bridge-b>sdk"], "file:/artifacts/sdk@1.9.0.tgz");
  assert.equal(overrides.sdk, undefined, "one resolved version per selector, never a name-level flattening");
});

test("rejects a graph where one parent name reaches two versions of a dependency", async (t) => {
  // Bun's parent>dependency selector form cannot express this, so it must fail
  // rather than ship one of the two versions silently.
  const { root } = await install(t, {});
  const nodes = new Map([
    ["sdk@1.4.0", { manifest: { name: "sdk", version: "1.4.0" } }],
    ["sdk@1.9.0", { manifest: { name: "sdk", version: "1.9.0" } }],
  ]);
  const edges = [
    { parentName: "sdk", dependencyName: "zod", child: "zod@4.4.3", peer: false },
    { parentName: "sdk", dependencyName: "zod", child: "zod@4.6.7", peer: false },
  ];
  assert.throws(
    () => deriveConsumerInputs({ nodes, edges, tarballFor: () => "/t.tgz", semver: Bun.semver }),
    /Cannot express sdk>zod as one override/,
  );
  await rm(root, { recursive: true, force: true });
});

test("promotes satisfied peers to root dependencies at the highest compatible version", async (t) => {
  const { root, directories } = await install(t, {
    "sdk-old": { version: "1.4.0", peerDependencies: { zod: "^4.0.0" } },
    "sdk-new": { version: "1.9.0", peerDependencies: { zod: "^4.6.0" } },
    zod: { version: "4.6.7" },
  });
  await mkdir(join(directories.get("sdk-old"), "node_modules/zod"), { recursive: true });
  await writeFile(
    join(directories.get("sdk-old"), "node_modules/zod/package.json"),
    JSON.stringify({ name: "zod", version: "4.4.3" }),
  );
  const nested = (from, name) => {
    if (from === directories.get("sdk-old") && name === "zod") return join(directories.get("sdk-old"), "node_modules/zod");
    return directories.get(name) ?? null;
  };
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { "sdk-old": "1.4.0", "sdk-new": "1.9.0" },
  }));
  const { nodes, edges } = await enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: nested });
  const { peerDependencies } = deriveConsumerInputs({
    nodes,
    edges,
    tarballFor: (identity) => `/artifacts/${identity}.tgz`,
    semver: Bun.semver,
  });
  // Both declaring ranges accept 4.6.7, and Bun resolves a peer at the install
  // root, so the highest satisfying version becomes the single root slot.
  assert.deepEqual(peerDependencies, { zod: "file:/artifacts/zod@4.6.7.tgz" });
});

test("fails closed when no packed version satisfies a peer range", async (t) => {
  const { root, directories } = await install(t, { sdk: { version: "1.0.0", peerDependencies: { zod: "^5.0.0" } }, zod: { version: "4.6.7" } });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { sdk: "1.0.0" },
  }));
  const { nodes, edges } = await enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: resolveFrom(directories) });
  assert.throws(
    () => deriveConsumerInputs({ nodes, edges, tarballFor: () => "/t.tgz", semver: Bun.semver }),
    /does not satisfy the packed graph's ranges \^5\.0.0/,
  );
});

test("skips absent optional dependencies and optional peers but not required ones", async (t) => {
  const { root, directories } = await install(t, {
    present: { version: "1.0.0", optionalDependencies: { missing: "^1.0.0" }, peerDependencies: { "optional-peer": "*" }, peerDependenciesMeta: { "optional-peer": { optional: true } } },
  });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { present: "1.0.0" },
    optionalDependencies: { "absent-platform": "^9.9.9" },
  }));
  const { nodes } = await enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: resolveFrom(directories) });
  assert.deepEqual([...nodes.keys()], ["present@1.0.0"]);

  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { "absent-required": "^1.0.0" },
  }));
  await assert.rejects(
    enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: resolveFrom(directories) }),
    /Required runtime dependency absent-required is not installed/,
  );
});

test("ignores workspace and file specifiers, which are build-time links, not packed bytes", async (t) => {
  const { root, directories } = await install(t, {
    real: { version: "1.0.0", dependencies: { linked: "workspace:*", local: "file:../local" } },
  });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "runner",
    version: "0.0.0",
    dependencies: { real: "1.0.0" },
  }));
  const { nodes, edges } = await enumerateRuntimeClosure({ packageRoot: root, resolveInstalled: resolveFrom(directories) });
  assert.deepEqual([...nodes.keys()], ["real@1.0.0"]);
  assert.deepEqual(edges.map((edge) => edge.dependencyName), ["real"]);
});
