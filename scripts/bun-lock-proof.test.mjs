import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bunLockProof } from "./bun-lock-proof.mjs";

const script = fileURLToPath(new URL("./bun-lock-proof.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "bun-lock-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ patchedDependencies: { "fixture@1.0.0": "fixture.patch" } }));
  writeFileSync(path.join(root, "fixture.patch"), "reviewed patch");
  writeFileSync(path.join(root, "bun.lock"), "reviewed lock");
  const run = mode => spawnSync(process.execPath, [script, mode], { cwd: root, encoding: "utf8" });
  assert.equal(run("write").status, 0);
  return { root, run };
}

test("source-bound lock proof accepts unchanged bytes", t => {
  const { run } = fixture(t);
  assert.equal(run("check").status, 0);
});
for (const file of ["fixture.patch", "bun.lock"]) {
  test(`source-bound lock proof rejects changed ${file}`, t => {
    const { root, run } = fixture(t);
    writeFileSync(path.join(root, file), "unreviewed bytes");
    const checked = run("check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /differs from the publisher's source-bound proof/);
  });
}

test("patch declarations cannot resolve outside the checkout or through symlinks", t => {
  const { root } = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), "bun-lock-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "secret"), "outside");
  symlinkSync(path.join(outside, "secret"), path.join(root, "linked.patch"));
  for (const relative of ["linked.patch", path.relative(root, path.join(outside, "secret")), path.join(outside, "secret")]) {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ patchedDependencies: { "fixture@1.0.0": relative } }));
    assert.throws(() => bunLockProof(root), /Invalid patch path|regular file inside/);
  }
});
