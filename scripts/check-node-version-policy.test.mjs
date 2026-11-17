#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
  BUN_FLOOR_SOURCE,
  collectVersionPolicyFailures,
  readBunFloor,
} from "./check-node-version-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUN_FLOOR = "1.4.4";
const fixtures = [];

function write(root, file, contents) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/**
 * A minimal repository whose only purpose is to satisfy every policy rule, so a
 * test can break exactly one input and assert the resulting failure.
 */
function policyFixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "paperclip-version-policy-"));
  fixtures.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });

  const files = {
    ".nvmrc": "24\n",
    [BUN_FLOOR_SOURCE]: `export const MINIMUM_BUN_VERSION = "${BUN_FLOOR}";\n`,
    "scripts/install.sh": `BUN_VERSION="${BUN_FLOOR}"\n`,
    "docker/agent-runtime/Dockerfile.base": "ARG NODE_VERSION=24\n",
    "packages/adapter-utils/src/sandbox-install-command.ts": 'const NODE_VERSION="v24.11.0";\n',
    "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts": 'const url = "https://deb.nodesource.com/setup_24.x";\n',
    "packages/plugins/sandbox-providers/modal/src/manifest.ts": 'const image = { default: "node:24" };\n',
    "cli/esbuild.config.mjs": 'export default { target: "node24" };\n',
    "packages/plugins/sdk/src/bundlers.ts": 'export const build = { target: "node24" };\n',
    "scripts/generate-npm-package-json.mjs": 'const manifest = { engines: { node: ">=24.11.0" } };\n',
    "package.json": JSON.stringify(
      { name: "fixture", engines: { node: ">=24.11.0" }, packageManager: `bun@${BUN_FLOOR}` },
      null,
      2,
    ),
    ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: ${BUN_FLOOR}\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 24\n`,
    "cli/src/index.ts": 'import { warnIfUnsupportedBunVersion } from "@paperclipai/shared/bun-version";\n',
    "server/src/index.ts": 'import { warnIfUnsupportedBunVersion } from "@paperclipai/shared/bun-version";\n',
    ...overrides,
  };
  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) continue;
    write(root, file, contents);
  }
  return root;
}

function failuresFor(overrides) {
  return collectVersionPolicyFailures(policyFixture(overrides));
}

after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe("readBunFloor", () => {
  it("reads the declared floor from the shared Bun runtime module", () => {
    assert.equal(readBunFloor(repoRoot), BUN_FLOOR);
  });

  it("returns null when the floor module is missing", () => {
    assert.equal(readBunFloor(policyFixture({ [BUN_FLOOR_SOURCE]: null })), null);
  });
});

describe("collectVersionPolicyFailures", () => {
  it("passes for a repository that keeps the scoped Node.js floors and the Bun runtime floor", () => {
    assert.deepEqual(failuresFor({}), []);
  });

  it("passes for this repository", () => {
    assert.deepEqual(collectVersionPolicyFailures(repoRoot), []);
  });

  it("no longer requires a Node.js floor in the installer that bootstraps Bun", () => {
    // The installer used to carry MIN_NODE_MAJOR/MIN_NODE_MINOR/MIN_NODE_PATCH.
    // Requiring them made the Bun-bootstrapping installer fail its own policy.
    const failures = failuresFor({ "scripts/install.sh": `BUN_VERSION="${BUN_FLOOR}"\n` });
    assert.deepEqual(failures, []);
  });

  it("fails when the installer pins a different Bun than the runtime floor", () => {
    const failures = failuresFor({ "scripts/install.sh": 'BUN_VERSION="1.3.0"\n' });
    assert.equal(failures.length, 1);
    assert.match(failures[0], /scripts\/install\.sh: missing the Bun version the installer bootstraps fragment/);
  });

  it("fails when the declared Bun floor is unparseable", () => {
    const failures = failuresFor({ [BUN_FLOOR_SOURCE]: "export const MINIMUM_BUN_VERSION = 144;\n" });
    assert.ok(failures.some((failure) => failure.includes("missing a parseable MINIMUM_BUN_VERSION")));
  });

  it("fails when the workspace packageManager does not pin the Bun floor", () => {
    const failures = failuresFor({
      "package.json": JSON.stringify({ name: "fixture", engines: { node: ">=24.11.0" }, packageManager: "bun@1.2.0" }),
    });
    assert.ok(failures.some((failure) => failure.includes(`packageManager must be bun@${BUN_FLOOR}`)));
  });

  it("fails when CI runs a Bun other than the shipped floor", () => {
    const failures = failuresFor({
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.2.0\n",
    });
    assert.ok(failures.some((failure) => failure.includes(`bun-version must be ${BUN_FLOOR}, found 1.2.0`)));
  });

  it("still enforces the Node.js floor for external provider SDK consumers", () => {
    const failures = failuresFor({
      "cli/package.json": JSON.stringify({ name: "cli", engines: { node: ">=22.0.0" }, devDependencies: { "@types/node": "^22.0.0" } }),
    });
    assert.ok(failures.some((failure) => failure.includes("cli/package.json: engines.node must be >=24.11.0")));
    assert.ok(failures.some((failure) => failure.includes("cli/package.json: devDependencies.@types/node must be ^24.0.0")));
  });

  it("keeps the sandbox provider Node.js install pinned to the provider floor", () => {
    const failures = failuresFor({
      "packages/adapter-utils/src/sandbox-install-command.ts": 'const NODE_VERSION="v22.0.0";\n',
    });
    assert.ok(failures.some((failure) => failure.includes("packages/adapter-utils/src/sandbox-install-command.ts")));
  });

  it("fails when a first-party entrypoint still imports the retired Node.js guard", () => {
    const failures = failuresFor({
      "cli/src/index.ts": 'import { warnIfUnsupportedNodeVersion } from "@paperclipai/shared/node-version";\n',
    });
    assert.ok(failures.some((failure) => failure.includes("cli/src/index.ts: must import the Bun runtime guard")));
    assert.ok(failures.some((failure) => failure.includes("cli/src/index.ts: must not import the retired Node.js runtime guard")));
  });

  it("fails when the server entrypoint drops the Bun runtime guard", () => {
    const failures = failuresFor({ "server/src/index.ts": "export const app = {};\n" });
    assert.deepEqual(failures, ['server/src/index.ts: must import the Bun runtime guard "@paperclipai/shared/bun-version"']);
  });

  it("ignores ignored scratch trees that are not part of the repository", () => {
    const root = policyFixture({ ".gitignore": ".tmp-scan/\n" });
    write(root, ".tmp-scan/stage/package.json", JSON.stringify({ name: "scratch" }));
    assert.deepEqual(collectVersionPolicyFailures(root), []);
  });
});
