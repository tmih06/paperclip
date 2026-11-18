import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), "..");

export function percentile(values, fraction) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function parseProcessStat(text, ticksPerSecond, pageSize) {
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
  return {
    cpuSeconds: (Number(fields[11]) + Number(fields[12])) / ticksPerSecond,
    rssMiB: Number(fields[21]) * pageSize / 1024 ** 2,
  };
}

function argument(name, fallback) {
  return process.argv.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function boundedNumber(name, fallback, min, max) {
  const value = Number(argument(name, fallback));
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `${name}: expected ${min}..${max}`);
  return value;
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function request(port, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${route}: ${response.status} ${text.slice(0, 1000)}`);
  return JSON.parse(text);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(20_000, undefined, { ref: false })]);
  // Only signal the detached process group created for this disposable instance.
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await exited;
}

async function load() {
  const port = boundedNumber("--port", 0, 1024, 65535);
  const concurrency = boundedNumber("--concurrency", 1, 1, 128);
  const seconds = boundedNumber("--seconds", 6, 1, 120);
  const warmup = boundedNumber("--warmup", 2, 1, 30);
  const route = argument("--route", "/api/health");
  assert.ok(route.startsWith("/api/") && !route.includes("://"));
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const latencies = [];
  const statuses = {};
  let bytes = 0;
  let expectedSize;
  let lastMeasuredEnd = 0;
  const started = performance.now();
  const measuredStart = started + warmup * 1000;
  const deadline = measuredStart + seconds * 1000;
  const cpuStart = process.cpuUsage();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const before = performance.now();
      const result = await new Promise((resolve, reject) => {
        const req = http.get({ hostname: "127.0.0.1", port, path: route, agent, timeout: 10_000,
          headers: { accept: "application/json" } }, response => {
          let size = 0;
          response.on("data", chunk => { size += chunk.length; });
          response.on("end", () => resolve({ status: response.statusCode, size }));
          response.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", reject);
      });
      assert.equal(result.status, 200, `Unexpected response for ${route}`);
      expectedSize ??= result.size;
      assert.equal(result.size, expectedSize, `Response length changed for ${route}`);
      const after = performance.now();
      // Exclude warmup requests, but retain late completions and their full latency.
      if (before >= measuredStart && before < deadline) {
        lastMeasuredEnd = Math.max(lastMeasuredEnd, after);
        latencies.push(after - before);
        bytes += result.size;
        statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      }
    }
  }));
  agent.destroy();
  const cpu = process.cpuUsage(cpuStart);
  const measurementElapsedSeconds = Math.max(seconds, (lastMeasuredEnd - measuredStart) / 1000);
  console.log(JSON.stringify({ requests: latencies.length, requestsPerSecond: latencies.length / measurementElapsedSeconds,
    measurementElapsedSeconds,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: latencies.reduce((max, value) => Math.max(max, value), 0) },
    bytes, responseBytes: expectedSize, statuses, seconds, warmupSeconds: warmup,
    clientCpuPercent: (cpu.user + cpu.system) / ((performance.now() - started) * 1000) * 100,
  }));
}

async function benchmark() {
  assert.equal(process.platform, "linux", "Linux /proc metrics are required");
  assert.ok(process.versions.bun, "Run the orchestrator with the pinned Bun runtime");
  const baseline = path.resolve(argument("--baseline", ""));
  assert.ok(argument("--baseline"), "Pass --baseline=/absolute/path/to/genuine-node");
  const nodeIdentity = JSON.parse(execFileSync(baseline, ["-p", "JSON.stringify({release:process.release.name,bun:process.versions.bun,version:process.version})"], { encoding: "utf8" }));
  assert.equal(nodeIdentity.release, "node");
  assert.equal(nodeIdentity.bun, undefined, "The baseline must be genuine Node, never a Bun alias");
  const runs = boundedNumber("--runs", 5, 1, 20);
  const seconds = boundedNumber("--seconds", 6, 1, 120);
  const warmup = boundedNumber("--warmup", 2, 1, 30);
  const output = path.resolve(argument("--output", path.join(os.tmpdir(), `paperclip-runtime-${Date.now()}`)));
  const appCpus = argument("--app-cpus", "0,1");
  const clientCpus = argument("--client-cpus", "2");
  assert.match(appCpus, /^\d+(?:,\d+)*$/);
  assert.match(clientCpus, /^\d+(?:,\d+)*$/);
  assert.ok(!appCpus.split(",").some(cpu => clientCpus.split(",").includes(cpu)), "Separate app and load-generator CPUs");
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
  const pageSize = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }));
  const entrypoint = path.join(repo, "server/dist-runtime/index.mjs");
  const artifact = [];
  for (const name of (await readdir(path.dirname(entrypoint))).filter(name => name.endsWith(".mjs")).sort()) {
    artifact.push({ name, sha256: createHash("sha256").update(await readFile(path.join(path.dirname(entrypoint), name))).digest("hex") });
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-benchmark-"));
  const cleanEnv = {
    PATH: process.env.PATH, NODE_ENV: "production", PAPERCLIP_INSTANCE_ID: "runtime-benchmark",
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted", PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    HOST: "127.0.0.1", SERVE_UI: "false", PAPERCLIP_LOG_LEVEL: "warn",
    HEARTBEAT_SCHEDULER_ENABLED: "false", PAPERCLIP_DB_BACKUP_ENABLED: "false",
    PAPERCLIP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false",
  };
  await mkdir(output, { recursive: true });
  const results = { recordedAt: new Date().toISOString(), sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    artifact,
    lockSha256: createHash("sha256").update(await readFile(path.join(repo, "bun.lock"))).digest("hex"),
    buildInfo: JSON.parse(await readFile(path.join(repo, "server/dist/build-info.json"), "utf8")),
    environment: { platform: process.platform, arch: process.arch, kernel: os.release(), cpu: os.cpus()[0].model,
      cpuCount: os.cpus().length, totalMemoryMiB: os.totalmem() / 1024 ** 2, appCpus, clientCpus,
      loadGenerator: `Bun ${process.versions.bun}`, node: nodeIdentity.version, bun: process.versions.bun,
      env: cleanEnv, cpuMax: await readFile("/sys/fs/cgroup/cpu.max", "utf8").catch(() => "unavailable") },
    settings: { runs, seconds, warmup, concurrentRequests: [1, 16], fixtureIssues: 100,
      startup: "Preinitialized cloned database; warm filesystem cache; start to healthy API; no UI",
      memory: "Main server process RSS only; excludes embedded PostgreSQL and load generator",
      cpu: "Main server process; 100% is one logical CPU; load phase includes warmup",
      requestModel: "Closed-loop HTTP/1.1 keep-alive; no TLS; loopback; responses fully consumed; no conditional requests" },
    samples: [],
  };
  let active;
  let activeLoad;
  async function interrupted() {
    if (activeLoad) activeLoad.kill("SIGKILL");
    if (active) await stop(active);
    await rm(scratch, { recursive: true, force: true });
    process.exit(130);
  }
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  async function launch(runtime, directory, logName) {
    await mkdir(directory, { recursive: true });
    const logPath = path.join(output, `${logName}.log`);
    const port = await availablePort();
    const env = { ...cleanEnv, HOME: directory, PAPERCLIP_CONFIG: path.join(directory, "config.json"),
      PAPERCLIP_HOME: path.join(directory, "home"), PORT: String(port) };
    const started = performance.now();
    const child = spawn("taskset", ["-c", appCpus, runtime, entrypoint], {
      cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    const logs = [];
    child.stdout.on("data", chunk => logs.push(chunk));
    child.stderr.on("data", chunk => logs.push(chunk));
    child.on("error", error => logs.push(Buffer.from(String(error))));
    const deadline = started + 180_000;
    try {
      while (performance.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited: ${child.exitCode}/${child.signalCode}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(250) });
          if (response.ok && (await response.json()).status === "ok") {
            return { child, port, startupMs: performance.now() - started, flush: () => writeFile(logPath, Buffer.concat(logs)) };
          }
        } catch { /* The listener is not ready yet. */ }
        await delay(50);
      }
      throw new Error("Server did not become healthy within 180 seconds");
    } catch (error) {
      await stop(child);
      await writeFile(logPath, Buffer.concat(logs));
      throw new Error(`${error.message}; see ${logPath}`);
    }
  }
  const stats = async child => parseProcessStat(await readFile(`/proc/${child.pid}/stat`, "utf8"), ticks, pageSize);
  try {
    const template = path.join(scratch, "template");
    console.log("Initializing disposable database and synthetic fixtures (not timed)...");
    const setup = await launch(process.execPath, template, "setup");
    const company = await request(setup.port, "/api/companies", { name: "Runtime Benchmark" });
    const issues = [];
    for (let i = 0; i < 100; i++) {
      issues.push(await request(setup.port, `/api/companies/${company.id}/issues`, {
        title: `Synthetic task ${String(i).padStart(3, "0")}`, description: "Synthetic benchmark context. ".repeat(20),
        status: "backlog", priority: "medium",
      }));
    }
    const listRoute = `/api/companies/${company.id}/issues?limit=50`;
    assert.equal((await request(setup.port, listRoute)).length, 50);
    assert.equal((await request(setup.port, `/api/companies/${company.id}/agents`)).length, 0, "No provider-capable agents may exist");
    results.fixture = { companyId: company.id, issues: issues.length, agents: 0 };
    await stop(setup.child);
    await setup.flush();
    active = undefined;
    for (let pair = 0; pair < runs; pair++) {
      const order = pair % 2 === 0 ? [["node", baseline], ["bun", process.execPath]] : [["bun", process.execPath], ["node", baseline]];
      for (const [runtime, executable] of order) {
        const directory = path.join(scratch, `pair-${pair + 1}-${runtime}`);
        await cp(template, directory, { recursive: true });
        const server = await launch(executable, directory, `pair-${pair + 1}-${runtime}`);
        await delay(2000);
        const sample = { pair: pair + 1, runtime, orderInPair: order.findIndex(([name]) => name === runtime) + 1,
          startupMs: server.startupMs, idleRssMiB: (await stats(server.child)).rssMiB,
          hostLoadAverage: os.loadavg(), workloads: [] };
        sample.fixtureResponseSha256 = {};
        for (const route of ["/api/companies", listRoute]) {
          const body = await request(server.port, route);
          assert.equal(body.length, route === listRoute ? 50 : 1);
          const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
          sample.fixtureResponseSha256[route] = digest;
          if (results.samples.length) assert.equal(digest, results.samples[0].fixtureResponseSha256[route], "Node and Bun must return identical fixture data");
        }
        results.samples.push(sample);
        console.log(`Pair ${pair + 1}/${runs} ${runtime}: healthy in ${Math.round(server.startupMs)} ms; idle RSS ${Math.round(sample.idleRssMiB)} MiB`);
        for (const [name, route] of [["health", "/api/health"], ["companies", "/api/companies"], ["issues-50", listRoute]]) {
          for (const concurrency of [1, 16]) {
            const before = await stats(server.child);
            const started = performance.now();
            const child = spawn("taskset", ["-c", clientCpus, process.execPath, script, "--load",
              `--port=${server.port}`, `--route=${route}`, `--concurrency=${concurrency}`, `--seconds=${seconds}`, `--warmup=${warmup}`],
            { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
            activeLoad = child;
            const stdout = [], stderr = [], rss = [];
            child.stdout.on("data", chunk => stdout.push(chunk));
            child.stderr.on("data", chunk => stderr.push(chunk));
            const exited = once(child, "close");
            while (child.exitCode === null && child.signalCode === null) {
              rss.push((await stats(server.child)).rssMiB);
              await delay(100);
            }
            const [code] = await exited;
            activeLoad = undefined;
            assert.equal(code, 0, `Load failed: ${Buffer.concat(stderr)}`);
            const elapsed = (performance.now() - started) / 1000;
            const after = await stats(server.child);
            const measured = JSON.parse(Buffer.concat(stdout).toString());
            const row = { name, concurrency, ...measured, serverCpuPercent: (after.cpuSeconds - before.cpuSeconds) / elapsed * 100,
              serverCpuSeconds: after.cpuSeconds - before.cpuSeconds, serverRssMiB: { median: percentile(rss, 0.5), peak: Math.max(...rss) } };
            sample.workloads.push(row);
            console.log(`  ${name} c${concurrency}: ${Math.round(row.requestsPerSecond)} req/s; p95 ${row.latencyMs.p95.toFixed(2)} ms; RSS ${Math.round(row.serverRssMiB.median)} MiB; client CPU ${Math.round(row.clientCpuPercent)}%`);
            await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
          }
        }
        await stop(server.child);
        await server.flush();
        active = undefined;
        await rm(directory, { recursive: true });
      }
    }
    await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(`Results: ${path.join(output, "results.json")}`);
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    if (activeLoad) activeLoad.kill("SIGKILL");
    if (active) await stop(active);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--load")) await load();
  else await benchmark();
}
