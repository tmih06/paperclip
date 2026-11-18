import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Bun profiling resolves built workspace roots and subpaths instead of source exports", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paperclip-profile-alias-"));
  try {
    const register = path.join(root, "server/scripts/profile-tool-projection/register.mjs");
    mkdirSync(path.dirname(register), { recursive: true });
    copyFileSync(new URL("./profile-tool-projection/register.mjs", import.meta.url), register);
    mkdirSync(path.join(root, "node_modules/@paperclipai"), { recursive: true });
    for (const name of ["db", "shared"]) {
      const directory = path.join(root, "packages", name);
      mkdirSync(path.join(directory, "src"), { recursive: true });
      writeFileSync(path.join(directory, "package.json"), JSON.stringify({
        name: `@paperclipai/${name}`, type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
      }));
      symlinkSync(directory, path.join(root, "node_modules/@paperclipai", name), "dir");
    }
    for (const [dir, file, marker] of [["db", "index", "database"], ["shared", "index", "shared"], ["shared", "constants", "subpath"]]) {
      const dist = path.join(root, "packages", dir, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(root, "packages", dir, "src", `${file}.ts`), 'throw new Error("Source must not execute during built profiling");');
      writeFileSync(path.join(dist, `${file}.js`), `export const marker = ${JSON.stringify(marker)};`);
    }
    const result = spawnSync(process.execPath, ["--preload", register, "--eval", `
      import assert from "node:assert/strict";
      assert.equal((await import("@paperclipai/db")).marker, "database");
      assert.equal((await import("@paperclipai/shared")).marker, "shared");
      assert.equal((await import("@paperclipai/shared/constants")).marker, "subpath");
    `], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
