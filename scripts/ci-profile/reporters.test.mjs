import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseJunitReport, receiptRecorder, recordReport } from "./node-reporter.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = path.join(root, "scripts/ci-profile");

for (const framework of ["vitest", "playwright", "node"]) {
  test(`${framework} reports every file with its own child tests and preserves failing exit codes`, () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-profile-smoke-")));
    try {
      symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
      const output = path.join(directory, "timings");
      const fixture = framework === "node"
        ? 'import { test } from "node:test";'
        : framework === "vitest" ? 'import { test } from "vitest";' : 'import { test } from "@playwright/test";';
      const filenames = ["probe.test.mjs", "second.test.mjs"];
      for (const filename of filenames) writeFileSync(path.join(directory, filename), `${fixture}
test("passing", async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
test("failing", async () => { throw new Error("expected probe failure"); });
`);
      let args;
      if (framework === "node") {
        args = [path.join(scripts, "node-test.mjs"), ...filenames];
      } else {
        const config = framework === "vitest"
          ? { test: { include: ["*.test.mjs"], reporters: [path.join(scripts, "vitest-reporter.mjs")] } }
          : { testDir: directory, testMatch: "*.test.mjs", workers: 2, retries: 0, reporter: [[path.join(scripts, "playwright-reporter.mjs")]] };
        const configFile = path.join(directory, `${framework}.config.mjs`);
        writeFileSync(configFile, `export default ${JSON.stringify(config)};`);
        args = framework === "vitest"
          ? [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", configFile, "--root", directory]
          : [path.join(root, "node_modules/@playwright/test/cli.js"), "test", "--config", configFile];
        args = [path.join(scripts, "run.mjs"), framework, process.execPath, ...args];
      }
      const start = Date.now();
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, args, {
        cwd: directory, encoding: "utf8", timeout: 30_000,
        env: { ...env, PAPERCLIP_CI_PROFILE: "true", PAPERCLIP_CI_PROFILE_DIR: output,
          PAPERCLIP_CI_PROFILE_JOB: "probe", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKSPACE: directory },
      });
      const end = Date.now();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const records = readdirSync(output).flatMap((file) => readFileSync(path.join(output, file), "utf8").trim().split("\n").map(JSON.parse));
      const cases = records.filter((record) => record.kind === "test");
      assert.equal(cases.length, 4, JSON.stringify(records));
      assert.ok(cases.some((record) => record.status === "passed"));
      assert.ok(cases.some((record) => record.status === "failed"));
      for (const record of cases) {
        assert.ok(record.start >= start && record.start <= end, JSON.stringify(record));
        assert.ok(record.duration >= 0 && record.start + record.duration <= end + 10);
        assert.ok(filenames.includes(record.file));
      }
      assert.ok(records.some((record) => record.kind === "end"));
      const expected = records.filter((record) => record.kind === "expected");
      assert.equal(expected.length, 1);
      assert.ok(records.every((record) => record.invocation === expected[0].invocation));
      const files = records.filter((record) => record.kind === "file");
      assert.deepEqual(files.map((record) => record.name).sort(), filenames);
      for (const file of files) {
        const children = cases.filter((record) => record.parent === file.id);
        assert.equal(children.length, 2);
        assert.ok(children.every((record) => record.file === file.file));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

// Bun's JUnit report nests each describe block, and the launcher pairs the
// report with the completion receipts it reads from the console stream.
test("bun JUnit output rebuilds nested names and per-file test status", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3">
  <testsuite name="sub/a.test.mjs" file="sub/a.test.mjs" tests="3">
    <testsuite name="outer" file="sub/a.test.mjs">
      <testsuite name="inner" file="sub/a.test.mjs">
        <testcase name="deep &amp; &lt;odd&gt;" classname="outer" time="0.007463" file="sub/a.test.mjs"/>
      </testsuite>
      <testcase name="direct" classname="outer" time="0.000083" file="sub/a.test.mjs"/>
    </testsuite>
    <testcase name="failing" classname="" time="0.05265" file="sub/a.test.mjs">
      <failure type="Error" message="boom">Error: boom&#10;</failure>
    </testcase>
    <testcase name="skipped" classname="" time="0" file="sub/a.test.mjs"><skipped /></testcase>
  </testsuite>
</testsuites>`;
  const report = parseJunitReport(xml, "/work");
  assert.deepEqual(report.files.map((entry) => entry.file), ["/work/sub/a.test.mjs"]);
  assert.deepEqual(report.files[0].tests.map((entry) => entry.name),
    ["outer > inner > deep & <odd>", "outer > direct", "failing", "skipped"]);
  assert.deepEqual(report.files[0].tests.map((entry) => entry.status),
    ["passed", "passed", "failed", "skipped"]);
  assert.ok(Math.abs(report.files[0].tests[0].duration - 7.463) < 1e-9, "Bun reports seconds");
});

test("a file that ran no test owes no timing record", () => {
  const xml = `<testsuites><testsuite name="a.test.mjs" file="a.test.mjs" tests="1">
    <testcase name="real" time="0.5" file="a.test.mjs"/></testsuite></testsuites>`;
  assert.deepEqual(parseJunitReport(xml, "/work").files.map((entry) => entry.file), ["/work/a.test.mjs"]);
  assert.deepEqual(parseJunitReport("<testsuites></testsuites>", "/work").files, []);
});

test("receipts come from file headers and result lines, and ignore test output", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-profile-receipts-")));
  try {
    const file = path.join(directory, "a.test.mjs");
    writeFileSync(file, "");
    const recorder = receiptRecorder(directory);
    // A test may print a line that looks like a header or a result; only a
    // header naming an existing path selects a file.
    recorder.write(Buffer.from(`not a header:\n(pass) not a result\n\na.test.mjs:\n(pass) first [1.00ms]\n`));
    recorder.write(Buffer.from(`(fail) second [0.10ms]\n(skip) third\n`));
    recorder.end();
    assert.deepEqual(recorder.receipts.map((receipt) => receipt.file), [file, file, file]);
    assert.ok(recorder.receipts.every((receipt) => Number.isFinite(receipt.at)));
    assert.ok(recorder.receipts[0].at <= recorder.receipts[1].at);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("each test is anchored at its own receipt and files without one stay unreported", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-profile-anchor-")));
  try {
    const a = path.join(directory, "a.test.mjs");
    const b = path.join(directory, "b.test.mjs");
    for (const file of [a, b]) writeFileSync(file, "");
    const records = [];
    const report = { files: [
      { file: a, tests: [
        { name: "first", duration: 20, status: "passed" },
        { name: "second", duration: 5, status: "failed" }] },
      // No receipt: the launcher reports this file as a coverage gap instead of
      // inventing a timestamp for it.
      { file: b, tests: [{ name: "unreceipted", duration: 5, status: "passed" }] },
    ] };
    const collected = recordReport((record) => records.push(record), report,
      [{ file: a, at: 1_000 }, { file: a, at: 1_500 }], directory);
    assert.deepEqual([collected.tests, collected.files], [2, 1]);
    assert.deepEqual(collected.missing.map((file) => path.basename(file)), ["b.test.mjs"]);
    const tests = records.filter((record) => record.kind === "test");
    assert.deepEqual(tests.map((record) => [record.name, record.start, record.duration, record.status]),
      [["first", 980, 20, "passed"], ["second", 1_495, 5, "failed"]]);
    const file = records.find((record) => record.kind === "file");
    assert.ok(tests.every((record) => record.clock === "reporter-receipt"
      && record.parent === file.id && record.file === file.file));
    assert.deepEqual([path.basename(file.name), file.start, file.duration, file.status, file.clock],
      ["a.test.mjs", 980, 520, "failed", "reporter-receipt"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a file that printed fewer receipts than tests reuses its last one", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-profile-fewer-")));
  try {
    const file = path.join(directory, "a.test.mjs");
    writeFileSync(file, "");
    const records = [];
    const collected = recordReport((record) => records.push(record),
      { files: [{ file, tests: [{ name: "one", duration: 10, status: "passed" }, { name: "two", duration: 4, status: "passed" }] }] },
      [{ file, at: 2_000 }], directory);
    assert.deepEqual(collected, { tests: 2, files: 1, missing: [] });
    assert.deepEqual(records.filter((record) => record.kind === "test").map((record) => record.start), [1_990, 1_996]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
