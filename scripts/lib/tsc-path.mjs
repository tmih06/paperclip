// Resolves the repository's TypeScript compiler from a directory.
//
// bunfig.toml installs with the hoisted linker, so a workspace has no
// node_modules of its own and `<cwd>/node_modules/typescript/bin/tsc` does not
// exist. Resolve through the package the same way scripts/run-tsc.mjs does, so
// every script runs the one compiler the root install picked.

import path from "node:path";
import { createRequire } from "node:module";

export function resolveTscPath(cwd) {
  const packageJson = createRequire(path.join(cwd, "package.json")).resolve("typescript/package.json");
  return path.join(path.dirname(packageJson), "bin", "tsc");
}
