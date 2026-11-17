import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-bun-migration.mjs", import.meta.url));
for (const [name, file, source, status] of [
  ["remote shell eval requires Bun", "server/probe.ts", "const command = `node -e 'console.log(process.argv[1])' value`;", 1],
  ["bunx must force the runtime", "scripts/tool.mjs", 'const command = "bun x --no-install vitest run";', 1],
  ["bunx accepts an explicit runtime", "scripts/tool.mjs", 'const command = "bun x --bun --no-install vitest run";', 0],
  ["remote shell eval accepts Bun", "server/probe.ts", "const command = `bun -e 'console.log(process.argv[1])' value`;", 0],
  ["external Node version probe remains allowed", "packages/adapter-utils/src/sandbox-install-command.ts", 'const probe = "node -e \'const v=process.versions.node.split(\".\")\'";', 0],
  ["external exception does not hide other commands", "packages/adapter-utils/src/sandbox-install-command.ts", 'const command = "node -e \'runFirstParty()\'";', 1],
  ["registry lifecycle sentinel retains Node", "scripts/verify-grok-npm-install.mjs", 'const scripts = {postinstall: \'node -e "writeFileSync(\\\'lifecycle-ran\\\', \\\'ok\\\')"\'};', 0],
]) {
  test(name, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bun-launcher-audit-"));
    try {
      const git = args => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git(["init", "--quiet"]);
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
      git(["add", "--", file]);
      const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, status, result.stdout + result.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
