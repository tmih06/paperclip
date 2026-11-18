import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../setup-paperclip-worktree.sh", import.meta.url).pathname;
const runtimeScript = new URL("../provision-worktree-runtime.sh", import.meta.url).pathname;

// Both scripts require Bun and no longer fall back to Node or pnpm. Resolve the
// real Bun executable so a test can put a shim ahead of it on PATH without
// losing access to the interpreter the scripts need for their inline programs.
const realBun = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }).stdout.trim();
assert.ok(realBun, "these tests require Bun on PATH");

// Keep the PATH minimal so the launch ladder is deterministic: bun must be
// reachable, but a globally installed `paperclipai` must not shadow the paths
// under test. Node and pnpm stay deliberately absent.
const testPath = [path.dirname(realBun), "/usr/bin", "/bin"].join(":");

const cleanupDirs = [];

/**
 * Bun's lockfile is JSON. These fixtures answer `bun install` with a shim that
 * never parses it, but a pnpm-era YAML string here would misrepresent what the
 * provisioner expects to find, so write the shape Bun itself emits.
 */
function minimalBunLockfile() {
  return `${JSON.stringify({
    lockfileVersion: 3,
    configVersion: 1,
    workspaces: { "": { name: "workspace-root" } },
    packages: {},
  }, null, 2)}\n`;
}

function makeTempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * Writes a `bun` shim ahead of the real executable on PATH. `install` calls are
 * answered by `handleInstall`, which receives the install arguments and returns
 * the exit code; every other invocation execs the real Bun so the scripts'
 * inline programs and the fake CLI still run.
 */
function makeBunShim(tempPrefix, handleInstall) {
  const bin = makeTempDir(tempPrefix);
  const shimPath = path.join(bin, "bun");
  fs.writeFileSync(
    shimPath,
    [
      "#!/usr/bin/env bash",
      `if [[ "$1" == "install" ]]; then`,
      `  shift`,
      `  ${handleInstall}`,
      "fi",
      `exec ${JSON.stringify(realBun)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A control plane's own instance home. A managed project checkout carries no
 * instance config of its own, so this is the seed source the scripts fall back to.
 */
function makeInstanceHome() {
  const home = makeTempDir("paperclip-provision-instance-home-");
  fs.mkdirSync(path.join(home, "instances", "default"), { recursive: true });
  fs.writeFileSync(path.join(home, "instances", "default", "config.json"), "{}\n");
  return home;
}

test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Writes a fake base workspace whose CLI entry is a Bun script, so the
 * provision script's health check and init call can be steered per test.
 *
 * helpExit: exit code for `bun cli/src/index.ts --help` (the health check boot).
 * initExit: exit code for `bun cli/src/index.ts worktree init ...`; on 0 the fake
 *           CLI writes a marker config so tests can tell CLI init from fallback.
 */
function makeBaseWorkspace({ helpExit, initExit, ensureExit = 0 }) {
  const baseCwd = makeTempDir("paperclip-provision-base-");
  const entryPath = path.join(baseCwd, "cli", "src", "index.ts");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  // An installed base workspace always carries at least the CLI's own package
  // tree; checkout-only provisioning mirrors those directories into the
  // worktree as symlinks.
  fs.mkdirSync(path.join(baseCwd, "cli", "node_modules"), { recursive: true });
  fs.writeFileSync(
    entryPath,
    `
import fs from "node:fs";
// Bun executes this entry directly, so the CLI arguments start at argv[2].
const cliArgs = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(baseCwd, "cli-invocations.log"))}, JSON.stringify(cliArgs) + "\\n");
if (cliArgs.includes("--help")) {
  if (${helpExit} !== 0) console.error("ERR_MODULE_NOT_FOUND: drizzle-orm");
  process.exit(${helpExit});
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "init") {
  if (${initExit} !== 0) {
    console.error("fake worktree init failure");
    process.exit(${initExit});
  }
  fs.mkdirSync(".paperclip", { recursive: true });
  fs.writeFileSync(".paperclip/config.json", JSON.stringify({ $meta: { source: "fake-cli" } }));
  fs.writeFileSync(".paperclip/.env", "PAPERCLIP_IN_WORKTREE=true\\n");
  process.exit(0);
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "ensure-seeded") {
  if (${ensureExit} !== 0) {
    console.error("fake worktree ensure-seeded failure");
    process.exit(${ensureExit});
  }
  fs.rmSync(".paperclip/seed-pending", { force: true });
  fs.rmSync(".paperclip/seed-complete", { force: true });
  fs.writeFileSync(".paperclip/seed-manifest.json", JSON.stringify({
    version: 2,
    source: { instanceId: "base-source", configPath: ${JSON.stringify(path.join(baseCwd, ".paperclip", "config.json"))} },
    snapshotAt: "2026-08-19T00:00:00.000Z",
    seedMode: "minimal",
    migrationRevision: "0142_test.sql",
    targetInstanceId: "target-test",
    phase: "complete",
    state: "verified",
    attemptId: "attempt-test",
    startedAt: "2026-08-19T00:00:00.000Z",
    finishedAt: "2026-08-19T00:01:00.000Z",
    diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-19T00:01:00.000Z" }],
  }) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return baseCwd;
}

function runProvision(baseCwd, { pathPrefix, setupWorktree, setupInstance, existingWorktree, env = {} } = {}) {
  const worktreeCwd = existingWorktree ?? makeTempDir("paperclip-provision-worktree-");
  setupWorktree?.(worktreeCwd);
  const worktreesHome = makeTempDir("paperclip-provision-home-");
  const paperclipHome = makeInstanceHome();
  setupInstance?.(paperclipHome);
  const result = spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: pathPrefix ? `${pathPrefix}:${testPath}` : testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_PROJECT_WORKSPACE_ID: "project-workspace-1",
      PAPERCLIP_SEED_EXPECTED_COMPANY_ID: "company-1",
      ...(typeof env === "function" ? env(paperclipHome) : env),
    },
  });
  return { result, worktreeCwd, worktreesHome, paperclipHome };
}

