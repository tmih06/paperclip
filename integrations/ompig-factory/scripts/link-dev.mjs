// Explicit checkout-only setup. Never install this as a published package lifecycle hook.
import { mkdirSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkSdkInto } from "../../../scripts/link-plugin-dev-sdk.mjs";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(packageDir, "../..");
linkSdkInto(packageDir);
const scope = path.join(packageDir, "node_modules", "@paperclipai");
mkdirSync(scope, { recursive: true });
const destination = path.join(scope, "adapter-utils");
const source = path.join(root, "packages", "adapter-utils");
try {
  lstatSync(destination);
  if (realpathSync(destination) !== realpathSync(source)) {
    throw new Error("Factory development requires the in-checkout adapter-utils; remove the stale local install explicitly before linking.");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  symlinkSync(path.relative(scope, source), destination, "dir");
}
