import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-js-syntax.mjs", import.meta.url));
test("syntax checks never execute module code and reject invalid files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-syntax-"));
  try {
    const valid = path.join(root, "valid.mjs");
    const invalid = path.join(root, "invalid.mjs");
    const marker = path.join(root, "executed");
    writeFileSync(valid, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`);
    writeFileSync(invalid, "export const = ;");
    const success = spawnSync(process.execPath, [checker, valid], { encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(existsSync(marker), false);
    const failure = spawnSync(process.execPath, [checker, valid, invalid], { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /invalid\.mjs/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
