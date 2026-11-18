import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The release publishes with npm, whose manifest handling differs from the
// pnpm publisher it replaced: npm and Bun both send the package.json they are
// given verbatim, while pnpm applied `publishConfig` entrypoint overrides at
// publish time. A package whose development entrypoints point into `src/*.ts`
// would therefore ship a manifest naming files its tarball does not contain.
// These tests drive the real staging helpers in scripts/release-lib.sh and
// capture exactly what npm would submit, against a local registry stand-in.
// Nothing here contacts the network, publishes, pushes, or builds images.

function runStaging(stageCalls) {
  const script = `
set -euo pipefail
REPO_ROOT=${JSON.stringify(repoRoot)}
release_info() { printf '%s\\n' "$@"; }
release_warn() { printf 'Warning: %s\\n' "$*" >&2; }
release_fail() { printf 'Error: %s\\n' "$*" >&2; exit 1; }
source "$REPO_ROOT/scripts/release-lib.sh"
${stageCalls}
`;
  return execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** Start a registry stand-in that records the manifest document on publish. */
async function startCapturingRegistry() {
  const requests = [];
  let captured = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "PUT") {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    published: () => captured,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

function writeFixturePackage(root) {
  const packageDir = join(root, "packages", "fixture-adapter");
  mkdirSync(join(packageDir, "src"), { recursive: true });
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "src", "index.ts"), "export const value: number = 1;\n");
  writeFileSync(join(packageDir, "src", "index.d.ts"), "export declare const value: number;\n");
  writeFileSync(join(packageDir, "dist", "index.js"), "export const value = 1;\n");
  writeFileSync(join(packageDir, "dist", "index.d.ts"), "export declare const value: number;\n");
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({
      name: "@paperclipai/fixture-adapter",
      version: "2026.1116.0",
      type: "module",
      files: ["dist"],
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      dependencies: { "@paperclipai/shared": "workspace:*" },
      publishConfig: {
        access: "public",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      },
    }, null, 2)}\n`,
  );
  return packageDir;
}

test("staging rewrites publishConfig entrypoints so the published manifest resolves to shipped files", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-release-manifest-"));
  const staging = join(root, "staging");
  try {
    const packageDir = writeFixturePackage(root);
    runStaging(
      `stage_publish_package ${JSON.stringify(packageDir)} ${JSON.stringify(staging)} bun`,
    );

    const staged = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
    // The development entrypoints point at TypeScript sources the tarball does
    // not carry; the staged manifest must point at the built dist files.
    assert.equal(staged.main, "./dist/index.js");
    assert.equal(staged.types, "./dist/index.d.ts");
    assert.deepEqual(staged.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    // workspace: ranges cannot resolve from a registry tarball.
    assert.equal(staged.dependencies["@paperclipai/shared"], "2026.1116.0");
    // publishConfig is publish-time metadata, not part of the shipped manifest.
    assert.equal(staged.publishConfig, undefined);
    // Everything the manifest names is present in the staged payload.
    for (const relative of ["dist/index.js", "dist/index.d.ts"]) {
      assert.ok(readFileSync(join(staging, relative), "utf8").length > 0, `${relative} must be staged`);
    }
    assert.equal(staged.files.includes("src"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the npm publish payload carries the materialized manifest, not the development one", async () => {
  const registry = await startCapturingRegistry();
  const root = mkdtempSync(join(tmpdir(), "paperclip-release-publish-"));
  const staging = join(root, "staging");
  const npmrc = join(root, ".npmrc");
  writeFileSync(npmrc, `registry=${registry.url}/\n//127.0.0.1:${new URL(registry.url).port}/:_authToken=fake-token\n`);
  try {
    const packageDir = writeFixturePackage(root);
    runStaging(
      `stage_publish_package ${JSON.stringify(packageDir)} ${JSON.stringify(staging)} bun`,
    );

    // Run the same publish helper release.sh uses, pointed at the local
    // registry stand-in through the npm config the helper inherits.
    await new Promise((resolve, reject) => {
      const child = spawn(
        "bash",
        ["-c", `
set -euo pipefail
REPO_ROOT=${JSON.stringify(repoRoot)}
release_info() { printf '%s\\n' "$@"; }
release_warn() { printf 'Warning: %s\\n' "$*" >&2; }
release_fail() { printf 'Error: %s\\n' "$*" >&2; exit 1; }
source "$REPO_ROOT/scripts/release-lib.sh"
cd ${JSON.stringify(staging)}
publish_package_to_npm canary @paperclipai/fixture-adapter 2026.1116.0
`],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            NPM_CONFIG_USERCONFIG: npmrc,
            // Keep the bundled npm out of the shared cache lock path.
            BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`publish exited ${code}`))));
    });

    const published = registry.published();
    assert.ok(published, `expected a publish PUT; saw ${registry.requests.join(", ")}`);
    const manifest = published.versions["2026.1116.0"];
    assert.equal(manifest.main, "./dist/index.js", "the published manifest must name the shipped entrypoint");
    assert.equal(manifest.types, "./dist/index.d.ts");
    assert.deepEqual(manifest.exports, {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    assert.equal(manifest.publishConfig, undefined);

    // The tarball the registry received must actually contain those files.
    const attachment = Object.values(published._attachments)[0];
    const archive = join(root, "published.tgz");
    writeFileSync(archive, Buffer.from(attachment.data, "base64"));
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    for (const entry of ["package/dist/index.js", "package/dist/index.d.ts", "package/package.json"]) {
      assert.match(listing, new RegExp(`^${entry}$`, "m"));
    }
    assert.doesNotMatch(listing, /^package\/src\//m);
  } finally {
    await registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging refuses to publish when the package cannot be packed", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-release-broken-"));
  const packageDir = join(root, "broken");
  mkdirSync(packageDir, { recursive: true });
  try {
    // No package.json means the package cannot pack, so staging must fail
    // rather than hand npm an empty directory to publish.
    assert.throws(
      () => runStaging(`stage_publish_package ${JSON.stringify(packageDir)} ${JSON.stringify(join(root, "staging"))} bun`),
      /failed to pack/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
