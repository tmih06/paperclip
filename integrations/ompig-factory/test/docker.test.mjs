import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openWorker, createWorkerServer } from "../src/worker.mjs";
import { createProvider } from "../src/provider.mjs";
import { createServerAdapter } from "../src/adapter.mjs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const image = process.env.PAPERCLIP_FACTORY_DOCKER_IMAGE;

test("Docker accepts registry digest references when the container reports its immutable image ID", async () => {
  const digest = `a${"a".repeat(63)}`;
  const engine = new (await import("../src/docker.mjs")).DockerEngine({
    workerId: "test", dataDir: "/tmp", dockerBinary: "/usr/bin/docker", dockerHost: "unix:///var/run/docker.sock", dockerConfig: "/tmp",
    images: [`repo@sha256:${digest}`], network: "none",
  });
  const labels = engine.labels({ id: "a".repeat(64), companyId: "c", environmentId: "e", agentId: "a", runId: "r" });
  engine.checked = async args => args[0] === "container" && args[1] === "ls" ? "a".repeat(64) : args[0] === "container" && args[1] === "inspect" ? JSON.stringify([{ Config: { Image: `sha256:${digest}`, Labels: labels }, State: { Running: true } }]) : "";
  const result = await engine.inspect({ id: "a".repeat(64), image: `repo@sha256:${digest}`, companyId: "c", environmentId: "e", agentId: "a", runId: "r" });
  assert.equal(result.State.Running, true);
});

