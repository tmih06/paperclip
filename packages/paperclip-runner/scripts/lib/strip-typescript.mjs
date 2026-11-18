// Stripping TypeScript without depending on the host runtime.
//
// `node:module`'s `stripTypeScriptTypes` is the only stripper whose bytes the Pi
// closure pins: it erases annotations and emits the source otherwise verbatim.
// Bun has no equivalent export, and Bun's own transpiler rewrites the module
// (different output for the same input), so it cannot stand in where the pinned
// `helperSha256` and the patched wrapper are compared byte for byte.
//
// Stripping therefore always runs on a real Node executable — for the Pi
// closure that is the verified pinned Node, which also keeps the result stable
// on a host whose own Node is a different patch release.
export const STRIP_TYPESCRIPT_SCRIPT =
  'import {readFileSync} from "node:fs"; import {stripTypeScriptTypes} from "node:module"; process.stdout.write(stripTypeScriptTypes(readFileSync(process.argv[1],"utf8")));';

/** Arguments that strip one TypeScript file and write the result to stdout. */
export function stripTypeScriptTypesArguments(path) {
  return ["--input-type=module", "-e", STRIP_TYPESCRIPT_SCRIPT, path];
}
