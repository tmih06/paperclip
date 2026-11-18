import type { CreateConfigValues, TranscriptEntry } from "@paperclipai/adapter-utils";
import { buildAdapterEnvConfig } from "@paperclipai/adapter-utils";
export function buildOmpigSlimConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = { timeoutSec: 0, graceSec: 20 };
  for (const key of ["model", "maxTurns", "instructionsFilePath"] as const) {
    if (values.adapterSchemaValues?.[key] !== undefined) config[key] = values.adapterSchemaValues[key];
  }
  if (values.model) config.model = values.model;
  if (values.cwd) config.cwd = values.cwd;
  if (values.command) config.command = values.command;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  const env = buildAdapterEnvConfig(values.envBindings, values.envVars);
  if (Object.keys(env).length) config.env = env;
  return config;
}
export function parseOmpigSlimStdoutLine(line: string, ts: string): TranscriptEntry[] {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return line.trim() ? [{kind: "stdout", ts, text: line}] : []; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return [];
  if (row.type === "text" && typeof row.content === "string") return [{kind: "assistant", ts, text: row.content, channel: "progress"}];
  if (row.type === "tool_call" && typeof row.tool === "string") return [{kind: "tool_call", ts, name: row.tool, input: row.input, toolUseId: typeof row.call_id === "string" ? row.call_id : undefined}];
  if (row.type === "tool_result" && typeof row.call_id === "string") return [{kind: "tool_result", ts, toolUseId: row.call_id, toolName: typeof row.tool === "string" ? row.tool : undefined, content: typeof row.output === "string" ? row.output : "", isError: false}];
  if (typeof row.request_id === "string" && (row.status === "done" || row.status === "unanswered")) return [{kind: "result", ts, text: typeof row.answer === "string" ? row.answer : "", subtype: row.status, isError: row.status === "unanswered", errors: typeof row.reason === "string" ? [row.reason] : [], inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0}];
  if (row.type === "usage") return [];
  return [{kind: "stdout", ts, text: line}];
}
