import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openWorker, createWorkerServer, validateWorkerConfig } from "../src/worker.mjs";
import { digest } from "../src/protocol.mjs";

const image = `sha256:${"a".repeat(64)}`;
const token = "worker-test-token-".repeat(4);

export class FakeDocker {
  containers = new Map();
  creates = 0;
  failStop = false;
  async create(row) { this.creates++; await new Promise(resolve => setImmediate(resolve)); this.containers.set(row.id, true); }
  async inspect(row) { return this.containers.has(row.id) ? { State: { Running: this.containers.get(row.id) } } : null; }
  async stop(row) { if (this.failStop) throw new Error("offline"); if (this.containers.has(row.id)) this.containers.set(row.id, false); }
  async destroy(row) { await this.stop(row); this.containers.delete(row.id); }
  async resume(row) { assert.ok(this.containers.has(row.id)); this.containers.set(row.id, true); }
  async execute() { return { exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }; }
}

export async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paperclip-factory-"));
  const config = { dataDir, workerId: "worker-1", slots: 2, memoryMiB: 256, cpusPerSlot: 1,
    leaseMs: 60_000, minFreeBytes: 0, images: [image], clients: [{ companyId: "company-a", token }], ...options };
  const engine = new FakeDocker();
  let worker = await openWorker(config, engine);
  t.after(async () => { if (!worker.closed) await worker.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { config, engine, get worker() { return worker; }, async restart() { await worker.close(); worker = await openWorker(config, engine); return worker; } };
}

export function assignment(name = "one") {
  return { id: digest(name), environmentId: "env-a", runId: name, agentId: "same-agent", image };
}

test("one agent fills independent slots concurrently; admission never oversubscribes", async t => {
  const { worker, engine } = await fixture(t);
  const results = await Promise.allSettled(["one", "two", "three"].map(name => worker.acquire(assignment(name), "company-a")));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "factory_slots_full");
  assert.equal(engine.creates, 2);
  assert.equal(worker.capacity().occupied, 2);
});

test("duplicate admission is idempotent and assignment mutation is rejected", async t => {
  const { worker, engine } = await fixture(t);
  const input = assignment();
  const results = await Promise.all([worker.acquire(input, "company-a"), worker.acquire(input, "company-a")]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(engine.creates, 1);
  await assert.rejects(worker.acquire({ ...input, agentId: "another-agent" }, "company-a"), { code: "factory_assignment_conflict" });
});

test("company and environment boundaries apply to inspect, execute and deletion", async t => {
  const { worker, engine } = await fixture(t);
  const input = assignment();
  await worker.acquire(input, "company-a");
  for (const action of [() => worker.inspect(input.id, "company-b", "env-a"),
    () => worker.stop(input.id, "company-b", "env-a", true),
    () => worker.execute(input.id, "company-a", "wrong-env", { command: "id" })]) {
    await assert.rejects(action(), { code: "factory_lease_not_found" });
  }
  assert.equal(engine.containers.get(input.id), true);
});

test("failed stop never frees capacity or destroys retained data", async t => {
  const { worker, engine } = await fixture(t, { slots: 1 });
  const input = assignment();
  await worker.acquire(input, "company-a");
  engine.failStop = true;
  await assert.rejects(worker.stop(input.id, "company-a", "env-a"));
  assert.equal(worker.capacity().occupied, 1);
  await assert.rejects(worker.acquire(assignment("next"), "company-a"), { code: "factory_slots_full" });
  engine.failStop = false;
  assert.equal((await worker.stop(input.id, "company-a", "env-a")).state, "stopped");
  assert.equal(worker.capacity().occupied, 0);
  assert.ok(engine.containers.has(input.id));
});

test("restart retains reservations and stopped clones reacquire physical capacity", async t => {
  const f = await fixture(t, { slots: 1 });
  const input = assignment();
  await f.worker.acquire(input, "company-a");
  await f.restart();
  assert.equal(f.worker.capacity().occupied, 1);
  await f.worker.stop(input.id, "company-a", "env-a");
  await f.worker.acquire(assignment("other"), "company-a");
  await assert.rejects(f.worker.resume(input.id, "company-a", "env-a"), { code: "factory_slots_full" });
  await f.worker.stop(assignment("other").id, "company-a", "env-a", true);
  assert.equal((await f.worker.resume(input.id, "company-a", "env-a")).state, "running");
});

test("another daemon cannot open the same ledger", async t => {
  const { config } = await fixture(t);
  await assert.rejects(openWorker(config, new FakeDocker()));
});

test("uncertain creation holds its slot until a matching container can be destroyed", async t => {
  const { worker, engine } = await fixture(t, { slots: 1 });
  engine.create = async () => { throw new Error("lost create response"); };
  const input = assignment();
  await assert.rejects(worker.acquire(input, "company-a"));
  await assert.rejects(worker.stop(input.id, "company-a", "env-a", true), { code: "factory_creation_uncertain" });
  assert.equal(worker.capacity().occupied, 1);
  engine.containers.set(input.id, true);
  assert.equal((await worker.stop(input.id, "company-a", "env-a", true)).state, "destroyed");
  assert.equal(worker.capacity().occupied, 0);
});

test("negative cleanup fences a late create request", async t => {
  const { worker, engine } = await fixture(t);
  const input = assignment();
  assert.equal((await worker.stop(input.id, "company-a", "env-a", true)).state, "destroyed");
  await assert.rejects(worker.acquire(input, "company-a"));
  assert.equal(engine.creates, 0);
});

test("expiry stops and retains the exact sandbox and releases its slot", async t => {
  const { worker, engine } = await fixture(t);
  const input = assignment();
  await worker.acquire({ ...input, expiresAt: new Date(Date.now() + 2100).toISOString() }, "company-a");
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(engine.containers.get(input.id), false);
  assert.equal(worker.capacity().occupied, 0);
});

test("worker API authenticates all endpoints and never echoes backend credentials", async t => {
  const { worker } = await fixture(t);
  const server = createWorkerServer(worker);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + "/v1/capacity")).status, 401);
  const response = await fetch(origin + "/v1/capacity", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).slots, 2);
  const acquire = await fetch(origin + "/v1/leases", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(assignment()) });
  assert.equal(acquire.status, 200);
});

