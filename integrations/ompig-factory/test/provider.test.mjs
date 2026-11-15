import { test } from "node:test";
import assert from "node:assert/strict";
import { createProvider, providerConfig } from "../src/provider.mjs";
import { leaseId, rankedWorkers, workerKey, LEASE_SCHEMA } from "../src/protocol.mjs";

const config = { workers: ["http://100.64.0.1:8787", "http://100.64.0.2:8787"], workerToken: "x".repeat(48), image: `sha256:${"a".repeat(64)}` };
const params = { config, companyId: "company-a", environmentId: "env-a", agentId: "developer", runId: "run-one", creationOperationId: "creation-one" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function success(url, options) {
  const input = JSON.parse(options.body);
  return reply({ id: input.id, image: input.image, state: "running", expiresAt: new Date(Date.now() + 60_000).toISOString() });
}

test("same image can acquire many independent clones on the same pool", async () => {
  const calls = [];
  const provider = createProvider({ fetchImpl: async (url, options) => { calls.push([url, options]); return success(url, options); } });
  const leases = await Promise.all(["one", "two"].map(runId => provider.onEnvironmentAcquireLease({ ...params, runId, creationOperationId: runId })));
  assert.notEqual(leases[0].providerLeaseId, leases[1].providerLeaseId);
  assert.ok(leases.every(lease => lease.metadata.image === config.image && lease.metadata.schema === LEASE_SCHEMA));
  assert.ok(calls.every(([, options]) => options.redirect === "error"));
});

test("only explicit pre-allocation capacity refusal permits another worker", async () => {
  const calls = [];
  const provider = createProvider({ fetchImpl: async (url, options) => {
    calls.push(url);
    return calls.length === 1 ? reply({ code: "factory_slots_full" }, 409) : success(url, options);
  } });
  await provider.onEnvironmentAcquireLease(params);
  assert.equal(calls.length, 2);
  assert.notEqual(new URL(calls[0]).origin, new URL(calls[1]).origin);
});

test("a lost create response never fails over and carries exact cleanup ownership", async () => {
  let calls = 0;
  const provider = createProvider({ fetchImpl: async () => { calls++; throw new Error("lost response containing SECRET"); } });
  await assert.rejects(provider.onEnvironmentAcquireLease(params), error => {
    const origin = rankedWorkers(config.workers, params.creationOperationId)[0];
    assert.equal(error.cleanup.providerLeaseId, leaseId(origin, params.companyId, params.environmentId, params.creationOperationId));
    assert.equal(error.cleanup.companyId, params.companyId);
    assert.equal(error.errors.length, 0);
    assert.ok(!JSON.stringify(error).includes("SECRET"));
    assert.ok(!JSON.stringify(error).includes(config.workerToken));
    return true;
  });
  assert.equal(calls, 1);
});

test("authentication failures are not uncertain allocations or fallback invitations", async () => {
  let calls = 0;
  const provider = createProvider({ fetchImpl: async () => { calls++; return reply({ code: "factory_unauthorized" }, 401); } });
  await assert.rejects(provider.onEnvironmentAcquireLease(params), error => error.code === "factory_unauthorized" && !error.cleanup);
  assert.equal(calls, 1);
});

test("full pool is reported as bounded retryable provider unavailability", async () => {
  const provider = createProvider({ fetchImpl: async () => reply({ code: "factory_slots_full" }, 409) });
  await assert.rejects(provider.onEnvironmentAcquireLease(params), { code: "factory_slots_full", status: 503 });
});

test("stop-and-retain never invokes destructive cleanup", async () => {
  const calls = [];
  const origin = config.workers[0];
  const id = leaseId(origin, "company-a", "env-a", "one");
  const provider = createProvider({ fetchImpl: async (url, options) => { calls.push([url, options]); return reply({ id, state: "stopped" }); } });
  const result = await provider.onEnvironmentReleaseLease({ ...params, providerLeaseId: id,
    leaseMetadata: { schema: LEASE_SCHEMA, workerKey: workerKey(origin), image: config.image }, resourceDisposition: "stop_and_retain" });
  assert.equal(result.state, "stopped");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].method, "POST");
  assert.ok(calls[0][0].includes("/stop?environmentId=env-a"));
});

