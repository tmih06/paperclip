import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUN_VERSION_INSTALL_GUIDE_URL,
  MINIMUM_BUN_VERSION,
  detectBunVersion,
  formatBunVersionWarning,
  isSupportedBunVersion,
  warnIfUnsupportedBunVersion,
} from "@paperclipai/shared/bun-version";

const WARNING_EMITTED = Symbol.for("@paperclipai/bun-version-warning-emitted");

function resetWarningState(): void {
  delete (globalThis as unknown as Record<symbol, boolean | undefined>)[WARNING_EMITTED];
}

describe("Bun runtime guard", () => {
  it("pins the Bun floor the installer and CI bootstrap", () => {
    expect(MINIMUM_BUN_VERSION).toBe("1.4.4");
    expect(isSupportedBunVersion(MINIMUM_BUN_VERSION)).toBe(true);
    expect(isSupportedBunVersion("1.4.3")).toBe(false);
    expect(isSupportedBunVersion("2.0.0")).toBe(true);
  });

  it("reads the running Bun rather than the advertised Node.js compatibility version", () => {
    expect(detectBunVersion({ bun: "1.4.4", node: "26.3.0" })).toBe("1.4.4");
    expect(detectBunVersion({ node: "26.3.0" })).toBeNull();

    // The test suite itself runs on Bun, so the real process is detectable.
    expect(process.versions.bun, "CLI tests must run on Bun").toBeTruthy();
    expect(isSupportedBunVersion(detectBunVersion() ?? "")).toBe(true);
  });

  it("warns once and names Bun, its executable, and the Bun floor", () => {
    resetWarningState();
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);

    expect(warnIfUnsupportedBunVersion(warn, { bunVersion: "1.3.0" })).toBe(true);
    expect(warnIfUnsupportedBunVersion(warn, { bunVersion: "1.3.0" })).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Bun 1.3.0 is unsupported");
    expect(warnings[0]).toContain(`requires Bun ${MINIMUM_BUN_VERSION} or newer`);
    expect(warnings[0]).toContain("Running executable:");
    expect(warnings[0]).toContain(BUN_VERSION_INSTALL_GUIDE_URL);
    resetWarningState();
  });

  it("warns when no Bun runtime is present at all", () => {
    resetWarningState();
    const warnings: string[] = [];
    expect(warnIfUnsupportedBunVersion((message) => warnings.push(message), { bunVersion: null })).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Paperclip is not running on Bun");
    resetWarningState();
  });

  it("stays silent on a supported Bun", () => {
    expect(formatBunVersionWarning({ bunVersion: MINIMUM_BUN_VERSION })).toBeNull();
    expect(formatBunVersionWarning({ bunVersion: "1.5.0" })).toBeNull();
  });
});

describe("CLI startup guard wiring", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");

  it("guards on Bun in main() and no longer imports the retired Node.js guard", () => {
    expect(source).toContain('from "@paperclipai/shared/bun-version"');
    expect(source).not.toContain("@paperclipai/shared/node-version");
    expect(source).not.toContain("warnIfUnsupportedNodeVersion");
    expect(source).toMatch(/warnIfUnsupportedBunVersion\(\(message\) => console\.warn\(message\)\)/);
    // Bun's advertised Node.js compatibility version must never be the input.
    expect(source).not.toMatch(/warnIfUnsupportedBunVersion\(\s*process\.versions\.node/);
  });
});
