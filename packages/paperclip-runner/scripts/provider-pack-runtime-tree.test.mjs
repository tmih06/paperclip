import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  installedPackageKeyOf,
  providerPackLibc,
  removeControllerArtifactsFromProviderPack,
  removeForeignLibcPackagesFromProviderPack,
  removeInstalledPackages,
  sha256Tree,
} from "./provider-pack-runtime-tree.mjs";

test("the tree digest of a pack directory keeps its recorded format", () => {
  // Packs already in images carry digests computed this way, and the server
  // recomputes them with its own copy of the walk. A change here must be a
  // deliberate pack contract change.
  const root = mkdtempSync(join(tmpdir(), "provider-pack-tree-digest-"));
  try {
    mkdirSync(join(root, "cli"), { recursive: true });
    writeFileSync(join(root, "index.js"), "export {};\n");
    writeFileSync(join(root, "cli", "proxy.cjs"), "module.exports = {};\n");
    symlinkSync("index.js", join(root, "main.js"));
    assert.equal(sha256Tree(root), "sha256:01f41c32adc4fae6f04481df39bb22ef6facf49424b8fb77a31d555fd7ff8878");
    writeFileSync(join(root, "cli", "proxy.cjs"), "module.exports = { changed: true };\n");
    assert.notEqual(sha256Tree(root), "sha256:01f41c32adc4fae6f04481df39bb22ef6facf49424b8fb77a31d555fd7ff8878");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("image and native producer packs retain identical provider outputs despite different controller artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-producers-"));
  try {
    const packs = [join(root, "image"), join(root, "native")];
    for (const pack of packs) {
      mkdirSync(join(pack, "dist", "cli"), { recursive: true });
      writeFileSync(join(pack, "dist", "cli", "acpx-runtime-sidecar.cjs"), "identical provider bridge\n");
    }
    mkdirSync(join(packs[1], "dist", "bin"));
    writeFileSync(join(packs[1], "dist", "bin", "paperclip-runnerd"), "host-specific daemon");
    mkdirSync(join(packs[1], "dist", "remote-provider-packs"));
    writeFileSync(join(packs[1], "dist", "remote-provider-packs", "prior-pack.json"), "earlier release identity");
    for (const pack of packs) {
      removeControllerArtifactsFromProviderPack(pack);
      assert.deepEqual(readdirSync(join(pack, "dist")), ["cli"]);
      assert.equal(readFileSync(join(pack, "dist", "cli", "acpx-runtime-sidecar.cjs"), "utf8"), "identical provider bridge\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removing an owned controller-artifact link preserves its external target", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-controller-link-"));
  try {
    const pack = join(root, "pack"), outside = join(root, "outside");
    mkdirSync(join(pack, "dist"), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(outside, "preserved"), "original");
    symlinkSync(outside, join(pack, "dist", "bin"));
    removeControllerArtifactsFromProviderPack(pack);
    assert.equal(existsSync(join(pack, "dist", "bin")), false);
    assert.equal(readFileSync(join(outside, "preserved"), "utf8"), "original");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function installed(pack, name, manifest = {}) {
  const path = join(pack, "node_modules", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  writeFileSync(join(path, "binary"), `${name}\n`);
  return path;
}

// A hoisted install keeps one real directory per package at the top level, so a
// package that is pruned leaves nothing behind in a store it never had.
function hoisted(pack, name, manifest = {}) {
  return installed(pack, name, manifest);
}

test("detects the libc of the Node copied into Linux packs only", () => {
  assert.equal(providerPackLibc("linux", () => ({ header: { glibcVersionRuntime: "2.39" } })), "glibc");
  assert.equal(providerPackLibc("linux", () => ({ header: {} })), "musl");
  assert.equal(providerPackLibc("darwin", () => { throw new Error("unused"); }), undefined);
});

test("removes hoisted packages built only for another libc and any link into them", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-libc-"));
  try {
    const pack = join(root, "pack");
    const kept = [
      hoisted(pack, "@scope/native-linux-x64", { libc: ["glibc"] }),
      hoisted(pack, "tool-linux-x64"),
      hoisted(pack, "consumer", { optionalDependencies: { "tool-linux-x64": "1.0.0", "tool-linux-x64-musl": "1.0.0" } }),
    ];
    const pruned = [
      hoisted(pack, "@scope/native-linux-x64-musl", { libc: ["musl"] }),
      hoisted(pack, "tool-linux-x64-musl", { libc: ["musl"] }),
    ];
    // A link a hoisted install may still carry, e.g. from a workspace package.
    const relinked = join(pack, "node_modules", "consumer", "node_modules", "tool-linux-x64-musl");
    mkdirSync(dirname(relinked), { recursive: true });
    symlinkSync(relative(dirname(relinked), pruned[1]), relinked);

    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, "glibc"), [
      "@scope/native-linux-x64-musl", "tool-linux-x64-musl",
    ]);
    for (const path of kept) assert.equal(existsSync(join(path, "package.json")), true);
    for (const path of pruned) assert.equal(lstatExists(path), false);
    assert.equal(lstatExists(relinked), false);
    // The emptied scope goes too; the surviving glibc package keeps its scope.
    assert.deepEqual(readdirSync(join(pack, "node_modules", "@scope")), ["native-linux-x64"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps every package when the pack has no libc or the libc matches", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-libc-noop-"));
  try {
    const pack = join(root, "pack");
    hoisted(pack, "tool-linux-x64-musl", { libc: ["musl"] });
    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, undefined), []);
    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, "musl"), []);
    assert.equal(existsSync(join(pack, "node_modules", "tool-linux-x64-musl")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prunes a foreign-libc package nested for a version override, not just the top level", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-libc-nested-"));
  try {
    const pack = join(root, "pack");
    const host = hoisted(pack, "native");
    const nested = join(host, "node_modules", "native-musl");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "native-musl", version: "2.0.0", libc: ["musl"] }));
    // A same-named glibc copy beside the host package is a different version and stays.
    hoisted(pack, "tool-linux-x64");
    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, "glibc"), ["native-musl"]);
    assert.equal(lstatExists(nested), false);
    assert.equal(existsSync(join(pack, "node_modules", "tool-linux-x64", "package.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pnpm virtual store still names a package by its store entry", () => {
  // Packs already published were built by pnpm deploy, so the store shape has to
  // keep working: the key is the entry, not the package path inside it.
  const root = mkdtempSync(join(tmpdir(), "provider-pack-store-key-"));
  try {
    const pack = join(root, "pack");
    const packagePath = join(pack, "node_modules", ".pnpm", "@scope+tool@1.0.0", "node_modules", "@scope", "tool");
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "@scope/tool", version: "1.0.0", libc: ["musl"] }));
    assert.equal(installedPackageKeyOf(pack, packagePath), "@scope+tool@1.0.0");
    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, "glibc"), ["@scope/tool"]);
    assert.equal(existsSync(join(pack, "node_modules", ".pnpm", "@scope+tool@1.0.0")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("names a hoisted package by its path below node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-hoisted-key-"));
  try {
    const pack = join(root, "pack");
    const top = hoisted(pack, "@scope/tool");
    assert.equal(installedPackageKeyOf(pack, top), "@scope/tool");
    const nested = join(pack, "node_modules", "host", "node_modules", "tool");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "tool", version: "2.0.0" }));
    assert.equal(installedPackageKeyOf(pack, nested), "host/node_modules/tool");
    assert.throws(() => installedPackageKeyOf(pack, root), /not inside the provider pack/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removing a package also removes the command that pointed at it", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-command-prune-"));
  try {
    const pack = join(root, "pack");
    const packagePath = hoisted(pack, "tool");
    hoisted(pack, "kept");
    mkdirSync(join(pack, "node_modules", ".bin"), { recursive: true });
    symlinkSync("../tool/binary", join(pack, "node_modules", ".bin", "tool"));
    symlinkSync("../kept/binary", join(pack, "node_modules", ".bin", "kept"));
    removeInstalledPackages(pack, ["tool"]);
    assert.equal(lstatExists(join(pack, "node_modules", ".bin", "tool")), false);
    assert.equal(lstatExists(join(pack, "node_modules", ".bin", "kept")), true);
    assert.equal(existsSync(packagePath), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses removal keys that could name anything but one installed package", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-store-escape-"));
  try {
    const pack = join(root, "pack");
    mkdirSync(join(pack, "node_modules", ".pnpm", "node_modules"), { recursive: true });
    writeFileSync(join(pack, "node_modules", "outside"), "kept");
    for (const name of ["", "../outside", "node_modules", "a/b", "@scope/a/b", "a\\b", "/abs", "."]) {
      assert.throws(() => removeInstalledPackages(pack, [name]), /Refusing to remove/);
    }
    assert.equal(readFileSync(join(pack, "node_modules", "outside"), "utf8"), "kept");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}