test("pending acquisitions wake on physical release; an idle worker schedules no scans", async t => {
  const { worker } = await fixture(t, { slots: 1 });
  assert.equal(worker.deadlines.size, 0);
  assert.equal(worker.waiters.size, 0);
  const input = assignment();
  await worker.acquire(input, "company-a");
  const waiting = worker.waitForSlot(5000);
  assert.equal(worker.waiters.size, 1);
  await worker.stop(input.id, "company-a", "env-a");
  assert.equal((await waiting).occupied, 0);
  assert.equal(worker.waiters.size, 0);
  assert.equal(worker.deadlines.size, 0);
});

test("broker credentials are injected only for the owning company and never exposed in capacity", async t => {
  const broker = { url: "http://172.30.250.1:8765", token: "broker-company-a-".repeat(4) };
  const { worker, engine } = await fixture(t, { clients: [{ companyId: "company-a", token, broker },
    { companyId: "company-b", token: "other-company-token-".repeat(4) }] });
  const calls = [];
  engine.execute = async (row, input) => { calls.push(input.env); return { exitCode: 0, stdout: "ok", stderr: "" }; };
  const a = assignment("broker-a"), b = assignment("broker-b");
  await worker.acquire(a, "company-a"); await worker.acquire(b, "company-b");
  await worker.execute(a.id, "company-a", "env-a", { command: "env", env: {
    OMPIG_BROKER_URL: "https://wrong.invalid", OMPIG_BROKER_TOKEN: "wrong", OMPIG_BROKER_TOKEN_FILE: "/tmp/override", EXTRA: "kept",
  } });
  await worker.execute(b.id, "company-b", "env-a", { command: "env" });
  assert.deepEqual(calls[0], { OMPIG_BROKER_URL: broker.url, OMPIG_BROKER_TOKEN: broker.token, EXTRA: "kept" });
  assert.deepEqual(calls[1], {});
  assert.ok(!JSON.stringify(worker.capacity()).includes(broker.token));
  assert.ok(!JSON.stringify(worker.store.all()).includes(broker.token));
});

test("broker URLs and DNS cannot smuggle public plaintext endpoints, credentials, or Docker flags", async t => {
  const { config } = await fixture(t);
  for (const url of ["http://example.com", "http://192.999.1.1", "ftp://172.30.250.1", "https://user:pass@example.com", "https://example.com/path"]) {
    assert.throws(() => validateWorkerConfig({ ...config, clients: [{ companyId: "company-a", token, broker: { url, token } }] }));
  }
  for (const dns of [["1.1.1.1 --privileged"], ["999.1.1.1"], []]) assert.throws(() => validateWorkerConfig({ ...config, dns }));
  assert.deepEqual(validateWorkerConfig({ ...config, dns: ["1.1.1.1"] }).dns, ["1.1.1.1"]);
});

test("mutable images, host networking and remote Docker sockets are refused", async t => {
  const { config } = await fixture(t);
  for (const changes of [{ images: ["agent:latest"] }, { network: "host" }, { network: "bridge" }, { dockerHost: "tcp://other:2375" }]) {
    assert.throws(() => validateWorkerConfig({ ...config, ...changes }));
  }
});
