import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const compose = fileURLToPath(new URL("../compose.yml", import.meta.url));
const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
test("broker Compose isolates its vault, binds only the private gateway, and receives its bearer from a file", { skip: !composeAvailable }, () => {
  const env = { ...process.env, OMPIG_BROKER_IMAGE: `broker@sha256:${"a".repeat(64)}`,
    OMPIG_BROKER_TOKEN_FILE: "/tmp/factory-compose-test-token", FACTORY_BROKER_BIND_IP: "172.30.250.1" };
  const config = JSON.parse(execFileSync("docker", ["compose", "-f", compose, "config", "--format", "json"], { env, encoding: "utf8" }));
  const broker = config.services.broker;
  assert.equal(broker.image, env.OMPIG_BROKER_IMAGE);
  assert.equal(broker.network_mode, "host");
  assert.equal(broker.environment.BROKER_BIND_IP, "172.30.250.1");
  assert.equal(broker.environment.OMPIG_BROKER_TOKEN, undefined);
  assert.equal(broker.user, "10001:10001");
  assert.equal(broker.read_only, true);
  assert.equal(broker.restart, "unless-stopped");
  assert.equal(broker.ports, undefined);
  assert.deepEqual(broker.secrets.map(secret => secret.source), ["broker_token"]);
  assert.deepEqual(broker.volumes.map(volume => volume.target), ["/data"]);
  assert.match(broker.command.join(" "), /cat \/run\/secrets\/broker_token/);
  assert.match(broker.command.join(" "), /exec ompig-slim-broker/);
  assert.ok(broker.healthcheck.test.join(" ").includes("/healthz"));
  assert.ok(!JSON.stringify(broker.volumes).includes("docker.sock"));
});
