import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, chown, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openWorker } from "../src/worker.mjs";
import { digest, isImmutableImage } from "../src/protocol.mjs";

const image = process.env.PAPERCLIP_FACTORY_DOCKER_IMAGE;
const brokerImage = process.env.PAPERCLIP_FACTORY_BROKER_IMAGE;
test("real Compose broker: two durable clones sync profiles, resolve remote credentials, and fail closed on lost broker auth", {
  skip: !image || !brokerImage, timeout: 120_000,
}, async t => {
  assert.equal(process.getuid(), 0, "Run this opt-in test with rootful Docker and real Node 24.");
  assert.ok(isImmutableImage(image) && isImmutableImage(brokerImage));
  const directory = await mkdtemp(path.join(tmpdir(), "pc-factory-broker-"));
  const project = "pcbroker" + randomUUID().replaceAll("-", "").slice(0, 12);
  const network = project + "-isolated";
  const bridge = project.slice(0, 15);
  const firewall = [];
  const iptables = args => execFileSync("/usr/sbin/iptables", ["-w", ...args], { stdio: "pipe" });
  const docker = args => execFileSync("/usr/bin/docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  docker(["network", "create", "--internal", "--opt", "com.docker.network.bridge.enable_icc=false", "--opt", `com.docker.network.bridge.name=${bridge}`, network]);
  const [networkInfo] = JSON.parse(docker(["network", "inspect", network]));
  const gateway = networkInfo.IPAM.Config[0].Gateway;
  let worker, model, compose;
  t.after(async () => {
    if (worker) {
      for (const row of worker.store.all()) await worker.engine.destroy(row);
      await worker.close();
    }
    if (compose) compose(["down", "--volumes"]);
    if (model) await new Promise(resolve => model.close(resolve));
    for (const rule of firewall) iptables(["-D", "INPUT", ...rule]);
    docker(["network", "rm", network]);
    await rm(directory, { recursive: true, force: true });
  });
  const bearer = randomUUID() + randomUUID();
  const modelKey = "synthetic-model-" + randomUUID();
  let calls = 0;
  model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume bounded synthetic prompts */ }
    if (request.headers.authorization !== `Bearer ${modelKey}`) { response.writeHead(401); response.end(); return; }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "broker-backed clone verified" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]) response.write("data: " + JSON.stringify(frame) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => model.listen(0, gateway, resolve));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, gateway, resolve));
  const brokerPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  // The real host may reject bridge -> host traffic. Open ONLY these fixture
  // endpoints on this temporary bridge; never weaken an unrelated host rule.
  for (const port of [brokerPort, model.address().port]) {
    const rule = ["-i", bridge, "-d", gateway, "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"];
    iptables(["-I", "INPUT", "1", ...rule]); firewall.push(rule);
  }
  const tokenFile = path.join(directory, "broker-token");
  await writeFile(tokenFile, bearer, { mode: 0o400 }); await chown(tokenFile, 10001, 10001);
  const env = { ...process.env, OMPIG_BROKER_IMAGE: brokerImage, OMPIG_BROKER_TOKEN_FILE: tokenFile,
    FACTORY_BROKER_BIND_IP: gateway, FACTORY_BROKER_PORT: String(brokerPort) };
  compose = args => execFileSync("/usr/bin/docker", ["compose", "--project-name", project, "-f",
    fileURLToPath(new URL("../compose.yml", import.meta.url)), ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  compose(["up", "-d", "--wait", "--wait-timeout", "40"]);
  const origin = `http://${gateway}:${brokerPort}`;
  const api = async (route, method = "GET", body, extra = {}) => {
    const response = await fetch(origin + route, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `Fixture broker ${route} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  assert.equal((await fetch(origin + "/v1/snapshot")).status, 401);
  await api("/v1/credential", "POST", { operation: "save", provider: "factory-broker-fixture", explicit: true,
    accountKey: null, credential: { type: "api_key", key: modelKey } });
  const document = await api("/v1/items/models.json");
  const models = { providers: { "factory-broker-fixture": {
    api: "openai-completions", baseUrl: `http://${gateway}:${model.address().port}/v1`,
    models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
  } } };
  await api("/v1/items/models.json", "PUT", { data: Buffer.from(JSON.stringify(models)).toString("base64") }, { "if-match": `"${document.revision}"` });
  worker = await openWorker({ workerId: project, dataDir: path.join(directory, "worker"), slots: 2,
    memoryMiB: 512, cpusPerSlot: 0.5, network, images: [image], minFreeBytes: 0,
    clients: [{ companyId: "broker-test-company", token: "worker-management-token-".repeat(3), broker: { url: origin, token: bearer } }] });
  const leases = await Promise.all(["one", "two"].map(runId => worker.acquire({ id: digest(project + runId), runId,
    agentId: "broker-test-agent", environmentId: "broker-test-env", image }, "broker-test-company")));
  const execute = (lease, command, args, stdin) => worker.execute(lease.id, "broker-test-company", "broker-test-env", { command, args, stdin, timeoutMs: 35_000 });
  const launcher = await readFile(new URL("../src/clone-entrypoint.mjs", import.meta.url), "utf8");
  for (const lease of leases) {
    const upload = await execute(lease, "node", ["-e", "require('node:fs').writeFileSync('/workspace/clone-entrypoint.mjs',require('node:fs').readFileSync(0))"], launcher);
    assert.equal(upload.exitCode, 0, upload.stderr);
  }
  const run = (lease, runId) => execute(lease, "node", ["/workspace/clone-entrypoint.mjs"], JSON.stringify({ runId, cwd: "/workspace",
    model: "factory-broker-fixture/fixture", maxTurns: 2, prompt: "Confirm broker-backed inference." }));
  const results = await Promise.all(leases.map((lease, index) => run(lease, "broker-clone-" + index)));
  for (const result of results) {
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(result.stdout.includes('"status":"done"'), result.stdout);
    assert.ok(!result.stdout.includes(bearer) && !result.stderr.includes(bearer));
  }
  assert.equal(calls, 2, "Both clones must authenticate to the model using the credential available ONLY in the broker vault.");
  for (const [index, lease] of leases.entries()) {
    const profile = `/state/broker-clone-${index}/profile/agent`;
    const check = await execute(lease, "/bin/sh", ["-c", `test -f ${profile}/models.json && test ! -f ${profile}/agent.db && test ! -f ${profile}/auth.json`]);
    assert.equal(check.exitCode, 0, "Broker clients must not create a local credential vault.");
  }
  worker.config.clients[0].broker.token = "wrong-broker-token-".repeat(4);
  const refused = await run(leases[0], "broker-refused");
  assert.notEqual(refused.exitCode, 0); assert.match(refused.stderr, /factory_broker_unavailable/); assert.equal(calls, 2);
  worker.config.clients[0].broker.token = bearer;
  compose(["stop", "broker"]);
  const offline = await run(leases[0], "broker-offline");
  assert.notEqual(offline.exitCode, 0); assert.match(offline.stderr, /factory_broker_unavailable/); assert.equal(calls, 2);
  compose(["up", "-d", "--wait", "--wait-timeout", "40"]);
  assert.equal((await run(leases[0], "broker-after-restart")).exitCode, 0);
  assert.equal(calls, 3, "Vault and profile must survive the broker restart without re-importing a key.");
});
