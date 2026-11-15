import { createHash } from "node:crypto";

export const LEASE_SCHEMA = "paperclip/ompig-factory-lease/v1";
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const identifier = /^[a-zA-Z0-9_-]{1,160}$/;
export const leaseIdentifier = /^[a-f0-9]{64}$/;

/** Transport errors carry public codes, never provider output or credentials. */
export class FactoryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition, code, status = 400) {
  if (!condition) throw new FactoryError(code, status);
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Tags are mutable. Accept registry digests or a preloaded local image ID only. */
export function isImmutableImage(value) {
  return typeof value === "string" && /^(?:[a-zA-Z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/.test(value);
}

export function requireId(value) {
  requireValue(typeof value === "string" && identifier.test(value), "factory_invalid_identifier");
  return value;
}

export function integer(value, min, max, code) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max, code);
  return value;
}

/** Only private encrypted-overlay HTTP or authenticated HTTPS origins are accepted. */
export function workerOrigin(value) {
  const url = new URL(value);
  const octets = url.hostname.split(".").map(Number);
  const overlay = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  requireValue(url.protocol === "https:" || (url.protocol === "http:"
    && (overlay || ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))), "factory_worker_requires_private_transport");
  requireValue(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "factory_invalid_worker_origin");
  return url.origin;
}

export function workerKey(origin) {
  return digest(origin).slice(0, 16);
}

/** Placement is stable across plugin restarts; only definite full responses permit fallback. */
export function rankedWorkers(workers, assignment) {
  return [...workers].sort((a, b) => digest(assignment + a).localeCompare(digest(assignment + b)));
}

export function leaseId(origin, companyId, environmentId, operationId) {
  return workerKey(origin) + digest(JSON.stringify([companyId, environmentId, operationId])).slice(0, 48);
}