test("image edits or unsupported stored lease schemas fail closed before contacting workers", async () => {
  let calls = 0;
  const provider = createProvider({ fetchImpl: async () => { calls++; throw new Error("must not contact"); } });
  const id = leaseId(config.workers[0], "company-a", "env-a", "one");
  for (const metadata of [{}, { schema: "v99" }, { schema: LEASE_SCHEMA, workerKey: workerKey(config.workers[0]), image: `sha256:${"b".repeat(64)}` }]) {
    await assert.rejects(provider.onEnvironmentDestroyLease({ ...params, providerLeaseId: id, leaseMetadata: metadata }));
  }
  assert.equal(calls, 0);
});

test("explicit Core platform probes acquire an owned sandbox without an agent", async () => {
  const provider = createProvider({ fetchImpl: async (url, options) => {
    const input = JSON.parse(options.body);
    assert.equal(input.agentId, "probe-creation-one");
    assert.equal(input.runId, params.runId);
    assert.equal(input.environmentId, params.environmentId);
    return success(url, options);
  } });
  assert.ok((await provider.onEnvironmentAcquireLease({ ...params, agentId: undefined, resolveSnapshotIdentity: true })).providerLeaseId);
});

test("ordinary run allocations still require an agent before contacting workers", async () => {
  let calls = 0;
  const provider = createProvider({ fetchImpl: async () => { calls++; throw new Error("must not contact"); } });
  await assert.rejects(provider.onEnvironmentAcquireLease({ ...params, agentId: undefined }), { code: "factory_agent_required" });
  assert.equal(calls, 0);
});

test("probe inventories workers without creating a sandbox", async () => {
  const provider = createProvider({ fetchImpl: async (url, options) => {
    assert.ok(url.endsWith("/v1/capacity")); assert.equal(options.method, "GET");
    return reply({ images: [config.image], slots: 1, occupied: 0, draining: false });
  } });
  assert.equal((await provider.onEnvironmentProbe(params)).ok, true);
});

test("a full pool waits for a release event instead of failing the assignment", async () => {
  let full = true;
  let release;
  const released = new Promise(resolve => { release = () => { full = false; resolve(); }; });
  const provider = createProvider({ fetchImpl: async (url, options) => {
    if (url.includes("/v1/capacity?")) { await released; return reply({ occupied: 0, slots: 1 }); }
    return full ? reply({ code: "factory_slots_full" }, 409) : success(url, options);
  } });
  const admitted = provider.onEnvironmentAcquireLease({ ...params, config: { ...config, timeoutMs: 1000 } });
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.ok((await admitted).providerLeaseId);
});

test("environment validation retains the default model for name-only onboarding", async () => {
  const model = "deploy/deepseek-ai/deepseek-v4.1-flash-1017";
  const result = await createProvider().onEnvironmentValidateConfig({ ...params, config: { ...config, model: ` ${model} ` } });
  assert.equal(result.ok, true);
  assert.equal(result.normalizedConfig.model, model);
  for (const invalid of ["", "model-without-provider", 42, "p/" + "x".repeat(300)]) {
    assert.equal((await createProvider().onEnvironmentValidateConfig({ ...params, config: { ...config, model: invalid } })).ok, false);
  }
});

test("config rejects mutable tags and public plaintext origins", () => {
  assert.throws(() => providerConfig({ ...config, image: "developer:latest" }));
  assert.throws(() => providerConfig({ ...config, workers: ["http://example.com"] }));
  assert.throws(() => providerConfig({ ...config, workers: ["https://user:password@example.com"] }));
});
