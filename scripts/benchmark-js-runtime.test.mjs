import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProcessStat, percentile } from "./benchmark-js-runtime.mjs";

test("runtime benchmark percentiles use nearest rank without mutating samples", () => {
  const samples = [5, 1, 4, 2, 3];
  assert.equal(percentile(samples, 0.5), 3);
  assert.equal(percentile(samples, 0.95), 5);
  assert.equal(percentile([7], 0.99), 7);
  assert.deepEqual(samples, [5, 1, 4, 2, 3]);
  assert.throws(() => percentile([], 0.5));
});

test("runtime benchmark reads main-process CPU and RSS after a parenthesized process name", () => {
  const fields = Array.from({ length: 22 }, () => "0");
  fields[0] = "R";
  fields[11] = "120";
  fields[12] = "30";
  fields[21] = "1024";
  assert.deepEqual(parseProcessStat(`123 (benchmark (worker)) ${fields.join(" ")}`, 100, 4096), {
    cpuSeconds: 1.5,
    rssMiB: 4,
  });
});
