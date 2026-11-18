import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function bunLockProof(root) {
  root = realpathSync(root);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const patches = Object.entries(manifest.patchedDependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([dependency, relative]) => {
      if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("Invalid patch path");
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || realpathSync(file) !== file || !lstatSync(file).isFile()) {
        throw new Error("Patch must be a regular file inside the checkout");
      }
      return { dependency, path: relative, sha256: sha256(readFileSync(file)) };
    });
  return { schema: "paperclip.bun-lock-proof.v1", lockSha256: sha256(readFileSync(path.join(root, "bun.lock"))), patches };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, receipt = "bun.lock.proof.json"] = process.argv.slice(2);
  if (mode !== "write" && mode !== "check") throw new Error("Usage: bun scripts/bun-lock-proof.mjs <write|check> [receipt]");
  const proof = bunLockProof(process.cwd());
  if (mode === "write") writeFileSync(receipt, JSON.stringify(proof, null, 2) + "\n");
  else if (JSON.stringify(JSON.parse(readFileSync(receipt, "utf8"))) !== JSON.stringify(proof)) {
    throw new Error("Bun lockfile or patch content differs from the publisher's source-bound proof");
  }
}
