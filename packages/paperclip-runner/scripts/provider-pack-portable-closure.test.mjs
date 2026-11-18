import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  installedPackagePath, pinnedBunVersion, resolveInstalledPackage, stageProviderPack,
  writeInstalledCommandShims,
} from "./provider-pack-portable-closure.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-closure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The workspace install and the Runner package that reads from it, laid out
  // the way a hoisted Bun install produces them.
  const workspace = join(root, "workspace");
  const runner = join(workspace, "packages", "runner");
  mkdirSync(join(workspace, "node_modules"), { recursive: true });
  mkdirSync(join(runner, "dist"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "root", private: true, packageManager: "bun@1.4.4" }));
  return { root, workspace, runner };
}

function packageAt(modules, name, manifest) {
  const directory = join(modules, ...name.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  return directory;
}

function runnerManifest(runner, manifest) {
  writeFileSync(join(runner, "package.json"), JSON.stringify({
    name: "@paperclipai/paperclip-runner", version: "0.0.0", files: ["dist"], ...manifest,
  }));
  writeFileSync(join(runner, "dist", "index.js"), "export const runner = true;\n");
}

test("stages the runner's production closure and skips development dependencies", (t) => {
  const { root, workspace, runner } = fixture(t);
  const modules = join(workspace, "node_modules");
  packageAt(modules, "direct", { dependencies: { transitive: "1.0.0" } });
  packageAt(modules, "transitive", {});
  packageAt(modules, "dev-only", {});
  packageAt(modules, "peer", {});
  runnerManifest(runner, { dependencies: { direct: "1.0.0" }, peerDependencies: { peer: "*" }, devDependencies: { "dev-only": "1.0.0" } });

  const destination = join(root, "pack");
  const staged = stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });

  assert.deepEqual(staged.map(entry => entry.path), ["direct", "transitive"]);
  assert.equal(readFileSync(join(destination, "node_modules", "direct", "package.json"), "utf8").includes('"direct"'), true);
  assert.equal(existsSync(join(destination, "node_modules", "dev-only")), false);
  assert.equal(existsSync(join(destination, "node_modules", "peer")), false);
  // The published files and the installed manifest become the deployed root.
  assert.equal(readFileSync(join(destination, "dist", "index.js"), "utf8"), "export const runner = true;\n");
  assert.equal(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).name, "@paperclipai/paperclip-runner");
  assert.equal(existsSync(join(destination, "node_modules")), true);
});

test("keeps two installed versions apart exactly as the install resolved them", (t) => {
  const { root, workspace, runner } = fixture(t);
  const modules = join(workspace, "node_modules");
  // A hoisted install keeps the shared version at the top and the overridden one
  // nested under the package that needs it.
  packageAt(modules, "host", { dependencies: { conflict: "2.0.0" } });
  packageAt(join(modules, "host", "node_modules"), "conflict", { version: "2.0.0" });
  packageAt(modules, "conflict", { version: "1.0.0" });
  runnerManifest(runner, { dependencies: { host: "1.0.0", conflict: "1.0.0" } });

  const destination = join(root, "pack");
  const staged = stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });

  assert.deepEqual(staged.map(entry => [entry.path, entry.version]), [
    ["conflict", "1.0.0"], ["host", "1.0.0"], ["host/node_modules/conflict", "2.0.0"],
  ]);
  assert.equal(JSON.parse(readFileSync(join(destination, "node_modules", "conflict", "package.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(readFileSync(join(destination, "node_modules", "host", "node_modules", "conflict", "package.json"), "utf8")).version, "2.0.0");
  // Node resolution inside the staged pack sees the same two versions.
  const resolve = (from, name) => {
    for (let directory = from; ; directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", ...name.split("/"));
      if (existsSync(join(candidate, "package.json"))) return JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")).version;
      if (directory === destination) return null;
    }
  };
  assert.equal(resolve(join(destination, "node_modules", "host"), "conflict"), "2.0.0");
  assert.equal(resolve(destination, "conflict"), "1.0.0");
});

test("carries the installed bytes, so a patched package stays patched", (t) => {
  const { root, workspace, runner } = fixture(t);
  // The install is where patches landed; staging must copy that tree and never
  // re-fetch the unpatched tarball.
  const patched = packageAt(join(workspace, "node_modules"), "bridge", {});
  writeFileSync(join(patched, "runtime.js"), "// paperclip patch: requestExtension\nexport {};\n");
  runnerManifest(runner, { dependencies: { bridge: "1.0.0" } });

  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });

  assert.equal(
    readFileSync(join(destination, "node_modules", "bridge", "runtime.js"), "utf8"),
    "// paperclip patch: requestExtension\nexport {};\n",
  );
});

