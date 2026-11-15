import { requireValue } from "./protocol.mjs";

const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Durable receipts and events are separate snapshots, never additive sources of the same usage. */
export function summarizeUsage(reports) {
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  let costUsd = 0;
  let priced = reports.length > 0;
  for (const report of reports) {
    usage.inputTokens += number(report.input_tokens) + number(report.cache_write_tokens);
    usage.outputTokens += number(report.output_tokens);
    usage.cachedInputTokens += number(report.cache_read_tokens);
    usage.cacheWriteTokens += number(report.cache_write_tokens);
    if (typeof report.cost_usd !== "number" || !Number.isFinite(report.cost_usd) || report.cost_usd < 0) priced = false;
    else costUsd += report.cost_usd;
  }
  return { usage, costUsd: priced ? costUsd : null, costStatus: priced ? "reported" : "unpriced", usageBasis: "per_run", billingType: "unknown" };
}

/** JSONL can split anywhere. Replayed committed event IDs do not double-charge a run. */
export function createAccounting(runId, onUsage) {
  let pending = "";
  const seen = new Set();
  const reports = [];
  let result = null;
  let snapshot = summarizeUsage([]);
  async function line(text) {
    let value;
    try { value = JSON.parse(text); } catch { return; }
    if (value.type === "ompig.event" && value.event?.type === "usage" && typeof value.event.id === "string" && !seen.has(value.event.id)) {
      seen.add(value.event.id);
      if (value.event.usage && typeof value.event.usage === "object") reports.push(value.event.usage);
      snapshot = summarizeUsage(reports);
      await onUsage?.({ ...snapshot, attemptId: runId, complete: false });
    }
    if (value.type === "ompig.result") {
      requireValue(value.receipt?.request_id === runId && ["done", "unanswered"].includes(value.receipt?.status), "factory_invalid_ompig_receipt", 502);
      result = value.receipt;
      if (Array.isArray(result.usage)) snapshot = summarizeUsage(result.usage);
      await onUsage?.({ ...snapshot, attemptId: runId, complete: Array.isArray(result.usage) });
    }
  }
  return {
    async consume(chunk) {
      pending += chunk;
      requireValue(Buffer.byteLength(pending) <= 8 * 1024 * 1024, "factory_ompig_output_limit", 413);
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const next = pending.slice(0, index);
        pending = pending.slice(index + 1);
        await line(next);
      }
    },
    async finish() { if (pending) { await line(pending); pending = ""; } return { receipt: result, ...snapshot, usageComplete: Array.isArray(result?.usage) }; },
  };
}
