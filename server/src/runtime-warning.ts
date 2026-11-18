import { warnIfUnsupportedBunVersion, type BunVersionContext } from "@paperclipai/shared/bun-version";
import { logger } from "./middleware/logger.js";

/**
 * Non-blocking server startup warning for the runtime Paperclip executes on.
 *
 * Paperclip runs on Bun. `process.versions.node` only reports the Node.js API
 * level Bun implements, so the guard is scoped to the Bun version and stays
 * silent on a supported one. The shared helper keeps this to one log line per
 * process even when the CLI boots a server in the same process.
 */
export function warnIfUnsupportedBunRuntime(context: BunVersionContext = {}): boolean {
  return warnIfUnsupportedBunVersion((message) => logger.warn(message), context);
}