test("real Docker: provider RPC, independent clones, unprivileged commands, retained files and daemon-independent expiry", { skip: !image, timeout: 90_000 }, async t => {
  assert.equal(process.getuid(), 0, "Run the opt-in real Docker smoke with sudo: worker bind volumes require root ownership.");
  const dataDir = await mkdtemp(path.join(tmpdir(), "paperclip-factory-docker-"));
  const token = randomUUID() + randomUUID();
  const worker = await openWorker({ dataDir, workerId: "local-smoke", slots: 2, cpusPerSlot: 0.5,
    memoryMiB: 256, minFreeBytes: 0, leaseMs: 60_000, images: [image], clients: [{ companyId: "smoke-company", token }] });
  const server = createWorkerServer(worker);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { workers: [`http://127.0.0.1:${server.address().port}`], workerToken: token, image, timeoutMs: 30_000 };
  const provider = createProvider();
  const base = { config, companyId: "smoke-company", environmentId: "smoke-env", agentId: "one-agent" };
  const leases = [];
  t.after(async () => {
    // Delete only allocations created by this test; the engine checks exact ownership labels.
    for (const row of worker.store.all()) await worker.engine.destroy(row);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (!worker.closed) await worker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const acquire = async () => {
    const lease = await provider.onEnvironmentAcquireLease({ ...base, runId: randomUUID(), creationOperationId: randomUUID() });
    leases.push(lease); return lease;
  };
  const [a, b] = await Promise.all([acquire(), acquire()]);
  assert.notEqual(a.providerLeaseId, b.providerLeaseId);
  assert.equal(worker.capacity().occupied, 2);
  await assert.rejects(provider.onEnvironmentAcquireLease({ ...base, config: { ...config, timeoutMs: 100 }, runId: randomUUID() }), { code: "factory_slots_full" });
  const execute = (lease, command, args = [], env) => provider.onEnvironmentExecute({ ...base, lease, command, args, env, timeoutMs: 10_000 });
  const identity = await execute(a, "id", ["-u"]);
  assert.equal(identity.stdout.trim(), "1000");
  const secret = "a quoted ' value\nwith Unicode λ";
  assert.equal((await execute(a, "printenv", ["FACTORY_TEST_SECRET"], { FACTORY_TEST_SECRET: secret })).stdout.trim(), secret);
  assert.equal((await execute(a, "/usr/local/bin/ompig-slim", ["durable", "--help"])).exitCode, 0);
  assert.equal((await execute(a, "/bin/sh", ["-c", "printf saved > /workspace/proof"])).exitCode, 0);
  assert.notEqual((await execute(b, "cat", ["/workspace/proof"])).exitCode, 0);
  assert.notEqual((await execute(a, "/bin/sh", ["-c", "echo bad > /run/factory-control/expires"])).exitCode, 0);
  if (process.env.PAPERCLIP_FACTORY_DURABLE_SMOKE === "1") {
    const fixture = await readFile(new URL("./fixtures/durable-smoke.py", import.meta.url), "utf8");
    const launcher = await readFile(new URL("../src/clone-entrypoint.mjs", import.meta.url));
    const result = await provider.onEnvironmentExecute({ ...base, lease: a, command: "python3", args: ["-"],
      env: { FACTORY_LAUNCHER_B64: launcher.toString("base64") }, stdin: fixture, timeoutMs: 40_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.find(event => event.type === "ompig.result")?.receipt.status, "done");
    assert.ok(events.some(event => event.type === "ompig.event" && event.event.type === "tool_call"));
    assert.equal((await execute(a, "cat", ["/workspace/factory-result.txt"])).stdout, "verified\n");
  }
  if (process.env.PAPERCLIP_FACTORY_ADAPTER_SMOKE === "1") {
    const fixture = await readFile(new URL("./fixtures/durable-smoke.py", import.meta.url), "utf8");
    const upload = await provider.onEnvironmentExecute({ ...base, lease: b, command: "python3", args: ["-c", "import sys; open('/state/model.py','w').write(sys.stdin.read())"], stdin: fixture });
    assert.equal(upload.exitCode, 0);
    assert.equal((await execute(b, "/bin/sh", ["-c", "FACTORY_MODEL_DAEMON=1 FACTORY_CALLBACK_CHECK=1 python3 /state/model.py >/state/model.log 2>&1 </dev/null &"])).exitCode, 0);
    assert.equal((await execute(b, "/bin/sh", ["-c", "for n in 1 2 3 4 5; do test -f /state/fixture-profile/ready && exit 0; sleep 1; done; cat /state/model.log; exit 1"])).exitCode, 0);
    const repo = path.join(dataDir, "source");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(path.join(repo, "README.md"), "Synthetic factory checkout\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const callbacks = [];
    const api = createServer((request, response) => { callbacks.push({ path: request.url, authorization: request.headers.authorization }); response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
    await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
    const previousHost = process.env.PAPERCLIP_LISTEN_HOST, previousPort = process.env.PAPERCLIP_LISTEN_PORT;
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = String(api.address().port);
    try {
      const target = { kind: "remote", transport: "sandbox", providerKey: "ompig_factory", remoteCwd: "/workspace", shellCommand: "sh", timeoutMs: 30_000,
        runner: { execute: async input => {
          const result = await provider.onEnvironmentExecute({ ...base, lease: b, ...input });
          await input.onLog?.("stdout", result.stdout); await input.onLog?.("stderr", result.stderr);
          return result;
        } } };
      const executionContext = { runId: worker.store.get(b.providerLeaseId).runId,
        agent: { id: "one-agent", companyId: "smoke-company", name: "Developer" }, runtime: {},
        config: { image, model: "factory-fixture/fixture", timeoutSec: 30, maxTurns: 8,
          env: { PIG_HOME: "/state/fixture-profile", PIG_CODING_AGENT_DIR: "/state/fixture-profile/agent", OMPIG_SLIM_CODING_AGENT_DIR: "/state/fixture-profile/agent", PI_OFFLINE: "1" } },
        context: { taskId: "synthetic-ticket", executionWorkspaceId: "synthetic-workspace", paperclipWorkspace: { cwd: repo } },
        executionTarget: target, authToken: "synthetic-run-token", onLog: async () => {},
        stopRemoteStartup: () => provider.onEnvironmentStopLease({ ...base, providerLeaseId: b.providerLeaseId, leaseMetadata: b.metadata }),
      };
      const result = await createServerAdapter().execute(executionContext);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(await readFile(path.join(repo, "factory-result.txt"), "utf8"), "verified\n");
      assert.ok(callbacks.some(call => call.path === "/api/agents/me" && call.authorization === "Bearer synthetic-run-token"));
      await execute(b, "touch", ["/state/fixture-slow"]);
      const controller = new AbortController();
      let cancellationTimer;
      try {
        const cancelled = await createServerAdapter().execute({ ...executionContext, runId: randomUUID(), signal: controller.signal,
          onDispatch: () => { cancellationTimer = setTimeout(() => controller.abort(), 1500); },
        });
        assert.equal(cancelled.errorCode, "cancelled");
        assert.equal((await provider.onEnvironmentInspectLease({ ...base, providerLeaseId: b.providerLeaseId, leaseMetadata: b.metadata })).state, "stopped");
      } finally { clearTimeout(cancellationTimer); }
    } finally {
      if (previousHost === undefined) delete process.env.PAPERCLIP_LISTEN_HOST; else process.env.PAPERCLIP_LISTEN_HOST = previousHost;
      if (previousPort === undefined) delete process.env.PAPERCLIP_LISTEN_PORT; else process.env.PAPERCLIP_LISTEN_PORT = previousPort;
      await new Promise(resolve => { api.close(resolve); api.closeAllConnections(); });
    }
  }
  const release = { ...base, providerLeaseId: a.providerLeaseId, leaseMetadata: a.metadata };
  assert.equal((await provider.onEnvironmentStopLease(release)).state, "stopped");
  const resumed = await provider.onEnvironmentResumeLease(release);
  assert.equal((await execute(resumed, "cat", ["/workspace/proof"])).stdout, "saved");
  assert.equal((await provider.onEnvironmentDestroyLease(release)).state, "destroyed");
  const expiry = await provider.onEnvironmentAcquireLease({ ...base, runId: randomUUID(), requestedExpiresAt: new Date(Date.now() + 7000).toISOString() });
  leases.push(expiry);
  for (const timer of worker.deadlines.values()) clearTimeout(timer);
  worker.deadlines.clear(); // Simulate loss of the daemon's expiry scheduler; the container must enforce its own bound.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiry.expiresAt) - Date.now()) + 1000));
  assert.equal((await worker.engine.inspect(worker.store.get(expiry.providerLeaseId))).State.Running, false);
});
