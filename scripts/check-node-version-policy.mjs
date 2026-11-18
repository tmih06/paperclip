#!/usr/bin/env bun
/**
 * First-party Bun runtime policy, plus the Node.js floors that remain scoped.
 *
 * Paperclip runs on Bun. The installer bootstraps a pinned Bun, the CLI and the
 * server start under Bun, and the runtime guards read `process.versions.bun`.
 * Node.js survives in this policy only where it is genuinely scoped: external
 * provider SDKs, sandbox images, and the published `engines` ranges and bundle
 * targets that describe the Node.js API level those artifacts run on.
 *
 * The Bun floor declared in `packages/shared/src/bun-version.ts` is the single
 * source of truth. The installer pin and every CI `bun-version` pin must match
 * it, so a runner never exercises a different Bun than the shipped floor.
 *
 * Files are enumerated from the git index plus untracked, non-ignored paths, so
 * a local run sees the same policy or an earlier warning, and an ignored
 * scratch or vendor tree can never decide the result.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNode24ImageTag } from "./node-image-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXPECTED_NODE_ENGINE = ">=24.11.0";
export const EXPECTED_NODE_TYPES = "^24.0.0";
export const EXPECTED_NODE_MAJOR = "24";
export const BUN_FLOOR_SOURCE = "packages/shared/src/bun-version.ts";
export const BUN_FLOOR_PATTERN = /MINIMUM_BUN_VERSION = "(\d+\.\d+\.\d+)"/;

/** Node.js floors that stay in force for external provider and image artifacts. */
export const NODE_PROVIDER_FRAGMENTS = [
  [".nvmrc", "24", "the Node.js used by external provider tooling"],
  ["docker/agent-runtime/Dockerfile.base", "ARG NODE_VERSION=24", "the agent runtime Node.js the providers need"],
  ["packages/adapter-utils/src/sandbox-install-command.ts", 'NODE_VERSION="v24.11.0"', "the sandbox provider Node.js install"],
  ["packages/plugins/sandbox-providers/exe-dev/src/plugin.ts", "nodesource.com/setup_24.x", "the exe.dev sandbox image Node.js"],
  ["packages/plugins/sandbox-providers/modal/src/manifest.ts", 'default: "node:24"', "the Modal sandbox image Node.js"],
  ["cli/esbuild.config.mjs", 'target: "node24"', "the CLI bundle output level"],
  ["packages/plugins/sdk/src/bundlers.ts", 'target: "node24"', "the plugin bundle output level"],
  ["scripts/generate-npm-package-json.mjs", `engines: { node: "${EXPECTED_NODE_ENGINE}" }`, "the published Node.js engines range"],
];

/** First-party entrypoints must guard on Bun, never on Node.js. */
export const BUN_RUNTIME_ENTRYPOINTS = ["cli/src/index.ts", "server/src/index.ts"];
export const BUN_GUARD_IMPORT = "@paperclipai/shared/bun-version";
export const NODE_GUARD_IMPORT = "@paperclipai/shared/node-version";

function readSource(root, filePath) {
  return fs.readFileSync(path.join(root, filePath), "utf8");
}

function trackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).split("\0").filter(Boolean);
  } catch (error) {
    throw new Error(`The version policy check enumerates tracked files with git: ${error.message}`, { cause: error });
  }
}

export function readBunFloor(root) {
  const source = path.join(root, BUN_FLOOR_SOURCE);
  if (!fs.existsSync(source)) return null;
  return BUN_FLOOR_PATTERN.exec(fs.readFileSync(source, "utf8"))?.[1] ?? null;
}

