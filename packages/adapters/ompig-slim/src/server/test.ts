import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactDiagnosticText, type AdapterConfigSchema, type AdapterEnvironmentCheck, type AdapterEnvironmentTestContext, type AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { adapterExecutionTargetIsRemote, ensureAdapterExecutionTargetCommandResolvable, ensureAdapterExecutionTargetDirectory, resolveAdapterExecutionTargetCwd, runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseDurableReceipt } from "../protocol.js";

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
  const runId = "ompig-probe-" + randomUUID();
  const model = asString(config.model, "").trim();
  const remote = adapterExecutionTargetIsRemote(target);
  const stateDir = remote ? path.posix.join("/tmp", runId) : path.join(os.tmpdir(), runId);
  let stopped = false;
  if (!/^[^\s/]+\/[^\s]+$/.test(model)) checks.push({code: "ompig_model_required", level: "error", message: "Select an exact configured provider/model identity."});
  if (process.env.PAPERCLIP_EXECUTION_MODE === "kubernetes" && (target?.kind !== "remote" || target.transport !== "sandbox")) {
    checks.push({code: "ompig_sandbox_required", level: "error", message: "Kubernetes execution mode requires a sandbox target; local fallback is forbidden."});
  }
  if (!checks.some(check => check.level === "error")) {
    try {
      const command = asString(config.command, "ompig-slim");
      await ensureAdapterExecutionTargetDirectory(runId, target, cwd, { cwd, env, createIfMissing: false });
      for (const executable of [command, "node"]) await ensureAdapterExecutionTargetCommandResolvable(executable, target, cwd, env);
      const options = { cwd, env, timeoutSec: 15, graceSec: 5, onLog: async () => {} };
      const help = await runAdapterExecutionTargetProcess(runId, target, command, ["durable", "--help"], options);
      if (help.exitCode !== 0 || help.timedOut || !help.stdout.includes("durable resume") || !help.stdout.includes("--events-file")) throw new Error("The installed executable does not expose the required Durable run/resume/event protocol.");
      checks.push({code: "ompig_durable_available", level: "info", message: "Workspace, Node transport, and ompig-slim Durable protocol are available."});
      const result = await runAdapterExecutionTargetProcess(runId, target, command, [
        "durable", "run", "--state", stateDir, "--cwd", cwd, "--model", model,
        "--request-id", runId, "--max-turns", "1", "--", "Reply with exactly hello. Do not use tools.",
      ], { ...options, timeoutSec: 90, onProcessStopped: () => { stopped = true; } });
      const receipt = parseDurableReceipt(result.stdout, runId);
      const passed = result.exitCode === 0 && !result.timedOut && !result.signal && receipt?.status === "done" && receipt.answer?.trim().toLowerCase() === "hello";
      checks.push({code: passed ? "ompig_hello_probe_passed" : result.timedOut ? "ompig_hello_probe_timed_out" : "ompig_hello_probe_failed",
        level: passed ? "info" : "error", message: passed ? "ompig-slim answered hello using the configured model." : "The configured model did not complete the bounded hello assignment.",
        ...(!passed ? { detail: redactDiagnosticText(receipt?.reason || result.stderr || `Exit code ${result.exitCode}; no matching completed receipt.`).slice(0, 1200) } : {}) });
    } catch (error) { checks.push({code: "ompig_runtime_unavailable", level: "error", message: error instanceof Error ? error.message : String(error), hint: "Install a pinned ompig-slim binary and Node, and verify the selected model's provider configuration in the execution image."}); }
    finally {
      if (stopped) {
        try {
          if (remote) {
            const cleanup = await runAdapterExecutionTargetProcess(runId, target, "rm", ["-rf", "--", stateDir], { cwd, env, timeoutSec: 15, graceSec: 5, onLog: async () => {} });
            if (cleanup.exitCode !== 0 || cleanup.timedOut || cleanup.signal) throw new Error("Probe cleanup did not finish");
          } else await rm(stateDir, { recursive: true, force: true });
        } catch { checks.push({code: "ompig_probe_cleanup_failed", level: "warn", message: "The stopped probe workdesk could not be removed."}); }
      }
    }
  }
  checks.push({code: "ompig_storage_contract", level: "warn", message: "Persist the whole workdesk and repository at the same absolute cwd. Workspace sync does not protect against emptyDir pod deletion or node loss."});
  return { adapterType: "ompig_slim", status: checks.some(check => check.level === "error") ? "fail" : "warn", checks, testedAt: new Date().toISOString() };
}
