// Supply the pack's own interpreters.
//
// The pack carries its Node so a relocated, immutable pack never depends on the
// host toolchain, and `nodeCommand` (a fixed pack path the controller verifies)
// keeps naming a real Node: providers that ship their own executable still
// expect Node semantics for the bridges and proxy scripts around them. Bun is
// staged beside it under its own directory because the controller's sandbox
// commands are migrating to Bun; each keeps a distinct pack path, so a pack can
// never silently substitute one runtime for the other.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildNodeStartupTimeout } from "./build-node-startup-timeout.mjs";

/** The Node the pack pins as its minimum. Manifest `pins.nodeMinimum` records it. */
export const MINIMUM_NODE_VERSION = [24, 11, 0];

const versionAtLeast = (actual, minimum) =>
  actual[0] > minimum[0] ||
  (actual[0] === minimum[0] &&
    (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2])));

const OVERRIDES = { node: "PAPERCLIP_RUNNER_PROVIDER_NODE", bun: "PAPERCLIP_RUNNER_PROVIDER_BUN" };

/**
 * The `node` binary of the workspace's locked `node` package, when the Runner
 * installs one. A bare `bun script.mjs` does not put node_modules/.bin on PATH
 * the way `bun run` does, so resolving the package itself is what keeps the pack
 * on the reviewed version instead of whatever Node the build host happens to
 * have. Returns null when the package is not part of the installed closure.
 */
export function installedLockedNode(packageRoot) {
  let manifest;
  try {
    manifest = createRequire(join(packageRoot, "package.json")).resolve("node/package.json");
  } catch { return null; }
  const metadata = JSON.parse(readFileSync(manifest, "utf8"));
  // `node` publishes a platform binary through its bin field; use that path so
  // the layout is the package's own declaration, not an assumed shape.
  const declared = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.node;
  if (typeof declared !== "string" || !declared) {
    throw new Error("The installed node package does not declare a node command");
  }
  const command = join(dirname(manifest), declared);
  if (!existsSync(command)) {
    throw new Error(`The installed node package declares ${declared} but the file is absent`);
  }
  return { command, version: metadata.version };
}

function candidateExecutables(kind, environment, execPath, versions, packageRoot) {
  const configured = environment[OVERRIDES[kind]]?.trim();
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    throw new Error(`${OVERRIDES[kind]} must be an absolute path`);
  }
  // The interpreter that is running this build is preferred when it is the
  // runtime being staged, so an already-qualified binary is reused instead of
  // introducing a second supply chain.
  const runningAsKind = kind === "node" ? versions.bun === undefined : versions.bun !== undefined;
  const onPath = String(environment.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(":").filter(directory => isAbsolute(directory)).map(directory => join(directory, kind));
  const locked = kind === "node" && packageRoot ? installedLockedNode(packageRoot)?.command : null;
  // An explicit override wins, then the workspace's locked package, then the
  // interpreter running the build, then whatever the host PATH offers.
  return [...new Set([configured || null, locked, runningAsKind ? execPath : null, ...onPath])]
    .filter(candidate => typeof candidate === "string" && isAbsolute(candidate));
}

function probeExecutable(executable, args, cwd = process.cwd()) {
  return spawnSync(executable, args, {
    // A pristine PATH proves the copied bytes stand alone rather than finding a
    // host runtime that the immutable image will not have.
    cwd, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: buildNodeStartupTimeout(),
  });
}

/**
 * A real Node at least `MINIMUM_NODE_VERSION` — the version the pack pins. Bun
 * answers `-e` scripts but not `--version` when the file is named node, so the
 * shape of that one reply is what distinguishes the two runtimes.
 */
export function resolvePinnedNode({ environment = process.env, execPath = process.execPath, versions = process.versions, packageRoot } = {}) {
  const rejected = [];
  for (const candidate of candidateExecutables("node", environment, execPath, versions, packageRoot)) {
    const probe = probeExecutable(candidate, ["--version"]);
    const reported = /^v(\d+\.\d+\.\d+)$/.exec(probe.stdout?.trim() ?? "");
    if (probe.status !== 0 || !reported) {
      rejected.push(`${candidate} is not a Node executable`);
      continue;
    }
    if (!versionAtLeast(reported[1].split(".").map(Number), MINIMUM_NODE_VERSION)) {
      rejected.push(`${candidate} is Node ${reported[1]}`);
      continue;
    }
    return { command: candidate, version: reported[1] };
  }
  throw new Error(`Provider pack needs a Node ${MINIMUM_NODE_VERSION.join(".")} or newer; ${rejected.join("; ")}`);
}

/**
 * The Bun the workspace pins as its package manager, so the staged runtime is
 * the reviewed toolchain instead of whatever version happens to be installed.
 */
export function resolvePinnedBun({ pinnedVersion, environment = process.env, execPath = process.execPath, versions = process.versions, packageRoot } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(pinnedVersion ?? "")) {
    throw new Error("The workspace packageManager pin must name a Bun x.y.z version");
  }
  const rejected = [];
  for (const candidate of candidateExecutables("bun", environment, execPath, versions, packageRoot)) {
    const probe = probeExecutable(candidate, ["--version"]);
    const reported = probe.stdout?.trim();
    if (probe.status !== 0 || reported !== pinnedVersion) {
      rejected.push(`${candidate} reported ${reported ? reported : "no version"}`);
      continue;
    }
    return { command: candidate, version: reported };
  }
  throw new Error(`Provider pack needs Bun ${pinnedVersion}; ${rejected.join("; ")}`);
}

/**
 * Copy an interpreter to its stable pack path and prove the copied bytes run
 * there at the expected version. A freshly copied x64 Mach-O can stall when
 * launched from a translated process, so that one case selects Rosetta.
 */
export function stagePackInterpreter({
  source, destination, expectedVersion, platform = process.platform, arch = process.arch, probe = probeExecutable,
}) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  const translated = platform === "darwin" && arch === "x64"
    && spawnSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8", timeout: 1_000 }).stdout?.trim() === "1";
  const result = translated
    ? spawnSync("/usr/bin/arch", ["-x86_64", destination, "--version"], {
      cwd: dirname(destination), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: buildNodeStartupTimeout(),
    })
    : probe(destination, ["--version"], dirname(destination));
  if (result.status !== 0 || result.stdout?.trim().replace(/^v/, "") !== expectedVersion) {
    throw new Error(`Provider pack interpreter ${destination} is not portable after relocation; stage a standalone distribution`);
  }
  return destination;
}
