import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("parser runs under the board CJS contract and keeps clone histories independent", async () => {
  const source = await readFile(new URL("../src/ui-parser.cjs", import.meta.url), "utf8");
  const exports = {};
  new Function("exports", "module", "self", "globalThis", source)(exports, { exports }, undefined, undefined);
  const first = exports.createStdoutParser(), second = exports.createStdoutParser();
  const line = JSON.stringify({ type: "ompig.event", event: { id: "1:0:0", type: "tool_call", tool: "bash", call_id: "call-1", input: { command: "test -f result.txt" } } });
  assert.equal(first.parseLine(line, "now")[0].kind, "tool_call");
  assert.deepEqual(first.parseLine(line, "later"), []);
  assert.equal(second.parseLine(line, "now").length, 1);
  first.reset();
  assert.equal(first.parseLine(line, "again").length, 1);
});
