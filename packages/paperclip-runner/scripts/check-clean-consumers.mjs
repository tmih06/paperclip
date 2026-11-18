import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { withInstalledPackagePackInput } from "./lib/installed-package-pack.mjs";
import { resolveInstalledPackageRoot } from "./lib/runner-runtime-dependency-roots.mjs";
import { deriveConsumerInputs, enumerateRuntimeClosure } from "./lib/runtime-closure.mjs";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The workspace install owns the dependency bytes. Under Bun's hoisted linker
// the Runner has no node_modules of its own, so every package resolves through
// the workspace root install instead of a package-local tree.
const workspaceRoot = await realpath(resolve(runnerRoot, "../.."));
const scratchParent = process.env.PAPERCLIP_RUN_SCRATCH_DIR
  ?? process.env.PAPERCLIP_SCRATCH_DIR
  ?? tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(join(scratchParent, "paperclip-package-consumer-"));
const artifactsRoot = resolve(scratchRoot, "artifacts");
const publicationRoot = process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR === undefined
  ? undefined
  : resolve(process.env.PAPERCLIP_CLEAN_CONSUMER_OUTPUT_DIR);
await mkdir(artifactsRoot, { recursive: true });

try {
  run("bun", ["run", "build:typescript"], runnerRoot);
  run("cargo", [
    "build",
    "--release",
    "--manifest-path",
    "runner/Cargo.toml",
    "--locked",
    "-p",
    "paperclip-runner-core",
    "--bin",
    "paperclip-runnerd",
  ], runnerRoot);
  run("bun", ["scripts/stage-runner-binary.mjs"], runnerRoot);
  const closure = await packRunnerRuntimeClosure(artifactsRoot);
  const runnerdArtifact = await stageRunnerdArtifact(artifactsRoot);
  const conformanceRecord = resolve(artifactsRoot, "paperclip-runner-consumer-conformance.json");
  const sourceCommit = (
    process.env.PAPERCLIP_SOURCE_COMMIT
    ?? capture("git", ["rev-parse", "HEAD"], runnerRoot)
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("PAPERCLIP_SOURCE_COMMIT must be a full lowercase Git commit SHA");
  }

  await verifyRunnerConsumer({
    consumerRoot: resolve(scratchRoot, "runner-consumer"),
    ...closure,
    runnerdArtifact,
    conformanceRecord,
    sourceCommit,
  });

  if (publicationRoot !== undefined) {
    await publishArtifacts({ publicationRoot, runnerTarball: closure.runnerTarball, runnerdArtifact, conformanceRecord });
    process.stdout.write(`Published clean-consumer artifacts at ${publicationRoot}\n`);
  }
  process.stdout.write("Clean-consumer pack/install checks passed for the runner root, evals, and testing exports.\n");
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

/**
 * Pack one package with Bun's packer. `--cwd` packs `packageRoot` without
 * changing into it, so the same command packs the Runner root and every
 * installed dependency; `--ignore-scripts` keeps a publisher lifecycle script
 * from running. Bun's packer applies `files`, `.npmignore`, and
 * `publishConfig.executableFiles` the way npm does, which is what makes the
 * packed runnerd executable in the consumer.
 */
async function pack(packageRoot, destination) {
  const before = new Set(await readdir(destination));
  run("bun", [
    "pm", "pack",
    "--cwd", resolve(packageRoot),
    "--ignore-scripts",
    "--quiet",
    "--destination", destination,
  ], packageRoot, { quiet: true });
  const created = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .sort();
  if (created.length !== 1) {
    throw new Error(`Expected one tarball from ${packageRoot}, found ${created.join(", ") || "none"}`);
  }
  return resolve(destination, created[0]);
}

/**
 * Pack the Runner and every package its runtime graph reaches, then describe
 * the graph as Bun `overrides` and root peer dependencies.
 */
async function packRunnerRuntimeClosure(destination) {
  const { nodes, edges } = await enumerateRuntimeClosure({
    packageRoot: runnerRoot,
    resolveInstalled: (fromDirectory, dependencyName) =>
      resolveInstalledPackageRoot(fromDirectory, dependencyName, { stopAt: workspaceRoot }),
  });
  const packed = new Map();
  for (const [identity, { packageRoot }] of nodes) {
    packed.set(identity, await withInstalledPackagePackInput(packageRoot, scratchRoot, input => pack(input, destination)));
  }
  // The Runner root is packed last from its real tree, so `files`,
  // `.npmignore`, and `publishConfig.executableFiles` decide its contents.
  const runnerTarball = await pack(runnerRoot, destination);
  const { overrides, peerDependencies } = deriveConsumerInputs({
    nodes,
    edges,
    tarballFor: identity => packed.get(identity),
    semver: Bun.semver,
  });
  return { runnerTarball, overrides, peerDependencies, packages: nodes.size, edges: edges.length };
}

/**
 * Copy the built runnerd beside the package tarball under a platform-named file
 * and describe it. The consumer resolves this artifact explicitly, so the
 * bundled default daemon and the release artifact stay separate proofs.
 */
async function stageRunnerdArtifact(destination) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const source = resolve(runnerRoot, `dist/bin/paperclip-runnerd${suffix}`);
  const executablePath = resolve(destination, `paperclip-runnerd-${process.platform}-${process.arch}${suffix}`);
  await copyFile(source, executablePath);
  if (process.platform !== "win32") await chmod(executablePath, 0o755);
  const bytes = await readFile(executablePath);
  return {
    executablePath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    byteSize: bytes.byteLength,
    buildProfile: "release",
  };
}

