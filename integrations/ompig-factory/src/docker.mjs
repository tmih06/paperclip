import { spawn } from "node:child_process";
import { mkdir, chown, chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { FactoryError, MAX_OUTPUT_BYTES, requireValue } from "./protocol.mjs";

/** Docker remains a privileged host operation. No caller supplies flags, mounts or identities. */
export class DockerEngine {
  constructor(config) {
    this.config = config;
  }

  async validate() {
    requireValue(process.platform === "linux" && process.getuid() === 0, "factory_worker_requires_linux_root");
    for (const image of this.config.images) await this.checked(["image", "inspect", image]);
    if (this.config.network !== "none") {
      const [network] = JSON.parse(await this.checked(["network", "inspect", this.config.network]));
      requireValue(network.Driver === "bridge" && network.Options?.["com.docker.network.bridge.enable_icc"] === "false", "factory_network_requires_container_isolation");
    }
  }

  async cli(args, { stdin = "", env = {}, timeoutMs = 60_000 } = {}) {
    const config = this.config;
    // --env KEY reads from this child's environment, keeping values out of argv.
    const childEnv = { ...process.env, ...env, DOCKER_HOST: config.dockerHost };
    delete childEnv.DOCKER_CONTEXT;
    delete childEnv.DOCKER_API_VERSION;
    return await new Promise((resolve, reject) => {
      const child = spawn(config.dockerBinary, ["--host", config.dockerHost, "--config", config.dockerConfig, ...args], {
        env: childEnv, stdio: ["pipe", "pipe", "pipe"],
      });
      let bytes = 0;
      let exceeded = false;
      let timedOut = false;
      const stdout = [], stderr = [];
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      const collect = output => chunk => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) { exceeded = true; child.kill("SIGKILL"); }
        else output.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.stdin.on("error", () => {}); // A terminated exec can close stdin before upload finishes.
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, timedOut, exceeded, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
      });
      child.stdin.end(stdin);
    });
  }

  async checked(args) {
    const result = await this.cli(args);
    if (result.exitCode !== 0 || result.timedOut || result.exceeded) throw new FactoryError("factory_docker_operation_failed", 503);
    return result.stdout;
  }

  name(id) { return `pc-factory-${id}`; }

  /** Missing is proven by Docker's structured inventory, not by interpreting arbitrary stderr. */
  async inspect(row) {
    const ids = (await this.checked(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${this.name(row.id)}$`])).trim();
    if (!ids) return null;
    const [container] = JSON.parse(await this.checked(["container", "inspect", this.name(row.id)]));
    const labels = container.Config.Labels ?? {};
    for (const [key, value] of Object.entries(this.labels(row))) {
      requireValue(labels[key] === value, "factory_container_ownership_mismatch", 409);
    }
    // Docker records the image ID in Config.Image even when create received a
    // registry@digest reference. Compare immutable digest identity, not the
    // presentation form, without accepting mutable tags or doing a registry lookup.
    const configuredDigest = row.image.match(/^.*@sha256:([a-f0-9]{64})$/)?.[1] ?? row.image.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    const observedDigest = container.Config.Image.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    requireValue(container.Config.Image === row.image || Boolean(configuredDigest && observedDigest === configuredDigest), "factory_container_image_mismatch", 409);
    return container;
  }

  labels(row) {
    return { "paperclip-provider": "ompig-factory", "paperclip-worker": this.config.workerId,
      "paperclip-company": row.companyId, "paperclip-environment": row.environmentId, "paperclip-lease": row.id,
      "paperclip-agent": row.agentId, "paperclip-run": row.runId };
  }

  directory(row) { return path.join(this.config.dataDir, "leases", row.id); }

  async prepare(row) {
    const root = this.directory(row);
    // The Docker daemon resolves bind sources using the container's reduced
    // root identity. Keep the ledger itself private, but allow traversal of
    // the lease mount parent; mounted workspace/state/control permissions are
    // still enforced at their targets.
    await chmod(this.config.dataDir, 0o755);
    await chmod(path.dirname(root), 0o755);
    for (const directory of ["workspace", "state"]) {
      await mkdir(path.join(root, directory), { recursive: true, mode: 0o700 });
      await chown(path.join(root, directory), 1000, 1000);
    }
    // Docker bind mounts still require traversal of the host-side lease
    // directory before the container's mount namespace can apply its own
    // target permissions. The directory contains only this lease's mounts.
    await chmod(root, 0o755);
    const control = path.join(root, "control");
    await mkdir(control, { recursive: true, mode: 0o755 });
    // The agent must read the non-secret expiry/image attestation through the
    // bind mount. The lease parent is private to the worker, so grant only
    // this control directory and its two non-secret files to UID 1000.
    await chown(control, 1000, 1000);
    // The mount itself is read-only; permissive source read/traverse modes are
    // necessary because the container has all capabilities dropped and the
    // root guard must read these non-secret deadline/attestation files.
    await chmod(control, 0o777);
    const expires = path.join(control, "expires");
    const image = path.join(control, "image");
    await writeFile(expires, String(Math.floor(row.expiresAt / 1000)), { mode: 0o666 });
    await writeFile(image, row.image, { mode: 0o666 });
    await chown(expires, 1000, 1000);
    await chown(image, 1000, 1000);
  }

  async create(row) {
    await this.prepare(row);
    if (await this.inspect(row)) return;
    // Preload/pull approved images administratively. Admission never runs an uncontrolled pull.
    await this.checked(["image", "inspect", row.image]);
    const root = this.directory(row);
    const labels = Object.entries(this.labels(row)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    await this.checked(["container", "create", "--name", this.name(row.id), ...labels,
      "--pull", "never", "--restart", "no", "--init", "--user", "0:0", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--pids-limit", "512",
      "--cpus", String(this.config.cpusPerSlot), "--memory", `${this.config.memoryMiB}m`,
      "--memory-swap", `${this.config.memoryMiB}m`, "--network", this.config.network,
      ...(this.config.dns ?? []).flatMap(address => ["--dns", address]),
      "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=2",
      "--mount", `type=bind,src=${path.join(root, "workspace")},dst=/workspace`,
      "--mount", `type=bind,src=${path.join(root, "state")},dst=/state`,
      "--mount", `type=bind,src=${path.join(root, "control")},dst=/run/factory-control,readonly`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
      "--tmpfs", "/home/agent:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700",
      "--workdir", "/workspace", "--env", "HOME=/home/agent", "--entrypoint", "/bin/sh", row.image,
      "-c", 'delay=$(( $(/bin/cat /run/factory-control/expires) - $(/bin/date +%s) )); [ "$delay" -gt 0 ] && exec /bin/sleep "$delay"']);
    // A root, capability-free lifetime guard cannot be SIGSTOPed by UID 1000 agent commands.
    // Its absolute deadline also terminates the PID namespace if the worker daemon is down.
    await this.checked(["container", "start", this.name(row.id)]);
    requireValue((await this.inspect(row))?.State.Running, "factory_container_not_running", 503);
  }

  async resume(row) {
    requireValue(await this.inspect(row), "factory_sandbox_missing", 410);
    await this.prepare(row);
    await this.checked(["container", "start", this.name(row.id)]);
    requireValue((await this.inspect(row))?.State.Running, "factory_container_not_running", 503);
  }

  async stop(row) {
    const container = await this.inspect(row);
    if (container?.State.Running) {
      // Kill the whole cgroup/PID namespace, not merely the docker-exec client.
      await this.checked(["container", "kill", "--signal", "KILL", this.name(row.id)]);
    }
    requireValue(!(await this.inspect(row))?.State.Running, "factory_stop_unconfirmed", 503);
  }

  async destroy(row) {
    await this.stop(row);
    if (await this.inspect(row)) await this.checked(["container", "rm", this.name(row.id)]);
    requireValue(await this.inspect(row) === null, "factory_destroy_unconfirmed", 503);
  }

  async execute(row, input) {
    requireValue((await this.inspect(row))?.State.Running, "factory_lease_not_active", 409);
    const env = input.env ?? {};
    requireValue(Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && !/^(DOCKER_|LD_|DYLD_)/.test(key) && typeof value === "string" && !value.includes("\0")), "factory_invalid_command_environment");
    const result = await this.cli(["container", "exec", "--interactive", "--user", "1000:1000",
      "--workdir", input.cwd ?? "/workspace", ...Object.keys(env).flatMap(key => ["--env", key]),
      this.name(row.id), input.command, ...(input.args ?? [])], { stdin: input.stdin, env, timeoutMs: input.timeoutMs });
    // A killed client says nothing about the remote command. Stop must be confirmed first.
    if (result.timedOut || result.exceeded) await this.stop(row);
    if (result.exceeded) throw new FactoryError("factory_command_output_limit", 413);
    return result;
  }
}