test("an absent optional dependency stays absent while a required one fails the build", (t) => {
  const { root, workspace, runner } = fixture(t);
  packageAt(join(workspace, "node_modules"), "host", { optionalDependencies: { "native-linux-x64": "1.0.0" } });
  runnerManifest(runner, { dependencies: { host: "1.0.0" } });
  const destination = join(root, "pack");
  assert.doesNotThrow(() => stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination }));

  const strict = fixture(t);
  packageAt(join(strict.workspace, "node_modules"), "host", { dependencies: { "native-linux-x64": "1.0.0" } });
  runnerManifest(strict.runner, { dependencies: { host: "1.0.0" } });
  assert.throws(
    () => stageProviderPack({ packageRoot: strict.runner, workspaceRoot: strict.workspace, destinationRoot: join(strict.root, "pack") }),
    /native-linux-x64 is not installed/,
  );
});

test("refuses a dependency resolved outside the workspace install", (t) => {
  const { root, workspace, runner } = fixture(t);
  const outside = packageAt(join(root, "elsewhere", "node_modules"), "leaked", {});
  assert.throws(
    () => resolveInstalledPackage(outside, "leaked", workspace),
    /resolves outside the workspace install/,
  );
  runnerManifest(runner, {});
  // A package whose manifest points at a symlink out of the install is rejected
  // rather than shipping bytes the build never qualified.
  const linked = join(workspace, "node_modules", "linked");
  mkdirSync(join(linked, "node_modules"), { recursive: true });
  writeFileSync(join(linked, "package.json"), JSON.stringify({ name: "linked", version: "1.0.0", dependencies: { leaked: "1.0.0" } }));
  symlinkSync(outside, join(linked, "node_modules", "leaked"), "dir");
  assert.throws(
    () => resolveInstalledPackage(realpathSync(linked), "leaked", workspace),
    /resolves outside the workspace install/,
  );
});

test("a package the workspace install does not contain has no relative path", (t) => {
  const { root, workspace, runner } = fixture(t);
  runnerManifest(runner, {});
  assert.throws(() => installedPackagePath(workspace, runner, join(root, "outside")), /outside the workspace install/);
  // The Runner package is the pack root, not a closure member.
  assert.throws(() => installedPackagePath(workspace, runner, realpathSync(runner)), /outside the workspace install/);
});

test("the same install stages byte-identical trees on every run", (t) => {
  const { root, workspace, runner } = fixture(t);
  const modules = join(workspace, "node_modules");
  packageAt(modules, "b", { dependencies: { z: "1.0.0" } });
  packageAt(modules, "a", {});
  packageAt(modules, "z", {});
  runnerManifest(runner, { dependencies: { b: "1.0.0", a: "1.0.0" } });

  const digest = destination => spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    'import { sha256Tree } from process.argv[1]; process.stdout.write(sha256Tree(process.argv[2]));',
    new URL("./provider-pack-runtime-tree.mjs", import.meta.url).href,
    destination,
  ], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout;

  const first = join(root, "pack-one");
  const second = join(root, "pack-two");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: first });
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: second });
  assert.match(readFileSync(join(first, "package.json"), "utf8"), /paperclip-runner/);
  assert.equal(digest(first), digest(second));
  // Entry order is sorted, so it does not depend on directory iteration order.
  assert.deepEqual(stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: join(root, "third") }).map(e => e.path), ["a", "b", "z"]);
});

function commandFixture(t, callback) {
  const { root, workspace, runner } = fixture(t);
  const modules = join(workspace, "node_modules");
  // A native command and a node script, the two shapes the pack exposes.
  const native = packageAt(modules, "native-tool", { bin: { "native-tool": "./tool" } });
  writeFileSync(join(native, "tool"), '#!/bin/sh\nprintf "native %s\\n" "$@"\nexit 17\n');
  chmodSync(join(native, "tool"), 0o755);
  const script = packageAt(modules, "script-tool", { bin: { "script-tool": "cli.js" } });
  writeFileSync(join(script, "cli.js"), '#!/usr/bin/env node\nprocess.stdout.write(`script ${process.argv.slice(2).join(",")}\\n`);\n');
  chmodSync(join(script, "cli.js"), 0o755);
  packageAt(modules, "no-commands", {});
  runnerManifest(runner, { dependencies: { "native-tool": "1.0.0", "script-tool": "1.0.0", "no-commands": "1.0.0" } });
  return callback({ root, workspace, runner });
}

