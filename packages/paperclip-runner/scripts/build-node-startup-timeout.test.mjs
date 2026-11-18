import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNodeStartupTimeout } from "./build-node-startup-timeout.mjs";

test("cold Rosetta Node startup has a bounded build-only allowance", () => {
  assert.equal(buildNodeStartupTimeout("darwin", "x64"), 30_000);
  for (const [platform, architecture] of [["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.equal(buildNodeStartupTimeout(platform, architecture), 10_000);
  }
  assert.equal(buildNodeStartupTimeout(), buildNodeStartupTimeout(process.platform, process.arch));
});

// The probes below launch a Node executable for the first time in a build, so
// they take the cold-start allowance. Every other subprocess keeps its own
// deliberate deadline: the allowance must not become a blanket timeout.
test("both pack and private Pi Node probes use the allowance without changing other operation deadlines", () => {
  // The pack's interpreter probes live in the interpreter module: the
  // PATH-lookup probe and the post-relocation probe, each of which launches a
  // freshly copied executable.
  const interpreters = readFileSync(new URL("./provider-pack-interpreters.mjs", import.meta.url), "utf8");
  const packProbe = /probeExecutable[\s\S]*?timeout: buildNodeStartupTimeout\(\)/;
  assert.match(interpreters, packProbe, "the pack interpreter probe must use the allowance");
  const relocated = /\["-x86_64", destination, "--version"\][\s\S]*?timeout: buildNodeStartupTimeout\(\)/;
  assert.match(interpreters, relocated, "the relocated pack probe must use the allowance");
  // No probe may run without a deadline at all.
  for (const call of interpreters.match(/spawnSync\([\s\S]*?\}\)/g) ?? []) {
    assert.match(call, /timeout:/, "every interpreter subprocess must be bounded");
  }

  // The Pi closure probes launch the verified pinned Node the same way.
  const pi = readFileSync(new URL("./materialize-pi-distribution.mjs", import.meta.url), "utf8");
  const piProbes = [
    ['runOwned(node, ["--version"]', "the pinned Node version probe"],
    ['runOwned(node, ["-p", "process.versions.undici"]', "the pinned Undici probe"],
    ['runOwned(copiedNode, ["--version"]', "the relocated Pi Node probe"],
  ];
  for (const [needle, label] of piProbes) {
    const line = pi.split("\n").find(line => line.includes(needle));
    assert.ok(line, `${label} must exist`);
    assert.match(line, /timeout: buildNodeStartupTimeout\(\)/, `${label} must use the allowance`);
  }
  // The TypeScript strip is a pinned-Node subprocess too, and it must be bounded.
  const strip = pi.split("\n").find(line => line.includes("stripTypeScriptTypesArguments("));
  assert.ok(strip, "the pinned TypeScript strip must call the shared helper");
  assert.match(pi, /stripTypeScriptTypesArguments\(path\),\s*\{ env: \{\}, timeout: buildNodeStartupTimeout\(\)/, "the strip must use the allowance");

  // Non-probe subprocesses keep their own deadlines rather than inheriting it.
  assert.match(pi, /runOwned\("git", \["apply", "--check", inputSecurityPatchPath\], \{[^}]*timeout: 10_000/);
  assert.match(pi, /runOwned\("git", \["apply", inputSecurityPatchPath\], \{[^}]*timeout: 10_000/);
  assert.match(pi, /runOwned\("\/usr\/bin\/otool", \["-L", copiedNode\], \{ env: \{\}, timeout: 10_000/);
  assert.match(pi, /runOwned\("ldd", \[copiedNode\], \{ env: \{ PATH: "\/usr\/bin:\/bin" \}, timeout: 10_000/);
  assert.match(pi, /piDistributionInstallCommand\(\)\], \{[^}]*timeout: 300_000/);
  // No Pi subprocess may be unbounded either.
  for (const call of pi.match(/runOwned\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
    if (call.includes("checkCancelled")) continue;
    assert.match(call, /timeout:/, `unbounded subprocess: ${call.slice(0, 80)}`);
  }
});
