import profiles from "../acpx-profiles.json" with { type: "json" };
import compatibility from "../src/live/provider-pack-contract.json" with { type: "json" };
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseProviderPackArguments, materializeCandidateProviderPack, providerPackProviders, providerPackManifestFields } from "./candidate-provider-pack.mjs";
import { smokeKimiProviderPack } from "./kimi-provider-pack-smoke.mjs";
import { buildNodeStartupTimeout } from "./build-node-startup-timeout.mjs";
import { writePortableExecutableShim, writePortableCopilotShims } from "./provider-pack-executable-shims.mjs";
import { stageProviderPack, writeInstalledCommandShims, pinnedBunVersion } from "./provider-pack-portable-closure.mjs";
import { MINIMUM_NODE_VERSION, resolvePinnedNode, resolvePinnedBun, stagePackInterpreter } from "./provider-pack-interpreters.mjs";
import { providerPackLibc, removeControllerArtifactsFromProviderPack, removeForeignLibcPackagesFromProviderPack, sha256Tree } from "./provider-pack-runtime-tree.mjs";
import { packContractDigest } from "./contracts/contract-fingerprints.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const { output: outputArgument, candidates } = parseProviderPackArguments(process.argv.slice(2));
const outputRoot = resolve(
  process.cwd(),
  outputArgument ?? join(packageRoot, "provider-pack"),
);
if (
  outputRoot === workspaceRoot ||
  outputRoot === packageRoot ||
  outputRoot === "/"
) {
  throw new Error(`Refusing unsafe provider-pack output path: ${outputRoot}`);
}

const temporaryParent = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-provider-pack-")));
const temporaryRoot = join(temporaryParent, "pack");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256File(path) {
  return `sha256:${createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")}`;
}

function writePortableNodeShim(name, entrypoint) {
  const shimPath = join(temporaryRoot, "node_modules", ".bin", name);
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "set -eu",
      'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$basedir/../node/bin/node" "$basedir/../${entrypoint}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);
}