function runRuntimeProvision(baseCwd, worktreeCwd, { setupInstance } = {}) {
  const worktreesHome = makeTempDir("paperclip-provision-runtime-home-");
  const paperclipHome = makeInstanceHome();
  setupInstance?.(paperclipHome);
  return spawnSync("bash", [runtimeScript], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-runtime-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_PROJECT_WORKSPACE_ID: "project-workspace-1",
      PAPERCLIP_COMPANY_ID: "company-1",
    },
  });
}

function readCliInvocations(baseCwd) {
  const logPath = path.join(baseCwd, "cli-invocations.log");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readWorktreeConfig(worktreeCwd) {
  const configPath = path.join(worktreeCwd, ".paperclip", "config.json");
  assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist`);
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

test("uses the base CLI when its import graph boots", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "fake-cli");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json"), "utf8")).state,
    "pending",
  );
  const initInvocation = readCliInvocations(baseCwd).find(
    (args) => args[0] === "worktree" && args[1] === "init",
  );
  assert.ok(
    initInvocation?.includes("--no-seed"),
    `expected --no-seed in ${JSON.stringify(initInvocation)}`,
  );
});

for (const defaultConfigInEnv of [false, true]) {
  test(`prepares a plain checkout without a default instance config (image default env: ${defaultConfigInEnv})`, () => {
    const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
    const { result, worktreeCwd } = runProvision(baseCwd, {
      setupInstance: (home) => fs.rmSync(path.join(home, "instances", "default", "config.json")),
      env: (home) => defaultConfigInEnv ? { PAPERCLIP_CONFIG: path.join(home, "instances", "default", "config.json") } : {},
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /preparing checkout dependencies without a seeded development instance/);
    for (const file of ["config.json", ".env", "seed-manifest.json", "seed-pending", "seed-complete"]) {
      assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip", file)), false);
    }
    assert.equal(fs.realpathSync(path.join(worktreeCwd, "cli", "node_modules")), path.join(baseCwd, "cli", "node_modules"));
    assert.deepEqual(readCliInvocations(baseCwd), []);
  });
}

test("rejects a missing custom seed source", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const { result, worktreeCwd } = runProvision(baseCwd, {
    env: { PAPERCLIP_CONFIG: path.join(baseCwd, "missing", "config.json") },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config is unavailable \(control-plane instance\)/);
  assert.match(result.stderr, /For a seeded development instance, configure a canonical config/);
  assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip")), false);
  assert.deepEqual(readCliInvocations(baseCwd), []);
});

test("initializes a previously plain checkout once a registered seed source is available", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const first = runProvision(baseCwd, {
    setupInstance: (home) => fs.rmSync(path.join(home, "instances"), { recursive: true }),
  });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.deepEqual(readCliInvocations(baseCwd), []);

  const second = runProvision(baseCwd, { existingWorktree: first.worktreeCwd });
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(readWorktreeConfig(first.worktreeCwd).$meta.source, "fake-cli");
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.worktreeCwd, ".paperclip", "seed-manifest.json"), "utf8")).state, "pending");
});

test("a plain checkout without a source is not ready for a seeded runtime", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  fs.mkdirSync(path.join(baseCwd, "scripts"));
  fs.copyFileSync(script, path.join(baseCwd, "scripts", "setup-paperclip-worktree.sh"));
  const setupInstance = (home) => fs.rmSync(path.join(home, "instances"), { recursive: true });
  const { result, worktreeCwd } = runProvision(baseCwd, { setupInstance });
  assert.equal(result.status, 0, result.stderr);

  const runtime = runRuntimeProvision(baseCwd, worktreeCwd, { setupInstance });
  assert.notEqual(runtime.status, 0);
  assert.match(runtime.stderr, /Worktree config still does not exist after built-in provisioning/);
  assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json")), false);
  assert.deepEqual(readCliInvocations(baseCwd), []);
});

for (const relativePath of ["instances/default/config.json", "instances/default"]) {
  test(`rejects a dangling implicit source symlink at ${relativePath}`, () => {
    const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
    const { result, worktreeCwd } = runProvision(baseCwd, {
      setupInstance(home) {
        const sourcePath = path.join(home, relativePath);
        fs.rmSync(sourcePath, { recursive: true });
        fs.symlinkSync(path.join(home, "missing"), sourcePath);
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical/);
    assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip")), false);
    assert.deepEqual(readCliInvocations(baseCwd), []);
  });
}

for (const file of ["config.json", ".env", "seed-manifest.json", "seed-pending", "seed-complete"]) {
  test(`does not downgrade an existing development instance with ${file} when its source disappears`, () => {
    const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
    const { result, worktreeCwd } = runProvision(baseCwd, {
      setupInstance: (home) => fs.rmSync(path.join(home, "instances", "default", "config.json")),
      setupWorktree(root) {
        fs.mkdirSync(path.join(root, ".paperclip"));
        fs.writeFileSync(path.join(root, ".paperclip", file), "retained state\n");
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config is unavailable/);
    assert.equal(fs.readFileSync(path.join(worktreeCwd, ".paperclip", file), "utf8"), "retained state\n");
    assert.deepEqual(readCliInvocations(baseCwd), []);
  });
}

for (const installExit of [0, 42]) {
  test(`plain checkout dependency provisioning preserves install exit ${installExit}`, () => {
    const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
    // The fake install runs in the worktree, so it sees the same cwd the script
    // installs into and can materialize the node_modules it would have created.
    const bin = makeBunShim(
      "paperclip-checkout-bun-",
      `printf '%s\\n' "$*" >> bun-calls\nmkdir -p node_modules cli/node_modules\nexit ${installExit}`,
    );
    const { result, worktreeCwd } = runProvision(baseCwd, {
      pathPrefix: bin,
      setupInstance: (home) => fs.rmSync(path.join(home, "instances", "default", "config.json")),
      setupWorktree(root) {
        fs.writeFileSync(path.join(root, "package.json"), "{}\n");
        fs.writeFileSync(path.join(root, "bun.lock"), "lockfileVersion: '9.0'\n");
      },
    });
    assert.equal(result.status, installExit, result.stderr);
    assert.match(fs.readFileSync(path.join(worktreeCwd, "bun-calls"), "utf8"), /^--frozen-lockfile/);
    assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip", "bun-install-fingerprint")), installExit === 0);
    assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip", "config.json")), false);
    assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json")), false);
    assert.deepEqual(readCliInvocations(baseCwd), []);
  });
}

test("rejects a dangling base workspace config symlink instead of falling back", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  fs.mkdirSync(path.join(baseCwd, ".paperclip"), { recursive: true });
  fs.symlinkSync(path.join(baseCwd, "absent.json"), path.join(baseCwd, ".paperclip", "config.json"));

  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not a canonical file \(base project workspace\)/);
  assert.doesNotMatch(result.stderr, /checkout-only|provisionCommand/);
  assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip")), false);
  assert.deepEqual(readCliInvocations(baseCwd), []);
});

test("rejects a non-regular instance config without suggesting a setup bypass", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const { result, worktreeCwd } = runProvision(baseCwd, {
    setupInstance: (home) => {
      const configPath = path.join(home, "instances", "default", "config.json");
      fs.rmSync(configPath);
      fs.mkdirSync(configPath);
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is not a canonical file \(control-plane instance\)/);
  assert.match(result.stderr, /Repair the registered source path/);
  assert.doesNotMatch(result.stderr, /checkout-only|provisionCommand/);
  assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip")), false);
  assert.deepEqual(readCliInvocations(baseCwd), []);
});

test("rejects a dangling base workspace .paperclip symlink instead of falling back", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  // `-e`/`-L` on the config resolve `.paperclip` first, so the config reads as absent
  // here even though the workspace is malformed rather than a plain checkout.
  fs.symlinkSync(path.join(baseCwd, "absent-dir"), path.join(baseCwd, ".paperclip"));

  const { result } = runProvision(baseCwd);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.paperclip is a broken symlink/);
});

test("isolates fallback configuration and reconciles deployment mode from the registered source when reusing a guest config", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 1, initExit: 0 });
  const { result: first, worktreeCwd, worktreesHome, paperclipHome } = runProvision(baseCwd);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /writing isolated fallback config/);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "configure");
  const dataDir = config.database.embeddedPostgresDataDir;
  assert.ok(
    !path.relative(worktreesHome, dataDir).startsWith(".."),
    `expected ${dataDir} to live under ${worktreesHome}`,
  );
  const env = fs.readFileSync(path.join(worktreeCwd, ".paperclip", ".env"), "utf8");
  assert.match(env, /PAPERCLIP_IN_WORKTREE=true/);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json"), "utf8")).state,
    "pending",
  );

  assert.equal(readWorktreeConfig(worktreeCwd).server.deploymentMode, "local_trusted");

  // A base workspace that does carry its own instance config outranks the fallback.
  fs.mkdirSync(path.join(baseCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(
    path.join(baseCwd, ".paperclip", "config.json"),
    `${JSON.stringify({
      server: {
        deploymentMode: "authenticated",
        exposure: "private",
      },
    }, null, 2)}\n`,
  );

  const second = spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_PROJECT_WORKSPACE_ID: "project-workspace-1",
      PAPERCLIP_SEED_EXPECTED_COMPANY_ID: "company-1",
    },
  });

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /Reusing existing isolated Paperclip worktree config/);
  assert.match(second.stderr, /Reconciled isolated Paperclip worktree deployment mode/);
  assert.equal(readWorktreeConfig(worktreeCwd).server.deploymentMode, "authenticated");
  assert.equal(readWorktreeConfig(worktreeCwd).server.exposure, "private");
});

test("repairs an unhealthy base install under the lock and then uses the CLI", (t) => {
  const hasTools = ["flock", "git"].every(
    (tool) => spawnSync("bash", ["-lc", `command -v ${tool}`], { env: { PATH: testPath } }).status === 0,
  );
  if (!hasTools) {
    t.skip("flock or git not available on this host");
    return;
  }

  // The CLI's health is controlled by a flag file, and a fake `bun install`
  // creates that flag — modeling a forced reinstall that relinks the store.
  const baseCwd = makeTempDir("paperclip-provision-repair-base-");
  const healthFlag = path.join(baseCwd, "cli-healthy.flag");
  const entryPath = path.join(baseCwd, "cli", "src", "index.ts");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(
    entryPath,
    `
import fs from "node:fs";
// Bun runs this entry directly, so the CLI arguments start at argv[2].
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--help")) {
  process.exit(fs.existsSync(${JSON.stringify(healthFlag)}) ? 0 : 1);
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "init") {
  fs.mkdirSync(".paperclip", { recursive: true });
  fs.writeFileSync(".paperclip/config.json", JSON.stringify({ $meta: { source: "fake-cli" } }));
  fs.writeFileSync(".paperclip/.env", "PAPERCLIP_IN_WORKTREE=true\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  fs.writeFileSync(path.join(baseCwd, "package.json"), "{}\n");
  fs.writeFileSync(path.join(baseCwd, "bun.lock"), "lockfileVersion: '9.0'\n");
  spawnSync("git", ["init", "-q", baseCwd], { env: { PATH: testPath } });

  const installLog = path.join(baseCwd, "bun-invocations.log");
  const fakeBin = makeBunShim(
    "paperclip-provision-fakebin-",
    `echo "$*" >> ${JSON.stringify(installLog)}\ntouch ${JSON.stringify(healthFlag)}\nexit 0`,
  );

  const { result, worktreeCwd } = runProvision(baseCwd, { pathPrefix: fakeBin });

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "fake-cli");
  const installs = fs.readFileSync(installLog, "utf8").trim().split("\n");
  assert.equal(installs.length, 1, `expected exactly one repair install, got: ${installs.join(" | ")}`);
  assert.match(installs[0], /--force/);
  assert.match(installs[0], /--frozen-lockfile/);
  assert.ok(
    fs.existsSync(path.join(baseCwd, ".git", "paperclip-provision-repair.lock")),
    "expected the repair lock file inside the resolved git dir",
  );
});