/**
 * The consumer's install inputs. Every runtime edge is a tarball rule, so the
 * install needs no registry metadata: `bun install --offline` resolves entirely
 * from the packed artifacts. `peer = false` stops Bun from reaching outside the
 * closure for a peer range the packed graph already satisfies, and the hoisted
 * linker is pinned so this proves the same layout the workspace uses rather
 * than inheriting whichever default Bun ships.
 */
async function writeConsumerInputs({ consumerRoot, runnerTarball, overrides, peerDependencies }) {
  await writeFile(resolve(consumerRoot, "package.json"), `${JSON.stringify({
    name: "paperclip-runner-clean-consumer",
    private: true,
    type: "module",
    packageManager: `bun@${process.versions.bun}`,
    dependencies: {
      "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
      ...peerDependencies,
    },
    overrides,
  }, null, 2)}\n`);
  await writeFile(resolve(consumerRoot, "bunfig.toml"), [
    "[install]",
    'linker = "hoisted"',
    "peer = false",
    "",
  ].join("\n"));
}

async function verifyRunnerConsumer({
  consumerRoot,
  runnerTarball,
  overrides,
  peerDependencies,
  packages: closurePackageCount,
  edges: closureEdgeCount,
  runnerdArtifact,
  conformanceRecord,
  sourceCommit,
}) {
  await mkdir(consumerRoot, { recursive: true });
  await writeConsumerInputs({ consumerRoot, runnerTarball, overrides, peerDependencies });
  await writeFile(resolve(consumerRoot, "verify-default-runnerd.mjs"), `
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCapabilityRunnerdBinary } from "@paperclipai/paperclip-runner";
import { parsePaperclipRunnerdBuildMetadata, PAPERCLIP_RUNNER_BUILD_METADATA } from "@paperclipai/paperclip-runner/evals";
// This is the installed package's default lookup. The separate eval artifact
// below must not hide an unusable bundled daemon or repair its permissions.
const bundledRunnerd = defaultCapabilityRunnerdBinary();
const installedEntry = fileURLToPath(import.meta.resolve("@paperclipai/paperclip-runner"));
const expectedBundledRunnerd = resolve(dirname(installedEntry), "bin",
  "paperclip-runnerd" + (process.platform === "win32" ? ".exe" : ""));
if (await realpath(bundledRunnerd) !== await realpath(expectedBundledRunnerd)) {
  throw new Error("default runnerd escaped the installed package");
}
await access(bundledRunnerd, constants.X_OK);
const bundledRunnerdDigest = "sha256:" + createHash("sha256")
  .update(await readFile(bundledRunnerd)).digest("hex");
if (bundledRunnerdDigest !== process.env.EXPECTED_RUNNERD_SHA256) {
  throw new Error("installed default runnerd differs from the built binary");
}
const bundledMetadata = JSON.parse(execFileSync(bundledRunnerd, ["--build-metadata"], {
  encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH, HOME: process.cwd() },
}));
if (parsePaperclipRunnerdBuildMetadata(bundledMetadata).binaryContractVersion !== PAPERCLIP_RUNNER_BUILD_METADATA.contracts.runnerdArtifact) {
  throw new Error("installed default runnerd did not start with the expected contract");
}

await writeFile("bundled-runnerd-proof.json", JSON.stringify({ executable: true, started: true, binaryOverride: false, sha256: bundledRunnerdDigest }) + "\\n");
`);
  await writeFile(resolve(consumerRoot, "verify.mjs"), `
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as runtime from "@paperclipai/paperclip-runner";
import * as evals from "@paperclipai/paperclip-runner/evals";
import * as testing from "@paperclipai/paperclip-runner/testing";

if ("MockControlPlaneAdapter" in runtime || "runControlPlanePortConformance" in runtime) {
  throw new Error("test helpers leaked through the runtime root");
}
if (typeof testing.MockControlPlaneAdapter !== "function") {
  throw new Error("deterministic mock is absent from ./testing");
}
const adapter = new testing.MockControlPlaneAdapter();
const report = await testing.runControlPlanePortConformance({
  port: adapter,
  start: () => adapter.start(),
  stop: () => adapter.stop(),
});
if (report.eventCount !== 3) throw new Error("packed conformance kit returned the wrong event count");

const nativeBundle = await evals.loadPaperclipNativeExecutionFixture();
if (nativeBundle.schema !== "paperclip-runner/native-execution/v1") {
  throw new Error("packed native execution fixture is unavailable");
}
if (nativeBundle.semanticTools.results[0]?.outcome !== "denied") {
  throw new Error("native execution fixture lost its rejected tool effect");
}

runtime.assertPaperclipRunnerCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  components: { catalog: 1, protocol: 1, runnerClient: 1, controlPlaneAdapter: 1, testkit: 1 },
  requiredOperationIds: ["finish_task"],
  provider: { id: "clean-provider", supportedOperationIds: ["finish_task"] },
});

const driverConformance = await testing.runHarnessDriverConformance({
  driver: new testing.DeterministicHarnessDriver(),
});
if (!driverConformance.checks.transcriptCompleteness || driverConformance.semanticToolCallCount !== 1) {
  throw new Error("packed harness-driver conformance did not cover transcript/tools");
}

// Nothing may resolve back into the source checkout: this consumer is a real
// installed package, and a path into the repo would mean the proof read source
// files instead of the packed artifact.
const sourceTree = process.env.PAPERCLIP_SOURCE_TREE;
const resolvedExports = [
  import.meta.resolve("@paperclipai/paperclip-runner"),
  import.meta.resolve("@paperclipai/paperclip-runner/evals"),
  import.meta.resolve("@paperclipai/paperclip-runner/testing"),
];
if (sourceTree !== undefined) {
  for (const resolved of resolvedExports) {
    if (fileURLToPath(resolved).startsWith(sourceTree + sep)) {
      throw new Error("consumer export resolved into the source checkout: " + resolved);
    }
  }
}

const runnerd = await evals.resolvePaperclipRunnerdArtifact({
  executablePath: process.env.PAPERCLIP_RUNNERD_ARTIFACT,
  expectedSha256: process.env.PAPERCLIP_RUNNERD_SHA256,
});
const evalCompatibility = evals.assertPaperclipRunnerEvalCompatibility({
  consumer: "paperclip-runner-clean-consumer",
  packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
  runnerd: runnerd.buildMetadata,
  nativeExecutionVersion: 1,
  prp: { minimumVersion: 1, maximumVersion: 1 },
  catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
  driver: {
    contractVersion: driverConformance.contractVersion,
    descriptor: driverConformance.descriptor,
    requiredCapabilities: ["typedEvents", "interruption", "usage", "dynamicTools"],
  },
});
if (evalCompatibility.negotiatedPrpVersion !== 1) {
  throw new Error("package/binary PRP negotiation returned the wrong version");
}
let mismatchFailedClosed = false;
try {
  evals.assertPaperclipRunnerEvalCompatibility({
    consumer: "incompatible-runner-clean-consumer",
    packageVersion: evals.PAPERCLIP_RUNNER_BUILD_METADATA.package.version,
    runnerd: { ...runnerd.buildMetadata, binaryContractVersion: 999 },
    nativeExecutionVersion: 1,
    prp: { minimumVersion: 1, maximumVersion: 1 },
    catalog: evals.PAPERCLIP_RUNNER_BUILD_METADATA.semanticCatalog,
    driver: {
      contractVersion: driverConformance.contractVersion,
      descriptor: driverConformance.descriptor,
      requiredCapabilities: [],
    },
  });
} catch (error) {
  mismatchFailedClosed = error?.code === "paperclip_runner_eval_incompatible"
    && error.issues?.some((issue) => issue.code === "binary_contract_version_mismatch");
}
if (!mismatchFailedClosed) {
  throw new Error("runnerd contract mismatch did not fail closed");
}

const normalized = {
  authorization: { outcome: "allowed" },
  state: { status: "done" },
  effects: [],
  audit: [],
};
const semanticConformance = await testing.runSemanticConformanceKit({
  vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
  adapters: [
    { id: "mock", execute: async () => normalized },
    { id: "real", execute: async () => ({ audit: [], effects: [], state: { status: "done" }, authorization: { outcome: "allowed" } }) },
  ],
});

const packageArtifactPath = process.env.PAPERCLIP_RUNNER_PACKAGE_ARTIFACT;
const runnerdArtifactPath = process.env.PAPERCLIP_RUNNERD_ARTIFACT;
const packageBytes = await readFile(packageArtifactPath);
const runnerdBytes = await readFile(runnerdArtifactPath);
const packageStat = await stat(packageArtifactPath);
const runnerdStat = await stat(runnerdArtifactPath);
const runnerdDigest = "sha256:" + createHash("sha256").update(runnerdBytes).digest("hex");
if (runnerdDigest !== process.env.PAPERCLIP_RUNNERD_SHA256) {
  throw new Error("runnerd artifact digest changed after staging");
}

await writeFile(process.env.PAPERCLIP_CONFORMANCE_RECORD, JSON.stringify({
  schema: "paperclip-runner/clean-consumer-conformance/v1",
  recordedAt: new Date().toISOString(),
  sourceCommit: process.env.PAPERCLIP_SOURCE_COMMIT,
  platform: { os: process.platform, arch: process.arch },
  artifacts: {
    package: {
      filename: basename(packageArtifactPath),
      sha256: "sha256:" + createHash("sha256").update(packageBytes).digest("hex"),
      byteSize: packageStat.size,
    },
    runnerd: {
      filename: basename(runnerdArtifactPath),
      sha256: runnerdDigest,
      byteSize: runnerdStat.size,
      buildProfile: process.env.PAPERCLIP_RUNNERD_BUILD_PROFILE,
    },
  },
  consumer: {
    installMode: "offline-packed-artifact",
    installFlags: ["--offline", "--no-cache", "--ignore-scripts", "--no-save"],
    linker: "hoisted",
    imports: [
      "@paperclipai/paperclip-runner",
      "@paperclipai/paperclip-runner/evals",
      "@paperclipai/paperclip-runner/testing",
    ],
    resolvedImports: resolvedExports,
    runtimes: (process.env.PAPERCLIP_CONSUMER_RUNTIME ?? "").split(",").filter(Boolean),
    appSourceTreeImports: false,
    providerCalls: 0,
    closure: {
      packages: Number(process.env.PAPERCLIP_CLOSURE_PACKAGES),
      edges: Number(process.env.PAPERCLIP_CLOSURE_EDGES),
      overrideRules: Object.keys(JSON.parse(await readFile("package.json", "utf8")).overrides ?? {}).length,
      peerRootDependencies: Object.keys(JSON.parse(await readFile("package.json", "utf8")).dependencies ?? {}).length - 1,
    },
  },
  checks: {
    packageExportsResolved: true,
    nativeExecutionFixture: {
      schema: nativeBundle.schema,
      rejectedToolEffectPreserved: true,
    },
    evalCompatibility,
    evalMismatchFailedClosed: mismatchFailedClosed,
    mockControlPlaneConformance: report,
    harnessDriverConformance: driverConformance,
    runnerdDigest: true,
    closureRelocated: process.env.PAPERCLIP_RELOCATED_CONSUMER === "1",
    bundledDefaultRunnerd: JSON.parse(await readFile("bundled-runnerd-proof.json", "utf8")),
    semanticConformance: {
      schema: semanticConformance.schema,
      rowCount: semanticConformance.rows.length,
      adapterIds: semanticConformance.rows[0]?.adapterIds ?? [],
    },
  },
}, null, 2) + "\\n");
`);
  installAndRun(consumerRoot, {
    PAPERCLIP_RUNNERD_ARTIFACT: runnerdArtifact.executablePath,
    PAPERCLIP_RUNNERD_SHA256: runnerdArtifact.sha256,
    PAPERCLIP_RUNNERD_BUILD_PROFILE: runnerdArtifact.buildProfile,
    PAPERCLIP_RUNNER_PACKAGE_ARTIFACT: runnerTarball,
    PAPERCLIP_CONFORMANCE_RECORD: conformanceRecord,
    PAPERCLIP_SOURCE_COMMIT: sourceCommit,
    PAPERCLIP_SOURCE_TREE: workspaceRoot,
    PAPERCLIP_CLOSURE_PACKAGES: String(closurePackageCount),
    PAPERCLIP_CLOSURE_EDGES: String(closureEdgeCount),
    PAPERCLIP_CONSUMER_RUNTIME: "node,bun",
  });
  await verifyRelocatedConsumer({
    consumerRoot,
    extraEnv: {
      PAPERCLIP_RUNNERD_ARTIFACT: runnerdArtifact.executablePath,
      PAPERCLIP_RUNNERD_SHA256: runnerdArtifact.sha256,
      PAPERCLIP_RUNNERD_BUILD_PROFILE: runnerdArtifact.buildProfile,
      PAPERCLIP_RUNNER_PACKAGE_ARTIFACT: runnerTarball,
      PAPERCLIP_CONFORMANCE_RECORD: resolve(scratchRoot, "relocated-conformance.json"),
      PAPERCLIP_SOURCE_COMMIT: sourceCommit,
      PAPERCLIP_SOURCE_TREE: workspaceRoot,
      PAPERCLIP_RELOCATED_CONSUMER: "1",
    },
  });
}

