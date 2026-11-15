import { PluginEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { FactoryError, LEASE_SCHEMA, digest, integer, isImmutableImage, leaseId, leaseIdentifier, rankedWorkers, requireId, requireValue, workerKey, workerOrigin } from "./protocol.mjs";

export function providerConfig(raw) {
  requireValue(Array.isArray(raw.workers) && raw.workers.length > 0 && raw.workers.length <= 100, "factory_workers_required");
  const workers = raw.workers.map(workerOrigin);
  requireValue(new Set(workers).size === workers.length, "factory_duplicate_worker");
  requireValue(typeof raw.workerToken === "string" && raw.workerToken.length >= 32, "factory_worker_token_required");
  requireValue(isImmutableImage(raw.image), "factory_image_digest_required");
  requireValue(raw.model === undefined || typeof raw.model === "string" && raw.model.trim().includes("/")
    && raw.model.trim().length <= 300, "factory_model_required");
  return { workers, workerToken: raw.workerToken, image: raw.image, reuseLease: raw.reuseLease === true,
    ...(raw.model === undefined ? {} : { model: raw.model.trim() }),
    timeoutMs: integer(raw.timeoutMs ?? 3_600_000, 1, 86_400_000, "factory_invalid_timeout") };
}

/** The endpoint is configuration, not a value returned by a sandbox or task. Never follow redirects. */
export async function workerRequest(origin, token, route, { method = "GET", body, timeoutMs = 60_000, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(origin + route, { method, redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const result = await response.json();
  if (!response.ok) throw new FactoryError(typeof result.code === "string" && /^factory_[a-z_]+$/.test(result.code)
    ? result.code : "factory_worker_request_failed", response.status);
  return result;
}

function endpoint(config, id) {
  requireValue(typeof id === "string" && leaseIdentifier.test(id), "factory_invalid_lease_id");
  const origin = config.workers.find(origin => workerKey(origin) === id.slice(0, 16));
  requireValue(origin, "factory_lease_worker_missing", 409);
  return origin;
}

function lease(result, origin, config) {
  requireValue(result.image === config.image && typeof result.expiresAt === "string", "factory_lease_identity_mismatch", 409);
  return { providerLeaseId: result.id, expiresAt: result.expiresAt,
    metadata: { schema: LEASE_SCHEMA, provider: "ompig_factory", workerKey: workerKey(origin), image: result.image, remoteCwd: "/workspace" } };
}

function validateLease(config, id, metadata) {
  const origin = endpoint(config, id);
  if (metadata?.failedCreateCleanup) {
    const cleanup = metadata.failedCreateCleanup;
    requireValue(cleanup.providerLeaseId === id && cleanup.accountFingerprint === digest(config.workerToken), "factory_cleanup_identity_mismatch", 409);
  } else {
    requireValue(metadata?.schema === LEASE_SCHEMA, "factory_lease_schema_unsupported", 409);
    requireValue(metadata.image === config.image && metadata.workerKey === workerKey(origin), "factory_lease_identity_mismatch", 409);
  }
  return origin;
}

/** All hooks implement the existing provider contract; Core retains workspace/run authority. */
export function createProvider({ fetchImpl = fetch } = {}) {
  const shutdown = new AbortController();
  const request = (config, origin, route, options = {}) => workerRequest(origin, config.workerToken, route, { fetchImpl, ...options,
    signal: options.signal ? AbortSignal.any([shutdown.signal, options.signal]) : shutdown.signal });
  const routeFor = params => `/v1/leases/${params.providerLeaseId}?environmentId=${encodeURIComponent(requireId(params.environmentId))}`;
  const callLease = async (params, method = "GET", action = "", body) => {
    const config = providerConfig(params.config);
    const id = params.providerLeaseId ?? params.lease?.providerLeaseId;
    const metadata = params.leaseMetadata ?? params.lease?.metadata;
    const origin = validateLease(config, id, metadata);
    const route = routeFor({ ...params, providerLeaseId: id }).replace("?", action + "?");
    return await request(config, origin, route, { method, body,
      timeoutMs: action === "/exec" ? (body?.timeoutMs ?? config.timeoutMs) + 30_000 : 60_000 });
  };

  const handlers = {
    async onShutdown() { shutdown.abort(); },
    async onEnvironmentValidateConfig(params) {
      try { return { ok: true, normalizedConfig: providerConfig(params.config) }; }
      catch (error) { return { ok: false, errors: [error.code ?? "factory_invalid_configuration"] }; }
    },

    async onEnvironmentProbe(params) {
      try {
        const config = providerConfig(params.config);
        const workers = await Promise.all(config.workers.map(origin => request(config, origin, "/v1/capacity")));
        return { ok: workers.some(worker => !worker.draining && worker.images?.includes(config.image)),
          summary: "Worker inventory checked without allocating a sandbox.", metadata: { workers } };
      } catch { return { ok: false, summary: "Factory workers unavailable or unauthorized." }; }
    },

    async onEnvironmentAcquireLease(params) {
      const config = providerConfig(params.config);
      const operation = params.creationOperationId ?? params.runId;
      requireId(params.companyId); requireId(params.environmentId); requireId(operation);
      // Core's explicit platform probe has no saved agent. Keep its container
      // ownership tied to this creation operation; ordinary runs still require an agent.
      const agentId = params.agentId ?? (params.resolveSnapshotIdentity === true ? `probe-${operation}` : null);
      requireValue(agentId, "factory_agent_required");
      const deadline = Date.now() + config.timeoutMs;
      while (Date.now() < deadline) {
        for (const origin of rankedWorkers(config.workers, operation)) {
          if (Date.now() >= deadline) break;
          const id = leaseId(origin, params.companyId, params.environmentId, operation);
          try {
            const result = await request(config, origin, "/v1/leases", { method: "POST", timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())), body: {
              id, environmentId: params.environmentId, runId: params.runId, agentId,
              image: config.image, expiresAt: params.requestedExpiresAt,
            } });
            requireValue(result.id === id && result.state === "running", "factory_invalid_lease_response", 503);
            return lease(result, origin, config);
          } catch (error) {
            // Only these explicit pre-allocation rejections prove another worker is safe to try.
            if (error instanceof FactoryError && error.status === 409
              && ["factory_slots_full", "factory_worker_draining", "factory_disk_reserve"].includes(error.code)) continue;
            if (error instanceof FactoryError && error.status < 500) throw error;
            throw new PluginEnvironmentCreationCleanupError([], "Factory allocation requires exact-worker cleanup before retry.", {
              providerLeaseId: id, companyId: params.companyId, environmentId: params.environmentId,
              runId: params.runId, attemptId: params.creationOperationId ?? randomUUID(),
              accountFingerprint: digest(config.workerToken), labels: { "paperclip-provider": "ompig-factory", "paperclip-lease": id },
            });
          }
        }
        // These are active, bounded acquisition waits. No configured-but-idle polling exists.
        const controller = new AbortController();
        try {
          const waitMs = Math.max(1, Math.min(25_000, deadline - Date.now()));
          await Promise.any(config.workers.map(async origin => {
            const capacity = await request(config, origin, `/v1/capacity?waitForSlot=true&timeoutMs=${waitMs}`,
              { timeoutMs: waitMs + 5000, signal: controller.signal });
            requireValue(!capacity.draining, "factory_worker_draining", 503);
            return capacity;
          }));
        } catch { throw new FactoryError("factory_slots_full", 503); }
        finally { controller.abort(); }
      }
      throw new FactoryError("factory_slots_full", 503);
    },

    async onEnvironmentResumeLease(params) {
      const config = providerConfig(params.config);
      const origin = validateLease(config, params.providerLeaseId, params.leaseMetadata);
      const observed = await callLease(params);
      if (observed.state === "destroyed") return { providerLeaseId: null, metadata: { expired: true } };
      const result = observed.state === "active" ? { ...observed, state: "running" } : await callLease(params, "POST", "/resume", {});
      return lease(result, origin, config);
    },

    async onEnvironmentInspectLease(params) {
      const result = await callLease(params);
      return { providerLeaseId: params.providerLeaseId, state: result.state };
    },

    async onEnvironmentStopLease(params) {
      const result = await callLease(params, "POST", "/stop", {});
      requireValue(["stopped", "destroyed"].includes(result.state), "factory_stop_unconfirmed", 503);
      return { providerLeaseId: params.providerLeaseId, state: result.state };
    },

    async onEnvironmentReleaseLease(params) {
      if (!params.providerLeaseId) return;
      const config = providerConfig(params.config);
      if (params.resourceDisposition === "stop_and_retain" || config.reuseLease) return await handlers.onEnvironmentStopLease(params);
      return await handlers.onEnvironmentDestroyLease(params);
    },

    async onEnvironmentDestroyLease(params) {
      if (!params.providerLeaseId) return;
      const result = await callLease(params, "DELETE");
      requireValue(result.state === "destroyed", "factory_destroy_unconfirmed", 503);
      return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
    },

    async onEnvironmentRealizeWorkspace(params) {
      // Core stages/copies back through its validated fallback; the provider doesn't invent a second Git protocol.
      await callLease({ ...params, providerLeaseId: params.lease.providerLeaseId, leaseMetadata: params.lease.metadata });
      return { cwd: "/workspace", metadata: { provider: "ompig_factory" } };
    },

    async onEnvironmentExecute(params) {
      const config = providerConfig(params.config);
      return await callLease(params, "POST", "/exec", {
        command: params.command, args: params.args, env: params.env, stdin: params.stdin, cwd: params.cwd,
        timeoutMs: params.timeoutMs > 0 ? params.timeoutMs : config.timeoutMs,
      });
    },
  };
  return handlers;
}
