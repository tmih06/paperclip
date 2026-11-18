import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bun-workspace-links-"));
  for (const directory of ["scripts", "packages/shared", "server/node_modules", "ui", "cli", "node_modules/@paperclipai"])
    mkdirSync(path.join(root, directory), { recursive: true });
  for (const [directory, name] of [["packages/shared", "@paperclipai/shared"], ["server", "@paperclipai/server"], ["ui", "@paperclipai/ui"], ["cli", "paperclipai"]])
    writeFileSync(path.join(root, directory, "package.json"), JSON.stringify({ name, dependencies: directory === "server" ? { "@paperclipai/shared": "workspace:*" } : {} }));
  copyFileSync(new URL("./ensure-workspace-package-links.ts", import.meta.url), path.join(root, "scripts/ensure-workspace-package-links.ts"));
  writeFileSync(path.join(root, "scripts/dev-service-profile.ts"), `export const repoRoot = ${JSON.stringify(root)};`);
  const target = path.join(root, "packages/shared");
  const hoisted = path.join(root, "node_modules/@paperclipai/shared");
  const local = path.join(root, "server/node_modules/@paperclipai/shared");
  const run = () => spawnSync(process.execPath, ["scripts/ensure-workspace-package-links.ts"], { cwd: root, encoding: "utf8" });
  return { root, target, hoisted, local, run };
}

for (const mode of ["valid hoisted", "stale local", "stale hoisted", "absolute local", "absolute hoisted"]) {
  test(`workspace preflight preserves Bun ownership: ${mode}`, () => {
    const f = fixture();
    try {
      const foreign = path.join(f.root, "foreign"); mkdirSync(foreign);
      const hoistedTarget = mode === "stale hoisted" ? foreign : mode === "absolute hoisted" ? f.target : path.relative(path.dirname(f.hoisted), f.target);
      symlinkSync(hoistedTarget, f.hoisted, "dir");
      if (mode.endsWith("local")) {
        mkdirSync(path.dirname(f.local), { recursive: true });
        symlinkSync(mode === "stale local" ? foreign : f.target, f.local, "dir");
      }
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      if (mode === "valid hoisted") {
        assert.equal(existsSync(f.local), false, "A valid hoisted install must not acquire isolated-layout shadow links");
        assert.doesNotMatch(result.stdout, /relinking/);
      } else {
        const repaired = mode.endsWith("local") ? f.local : f.hoisted;
        assert.equal(realpathSync(repaired), realpathSync(f.target));
        assert.equal(lstatSync(repaired).isSymbolicLink(), true);
        assert.equal(path.isAbsolute(readlinkSync(repaired)), false, "Links must survive a Docker bind mount at another path");
        assert.equal(existsSync(foreign), true);
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("workspace repair never follows a scope directory into another checkout", () => {
  const f = fixture();
  const foreign = mkdtempSync(path.join(tmpdir(), "bun-workspace-foreign-"));
  try {
    mkdirSync(path.join(foreign, "shared"));
    const marker = path.join(foreign, "shared", "keep"); writeFileSync(marker, "user data");
    mkdirSync(path.dirname(f.local), { recursive: true });
    rmSync(path.dirname(f.local), { recursive: true });
    symlinkSync(foreign, path.dirname(f.local), "dir");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside.*checkout/);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});