test("a failed CLI init fails provisioning instead of being masked as success", () => {
  // Regression test for the masked `return 0` after the init subshell: a CLI
  // that passes the health check but fails `worktree init` signals a real
  // problem, so the script must propagate the failure rather than report
  // success or write an unseeded fallback config over it.
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 3 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /fake worktree init failure/);
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "config.json")));
});

test("runtime provisioning invokes ensure-seeded once and fast-exits after success", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-worktree-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-pending"), "{}\n");

  const first = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json"), "utf8")).state,
    "verified",
  );
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));

  const ensureCallsAfterFirst = readCliInvocations(baseCwd)
    .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded");
  assert.equal(ensureCallsAfterFirst.length, 1);
  assert.ok(ensureCallsAfterFirst[0].includes("--config"));
  assert.ok(ensureCallsAfterFirst[0].includes("--from-config"));

  const second = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /verified seed manifest.*skipping/);
  const ensureCallsAfterSecond = readCliInvocations(baseCwd)
    .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded");
  assert.equal(ensureCallsAfterSecond.length, 1);
});

test("runtime provisioning omits the source override when the base config exists", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  fs.mkdirSync(path.join(baseCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(baseCwd, ".paperclip", "config.json"), "{}\n");
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-base-config-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");

  const result = runRuntimeProvision(baseCwd, worktreeCwd);

  assert.equal(result.status, 0, result.stderr);
  const ensureCall = readCliInvocations(baseCwd).find(
    (args) => args[0] === "worktree" && args[1] === "ensure-seeded",
  );
  assert.ok(ensureCall, "expected the runtime provisioner to invoke ensure-seeded");
  assert.ok(!ensureCall.includes("--from-config"));
});

