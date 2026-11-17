export const MINIMUM_BUN_VERSION = "1.4.4";
export const BUN_VERSION_INSTALL_GUIDE_URL =
  "https://github.com/paperclipai/paperclip/blob/master/doc/INSTALLING.md#recommended-install";
const BUN_VERSION_WARNING_EMITTED = Symbol.for("@paperclipai/bun-version-warning-emitted");

export interface BunVersionContext {
  /** Bun version to judge. Defaults to the Bun running this process, if any. */
  bunVersion?: string | null;
  /** Executable that actually runs Paperclip. Defaults to `process.execPath`. */
  execPath?: string;
  /** Node.js compatibility version the runtime advertises. Defaults to `process.versions.node`. */
  nodeCompatVersion?: string | null;
}

type RuntimeVersions = { bun?: string | undefined; node?: string | undefined };

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed ? trimmed : null;
}

export function isSupportedBunVersion(version: string): boolean {
  const current = parseVersion(version);
  const minimum = parseVersion(MINIMUM_BUN_VERSION);
  if (!current || !minimum) return false;

  for (let index = 0; index < current.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

/**
 * The Bun version actually running this process, or null when it is not Bun.
 *
 * Bun implements a Node.js API level and advertises it in `process.versions.node`,
 * so that field can never answer "which Bun is this?". `process.versions.bun` is
 * the only truthful source for the runtime Paperclip executes on.
 */
export function detectBunVersion(versions: RuntimeVersions = process.versions): string | null {
  return normalizeVersion(versions.bun);
}

export function formatBunVersionWarning(context: BunVersionContext = {}): string | null {
  const current = normalizeVersion(context.bunVersion === undefined ? detectBunVersion() : context.bunVersion);
  if (current && isSupportedBunVersion(current)) return null;

  const execPath = context.execPath ?? process.execPath;
  const reportedNode =
    normalizeVersion(context.nodeCompatVersion === undefined ? process.versions.node : context.nodeCompatVersion) ??
    "unknown";

  return [
    current
      ? `[paperclip] warning: Bun ${current} is unsupported. Paperclip requires Bun ${MINIMUM_BUN_VERSION} or newer.`
      : `[paperclip] warning: Paperclip is not running on Bun. Paperclip requires Bun ${MINIMUM_BUN_VERSION} or newer.`,
    `Running executable: ${execPath}`,
    `This runtime reports Node.js compatibility version ${reportedNode} in process.versions.node; that is the Node.js API level the runtime implements, not the Paperclip runtime floor.`,
    current
      ? "Upgrade Bun with `bun upgrade`, or follow the recommended downloaded install.sh workflow:"
      : "Install Bun, or follow the recommended downloaded install.sh workflow:",
    `  ${BUN_VERSION_INSTALL_GUIDE_URL}`,
    current ? "Restart Paperclip after upgrading Bun." : "Restart Paperclip after installing Bun.",
    "For a background service, update its startup executable and PATH; changing Bun in your shell does not change the service runtime.",
  ].join("\n");
}

/**
 * Warns at most once per process: the CLI and the server can both boot inside
 * one process, and a service log should not repeat the same remediation.
 */
export function warnIfUnsupportedBunVersion(warn: (message: string) => void, context: BunVersionContext = {}): boolean {
  const warning = formatBunVersionWarning(context);
  if (!warning) return false;

  const warningState = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (warningState[BUN_VERSION_WARNING_EMITTED]) return false;

  warningState[BUN_VERSION_WARNING_EMITTED] = true;
  warn(warning);
  return true;
}
