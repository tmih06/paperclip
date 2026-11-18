import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execute = promisify(execFile);
// Bun runs the TypeScript CLI directly, so the entrypoint is the process under
// test rather than a loader's launcher.
const run = (args: string[]) => execute(process.execPath, args, { timeout: 15_000 });

it("runs the eval CLI parser through both canonical and symlinked paths", async () => {
  const cli = await realpath(fileURLToPath(new URL("./eval-session.ts", import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), "paperclip-eval-cli-entrypoint-"));
  try {
    const alias = join(root, "cli-alias");
    await symlink(dirname(cli), alias, "dir");
    for (const path of [cli, join(alias, "eval-session.ts")]) {
      // A skipped main guard silently exits zero. Rejecting the invalid option
      // proves actual CLI execution without loading credentials or a provider.
      await expect(run([path, "--unknown", "value"]))
        .rejects.toMatchObject({ code: 1, stderr: "unknown argument: --unknown\n" });
    }
    const imported = await run(["--eval", `import(${JSON.stringify(cli)}).then(() => console.log("imported"))`]);
    expect(imported.stdout.trim()).toBe("imported");
    expect(imported.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