async function publishArtifacts({ publicationRoot, runnerTarball, runnerdArtifact, conformanceRecord }) {
  await mkdir(publicationRoot, { recursive: true });
  const files = [runnerTarball, runnerdArtifact.executablePath, conformanceRecord];
  for (const file of files) await copyFile(file, resolve(publicationRoot, basename(file)));
  if (process.platform !== "win32") {
    await chmod(resolve(publicationRoot, basename(runnerdArtifact.executablePath)), 0o755);
  }
  const checksums = [];
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    checksums.push(`${digest}  ${basename(file)}`);
  }
  await writeFile(resolve(publicationRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);
}

function installAndRun(consumerRoot, extraEnv = {}) {
  // A clean install of the packed artifacts only. `--offline --no-cache` proves
  // no registry manifest or previously cached metadata is needed, `--no-save`
  // keeps the check from writing a lockfile back into the scratch consumer, and
  // `--ignore-scripts` keeps a packed lifecycle script from running arbitrary
  // code during the gate. The cache directory is inside the scratch root so a
  // developer's Bun cache cannot supply a manifest either.
  run("bun", [
    "install",
    "--offline",
    "--no-cache",
    "--ignore-scripts",
    "--no-save",
    "--cache-dir",
    resolve(consumerRoot, ".bun-install-cache"),
  ], consumerRoot, { env: { NODE_ENV: "development" } });
  // Verify under every runtime the published package supports. The consumer is
  // a real installed package, so this exercises the resolution a user gets
  // rather than the workspace's; Bun installs it, and both Bun and the Node
  // runtime in `engines.node` must then import and run it.
  const runtimes = ["node", "bun"];
  for (const runtime of runtimes) {
    run(runtime, ["verify-default-runnerd.mjs"], consumerRoot, {
      inheritEnv: false,
      env: { PATH: process.env.PATH, HOME: consumerRoot, EXPECTED_RUNNERD_SHA256: extraEnv.PAPERCLIP_RUNNERD_SHA256 },
    });
    run(runtime, ["verify.mjs"], consumerRoot, {
      env: { ...extraEnv, PAPERCLIP_CONSUMER_RUNTIME: runtime },
    });
  }
}

