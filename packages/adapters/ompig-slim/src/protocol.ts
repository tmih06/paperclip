export interface DurableReceipt {
  request_id: string;
  status: "pending" | "placed" | "queued" | "done" | "unanswered";
  answer?: string;
  reason?: string;
  usage?: unknown[];
  events?: unknown[];
  progress?: unknown;
}
export function parseDurableReceipt(stdout: string, requestId: string): DurableReceipt | null {
  let receipt: DurableReceipt | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value && value.request_id === requestId && ["pending", "placed", "queued", "done", "unanswered"].includes(value.status)) receipt = { request_id: requestId, status: value.status,
        answer: typeof value.answer === "string" ? value.answer : undefined, reason: typeof value.reason === "string" ? value.reason : undefined,
        usage: Array.isArray(value.usage) ? value.usage : [], progress: value.progress };
    } catch { /* Non-JSON diagnostic, not a receipt. */ }
  }
  return receipt;
}
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function durableUsage(receipt: DurableReceipt | null) {
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  let costUsd: number | null = null;
  for (const item of receipt?.usage ?? []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    usage.inputTokens += count(row.input_tokens) + count(row.cache_write_tokens);
    usage.outputTokens += count(row.output_tokens);
    usage.cachedInputTokens += count(row.cache_read_tokens);
    usage.cacheWriteTokens += count(row.cache_write_tokens);
    if (typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0) costUsd = (costUsd ?? 0) + row.cost_usd;
  }
  return { usage, costUsd };
}