try {
  // Stage the workspace's own installed production closure. This replaces
  // `pnpm deploy --prod`, which Bun has no equivalent for: a fresh install here
  // would re-resolve the registry and drop the reviewed lockfile's patches,
  // while the pack must carry the exact bytes the build qualified.
  stageProviderPack({
    packageRoot,
    workspaceRoot,
    destinationRoot: temporaryRoot,
  });
  removeControllerArtifactsFromProviderPack(temporaryRoot);
  const foreignLibcPackages = removeForeignLibcPackagesFromProviderPack(temporaryRoot, providerPackLibc());
  if (foreignLibcPackages.length) {
    process.stderr.write(`Removed ${foreignLibcPackages.length} provider-pack packages built for another libc: ${foreignLibcPackages.join(", ")}\n`);
  }

  // Fail the image build if a bridge silently brings back an older/private
  // provider CLI. A direct dependency alone does not deduplicate the graph.
  const packRequire = createRequire(join(temporaryRoot, "package.json"));
  const codexAcpRequire = createRequire(packRequire.resolve("@agentclientprotocol/codex-acp/package.json"));
  if (realpathSync(codexAcpRequire.resolve("@openai/codex/package.json")) !==
      realpathSync(packRequire.resolve("@openai/codex/package.json"))) {
    throw new Error("Codex ACP must share the image's Codex installation");
  }

  // Reuse the already-qualified build interpreter instead of introducing a
  // package-manager lifecycle hook or a second binary supply chain. The pack
  // manifest binds the copied bytes, platform, architecture, and minimum
  // version before any provider is launched.
  const pinnedNode = resolvePinnedNode({ packageRoot });
  const pinnedBun = resolvePinnedBun({ pinnedVersion: pinnedBunVersion(workspaceRoot) });
  const stableNodeRoot = join(temporaryRoot, "node_modules", "node");
  const stableBunRoot = join(temporaryRoot, "node_modules", "bun");
  for (const claimed of [stableNodeRoot, stableBunRoot]) {
    if (existsSync(claimed)) {
      throw new Error(
        `Provider pack deployment unexpectedly claimed the stable interpreter path ${claimed}`,
      );
    }
  }
  const stableNodeCommand = stagePackInterpreter({
    source: pinnedNode.command,
    destination: join(stableNodeRoot, "bin", "node"),
    expectedVersion: pinnedNode.version,
  });
  // Bun runs the controller's sandbox commands, so the pack carries the pinned
  // toolchain in its own directory. It is never an alias for Node: external
  // provider SDKs keep the pack's Node, and each runtime has a distinct path.
  const stableBunCommand = stagePackInterpreter({
    source: pinnedBun.command,
    destination: join(stableBunRoot, "bin", "bun"),
    expectedVersion: pinnedBun.version,
  });

  const candidateProviders = {};
  for (const provider of providerPackProviders(process.platform, process.arch, candidates)) {
    const assetPath = `provider-assets/${provider}/${process.platform}-${process.arch}`;
    const metadata = await materializeCandidateProviderPack({ provider, outputRoot: join(temporaryRoot, assetPath) });
    if (typeof metadata?.version !== "string" || !metadata.version || metadata.version.length > 120
      || !/^sha256:[a-f0-9]{64}$/.test(metadata.profileDigest)
      || !/^sha256:[a-f0-9]{64}$/.test(metadata.closureDigest)) throw new Error("Candidate builder omitted its pinned identity");
    candidateProviders[provider] = { version: metadata.version, profileDigest: metadata.profileDigest,
      closureDigest: metadata.closureDigest, qualification: ["pi", "cursor", "copilot"].includes(provider) || provider === "kimi" && profiles.profiles.kimi.qualificationStatus !== "pending" ? "qualified" : "pending", path: assetPath,
      sha256: sha256Tree(join(temporaryRoot, assetPath)) };
  }

  // Every launcher this pack exposes is written here, pack-relative, so an
  // identical provider pack hashes the same on every build and still resolves
  // after relocation. `writeInstalledCommandShims` already linked the install's
  // own command surface; the rest are the providers and bridges the image needs.
  // The image exposes these same installations to every adapter. Never add a
  // separate global/runner-only CLI version; refresh these packages and their
  // qualification digests together to the latest stable releases.
  writeInstalledCommandShims(temporaryRoot, { packageRoot });
  writePortableNodeShim("codex", "@openai/codex/bin/codex.js");
  const claudeAcpRequire = createRequire(
    packRequire.resolve("@agentclientprotocol/claude-agent-acp/package.json"),
  );
  // Use the ACP bridge's SDK dependency directly, avoiding a second peer-
  // resolved SDK installation just to expose its CLI on the global PATH.
  const sdkRequire = createRequire(claudeAcpRequire.resolve("@anthropic-ai/claude-agent-sdk"));
  const claudeExecutable = sdkRequire.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  );
  writePortableExecutableShim(
    temporaryRoot,
    "claude",
    relative(realpathSync(join(temporaryRoot, "node_modules")), realpathSync(claudeExecutable)),
  );
  writePortableExecutableShim(temporaryRoot, "node", "node/bin/node");
  writePortableExecutableShim(temporaryRoot, "bun", "bun/bin/bun");
  writePortableExecutableShim(temporaryRoot, "opencode", "opencode-ai/bin/opencode.exe");
  writePortableCopilotShims(temporaryRoot);
  writePortableNodeShim("acpx", "acpx/dist/cli.js");
  writePortableNodeShim("paperclip-runner-copilot-metadata-probe", "../dist/cli/copilot-metadata-probe.js");
  writePortableNodeShim(
    "claude-agent-acp",
    "@agentclientprotocol/claude-agent-acp/dist/index.js",
  );
  writePortableNodeShim(
    "codex-acp",
    "@agentclientprotocol/codex-acp/dist/index.js",
  );

  for (const shimName of readdirSync(
    join(temporaryRoot, "node_modules", ".bin"),
  )) {
    const shimPath = join(temporaryRoot, "node_modules", ".bin", shimName);
    const contents = readFileSync(shimPath, "utf8");
    if (contents.includes(temporaryParent)) {
      throw new Error(
        `Provider pack shim ${shimName} retains its temporary build path`,
      );
    }
  }

  // Exercise a clean import from the deployed dependency graph. This catches
  // malformed patch hunks that can look correct in an existing install store
  // but land inside the wrong function when applied to a fresh acpx tarball.
  const acpxImport = spawnSync(
    stableNodeCommand,
    ["--input-type=module", "-e", 'await import("acpx/runtime")'],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (acpxImport.status !== 0) {
    throw new Error(
      `Provider pack ACPX import failed: ${String(acpxImport.stderr ?? "")
        .trim()
        .slice(-2_000)}`,
    );
  }

  // The pack also serves the controller's Bun sandbox commands, so prove the
  // shim and the staged bytes agree before the manifest binds them. Both
  // interpreters keep their own path; Bun is never an alias for Node.
  const bunShimVersion = spawnSync(stableBunCommand, ["--version"], {
    cwd: temporaryRoot, encoding: "utf8", timeout: buildNodeStartupTimeout(),
    env: { PATH: join(temporaryRoot, "node_modules", ".bin") },
  });
  if (bunShimVersion.status !== 0 || bunShimVersion.stdout.trim() !== pinnedBun.version) {
    throw new Error(`Provider pack Bun does not run as bun ${pinnedBun.version}: ${String(bunShimVersion.stderr ?? "").trim().slice(-2_000)}`);
  }
  const bunOnPath = spawnSync(join(temporaryRoot, "node_modules", ".bin", "bun"), ["--version"], {
    cwd: temporaryRoot, encoding: "utf8", timeout: buildNodeStartupTimeout(), env: { PATH: "/usr/bin:/bin" },
  });
  if (bunOnPath.status !== 0 || bunOnPath.stdout.trim() !== pinnedBun.version) {
    throw new Error(`Provider pack bun command is not portable: ${String(bunOnPath.stderr ?? "").trim().slice(-2_000)}`);
  }
  const nodeShimVersion = spawnSync(join(temporaryRoot, "node_modules", ".bin", "node"), ["--version"], {
    cwd: temporaryRoot, encoding: "utf8", timeout: buildNodeStartupTimeout(), env: { PATH: "/usr/bin:/bin" },
  });
  if (nodeShimVersion.status !== 0 || nodeShimVersion.stdout.trim() !== `v${pinnedNode.version}`) {
    throw new Error(`Provider pack node command is not portable: ${String(nodeShimVersion.stderr ?? "").trim().slice(-2_000)}`);
  }

  const opencodeProxyPath = "dist/cli/opencode-app-server-proxy.cjs";
  const acpxSidecarPath = "dist/cli/acpx-runtime-sidecar.cjs";
  const opencodeCommand = "node_modules/.bin/opencode";
  const opencodeExecutable = "node_modules/opencode-ai/bin/opencode.exe";
  const nodeCommand = "node_modules/node/bin/node";
  const bunCommand = "node_modules/bun/bin/bun";
  const bunExecutable = "node_modules/.bin/bun";
  const productionLock = "bun.lock";
  copyFileSync(
    join(workspaceRoot, "bun.lock"),
    join(temporaryRoot, productionLock),
  );
  for (const relativePath of [
    nodeCommand,
    bunCommand,
    bunExecutable,
    productionLock,
    opencodeProxyPath,
    acpxSidecarPath,
    opencodeCommand,
    opencodeExecutable,
  ]) {
    if (!existsSync(join(temporaryRoot, relativePath))) {
      throw new Error(`Provider pack is missing ${relativePath}`);
    }
  }

  const opencodeProxySha = sha256File(join(temporaryRoot, opencodeProxyPath));
  const acpxSidecarSha = sha256File(join(temporaryRoot, acpxSidecarPath));
  const distDigest = sha256Tree(join(temporaryRoot, "dist"));
  const configuredRevision =
    process.env.PAPERCLIP_RUNNER_SOURCE_REVISION?.trim();
  const revision =
    configuredRevision ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("PAPERCLIP_RUNNER_SOURCE_REVISION must be a full Git SHA");
  }
  const dirty = configuredRevision
    ? false
    : spawnSync("git", ["diff", "--quiet", "--", "packages/paperclip-runner"], {
        cwd: workspaceRoot,
      }).status !== 0;
  // Set only by a publication build of the Runner image (the
  // `runner-artifacts` Dockerfile target with
  // PAPERCLIP_RUNNER_IMAGE_PUBLICATION=1): the identity of the inputs the image
  // was built from, which is its `inputs-<digest>` tag.
  // scripts/runner-image-layout.mjs checks it against the image, and refuses
  // it in a pack from any other build.
  const runnerInputsDigest = process.env.PAPERCLIP_RUNNER_INPUTS_DIGEST?.trim();
  if (runnerInputsDigest && !/^[0-9a-f]{64}$/.test(runnerInputsDigest)) {
    throw new Error("PAPERCLIP_RUNNER_INPUTS_DIGEST must be 64 hexadecimal characters");
  }
  const payload = {
    compatibility,
    // Semantic digest of the Runner/pack contracts. Image packs are reused only
    // by a controller whose bundled pack records the same value.
    contractDigest: packContractDigest(workspaceRoot),
    pins: {
      nodeMinimum: MINIMUM_NODE_VERSION.join("."),
      codex: profiles.profiles.codex.agentRuntimeVersion,
      opencode: "1.18.34",
      acpx: profiles.acpxVersion,
      grok: profiles.profiles.grok.agentRuntimeVersion,
      claudeAcp: profiles.profiles.claude.agentServerVersion,
      codexAcp: profiles.profiles.codex.agentServerVersion,
    },
    target: { platform: process.platform, architecture: process.arch },
    runnerSourceRevision: `${revision}${dirty ? "-dirty" : ""}`,
    ...(runnerInputsDigest ? { runnerInputsDigest } : {}),
    distDigest,
    bridgeDigest: `sha256:${createHash("sha256")
      .update(opencodeProxySha)
      .update("\n")
      .update(acpxSidecarSha)
      .update("\n")
      .update(distDigest)
      .digest("hex")}`,
    acpxProfileDigests: {
      grok: profiles.profiles.grok.commandDigest,
      claude:
        profiles.profiles.claude.commandDigest,
      codex:
        profiles.profiles.codex.commandDigest,
    },
    ...providerPackManifestFields(candidateProviders, candidates),
    // The versions of the two interpreters the pack carries, so a controller can
    // state what it is about to run without reading the binaries. `pins` stays
    // the provider contract the server compares byte for byte; this is pack
    // content, like `providers`.
    runtimeVersions: { node: pinnedNode.version, bun: pinnedBun.version },
    artifacts: {
      grokLauncher: {
        path: "dist/providers/grok/launcher.cjs",
        sha256: sha256File(join(temporaryRoot, "dist/providers/grok/launcher.cjs")),
      },
      nodeCommand: {
        path: nodeCommand,
        sha256: sha256File(join(temporaryRoot, nodeCommand)),
      },
      // The sandbox's Bun, bound by the same artifact contract as Node: a fixed
      // pack path plus the digest of the exact bytes staged there.
      bunCommand: {
        path: bunCommand,
        sha256: sha256File(join(temporaryRoot, bunCommand)),
      },
      bunExecutable: {
        path: bunExecutable,
        sha256: sha256File(join(temporaryRoot, bunExecutable)),
      },
      productionLock: {
        path: productionLock,
        sha256: sha256File(join(temporaryRoot, productionLock)),
      },
      opencodeCommand: {
        path: opencodeCommand,
        sha256: sha256File(join(temporaryRoot, opencodeCommand)),
      },
      opencodeExecutable: {
        path: opencodeExecutable,
        sha256: sha256File(join(temporaryRoot, opencodeExecutable)),
      },
      opencodeProxy: {
        path: opencodeProxyPath,
        sha256: opencodeProxySha,
      },
      acpxSidecar: { path: acpxSidecarPath, sha256: acpxSidecarSha },
    },
  };
  const manifest = {
    schema: "paperclip-runner/remote-provider-pack/v1",
    digest: `sha256:${createHash("sha256")
      .update(canonicalJson(payload))
      .digest("hex")}`,
    payload,
  };
  writeFileSync(
    join(temporaryRoot, "provider-pack.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (payload.providers?.kimi && profiles.profiles.kimi.qualificationStatus !== "pending") {
    const smoke = await smokeKimiProviderPack(temporaryRoot);
    process.stdout.write(`${JSON.stringify(smoke)}\n`);
  }

  rmSync(outputRoot, { recursive: true, force: true });
  renameSync(temporaryRoot, outputRoot);
  process.stdout.write(`${outputRoot}\n`);
} finally {
  rmSync(temporaryParent, { recursive: true, force: true });
}
