import type { AdapterConfigSchema, AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ensureAdapterExecutionTargetCommandResolvable, ensureAdapterExecutionTargetDirectory, resolveAdapterExecutionTargetCwd, runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
export const getConfigSchema = (): AdapterConfigSchema => ({ fields: [
  { key: "model", label: "Model", type: "text", required: true, hint: "Exact configured provider/model identity in the execution environment." },
  { key: "maxTurns", label: "Durable turn budget", type: "number", default: 100, hint: "Immutable for this assignment; resume does not reset it." },
  { key: "instructionsFilePath", label: "Agent instructions file", type: "text", hint: "Instructions readable inside the execution workspace." },
] });
export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];
  const target = ctx.executionTarget;
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseObject(config.env))) if (typeof value === "string") env[key] = value;
  const runId = "ompig-probe-" + Date.now();
  if (!/^[^\s/]+\/[^\s]+$/.test(asString(config.model, ""))) checks.push({code: "ompig_model_required", level: "error", message: "Select an exact configured provider/model identity."});
  if (process.env.PAPERCLIP_EXECUTION_MODE === "kubernetes" && (target?.kind !== "remote" || target.transport !== "sandbox")) {
    checks.push({code: "ompig_sandbox_required", level: "error", message: "Kubernetes execution mode requires a sandbox target; local fallback is forbidden."});
  } else {
    try {
      await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env, createIfMissing: false });
      for (const command of [asString(config.command, "ompig-slim"), "node"]) await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, env);
      const result = await runAdapterExecutionTargetProcess(runId, target, asString(config.command, "ompig-slim"), ["durable", "--help"], {
        cwd, env, timeoutSec: 15, graceSec: 5, onLog: async () => {},
      });
      if (result.exitCode !== 0 || result.timedOut || !result.stdout.includes("durable resume") || !result.stdout.includes("--events-file")) throw new Error("The installed executable does not expose the required Durable run/resume/event protocol.");
      checks.push({code: "ompig_durable_available", level: "info", message: "Workspace, Node transport, and ompig-slim Durable protocol are available."});
    } catch (error) { checks.push({code: "ompig_runtime_unavailable", level: "error", message: error instanceof Error ? error.message : String(error), hint: "Install a pinned ompig-slim binary and Node in the selected execution image."}); }
  }
  checks.push({code: "ompig_storage_contract", level: "warn", message: "Persist the whole workdesk and repository at the same absolute cwd. Workspace sync does not protect against emptyDir pod deletion or node loss. Provider authentication is checked on actual execution, not by this probe."});
  return { adapterType: "ompig_slim", status: checks.some(check => check.level === "error") ? "fail" : "warn", checks, testedAt: new Date().toISOString() };
}