/**
 * Every policy failure for the repository at `root`, in a stable order.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function collectVersionPolicyFailures(root = repoRoot) {
  const failures = [];
  const files = trackedFiles(root);
  const tracked = new Set(files);
  const bunFloor = readBunFloor(root);

  if (!bunFloor) {
    failures.push(`${BUN_FLOOR_SOURCE}: missing a parseable MINIMUM_BUN_VERSION declaration`);
  }

  for (const file of files) {
    if (path.basename(file) !== "package.json") continue;
    const manifest = JSON.parse(readSource(root, file));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const specifier = manifest[section]?.["@types/node"];
      if (specifier && specifier !== EXPECTED_NODE_TYPES) {
        failures.push(`${file}: ${section}.@types/node must be ${EXPECTED_NODE_TYPES}, found ${specifier}`);
      }
    }
    if (manifest.engines?.node !== EXPECTED_NODE_ENGINE) {
      failures.push(`${file}: engines.node must be ${EXPECTED_NODE_ENGINE}, found ${manifest.engines?.node ?? "missing"}`);
    }
    if (file === "package.json" && bunFloor && manifest.packageManager !== `bun@${bunFloor}`) {
      failures.push(`package.json: packageManager must be bun@${bunFloor}, found ${manifest.packageManager ?? "missing"}`);
    }
  }

  for (const file of files) {
    if (!file.startsWith(".github/workflows/") || !/\.ya?ml$/.test(file)) continue;
    const source = readSource(root, file);
    // Release verification packs binaries on an exact Node.js runner image; that
    // one pin is a pack input, not the policy for a workflow runtime.
    const packProducer = file === ".github/workflows/release-verify.yml"
      ? /(?:^|\n)  runner_binaries:\n[\s\S]*?(?=\n  [a-z_]+:\n|$)/.exec(source)
      : null;
    for (const match of source.matchAll(/bun-version:\s*["']?([^\s"'#]+)/g)) {
      if (bunFloor && match[1] !== bunFloor) {
        failures.push(`${file}: bun-version must be ${bunFloor}, found ${match[1]}`);
      }
    }
    for (const match of source.matchAll(/node-version:\s*["']?([^\s"'#]+)/g)) {
      if (match[1] === "24.21.0" && packProducer
        && match.index >= packProducer.index
        && match.index < packProducer.index + packProducer[0].length) continue;
      if (match[1] !== EXPECTED_NODE_MAJOR) {
        failures.push(`${file}: node-version must be ${EXPECTED_NODE_MAJOR}, found ${match[1]}`);
      }
    }
  }

  // Provider sandbox images still run their provider on Node.js.
  for (const file of files) {
    if (!path.basename(file).startsWith("Dockerfile")) continue;
    const source = readSource(root, file);
    for (const match of source.matchAll(/^\s*FROM\s+node:([^\s]+)/gm)) {
      if (!isNode24ImageTag(match[1])) failures.push(`${file}: Node base image must use the Node 24 major, found node:${match[1]}`);
    }
    for (const match of source.matchAll(/^\s*ARG\s+NODE_(?:MAJOR|VERSION)=([^\s]+)/gm)) {
      if (match[1] !== EXPECTED_NODE_MAJOR) failures.push(`${file}: Node build argument must be ${EXPECTED_NODE_MAJOR}, found ${match[1]}`);
    }
  }

  const requiredFragments = [
    ...NODE_PROVIDER_FRAGMENTS,
    ...(bunFloor
      ? [
          [BUN_FLOOR_SOURCE, `MINIMUM_BUN_VERSION = "${bunFloor}"`, "the first-party Bun runtime floor"],
          ["scripts/install.sh", `BUN_VERSION="${bunFloor}"`, "the Bun version the installer bootstraps"],
        ]
      : []),
  ];
  for (const [file, fragment, purpose] of requiredFragments) {
    if (!tracked.has(file)) {
      failures.push(`${file}: missing from the repository (${purpose})`);
      continue;
    }
    if (!readSource(root, file).includes(fragment)) {
      failures.push(`${file}: missing ${purpose} fragment ${JSON.stringify(fragment)}`);
    }
  }

  for (const file of BUN_RUNTIME_ENTRYPOINTS) {
    if (!tracked.has(file)) {
      failures.push(`${file}: missing from the repository (first-party runtime entrypoint)`);
      continue;
    }
    const source = readSource(root, file);
    if (!source.includes(BUN_GUARD_IMPORT)) {
      failures.push(`${file}: must import the Bun runtime guard ${JSON.stringify(BUN_GUARD_IMPORT)}`);
    }
    if (source.includes(NODE_GUARD_IMPORT)) {
      failures.push(`${file}: must not import the retired Node.js runtime guard ${JSON.stringify(NODE_GUARD_IMPORT)}`);
    }
  }

  return failures;
}

function isMainModule() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const failures = collectVersionPolicyFailures(repoRoot);
  if (failures.length > 0) {
    console.error("Version policy check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `Version policy check passed (Bun >=${readBunFloor(repoRoot)} for the first-party runtime, `
    + `Node ${EXPECTED_NODE_ENGINE} for provider SDKs and images, @types/node 24.x).`,
  );
}
