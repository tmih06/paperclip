import { spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { recorder, invocationEnv } from "./record.mjs";
import { parseJunitReport, receiptRecorder, recordReport } from "./node-reporter.mjs";

// Bun's test runner is the `test` subcommand. `--test` is a Node flag that Bun
// does not treat as a runner, so this launcher cannot reuse Node's argv.
const cwd = process.cwd();

// Callers name test files and globs. Bun treats every argument as a path
// filter and does not expand a glob, so expand it here. Resolving to absolute
// paths also keeps a file under a dot directory (`.github/...`) addressable,
// which a repository-relative filter cannot reach.
function testFiles(values) {
  const files = [];
  const unmatched = [];
  for (const value of values) {
    if (!/[*?[\]{}]/.test(value)) {
      const resolved = path.resolve(cwd, value);
      files.push(!value.startsWith("-") && existsSync(resolved) ? resolved : value);
      continue;
    }
    const matches = globSync(value, { cwd }).sort();
    if (!matches.length) unmatched.push(value);
    for (const match of matches) files.push(path.resolve(cwd, match));
  }
  return { files: [...new Set(files)], unmatched };
}

const args = process.argv.slice(2);
const runArgs = ["test"];
// Node's runner has no default test timeout, while `bun test` applies a
// five-second default to `node:test` files regardless of bunfig.toml. Zero
// restores the Node behavior; an explicit per-test timeout still applies.
if (!args.some((value) => /^--(?:test-)?timeout/.test(value))) runArgs.push("--timeout=0");
const selected = testFiles(args);
runArgs.push(...selected.files);
for (const value of selected.unmatched) console.error(`CI node tests: no test file matches ${value}`);
// Without a filter `bun test` runs every test in the repository. A caller that
// named files and resolved none must fail instead of disclosing that fallback.
const nothingSelected = selected.unmatched.length > 0 && !selected.files.some((file) => !file.startsWith("-"));

// The completion receipts come from the console stream, and the inventory from
// Bun's JUnit report. Both are only collected when the profile is enabled, so
// an ordinary run keeps its inherited stdio and writes nothing.
const environment = invocationEnv("node");
const record = recorder("node", environment);
const profiled = environment.PAPERCLIP_CI_PROFILE === "true";
const directory = profiled ? mkdtempSync(path.join(tmpdir(), "paperclip-node-tests-")) : null;
const report = directory && path.join(directory, "bun-junit.xml");
if (report) runArgs.push("--reporter=junit", `--reporter-outfile=${report}`);

const receipts = profiled && !nothingSelected ? receiptRecorder(cwd) : null;
if (receipts) record({ kind: "start" });
const result = nothingSelected ? { status: 1 } : await new Promise((resolve) => {
  // Bun writes a result line for each finished test to stderr. Teeing that
  // stream keeps the output visible while this process observes the receipt.
  // A caller may launch this file with Node, so select Bun explicitly there.
  const child = spawn(process.versions.bun ? process.execPath : "bun", runArgs, {
    stdio: ["inherit", "inherit", receipts ? "pipe" : "inherit"], env: environment,
  });
  if (receipts) {
    child.stderr.pipe(process.stderr, { end: false });
    child.stderr.on("data", (chunk) => receipts.write(chunk));
  }
  child.on("error", (error) => resolve({ error }));
  child.on("close", (status, signal) => resolve({ status, signal }));
});

if (result.error) console.error(result.error.message);
if (receipts) {
  receipts.end();
  const hasReport = Boolean(report && existsSync(report));
  if (!hasReport) {
    // A killed or crashed runner writes no JUnit file. Say so instead of
    // reporting an invocation whose tests silently went missing.
    console.error("CI profile: Bun wrote no JUnit report; no test timings were attributable");
  }
  const inventory = hasReport ? parseJunitReport(readFileSync(report, "utf8"), cwd) : { files: [] };
  const collected = recordReport(record, inventory, receipts.receipts, cwd);
  if (collected.missing.length) {
    // Never invent a timestamp: a file without a receipt is a reported gap.
    console.error(`CI profile: no completion receipt for ${collected.missing.join(", ")}`);
  }
  // Only a run that reached its own end owes an end record. A killed runner
  // leaves start without end, which the exporter reports as interrupted.
  if (typeof result.status === "number") record({ kind: "end" });
}
if (directory) rmSync(directory, { recursive: true, force: true });
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = typeof result.status === "number" ? result.status : 1;
