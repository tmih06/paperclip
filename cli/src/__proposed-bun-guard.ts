// Scratch file: verifies the exact guard replacement another worker will apply to
// cli/src/commands/install.ts. Deleted immediately after typechecking.
import { detectBunVersion, isSupportedBunVersion, MINIMUM_BUN_VERSION } from "@paperclipai/shared/bun-version";

export function assertSupportedBunVersion(): void {
  const bunVersion = detectBunVersion();
  if (!bunVersion || !isSupportedBunVersion(bunVersion)) {
    const found = bunVersion
      ? `Bun ${bunVersion}`
      : `no Bun runtime (process.versions.node ${process.versions.node})`;
    throw new Error(`Installing or updating Paperclip requires Bun ${MINIMUM_BUN_VERSION} or newer (found ${found} at ${process.execPath}). Install Bun ${MINIMUM_BUN_VERSION} or newer, or run the downloaded install.sh workflow, then run 'bun x paperclipai@latest install --yes' to re-pin an existing managed install.`);
  }
}
