// The general server test job has no Rust binary. This check builds and stages
// its own binary, then requires the complete runnerd → PRP → authority → HTTP test.
//
// Every step is a Bun command under Bun's own runtime. `bun x --bun --no-install`
// replaces `pnpm exec`: `--bun` runs the installed vitest entry on Bun instead of
// the Node shebang it declares, and `--no-install` fails rather than fetching a
// bin the workspace install does not have.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bun = process.platform === "win32" ? "bun.exe" : "bun";

// A bare `bun` on Windows is bun.exe, which needs the shell to resolve.
const needsShell = process.platform === "win32";

function run(args, cwd, env = process.env) {
  const result = spawnSync(bun, args, { cwd, env, stdio: "inherit", shell: needsShell });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["run", "--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"], fileURLToPath(new URL("../../../", import.meta.url)));
run(["run", "build:binary"], fileURLToPath(new URL("../", import.meta.url)));
run([
  "x", "--bun", "--no-install", "vitest", "run",
  "server/src/services/native-runtime/runner-api.test.ts",
  "server/src/services/native-runtime/runner-api-rollout.test.ts",
  "server/src/services/native-runtime/runner-api.integration.test.ts",
], fileURLToPath(new URL("../../../", import.meta.url)), {
  ...process.env, PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION: "1",
});
