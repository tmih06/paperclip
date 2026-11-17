import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MINIMUM_BUN_VERSION } from "@paperclipai/shared/bun-version";
import { cliVersion } from "../version.js";

// The guard has to be proven against a real Bun process: `process.versions.bun`
// is runtime state, so only the executable that actually starts the CLI can show
// that a missing or old Bun warns without demanding a Node.js runtime.
const cliEntrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-bun-runtime-"));

function resolveBunBinary(): string | null {
  if (process.versions.bun) return process.execPath;
  try {
    return execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const bunBinary = resolveBunBinary();

function runCli(versionsPatch: string | null): { status: number | null; output: string } {
  const args = [cliEntrypoint, "--version"];
  if (versionsPatch) {
    const preloadFile = path.join(fixtureRoot, "versions-patch.ts");
    fs.writeFileSync(preloadFile, versionsPatch);
    args.unshift("--preload", preloadFile);
  }
  const result = spawnSync(bunBinary!, args, { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe.runIf(bunBinary !== null)("CLI startup runtime guard", () => {
  it("starts quietly on a supported Bun", () => {
    const { status, output } = runCli(null);
    expect(status).toBe(0);
    expect(output).toContain(cliVersion);
    expect(output).not.toContain("[paperclip] warning:");
  });

  it("warns about an old Bun, naming Bun rather than the advertised Node.js version", () => {
    const { status, output } = runCli('(process.versions as Record<string, string>).bun = "1.0.0";');
    expect(status).toBe(0);
    expect(output).toContain("[paperclip] warning: Bun 1.0.0 is unsupported");
    expect(output).toContain(`Paperclip requires Bun ${MINIMUM_BUN_VERSION} or newer`);
    expect(output).toContain("not the Paperclip runtime floor");
    expect(output).toContain(cliVersion);
    // Bun's advertised Node.js compatibility version must never be the headline.
    expect(output).not.toContain("Node.js v");
  });

  it("warns when the process is not Bun at all instead of demanding Node.js", () => {
    const { status, output } = runCli("delete (process.versions as Record<string, string | undefined>).bun;");
    expect(status).toBe(0);
    expect(output).toContain("[paperclip] warning: Paperclip is not running on Bun");
    expect(output).toContain(`Paperclip requires Bun ${MINIMUM_BUN_VERSION} or newer`);
    expect(output).toContain(cliVersion);
  });

  it("warns exactly once per process", () => {
    const { output } = runCli('(process.versions as Record<string, string>).bun = "1.0.0";');
    expect(output.split("[paperclip] warning:").length - 1).toBe(1);
  });
});
