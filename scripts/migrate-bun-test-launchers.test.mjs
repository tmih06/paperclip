import assert from "node:assert/strict";
import test from "node:test";
import { removeTsxPreloads } from "./migrate-bun-test-launchers.mjs";

for (const [name, source, expected] of [
  ["leading preload", 'spawn(exec, ["--import", require.resolve("tsx"), "x.ts"]);', 'spawn(exec, ["x.ts"]);'],
  ["middle preload", 'spawn(exec, ["a", "--import", "tsx/esm", "b"]);', 'spawn(exec, ["a", "b"]);'],
  ["trailing preload", 'spawn(exec, ["a", "--import", "tsx"]);', 'spawn(exec, ["a"]);'],
  ["only preload", 'spawn(exec, ["--import", fileURLToPath(new URL("node_modules/tsx/dist/loader.mjs", import.meta.url))]);', 'spawn(exec, []);'],
  ["multiple preloads", 'spawn(exec, ["--import", "tsx", "a", "--import", "tsx/esm"]);', 'spawn(exec, ["a"]);'],
  ["unrelated imports", 'spawn(exec, ["--import", "./preload.mjs", "source.tsx"]);', 'spawn(exec, ["--import", "./preload.mjs", "source.tsx"]);'],
  ["CLI shim", 'spawn(exec, [path.join(root, "cli/node_modules/tsx/dist/cli.mjs"), "x.ts"]);', 'spawn(exec, ["x.ts"]);'],
  ["bin shim", 'spawn(exec, [fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)), "x.ts"]);', 'spawn(exec, ["x.ts"]);'],
  ["bound preload", 'const loader=require.resolve("tsx"); spawn(exec, ["--import", loader, "x.ts"]);', ' spawn(exec, ["x.ts"]);'],
  ["mixed declaration", 'const loader=require.resolve("tsx"), worker="worker.ts"; spawn(exec, ["--import", loader, worker]);', 'const worker="worker.ts"; spawn(exec, [worker]);'],
  ["multiple dead bindings", 'const a=require.resolve("tsx"), b=require.resolve("tsx"); spawn(exec, ["--import", a]); spawn(exec, ["--import", b]);', ' spawn(exec, []); spawn(exec, []);'],
  ["live loader reference", 'const loader=require.resolve("tsx"); log(loader); spawn(exec, ["--import", loader, "x.ts"]);', 'const loader=require.resolve("tsx"); log(loader); spawn(exec, ["x.ts"]);'],
  ["shadowed preload", 'const loader=require.resolve("tsx"); function f(loader) { spawn(exec, ["--import", loader, "x.ts"]); }', 'const loader=require.resolve("tsx"); function f(loader) { spawn(exec, ["--import", loader, "x.ts"]); }'],
  ["custom TSX preload", 'spawn(exec, ["--import", "./preload.tsx", "x.ts"]);', 'spawn(exec, ["--import", "./preload.tsx", "x.ts"]);'],
  ["mutable preload", 'let loader=require.resolve("tsx"); spawn(exec, ["--import", loader, "x.ts"]);', 'let loader=require.resolve("tsx"); spawn(exec, ["--import", loader, "x.ts"]);'],
  ["unicode offsets", 'const text="😃"; spawn(exec, ["--import", "tsx", "x.ts"]);', 'const text="😃"; spawn(exec, ["x.ts"]);'],
]) {
  test(`removes obsolete tsx preloads: ${name}`, () => {
    const result = removeTsxPreloads("fixture.mjs", source);
    assert.equal(result, expected);
    assert.equal(removeTsxPreloads("fixture.mjs", result), expected);
  });
}
test("refuses to rewrite invalid source", () => {
  assert.throws(() => removeTsxPreloads("fixture.mjs", "const = ;"), /fixture\.mjs/);
});
