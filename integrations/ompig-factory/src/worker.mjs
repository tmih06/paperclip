import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, chmod, statfs, rm } from "node:fs/promises";
import path from "node:path";
import { DockerEngine } from "./docker.mjs";
import { LeaseStore } from "./store.mjs";
import { FactoryError, digest, integer, isImmutableImage, leaseIdentifier, MAX_BODY_BYTES, requireId, requireValue } from "./protocol.mjs";

export function validateWorkerConfig(raw) {
  requireValue(path.isAbsolute(raw.dataDir ?? "") && !raw.dataDir.includes(","), "factory_invalid_data_directory");
  requireValue(Array.isArray(raw.clients) && raw.clients.length > 0 && raw.clients.every(client =>
    typeof client.token === "string" && client.token.length >= 32 && requireId(client.companyId)), "factory_invalid_clients");
  requireValue(new Set(raw.clients.map(client => client.token)).size === raw.clients.length, "factory_duplicate_client_token");
  requireValue(Array.isArray(raw.images) && raw.images.length > 0 && raw.images.every(isImmutableImage), "factory_images_require_digests");
  requireValue(typeof raw.cpusPerSlot === "number" && raw.cpusPerSlot > 0 && raw.cpusPerSlot <= 128, "factory_invalid_cpu_limit");
  const network = raw.network ?? "none";
  requireValue(network === "none" || /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(network)
    && !["host", "bridge", "default"].includes(network), "factory_requires_dedicated_network");
  requireValue(raw.dns == null || Array.isArray(raw.dns) && raw.dns.length > 0 && raw.dns.every(address =>
    typeof address === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)
      && address.split(".").every(octet => Number(octet) <= 255)), "factory_invalid_dns");
  const clients = raw.clients.map(client => {
    if (!client.broker) return client;
    const url = new URL(client.broker.url);
    const octets = url.hostname.split(".").map(Number);
    const privateAddress = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
      && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
    requireValue(url.protocol === "https:" || (url.protocol === "http:" && privateAddress), "factory_broker_requires_private_transport");
    requireValue(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "factory_invalid_broker_origin");
    requireValue(typeof client.broker.token === "string" && client.broker.token.length >= 32, "factory_broker_token_required");
    return { ...client, broker: { url: url.origin, token: client.broker.token } };
  });
  const config = {
    ...raw, clients, dataDir: path.resolve(raw.dataDir), network,
    slots: integer(raw.slots, 1, 256, "factory_invalid_slots"),
    memoryMiB: integer(raw.memoryMiB, 64, 1_048_576, "factory_invalid_memory_limit"),
    leaseMs: integer(raw.leaseMs ?? 3_600_000, 1000, 86_400_000, "factory_invalid_lease_duration"),
    minFreeBytes: integer(raw.minFreeBytes ?? 2 * 1024 ** 3, 0, Number.MAX_SAFE_INTEGER, "factory_invalid_disk_reserve"),
    dockerBinary: raw.dockerBinary ?? "/usr/bin/docker",
    dockerHost: raw.dockerHost ?? "unix:///var/run/docker.sock",
    dockerConfig: raw.dockerConfig ?? path.join(path.resolve(raw.dataDir), "docker-config"),
    workerId: requireId(raw.workerId),
  };
  requireValue(path.isAbsolute(config.dockerBinary) && path.isAbsolute(config.dockerConfig)
    && config.dockerHost.startsWith("unix:///"), "factory_requires_local_docker");
  return config;
}

/** The worker owns slots and exact container termination; it never assigns tickets. */
export class FactoryWorker {
  constructor(config, store, engine) {
    this.config = config;
    this.store = store;
    this.engine = engine;
    this.locks = new Map();
    this.deadlines = new Map();
    this.waiters = new Set();
    this.closed = false;
  }

  async locked(id, work) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  owned(id, companyId, environmentId) {
    requireValue(leaseIdentifier.test(id), "factory_invalid_lease_id");
    const row = this.store.get(id);
    requireValue(row && row.companyId === companyId && row.environmentId === environmentId, "factory_lease_not_found", 404);
    return row;
  }

  expiry(value) {
    const requested = value == null ? Date.now() + this.config.leaseMs : Date.parse(value);
    requireValue(Number.isFinite(requested) && requested > Date.now() + 1000, "factory_invalid_expiry");
    // Round down, matching the in-container guard, never past the host's deadline.
    return Math.floor(Math.min(requested, Date.now() + this.config.leaseMs) / 1000) * 1000;
  }

  publicLease(row) {
    return { id: row.id, state: row.state, image: row.image, expiresAt: new Date(row.expiresAt).toISOString(), workerId: this.config.workerId };
  }

  capacity() {
    return { workerId: this.config.workerId, slots: this.config.slots, occupied: this.store.occupied(),
      draining: this.closed || this.config.draining === true, arch: process.arch, images: this.config.images };
  }

  notifyCapacity() { for (const wake of [...this.waiters]) wake(); }

