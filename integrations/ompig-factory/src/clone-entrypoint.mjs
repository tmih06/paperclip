// Runs inside the sandbox. The immutable image supplies ompig-slim; Core stages this small launcher.
import { spawn } from "node:child_process";
import { mkdirSync, watch, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("factory_assignment_too_large");
}
const assignment = JSON.parse(raw);
if (!/^[a-zA-Z0-9_-]{1,160}$/.test(assignment.runId)) throw new Error("factory_invalid_run_id");
const state = `/state/${assignment.runId}`;
const eventsFile = `${state}/events.jsonl`;
mkdirSync(state, { recursive: true, mode: 0o700 });
if (process.env.OMPIG_BROKER_URL) {
  // Each clone gets its own profile/ancestry. Native ompig startup synchronizes
  // it and installs the remote vault; never share mutable client state across clones.
  process.env.OMPIG_SLIM_CODING_AGENT_DIR = `${state}/profile/agent`;
  mkdirSync(process.env.OMPIG_SLIM_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
  try {
    const url = new URL(process.env.OMPIG_BROKER_URL);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    const token = process.env.OMPIG_BROKER_TOKEN_FILE
      ? readFileSync(process.env.OMPIG_BROKER_TOKEN_FILE, "utf8").trim() : process.env.OMPIG_BROKER_TOKEN;
    if (!token) throw new Error();
    const response = await fetch(`${url.origin}/v1/snapshot`, { redirect: "error",
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error();
  } catch { throw new Error("factory_broker_unavailable"); }
}
let offset = 0;
let imageInstructions = "";
try { imageInstructions = readFileSync("/opt/agent/instructions.md", "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }

// Read appended bytes only. Watch notifications are hints; final drain runs after child close.
function drain() {
  let fd;
  try {
    fd = openSync(eventsFile, "r");
    const end = statSync(eventsFile).size;
    if (end < offset) throw new Error("factory_event_stream_rewound");
    while (offset < end) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, end - offset));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      // Buffer incomplete UTF-8 sequences by retaining raw bytes until a complete JSONL record.
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        if (line.trim()) process.stdout.write(JSON.stringify({ type: "ompig.event", event: JSON.parse(line) }) + "\n");
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error("factory_event_too_large");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
let pending = Buffer.alloc(0);
const watcher = watch(state, () => drain());
const child = spawn("/usr/local/bin/ompig-slim", ["durable", "run", "--state", state,
  "--cwd", assignment.cwd, "--model", assignment.model, "--request-id", assignment.runId,
  "--max-turns", String(assignment.maxTurns), "--events-file", eventsFile, [imageInstructions, assignment.prompt].filter(Boolean).join("\n\n")], {
  cwd: assignment.cwd, stdio: ["ignore", "pipe", "inherit"],
});
let receipt = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  receipt += chunk;
  if (Buffer.byteLength(receipt) > 4 * 1024 * 1024) child.kill("SIGTERM");
});
child.on("error", error => {
  watcher.close();
  console.error(error.code === "ENOENT" ? "factory_ompig_binary_missing" : "factory_ompig_spawn_failed");
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  watcher.close();
  drain();
  try {
    process.stdout.write(JSON.stringify({ type: "ompig.result", receipt: JSON.parse(receipt), exitCode: code, signal }) + "\n");
  } catch { console.error("factory_invalid_ompig_receipt"); }
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