test("runtime provisioning guards every optional source-config expansion for Bash 3.2", () => {
  const source = fs.readFileSync(runtimeScript, "utf8");
  const ensureSeededLines = source
    .split("\n")
    .filter((line) => line.includes("worktree ensure-seeded --config"));

  // Two launch paths: the base checkout's TypeScript entry under Bun, and a
  // globally installed `paperclipai`. The pnpm rung is gone with the rest of
  // the Node/pnpm ladder.
  assert.equal(ensureSeededLines.length, 2);
  assert.ok(ensureSeededLines[0].includes('bun "$base_cli_entry_path"'));
  assert.ok(ensureSeededLines[1].includes("paperclipai worktree ensure-seeded"));
  for (const line of ensureSeededLines) {
    assert.ok(
      line.includes('${source_config_args[@]+"${source_config_args[@]}"}'),
      `expected Bash 3.2-compatible optional array expansion in: ${line}`,
    );
  }
});

test("runtime provisioning seeds a worktree config that has no seed markers", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-unmarked-config-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");

  const result = runRuntimeProvision(baseCwd, worktreeCwd);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readCliInvocations(baseCwd)
      .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded").length,
    1,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json"), "utf8")).state,
    "verified",
  );
});

test("runtime provisioning bootstraps and seeds an empty .paperclip directory", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  fs.mkdirSync(path.join(baseCwd, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(baseCwd, "scripts", "setup-paperclip-worktree.sh"));
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-empty-state-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });

  const result = runRuntimeProvision(baseCwd, worktreeCwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /config is missing; running the built-in worktree provisioner/);
  const invocations = readCliInvocations(baseCwd);
  assert.equal(
    invocations.filter((args) => args[0] === "worktree" && args[1] === "init").length,
    1,
  );
  assert.equal(
    invocations.filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded").length,
    1,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(worktreeCwd, ".paperclip", "seed-manifest.json"), "utf8")).state,
    "verified",
  );
});

