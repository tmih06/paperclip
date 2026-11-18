import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { STRIP_TYPESCRIPT_SCRIPT, stripTypeScriptTypesArguments } from "./lib/strip-typescript.mjs";

const run = promisify(execFile);
const packageRoot = new URL("..", import.meta.url);
const helperSource = new URL("../src/drivers/acpx/pi-acp-runtime.ts", import.meta.url);
// Node's own stripper is what the Pi closure pins; Bun has no equivalent export,
// so this suite runs the strip on a real Node and skips where none is installed.
// Bun may answer to the name `node`, so admit only a runtime that lacks Bun's
// version marker and actually exports the stripper.
const realNode = await (async () => {
  const { execFileSync } = await import("node:child_process");
  const probe = (candidate, args) => {
    try { return execFileSync(candidate, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  };
  const candidates = process.versions.bun === undefined
    ? [process.execPath]
    : ["node", "/usr/local/bin/node", "/usr/bin/node", "/opt/node/bin/node"];
  for (const candidate of candidates) {
    const version = probe(candidate, ["--version"])?.trim() ?? "";
    if (!/^v\d+\.\d+\.\d+$/.test(version)) continue;
    // Bun also prints a version and even exits 0 for `-e`, but it has no
    // stripTypeScriptTypes export; require the runtime to expose the real one
    // through the same ESM import the strip script uses.
    if (probe(candidate, ["--input-type=module", "-e", 'await import("node:module").then((m)=>process.stdout.write(typeof m.stripTypeScriptTypes));'])?.trim() !== "function") continue;
    // Resolve to an absolute path: a bare name would be looked up again from
    // PATH by every later spawn, which can reach a different Node entirely.
    try {
      return execFileSync("sh", ["-c", `command -v -- ${JSON.stringify(candidate)}`], { encoding: "utf8" }).trim() || candidate;
    } catch { return candidate; }
  }
  return null;
})();

test("the strip script is the pinned Node stripper and takes one path", () => {
  assert.match(STRIP_TYPESCRIPT_SCRIPT, /from "node:module"/);
  assert.match(STRIP_TYPESCRIPT_SCRIPT, /stripTypeScriptTypes/);
  // It writes the stripped source to stdout so the caller owns the destination.
  assert.match(STRIP_TYPESCRIPT_SCRIPT, /process\.stdout\.write/);
  const args = stripTypeScriptTypesArguments("/abs/source.ts");
  assert.deepEqual(args.slice(0, 2), ["--input-type=module", "-e"]);
  assert.equal(args[2], STRIP_TYPESCRIPT_SCRIPT);
  assert.equal(args[3], "/abs/source.ts");
});

test("stripping reproduces the pinned Pi helper bytes exactly", { skip: realNode === null }, async () => {
  // PI_DISTRIBUTION_PINS.helperSha256 is Node's stripped output with trailing
  // whitespace removed. If this drifts the Pi closure no longer matches its
  // qualified source, so the bytes are the contract.
  const { stdout } = await run(realNode, stripTypeScriptTypesArguments(helperSource.pathname), {
    env: {}, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const normalised = stdout.split("\n").map(line => line.trimEnd()).join("\n");
  const digest = createHash("sha256").update(Buffer.from(normalised)).digest("hex");
  const { PI_DISTRIBUTION_PINS } = await import("./materialize-pi-distribution.mjs");
  assert.equal(digest, PI_DISTRIBUTION_PINS.helperSha256);
});

test("the strip removes annotations and keeps the module runnable", { skip: realNode === null }, async () => {
  const root = mkdtempSync(join(tmpdir(), "strip-typescript-"));
  try {
    const source = join(root, "fixture.ts");
    writeFileSync(source, [
      "export interface Shape { readonly size: number }",
      "export const sized = (value: string): number => value.length;",
      "export type Alias = Shape;",
      "",
    ].join("\n"));
    const { stdout } = await run(realNode, stripTypeScriptTypesArguments(source), { env: {}, timeout: 30_000 });
    // The stripper blanks type positions instead of reflowing the source, which
    // is why its bytes are a stable contract: annotations go, runtime syntax and
    // the remaining layout stay exactly where the author put them.
    assert.doesNotMatch(stdout, /interface Shape/);
    assert.doesNotMatch(stdout, /type Alias/);
    assert.doesNotMatch(stdout, /:\s*number\b/);
    assert.doesNotMatch(stdout, /:\s*string\b/);
    assert.match(stdout, /export const sized = \(value\s*\)\s*=> value\.length;/);
    // Every line keeps its original length, so no runtime token moved.
    for (const [index, line] of stdout.split("\n").entries()) {
      const original = readFileSync(source, "utf8").split("\n")[index] ?? "";
      assert.equal(line.length, original.length, `line ${index + 1} changed width`);
    }
    const stripped = join(root, "fixture.mjs");
    writeFileSync(stripped, stdout);
    const module = await import(`${stripped}?${Date.now()}`);
    assert.equal(module.sized("abcd"), 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stripping fails closed for a missing file instead of emitting nothing", { skip: realNode === null }, async () => {
  await assert.rejects(
    run(realNode, stripTypeScriptTypesArguments(join(packageRoot.pathname, "absent-source.ts")), { env: {}, timeout: 30_000 }),
    (error) => error.code === 1 || /ENOENT|Cannot find|no such file/i.test(String(error.stderr)),
  );
});

test("the Pi materializer never imports node:module's stripper directly", () => {
  // The direct import fails at load time on Bun, which is the whole reason the
  // strip runs as a subprocess. Keep the module importable by every runtime.
  const materializer = readFileSync(new URL("./materialize-pi-distribution.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(materializer, /import \{[^}]*stripTypeScriptTypes[^}]*\} from "node:module"/);
  assert.match(materializer, /from "\.\/lib\/strip-typescript\.mjs"/);
  // Exactly one strip path, taken for both the helper and the extension.
  assert.equal(materializer.match(/stripTypeScriptTypesArguments\(/g)?.length, 1);
  assert.equal(materializer.match(/await stripPinnedSource\(/g)?.length, 2);
});
