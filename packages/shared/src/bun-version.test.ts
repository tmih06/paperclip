import { describe, expect, it } from "vitest";
import {
  BUN_VERSION_INSTALL_GUIDE_URL,
  MINIMUM_BUN_VERSION,
  detectBunVersion,
  formatBunVersionWarning,
  isSupportedBunVersion,
  warnIfUnsupportedBunVersion,
} from "./bun-version.js";

const WARNING_EMITTED = Symbol.for("@paperclipai/bun-version-warning-emitted");

function resetWarningState(): void {
  delete (globalThis as unknown as Record<symbol, boolean | undefined>)[WARNING_EMITTED];
}

describe("isSupportedBunVersion", () => {
  it("accepts the pinned Bun floor and newer releases", () => {
    expect(MINIMUM_BUN_VERSION).toBe("1.4.4");
    expect(isSupportedBunVersion("1.4.4")).toBe(true);
    expect(isSupportedBunVersion("v1.4.4")).toBe(true);
    expect(isSupportedBunVersion("1.4.5")).toBe(true);
    expect(isSupportedBunVersion("1.10.0")).toBe(true);
    expect(isSupportedBunVersion("2.0.0")).toBe(true);
  });

  it("rejects older Bun releases", () => {
    expect(isSupportedBunVersion("1.4.3")).toBe(false);
    expect(isSupportedBunVersion("1.3.99")).toBe(false);
    expect(isSupportedBunVersion("0.8.1")).toBe(false);
  });

  it("rejects versions it cannot parse", () => {
    expect(isSupportedBunVersion("")).toBe(false);
    expect(isSupportedBunVersion("unknown")).toBe(false);
  });
});

describe("detectBunVersion", () => {
  it("reads the Bun runtime version, not the advertised Node.js compatibility version", () => {
    expect(detectBunVersion({ bun: "1.4.4", node: "26.3.0" })).toBe("1.4.4");
    expect(detectBunVersion({ node: "24.11.0" })).toBeNull();
    expect(detectBunVersion({ bun: "  ", node: "24.11.0" })).toBeNull();
    expect(detectBunVersion({})).toBeNull();
  });

  it("detects the Bun that is actually running the test process", () => {
    expect(process.versions.bun, "shared tests must run on Bun").toBeTruthy();
    expect(detectBunVersion()).toBe(process.versions.bun);
    expect(isSupportedBunVersion(detectBunVersion() ?? "")).toBe(true);
  });
});

describe("formatBunVersionWarning", () => {
  const context = { execPath: "/home/dev/.bun/bin/bun", nodeCompatVersion: "26.3.0" };

  it("stays silent on a supported Bun", () => {
    expect(formatBunVersionWarning({ ...context, bunVersion: "1.4.4" })).toBeNull();
  });

  it("names the running Bun and the Bun floor when Bun is too old", () => {
    const warning = formatBunVersionWarning({ ...context, bunVersion: "1.3.0" });
    expect(warning).toContain("Bun 1.3.0 is unsupported");
    expect(warning).toContain(`requires Bun ${MINIMUM_BUN_VERSION} or newer`);
    expect(warning).toContain("Running executable: /home/dev/.bun/bin/bun");
    expect(warning).toContain(BUN_VERSION_INSTALL_GUIDE_URL);
    expect(warning).toContain("Restart Paperclip after upgrading Bun");
    expect(warning).toContain("startup executable and PATH");
  });

  it("points at the advertised Node.js compatibility version without trusting it", () => {
    const warning = formatBunVersionWarning({ ...context, bunVersion: "1.3.0" });
    expect(warning).toContain("Node.js compatibility version 26.3.0");
    expect(warning).toContain("not the Paperclip runtime floor");
    // A Node.js version above the retired Node floor must not suppress the Bun warning.
    expect(formatBunVersionWarning({ ...context, bunVersion: "1.3.0" })).not.toBeNull();
    expect(formatBunVersionWarning({ ...context, bunVersion: "1.0.0" })).not.toBeNull();
  });

  it("explains that a process without Bun is not a supported runtime", () => {
    const warning = formatBunVersionWarning({ ...context, bunVersion: null });
    expect(warning).toContain("Paperclip is not running on Bun");
    expect(warning).toContain(`requires Bun ${MINIMUM_BUN_VERSION} or newer`);
    expect(warning).toContain("Node.js compatibility version 26.3.0");
    expect(warning).toContain(BUN_VERSION_INSTALL_GUIDE_URL);
  });

  it("reports an unknown runtime version instead of inventing one", () => {
    const warning = formatBunVersionWarning({
      bunVersion: null,
      execPath: "/usr/bin/node",
      nodeCompatVersion: null,
    });
    expect(warning).toContain("Node.js compatibility version unknown");
  });
});

describe("warnIfUnsupportedBunVersion", () => {
  it("emits at most one warning when CLI and server boot in the same process", () => {
    resetWarningState();
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    expect(warnIfUnsupportedBunVersion(warn, { bunVersion: "1.3.0" })).toBe(true);
    expect(warnIfUnsupportedBunVersion(warn, { bunVersion: "1.3.0" })).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Bun 1.3.0 is unsupported");
    resetWarningState();
  });

  it("does not consume the one warning slot for a supported runtime", () => {
    resetWarningState();
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    expect(warnIfUnsupportedBunVersion(warn, { bunVersion: "1.4.4" })).toBe(false);
    expect(warnIfUnsupportedBunVersion(warn, { bunVersion: null })).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Paperclip is not running on Bun");
    resetWarningState();
  });
});