test("runtime provisioning leaves seed-pending in place when ensure-seeded fails", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0, ensureExit: 4 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-failure-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-pending"), "{}\n");

  const result = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /fake worktree ensure-seeded failure/);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-complete")));
});

test("runtime provisioning does not trust a truncated verified manifest", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0, ensureExit: 4 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-truncated-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(
    path.join(worktreeCwd, ".paperclip", "seed-manifest.json"),
    JSON.stringify({ version: 2, state: "verified" }),
  );

  const result = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(result.status, 4, result.stderr);
  assert.equal(
    readCliInvocations(baseCwd)
      .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded").length,
    1,
  );
});

/**
 * The pnpm-era DEP0169 suppression flag existed only because the pinned pnpm's
 * toNerfDart called the deprecated url.parse(). Bun never touches that path, so
 * the flag and every `--prod=false` spelling are gone. This test pins what a
 * Bun install call site in these scripts may look like: no production flag with
 * a value, no frozen-less first attempt, and no Node-only warning carve-outs.
 */
test("both scripts install through Bun without Node-only flags", () => {
  const provisionSource = fs.readFileSync(script, "utf8");
  const runtimeSource = fs.readFileSync(runtimeScript, "utf8");

  for (const source of [provisionSource, runtimeSource]) {
    // Shell comments explain the removed ladder; only executable lines matter.
    const executable = source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    // Bun's --prod takes no value, so the old `--prod=false` spelling is a hard
    // error rather than a dev-dependency install.
    assert.ok(!executable.includes("--prod="), "Bun's --prod flag takes no value");
    assert.ok(!executable.includes("--disable-warning="), "the DEP0169 carve-out was pnpm-only");
    assert.ok(!executable.includes("$NODE_OPTIONS"), "no Node warning configuration is forwarded");
    // The pnpm and corepack rungs of the launch ladder are gone entirely.
    for (const removed of ["command -v pnpm", "pnpm paperclipai", "pnpm install", "corepack"]) {
      assert.ok(!executable.includes(removed), `expected ${removed} to be removed`);
    }
    // Every inline program and every CLI boot is handed to Bun.
    assert.ok(!/(?:^|\s)node\s+(?:<<|\$|["'])/.test(executable), "no inline program is run by Node");
    assert.ok(executable.includes("command -v bun"), "both scripts refuse to run without Bun");
  }

  // The unlocked retry still names its frozen counterpart, so the recovery is
  // an explicit second attempt rather than an unpinned default.
  assert.match(provisionSource, /run_bun_install --frozen-lockfile/);
  assert.match(provisionSource, /run_bun_install --no-frozen-lockfile/);

  // The repair path is the same at both of its call sites (locked and
  // unlocked), and always forces a relink under a frozen lockfile.
  const repairCallSites = provisionSource.match(/env -u NODE_ENV CI=true "\$\{repair_cmd\[@\]\}"/g) ?? [];
  assert.equal(repairCallSites.length, 2, "expected the repair bun install at both call sites");
  assert.match(provisionSource, /local repair_cmd=\(bun install --force --frozen-lockfile\)/);

  const runtimeRepairCallSites = runtimeSource.match(/env -u NODE_ENV CI=true "\$\{repair_cmd\[@\]\}"/g) ?? [];
  assert.equal(runtimeRepairCallSites.length, 2, "expected the repair bun install at both call sites");
  assert.match(runtimeSource, /local repair_cmd=\(bun install --force --frozen-lockfile\)/);
});

// Bun's frozen install refuses a lockfile that no longer matches the manifests
// with this exact diagnostic on stderr; the provisioner retries only that case
// without --frozen-lockfile and preserves every other failure.
const bunFrozenLockfileDrift = "error: lockfile had changes, but lockfile is frozen";

for (const failure of ["lockfile-drift", "network-failure", "integrity-failure", "retry-fails"]) {
  test(`dependency provisioning preserves failures and bounds recovery: ${failure}`, () => {
    const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
    const bin = makeBunShim(
      "paperclip-fake-bun-",
      `
printf '%s\\n' "$*" >> bun-calls
case "$*" in
  *--frozen-lockfile*)
    case "${failure}" in
      lockfile-drift | retry-fails)
        # Both reach the non-frozen retry; only retry-fails breaks there.
        echo '${bunFrozenLockfileDrift}' >&2
        exit 1
        ;;
      network-failure)
        echo 'error: GET https://registry.npmjs.org/x - ENOTFOUND' >&2
        exit 42
        ;;
      integrity-failure)
        echo 'error: Integrity check failed for "left-pad@1.3.0"' >&2
        exit 42
        ;;
    esac
    ;;
  *)
    if [[ "${failure}" == "retry-fails" ]]; then exit 43; fi
    mkdir -p node_modules
    exit 0
    ;;
esac`,
    );
    const { result, worktreeCwd } = runProvision(baseCwd, {
      pathPrefix: bin,
      setupWorktree(root) {
        fs.writeFileSync(path.join(root, "package.json"), "{}\n");
        fs.writeFileSync(path.join(root, "bun.lock"), "lockfileVersion: '9.0'\n");
      },
    });
    const recovers = failure === "lockfile-drift";
    // The provisioner keeps the failing install's own exit code; only the
    // drift retry is allowed to succeed, and a failing retry still fails.
    const expectedExit = recovers
      ? 0
      : failure === "retry-fails"
        ? 1
        : 42;
    assert.equal(result.status, expectedExit, result.stderr);
    assert.equal(fs.existsSync(path.join(worktreeCwd, ".paperclip/bun-install-fingerprint")), recovers);
    const calls = fs.readFileSync(path.join(worktreeCwd, "bun-calls"), "utf8").trim().split("\n");
    assert.equal(calls.length, failure === "retry-fails" || recovers ? 2 : 1);
    assert.match(calls[0], /^--frozen-lockfile$/);
    if (calls.length === 2) assert.match(calls[1], /^--no-frozen-lockfile$/);
  });
}

test("patch content changes invalidate an otherwise matching install fingerprint", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const bin = makeBunShim("paperclip-patch-bun-", `echo install >> bun-calls\nmkdir -p node_modules cli/node_modules`);
  const first = runProvision(baseCwd, { pathPrefix: bin, setupWorktree(root) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ patchedDependencies: { "dependency@1": "patches/dependency.diff" } }));
    fs.writeFileSync(path.join(root, "bun.lock"), "lockfileVersion: '9.0'\n");
    fs.mkdirSync(path.join(root, "patches"));
    fs.writeFileSync(path.join(root, "patches/dependency.diff"), "first patch");
  } });
  assert.equal(first.result.status, 0, first.result.stderr);
  const options = { pathPrefix: bin, existingWorktree: first.worktreeCwd };
  assert.equal(runProvision(baseCwd, options).result.status, 0);
  const callsPath = path.join(first.worktreeCwd, "bun-calls");
  assert.equal(fs.readFileSync(callsPath, "utf8"), "install\n");
  fs.writeFileSync(path.join(first.worktreeCwd, "unrelated.patch"), "unrelated change");
  assert.equal(runProvision(baseCwd, options).result.status, 0);
  assert.equal(fs.readFileSync(callsPath, "utf8"), "install\n");
  fs.writeFileSync(path.join(first.worktreeCwd, "patches/dependency.diff"), "changed patch");
  assert.equal(runProvision(baseCwd, options).result.status, 0);
  assert.equal(fs.readFileSync(callsPath, "utf8"), "install\ninstall\n");
});
