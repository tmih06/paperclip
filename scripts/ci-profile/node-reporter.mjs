import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { relativeFile } from "./record.mjs";

// Bun does not load a JavaScript test reporter, so this module is not a
// reporter the runtime calls the way Node called the previous one. The
// launcher in ./node-test.mjs instead runs `bun test` with Bun's built-in
// JUnit reporter plus a tee of the runner's console stream:
//
//   JUnit  - the test inventory: file, name, status, and duration.
//   stream - when this process read each result line, i.e. the completion
//            receipt. Bun prints a file header before that file's results and
//            prints each result as its test finishes, so a receipt is an
//            honest observation of the completed test, not a computed guess.
//
// Records use the schema in ./record.mjs and keep `clock: "reporter-receipt"`
// because Bun reports its own durations and only the receipt is observed here.

// Bun prints one of these for each finished, skipped, or todo test.
const RESULT = /^\((?:pass|fail|skip|todo)\) /;
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value) {
  return value.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|([a-zA-Z]+));/g, (entity, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : entity;
  });
}

function attributes(text) {
  const values = {};
  for (const match of text.matchAll(ATTRIBUTE)) values[match[1]] = decode(match[2] ?? match[3] ?? "");
  return values;
}

// Reduce Bun's JUnit report to the files it reported, in report order, and the
// tests of each file. Bun nests a describe block as a nested <testsuite>, so
// the enclosing suite names rebuild the "outer > inner > test" name that the
// previous Node reporter recorded. Failure details stay out of the trace.
export function parseJunitReport(xml, cwd = process.cwd()) {
  const files = [];
  const open = [];
  for (const match of xml.matchAll(TAG)) {
    const [, closing, name, rawAttributes, selfClosing] = match;
    if (closing) {
      const index = open.findLastIndex((element) => element.name === name);
      if (index !== -1) open.length = index;
      continue;
    }
    const values = attributes(rawAttributes);
    const parent = open.at(-1);
    const suites = parent?.suites ?? [];
    if (name === "testsuite" && parent?.name === "testsuites") {
      files.push({ file: path.resolve(cwd, values.file || values.name || ""), tests: [] });
      open.push({ name, suites: [] });
      continue;
    }
    if (name === "testcase" && files.length) {
      const test = {
        name: [...suites, values.name ?? ""].filter(Boolean).join(" > "),
        // Bun writes seconds with microsecond precision.
        duration: Number(values.time) * 1000,
        status: "passed",
      };
      files.at(-1).tests.push(test);
      open.push({ name, suites, test });
      if (selfClosing) open.pop();
      continue;
    }
    if (name === "failure" || name === "error" || name === "skipped") {
      const owner = open.findLast((element) => element.test);
      if (owner) owner.test.status = name === "skipped" ? "skipped" : "failed";
      continue;
    }
    open.push({ name, suites: name === "testsuite" ? [...suites, values.name ?? ""] : suites });
    if (selfClosing) open.pop();
  }
  // A file that runs no test gets no suite; it owes no timing record either.
  return { files: files.filter((entry) => entry.tests.length) };
}

// Watch the runner's console stream for the file header and each result line.
// Test output shares that stream, so only a header that names an existing path
// switches files; anything else is left untouched.
export function receiptRecorder(cwd = process.cwd()) {
  const receipts = [];
  const decoder = new StringDecoder("utf8");
  let section = null;
  let pending = "";
  const line = (text) => {
    if (RESULT.test(text)) {
      if (section) receipts.push({ file: section, at: Date.now() });
      return;
    }
    if (!text || text.startsWith(" ") || !text.endsWith(":")) return;
    const candidate = path.resolve(cwd, text.slice(0, -1));
    if (existsSync(candidate)) section = candidate;
  };
  return {
    receipts,
    write(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const text of lines) line(text.replace(/\r$/, ""));
    },
    end() {
      pending += decoder.end();
      if (pending) line(pending.replace(/\r$/, ""));
      pending = "";
    },
  };
}

// Place every reported test at the receipt of its own completion. Bun reports
// durations on its clock, so a test started at `receipt - duration`. When a
// file printed fewer receipts than it has tests (an interleaved worker stream)
// the last receipt of that file anchors the rest, and a file with no receipt at
// all is reported as missing rather than given an invented timestamp.
export function recordReport(record, report, receipts, cwd = process.cwd()) {
  const received = new Map();
  for (const { file, at } of receipts) {
    const key = path.resolve(cwd, file);
    received.set(key, [...(received.get(key) ?? []), at]);
  }
  let index = 0;
  let tests = 0;
  let files = 0;
  let missing = [];
  for (const entry of report.files) {
    const key = path.resolve(cwd, entry.file);
    const own = received.get(key) ?? [];
    if (!own.length) {
      missing.push(relativeFile(key));
      continue;
    }
    const file = relativeFile(key);
    let start = Infinity;
    let end = -Infinity;
    let failed = false;
    for (const [position, test] of entry.tests.entries()) {
      const completed = own[position] ?? own.at(-1);
      const duration = Number.isFinite(test.duration) ? Math.max(0, test.duration) : 0;
      start = Math.min(start, completed - duration);
      end = Math.max(end, completed);
      if (test.status === "failed") failed = true;
      record({
        kind: "test", parent: file, id: String(index++), name: test.name, file,
        start: completed - duration, duration, status: test.status,
        clock: "reporter-receipt",
      });
    }
    record({
      kind: "file", id: file, name: file, file,
      start, duration: end - start, status: failed ? "failed" : "passed",
      clock: "reporter-receipt",
    });
    tests += entry.tests.length;
    files += 1;
  }
  return { tests, files, missing };
}