  /** Active admission requests wait on release events, never scan an idle pool. */
  async waitForSlot(timeoutMs, signal) {
    if (this.capacity().draining || this.store.occupied() < this.config.slots) return this.capacity();
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener("abort", finish); resolve(); };
      const wake = () => { if (this.capacity().draining || this.store.occupied() < this.config.slots) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(wake);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish(); else wake();
    });
    return this.capacity();
  }

  /** Deadline timers exist only for actual allocations or unresolved termination obligations. */
  schedule(row, retryAt) {
    clearTimeout(this.deadlines.get(row.id));
    this.deadlines.delete(row.id);
    if (this.closed || ["stopped", "destroyed"].includes(row.state)) return;
    const timer = setTimeout(async () => {
      this.deadlines.delete(row.id);
      try { await this.stop(row.id, row.companyId, row.environmentId); }
      catch { if (!this.closed) this.schedule(this.store.get(row.id), Date.now() + 60_000); }
    }, Math.max(0, (retryAt ?? row.expiresAt) - Date.now()));
    timer.unref();
    this.deadlines.set(row.id, timer);
  }

  /** Reconstruct obligations before admitting requests; uncertain creates remain capacity reservations. */
  async recover() {
    for (const row of this.store.all()) {
      if (["stopped", "destroyed"].includes(row.state)) continue;
      if (["creating", "stopping", "destroying"].includes(row.state)) this.store.update(row.id, "uncertain");
      this.schedule(this.store.get(row.id));
    }
  }

  async acquire(input, companyId) {
    requireId(input.environmentId); requireId(input.runId); requireId(input.agentId);
    requireValue(leaseIdentifier.test(input.id), "factory_invalid_lease_id");
    requireValue(this.config.images.includes(input.image), "factory_image_not_allowed", 403);
    return await this.locked(input.id, async () => {
      let row = this.store.get(input.id);
      if (row) {
        this.owned(input.id, companyId, input.environmentId);
        requireValue(row.runId === input.runId && row.agentId === input.agentId && row.image === input.image, "factory_assignment_conflict", 409);
        requireValue(row.state === "running" && row.expiresAt > Date.now(), "factory_lease_not_active", 409);
        requireValue((await this.engine.inspect(row))?.State.Running, "factory_lease_not_active", 409);
        return this.publicLease(row);
      }
      requireValue(!this.closed && !this.config.draining, "factory_worker_draining", 409);
      const disk = await statfs(this.config.dataDir);
      requireValue(disk.bavail * disk.bsize >= this.config.minFreeBytes, "factory_disk_reserve", 409);
      row = this.store.reserve({ ...input, companyId, expiresAt: this.expiry(input.expiresAt) }, this.config.slots);
      try {
        await this.engine.create(row);
        row = this.store.update(row.id, "running");
        this.schedule(row);
        return this.publicLease(row);
      } catch (error) {
        // A lost create response is not proof of absence. Hold the slot until exact cleanup is confirmed.
        this.schedule(this.store.update(row.id, "uncertain"));
        throw error;
      }
    });
  }

  async inspect(id, companyId, environmentId) {
    return await this.locked(id, async () => {
      const row = this.owned(id, companyId, environmentId);
      const container = await this.engine.inspect(row);
      return { ...this.publicLease(row), state: container?.State.Running ? "active" : container ? "stopped"
        : ["creating", "uncertain"].includes(row.state) ? "unknown" : "destroyed" };
    });
  }

  async stop(id, companyId, environmentId, destroy = false) {
    return await this.locked(id, async () => {
      requireValue(leaseIdentifier.test(id), "factory_invalid_lease_id");
      requireId(environmentId);
      if (destroy && !this.store.get(id)) return this.publicLease(this.store.tombstone(id, companyId, environmentId));
      let row = this.owned(id, companyId, environmentId);
      if (row.state === "destroyed") return { ...this.publicLease(row), state: "destroyed" };
      // Never free a slot on an absent provisional name while a create may still settle late.
      if (["creating", "uncertain"].includes(row.state)) {
        requireValue(await this.engine.inspect(row), "factory_creation_uncertain", 503);
      }
      row = this.store.update(id, destroy ? "destroying" : "stopping");
      try {
        if (destroy) await this.engine.destroy(row); else await this.engine.stop(row);
        if (destroy) await rm(path.join(this.config.dataDir, "leases", id), { recursive: true, force: true });
        row = this.store.update(id, destroy ? "destroyed" : "stopped");
        this.schedule(row);
        this.notifyCapacity();
        return this.publicLease(row);
      } catch (error) {
        this.schedule(this.store.get(id), Date.now() + 60_000);
        throw error;
      }
    });
  }

  async resume(id, companyId, environmentId) {
    return await this.locked(id, async () => {
      let row = this.owned(id, companyId, environmentId);
      requireValue(row.state === "stopped", "factory_lease_not_stopped", 409);
      requireValue(!this.closed && !this.config.draining, "factory_worker_draining", 409);
      requireValue(this.store.occupied() < this.config.slots, "factory_slots_full", 409);
      row = this.store.update(id, "creating", this.expiry(null));
      try {
        await this.engine.resume(row);
        row = this.store.update(id, "running");
        this.schedule(row);
        return this.publicLease(row);
      } catch (error) { this.schedule(this.store.update(id, "uncertain")); throw error; }
    });
  }

  async execute(id, companyId, environmentId, input) {
    const row = this.owned(id, companyId, environmentId);
    requireValue(row.state === "running" && row.expiresAt > Date.now(), "factory_lease_not_active", 409);
    requireValue(typeof input.command === "string" && input.command.length > 0 && !input.command.includes("\0"), "factory_invalid_command");
    requireValue(input.args == null || Array.isArray(input.args) && input.args.every(arg => typeof arg === "string" && !arg.includes("\0")), "factory_invalid_arguments");
    requireValue(input.stdin == null || typeof input.stdin === "string", "factory_invalid_stdin");
    requireValue(input.env == null || typeof input.env === "object" && !Array.isArray(input.env), "factory_invalid_command_environment");
    requireValue(input.cwd == null || typeof input.cwd === "string" && input.cwd.startsWith("/") && !input.cwd.includes("\0"), "factory_invalid_cwd");
    const timeoutMs = Math.min(integer(input.timeoutMs ?? 60_000, 1, 86_400_000, "factory_invalid_timeout"), Math.max(1, row.expiresAt - Date.now()));
    // Exec is intentionally not in the lifecycle mutex: stop/control commands must interrupt it.
    // Broker credentials are company-owned worker configuration, never image
    // layers, task payloads, Docker argv, or worker-management credentials.
    const broker = this.config.clients.find(client => client.companyId === companyId)?.broker;
    const env = { ...input.env };
    if (broker) {
      delete env.OMPIG_BROKER_TOKEN_FILE;
      Object.assign(env, { OMPIG_BROKER_URL: broker.url, OMPIG_BROKER_TOKEN: broker.token });
    }
    const result = await this.engine.execute(row, { ...input, env, timeoutMs });
    if (result.timedOut) await this.stop(id, companyId, environmentId);
    return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr };
  }

  async close() {
    this.closed = true;
    this.notifyCapacity();
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    await Promise.allSettled(this.locks.values());
    this.store.close();
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    requireValue(size <= MAX_BODY_BYTES, "factory_request_too_large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
  catch { throw new FactoryError("factory_invalid_json"); }
}

/** Authenticated, company-scoped API. No unauthenticated health, inventory or command endpoint. */
export function createWorkerServer(worker) {
  const clients = worker.config.clients.map(client => ({ companyId: client.companyId, tokenHash: Buffer.from(digest(client.token), "hex") }));
  const server = createServer(async (request, response) => {
    try {
      const header = request.headers.authorization;
      const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
      const candidate = Buffer.from(digest(token), "hex");
      const client = clients.find(client => timingSafeEqual(client.tokenHash, candidate));
      requireValue(client, "factory_unauthorized", 401);
      const url = new URL(request.url, "http://worker.invalid");
      let result;
      if (request.method === "GET" && url.pathname === "/v1/capacity") {
        if (url.searchParams.get("waitForSlot") === "true") {
          const controller = new AbortController();
          response.once("close", () => controller.abort());
          result = await worker.waitForSlot(integer(Number(url.searchParams.get("timeoutMs") ?? 25000), 1, 30000, "factory_invalid_wait"), controller.signal);
        } else result = worker.capacity();
      }
      else if (request.method === "POST" && url.pathname === "/v1/leases") result = await worker.acquire(await readBody(request), client.companyId);
      else {
        const match = /^\/v1\/leases\/([a-f0-9]{64})(?:\/(stop|resume|exec))?$/.exec(url.pathname);
        requireValue(match, "factory_route_not_found", 404);
        const [, id, action] = match;
        const environmentId = requireId(url.searchParams.get("environmentId"));
        if (request.method === "GET" && !action) result = await worker.inspect(id, client.companyId, environmentId);
        else if (request.method === "DELETE" && !action) result = await worker.stop(id, client.companyId, environmentId, true);
        else if (request.method === "POST" && action === "stop") result = await worker.stop(id, client.companyId, environmentId);
        else if (request.method === "POST" && action === "resume") result = await worker.resume(id, client.companyId, environmentId);
        else if (request.method === "POST" && action === "exec") result = await worker.execute(id, client.companyId, environmentId, await readBody(request));
        else throw new FactoryError("factory_route_not_found", 404);
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof FactoryError ? error.status : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ code: error instanceof FactoryError ? error.code : "factory_worker_operation_failed" }));
    }
  });
  server.requestTimeout = 30_000;
  return server;
}

export async function openWorker(raw, engine) {
  const config = validateWorkerConfig(raw);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  const docker = engine ?? new DockerEngine(config);
  await docker.validate?.();
  const store = new LeaseStore(path.join(config.dataDir, "leases.sqlite"));
  const worker = new FactoryWorker(config, store, docker);
  try { await worker.recover(); return worker; }
  catch (error) { await worker.close(); throw error; }
}
