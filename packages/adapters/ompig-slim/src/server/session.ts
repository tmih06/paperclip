import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || typeof value.requestId !== "string" || typeof value.cwd !== "string" || typeof value.model !== "string"
      || typeof value.stateDir !== "string" || typeof value.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(value.promptHash)
      || !["pending", "placed", "queued", "done", "unanswered"].includes(String(value.status))
      || typeof value.companyId !== "string" || typeof value.agentId !== "string" || !Number.isSafeInteger(value.maxTurns)) return null;
    return { version: 1, requestId: value.requestId, cwd: value.cwd, model: value.model, stateDir: value.stateDir,
      promptHash: value.promptHash, status: value.status, companyId: value.companyId, agentId: value.agentId, maxTurns: value.maxTurns, executionTarget: value.executionTarget ?? null, taskKey: value.taskKey ?? null };
  },
  serialize(params) { return sessionCodec.deserialize(params); },
  getDisplayId(params) { return typeof params?.requestId === "string" ? params.requestId : null; },
};