test("writes pack-relative commands for the runner's direct dependencies", (t) => commandFixture(t, ({ root, workspace, runner }) => {
  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });
  const commands = writeInstalledCommandShims(destination, { packageRoot: runner });
  assert.deepEqual(commands, ["native-tool", "script-tool"]);
  for (const name of commands) {
    const shim = readFileSync(join(destination, "node_modules", ".bin", name), "utf8");
    // The build directory must never appear: the pack is relocated alone.
    assert.equal(shim.includes(root), false);
    assert.equal(shim.includes(destination), false);
    assert.match(shim, /basedir=\$\(CDPATH= cd -- "\$\(dirname -- "\$0"\)" && pwd\)/);
  }
  // A node script runs on the pack's own interpreter, not the host PATH.
  assert.match(readFileSync(join(destination, "node_modules", ".bin", "script-tool"), "utf8"), /exec "\$basedir\/\.\.\/node\/bin\/node"/);
}));

test("a command still works after the pack is relocated", (t) => commandFixture(t, ({ root, workspace, runner }) => {
  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });
  writeInstalledCommandShims(destination, { packageRoot: runner });
  // The launcher execs `node <script>`, so a copy of the real interpreter proves
  // the relocated path without depending on the host having a Node on PATH.
  const interpreter = join(destination, "node_modules", "node", "bin");
  mkdirSync(interpreter, { recursive: true });
  const realNode = spawnSync(process.execPath, ["--version"], { encoding: "utf8" });
  if (realNode.status !== 0) return; // No Node available to stand in for the pack's own.
  copyFileSync(process.execPath, join(interpreter, "node"));
  chmodSync(join(interpreter, "node"), 0o755);

  const relocated = join(root, "relocated pack");
  renameSync(destination, relocated);
  const native = spawnSync(join(relocated, "node_modules", ".bin", "native-tool"), ["one argument"], {
    cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(native.status, 17);
  assert.equal(native.stdout, "native one argument\n");
  const script = spawnSync(join(relocated, "node_modules", ".bin", "script-tool"), ["a", "b"], {
    cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(script.status, 0);
  assert.equal(script.stdout, "script a,b\n");
}));

test("a command whose package has no bin gets no shim", (t) => commandFixture(t, ({ root, workspace, runner }) => {
  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });
  writeInstalledCommandShims(destination, { packageRoot: runner });
  assert.equal(existsSync(join(destination, "node_modules", ".bin", "no-commands")), false);
}));

test("a command target that escapes its package is refused", (t) => commandFixture(t, ({ root, workspace, runner }) => {
  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });
  const manifestPath = join(destination, "node_modules", "native-tool", "package.json");
  writeFileSync(manifestPath, JSON.stringify({ name: "native-tool", version: "1.0.0", bin: { "native-tool": "../../../outside" } }));
  writeFileSync(join(root, "outside"), "#!/bin/sh\n", { mode: 0o755 });
  assert.throws(() => writeInstalledCommandShims(destination, { packageRoot: runner }), /not a regular file inside its package/);
}));

test("the staged pack keeps every symlink inside itself", (t) => commandFixture(t, ({ root, workspace, runner }) => {
  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });
  writeInstalledCommandShims(destination, { packageRoot: runner });
  const pack = realpathSync(destination);
  const escaping = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        if (target !== pack && !target.startsWith(`${pack}/`)) escaping.push(relative(pack, path));
      } else if (entry.isDirectory()) visit(path);
    }
  };
  visit(pack);
  // Commands are regular files, so they carry no link to break on relocation,
  // and the pack holds no symlink that resolves outside itself.
  assert.equal(escaping.length, 0);
  assert.equal(lstatSync(join(pack, "node_modules", ".bin", "native-tool")).isSymbolicLink(), false);
}));

test("the pinned Bun version comes from the workspace package manager field", (t) => {
  const { workspace } = fixture(t);
  assert.equal(pinnedBunVersion(workspace), "1.4.4");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "root", packageManager: "pnpm@9.15.4" }));
  assert.throws(() => pinnedBunVersion(workspace), /must pin its Bun version/);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "root" }));
  assert.throws(() => pinnedBunVersion(workspace), /must pin its Bun version/);
});

test("a staged tree keeps file modes so the staged interpreters stay executable", (t) => {
  const { root, workspace, runner } = fixture(t);
  const tool = packageAt(join(workspace, "node_modules"), "tool", {});
  writeFileSync(join(tool, "run"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(tool, "run"), 0o755);
  runnerManifest(runner, { dependencies: { tool: "1.0.0" } });
  const destination = join(root, "pack");
  stageProviderPack({ packageRoot: runner, workspaceRoot: workspace, destinationRoot: destination });
  assert.equal(lstatSync(join(destination, "node_modules", "tool", "run")).mode & 0o111, 0o111);
});
