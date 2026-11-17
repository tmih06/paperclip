import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MINIMUM_NODE_VERSION, resolvePinnedBun, resolvePinnedNode, stagePackInterpreter,
} from "./provider-pack-interpreters.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-interpreter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A stand-in interpreter reports the version its file name encodes, so the
// selection logic is exercised without depending on the host's toolchain.
function standIn(root, name, version) {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  chmodSync(path, 0o755);
  return path;
}

test("the pack pins Node 24.11.0 as its minimum", () => {
  assert.deepEqual(MINIMUM_NODE_VERSION, [24, 11, 0]);
});

test("accepts a Node at the pinned minimum and one above it", (t) => {
  const root = fixture(t);
  const minimum = standIn(root, "node", "v24.11.0");
  assert.deepEqual(resolvePinnedNode({ environment: { PATH: root }, execPath: "/nonexistent", versions: { bun: "1.4.4" } }), {
    command: minimum, version: "24.11.0",
  });
  const newer = standIn(root, "node", "v24.18.0");
  assert.deepEqual(resolvePinnedNode({ environment: { PATH: root }, execPath: "/nonexistent", versions: { bun: "1.4.4" } }), {
    command: newer, version: "24.18.0",
  });
});

test("rejects a Node older than the pinned minimum and one that is not Node", (t) => {
  const root = fixture(t);
  standIn(root, "node", "v24.10.9");
  assert.throws(() => resolvePinnedNode({ environment: { PATH: root }, execPath: "/nonexistent", versions: { bun: "1.4.4" } }), /is Node 24\.10\.9/);
  // Bun answers `-e` scripts but not `--version` when the file is named node, so
  // a run named node that does not print a version must not be accepted.
  standIn(root, "node", "error: Missing script to execute.");
  assert.throws(() => resolvePinnedNode({ environment: { PATH: root }, execPath: "/nonexistent", versions: { bun: "1.4.4" } }), /is not a Node executable/);
});

test("prefers the interpreter running the build when it is a Node", (t) => {
  const root = fixture(t);
  standIn(root, "node", "v22.0.0");
  const execPath = standIn(root, "build-node", "v24.18.0");
  const result = resolvePinnedNode({ environment: { PATH: root }, execPath, versions: { node: "24.18.0" } });
  assert.equal(result.command, execPath);
  assert.equal(result.version, "24.18.0");
});

test("an absolute override wins over PATH and a relative one is refused", (t) => {
  const root = fixture(t);
  standIn(root, "node", "v24.11.0");
  const override = standIn(root, "pinned-node", "v24.18.0");
  assert.equal(resolvePinnedNode({
    environment: { PATH: root, PAPERCLIP_RUNNER_PROVIDER_NODE: override },
    execPath: "/nonexistent", versions: { bun: "1.4.4" },
  }).command, override);
  assert.throws(() => resolvePinnedNode({
    environment: { PATH: root, PAPERCLIP_RUNNER_PROVIDER_NODE: "./node" },
    execPath: "/nonexistent", versions: { bun: "1.4.4" },
  }), /must be an absolute path/);
});

test("a build running on Bun still finds a real Node beside it", (t) => {
  const root = fixture(t);
  // The image installs Bun as the toolchain; the pack still needs a real Node for
  // the external provider SDK CLIs, so the PATH lookup has to supply it.
  const node = standIn(root, "node", "v24.18.0");
  const result = resolvePinnedNode({ environment: { PATH: root }, execPath: "/opt/bun/bin/bun", versions: { bun: "1.4.4", node: "26.3.0" } });
  assert.deepEqual(result, { command: node, version: "24.18.0" });
});

test("fails with every candidate it rejected when no Node qualifies", (t) => {
  const root = fixture(t);
  standIn(root, "node", "v20.0.0");
  assert.throws(() => resolvePinnedNode({ environment: { PATH: root }, execPath: "/nonexistent", versions: { bun: "1.4.4" } }),
    /needs a Node 24\.11\.0 or newer; .*is Node 20\.0\.0/);
});

test("accepts exactly the Bun the workspace pins and nothing else", (t) => {
  const root = fixture(t);
  const bun = standIn(root, "bun", "1.4.4");
  assert.deepEqual(resolvePinnedBun({ pinnedVersion: "1.4.4", environment: { PATH: root }, execPath: "/nonexistent", versions: { node: "24.18.0" } }), {
    command: bun, version: "1.4.4",
  });
  standIn(root, "bun", "1.3.0");
  assert.throws(() => resolvePinnedBun({ pinnedVersion: "1.4.4", environment: { PATH: root }, execPath: "/nonexistent", versions: { node: "24.18.0" } }), /needs Bun 1\.4\.4; .*reported 1\.3\.0/);
  assert.throws(() => resolvePinnedBun({ pinnedVersion: "latest", environment: { PATH: root }, execPath: "/nonexistent", versions: {} }), /must name a Bun x\.y\.z version/);
});

test("a build running on Bun reuses its own bytes instead of a second install", (t) => {
  const root = fixture(t);
  standIn(root, "bun", "1.3.0");
  const execPath = standIn(root, "build-bun", "1.4.4");
  const result = resolvePinnedBun({ pinnedVersion: "1.4.4", environment: { PATH: root }, execPath, versions: { bun: "1.4.4" } });
  assert.equal(result.command, execPath);
});

test("stages the bytes it was given and reports the stable path", (t) => {
  const root = fixture(t);
  const source = standIn(root, "source", "24.18.0");
  const destination = join(root, "pack", "node_modules", "node", "bin", "node");
  assert.equal(stagePackInterpreter({ source, destination, expectedVersion: "24.18.0", platform: "linux", arch: "x64" }), destination);
  assert.equal(existsSync(destination), true);
  assert.equal(readFileSync(destination, "utf8"), readFileSync(source, "utf8"));
});

test("rejects a copy that does not run at the expected version", (t) => {
  const root = fixture(t);
  const source = standIn(root, "source", "24.18.0");
  // A probe that reports a different version must fail: the manifest binds the
  // version, so a silent mismatch would publish the wrong interpreter identity.
  assert.throws(() => stagePackInterpreter({
    source, destination: join(root, "pack", "node"), expectedVersion: "24.11.0",
    platform: "linux", arch: "x64",
  }), /is not portable after relocation/);
  assert.throws(() => stagePackInterpreter({
    source, destination: join(root, "pack", "node"), expectedVersion: "24.18.0",
    platform: "linux", arch: "x64",
    probe: () => ({ status: 1, stdout: "" }),
  }), /is not portable after relocation/);
});

test("staging refuses to write a copy that cannot execute", (t) => {
  const root = fixture(t);
  const source = join(root, "not-executable");
  writeFileSync(source, "data");
  chmodSync(source, 0o644);
  const destination = join(root, "pack", "node");
  // The staged file is made executable, so the probe is what decides; a probe
  // that cannot run the bytes at all fails the build rather than shipping them.
  assert.throws(() => stagePackInterpreter({
    source, destination, expectedVersion: "24.18.0", platform: "linux", arch: "x64",
    probe: () => ({ status: 2, stdout: "" }),
  }), /is not portable after relocation/);
});
