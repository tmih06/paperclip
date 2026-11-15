import { test } from "node:test";
import assert from "node:assert/strict";
import { createServerAdapter } from "../src/adapter.mjs";
import { createAccounting } from "../src/accounting.mjs";

function context(overrides = {}) {
  return { runId: "run-one", agent: { id: "developer", companyId: "company-a", name: "Developer" },
    config: { image: `sha256:${"a".repeat(64)}`, model: "fixture/model", env: { OPENAI_API_KEY: "model-secret", PAPERCLIP_API_KEY: "forged" } },
    runtime: { sessionId: null, sessionParams: null, taskKey: "ticket-one" },
    context: { taskId: "ticket-one", executionWorkspaceId: "workspace-one", paperclipWorkspace: { cwd: "/tmp/factory-repo" } },
    executionTarget: { kind: "remote", transport: "sandbox", providerKey: "ompig_factory", remoteCwd: "/workspace", runner: {} },
    authToken: "minted-run-token", onLog: async () => {}, stopRemoteStartup: async () => {}, ...overrides };
}

function runtime(overrides = {}) {
  return {
    probe: async () => ({ exitCode: 0, timedOut: false, stdout: `sha256:${"a".repeat(64)}` }),
    prepare: async () => ({ workspaceRemoteDir: "/workspace/repo", runtimeRootDir: "/workspace/runtime", assetDirs: { launcher: "/workspace/runtime/launcher" }, restoreWorkspace: async () => {} }),
    bridge: async () => null,
    run: async (runId, target, command, args, options) => {
      options.onProcessStopped();
      await options.onLog("stdout", JSON.stringify({ type: "ompig.result", receipt: { request_id: runId, status: "done", answer: "Changes ready", usage: [{ input_tokens: 20, output_tokens: 5, cost_usd: 0.01 }] } }) + "\n");
      return { exitCode: 0, signal: null, timedOut: false };
    }, ...overrides,
  };
}

test("adapter dispatches private per-run workdesks and preserves minted runtime credentials", async () => {
  const assignments = [];
  const deps = runtime();
  const run = deps.run;
  deps.run = async (...args) => {
    const options = args.at(-1);
    assignments.push(JSON.parse(options.stdin));
    assert.equal(options.env.PAPERCLIP_API_KEY, "minted-run-token");
    assert.equal(options.env.OPENAI_API_KEY, "model-secret");
    return run(...args);
  };
  const adapter = createServerAdapter(deps);
  const [first, second] = await Promise.all([adapter.execute(context()), adapter.execute(context({ runId: "run-two" }))]);
  assert.equal(first.exitCode, 0); assert.equal(second.exitCode, 0);
  assert.notEqual(assignments[0].runId, assignments[1].runId);
  assert.equal(first.resultJson.accepted, false);
  assert.equal(first.costUsd, 0.01);
  assert.equal(first.usageComplete, true);
});

test("copyback follows verified provider stop and collection", async () => {
  const order = [];
  const adapter = createServerAdapter(runtime({ prepare: async () => ({ workspaceRemoteDir: "/workspace", runtimeRootDir: "/runtime", assetDirs: { launcher: "/launcher" },
    restoreWorkspace: async () => order.push("restore") }), bridge: async () => ({ env: {}, stop: async () => order.push("bridge-stop") }) }));
  await adapter.execute(context({ onProviderStopped: async () => order.push("collect") }));
  assert.deepEqual(order, ["collect", "bridge-stop", "restore"]);
});

test("cancellation awaits exact sandbox termination and never copies back an interrupted writer", async () => {
  const controller = new AbortController();
  let stopped = false, restored = false, collected = false;
  const adapter = createServerAdapter(runtime({
    prepare: async () => ({ assetDirs: { launcher: "/launcher" }, restoreWorkspace: async () => { restored = true; } }),
    run: async () => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 10)); return { exitCode: 137, signal: "SIGKILL", timedOut: false }; },
  }));
  const result = await adapter.execute(context({ signal: controller.signal,
    stopRemoteStartup: async () => { await new Promise(resolve => setTimeout(resolve, 15)); stopped = true; },
    onProviderStopped: async () => { assert.equal(stopped, true); collected = true; } }));
  assert.equal(stopped, true); assert.equal(collected, true); assert.equal(restored, false);
  assert.equal(result.errorCode, "cancelled");
});

test("transport loss does not copy back without verified termination", async () => {
  let restored = false;
  const adapter = createServerAdapter(runtime({ prepare: async () => ({ assetDirs: { launcher: "/launcher" }, restoreWorkspace: async () => { restored = true; } }),
    run: async () => { throw new Error("lost stream"); } }));
  await assert.rejects(adapter.execute(context()), /lost stream/);
  assert.equal(restored, false);
});

test("another agent image is rejected before the harness or workspace staging starts", async () => {
  const adapter = createServerAdapter(runtime({ probe: async () => ({ exitCode: 0, stdout: `sha256:${"b".repeat(64)}` }),
    prepare: async () => assert.fail("must not stage into a different image") }));
  await assert.rejects(adapter.execute(context()), { code: "factory_agent_image_mismatch" });
});

test("unsupported local targets fail before dispatch", async () => {
  const adapter = createServerAdapter(runtime({ run: async () => { assert.fail("must not run locally"); } }));
  await assert.rejects(adapter.execute(context({ executionTarget: { kind: "local" } })), { code: "factory_requires_worker_pool_environment" });
});

test("JSONL accounting handles split and replayed events without double counting final receipts", async () => {
  const checkpoints = [];
  const accounting = createAccounting("run-one", async checkpoint => checkpoints.push(checkpoint));
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, cost_usd: 0.05 };
  const event = JSON.stringify({ type: "ompig.event", event: { type: "usage", id: "1:0:0", usage } }) + "\n";
  await accounting.consume(event.slice(0, 10));
  await accounting.consume(event.slice(10) + event);
  await accounting.consume(JSON.stringify({ type: "ompig.result", receipt: { request_id: "run-one", status: "done", usage: [usage] } }));
  const result = await accounting.finish();
  assert.equal(checkpoints.length, 2);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.cachedInputTokens, 3);
  assert.equal(result.costUsd, 0.05);
});

test("missing usage is incomplete and unpriced, never claimed free", async () => {
  const accounting = createAccounting("run-one");
  await accounting.consume(JSON.stringify({ type: "ompig.result", receipt: { request_id: "run-one", status: "done" } }));
  const result = await accounting.finish();
  assert.equal(result.costUsd, null);
  assert.equal(result.usageComplete, false);
});

test("receipt for another assignment is rejected", async () => {
  const accounting = createAccounting("run-one");
  await assert.rejects(accounting.consume(JSON.stringify({ type: "ompig.result", receipt: { request_id: "other", status: "done" } }) + "\n"), { code: "factory_invalid_ompig_receipt" });
});