/**
 * The packed tree must survive being moved. Copy the installed consumer to a new
 * prefix and re-run the same export proof there, so a packed path that points
 * back at the original install (an absolute symlink, a build-directory
 * reference) fails instead of passing from where it happened to be unpacked.
 */
async function verifyRelocatedConsumer({ consumerRoot, extraEnv }) {
  const relocatedRoot = resolve(scratchRoot, "relocated-consumer");
  await rm(relocatedRoot, { recursive: true, force: true });
  await cp(consumerRoot, relocatedRoot, {
    recursive: true,
    verbatimSymlinks: true,
    filter: source => !source.split(sep).includes(".bun-install-cache"),
  });
  for (const runtime of ["node", "bun"]) {
    run(runtime, ["verify.mjs"], relocatedRoot, { env: { ...extraEnv, PAPERCLIP_CONSUMER_RUNTIME: runtime } });
  }
}

function run(command, args, cwd, { quiet = false, env = {}, inheritEnv = true } = {}) {
  const executable = process.platform === "win32" && (command === "bun" || command === "node")
    ? `${command}.exe`
    : command;
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...(inheritEnv ? process.env : {}), CI: "true", ...env },
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    ...(quiet ? { maxBuffer: 32 * 1024 * 1024 } : {}),
    // A bare executable name on Windows needs the shell to resolve it.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    if (quiet) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    if (result.error !== undefined) process.stderr.write(`${String(result.error)}\n`);
    if (result.signal !== null) process.stderr.write(`Terminated by signal ${result.signal}\n`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout;
}
