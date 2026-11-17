import { createHash } from "node:crypto";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { cancellableSandboxStartup } from "@paperclipai/adapter-utils/acpx-engine/startup-cancellation";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { withWorkspaceRestore } from "@paperclipai/adapter-utils/workspace-restore-result";
import {
  adapterExecutionTargetIsRemote, adapterExecutionTargetRemoteCwd, adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches, adapterExecutionTargetUsesPaperclipBridge,
  ensureAdapterExecutionTargetCommandResolvable, ensureAdapterExecutionTargetDirectory,
  overrideAdapterExecutionTargetRemoteCwd, prepareAdapterExecutionTargetRuntime, readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec, runAdapterExecutionTargetProcess, startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber, asString, buildInvocationEnvForLogs, buildPaperclipEnv, buildRuntimeToolsEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  hydrateFreshSessionHandoff, joinPromptSections, parseObject, renderTemplate, selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { DURABLE_PROCESS } from "./durable-process.js";
import { durableUsage, parseDurableReceipt } from "../protocol.js";
import { sessionCodec } from "./session.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = (status: unknown) => status === "done" || status === "unanswered";

export async function execute(original: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const cancellation = cancellableSandboxStartup(original);
  try {
    return await executeDurable(cancellation.context);
  } finally {
    await cancellation.finish();
  }
}

async function executeDurable(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, runtime, context, onLog } = ctx;
  const stopBoundary = createProviderStoppedBoundary(ctx.onProviderStopped);
  let stopped = false;
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.executionTransport?.remoteExecution });
  const remote = adapterExecutionTargetIsRemote(target);
  if (process.env.PAPERCLIP_EXECUTION_MODE === "kubernetes" && (target?.kind !== "remote" || target.transport !== "sandbox")) {
    throw new Error("ompig-slim requires a sandbox execution target in Kubernetes execution mode; local fallback is forbidden.");
  }
  const model = asString(config.model, "").trim();
  if (!/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error("ompig-slim requires an exact provider/model identity.");
  const maxTurns = asNumber(config.maxTurns, 100);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer.");
  const command = asString(config.command, "ompig-slim");
  const workspace = parseObject(context.paperclipWorkspace);
  const cwd = asString(workspace.cwd, "") || asString(config.cwd, "") || process.cwd();
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(target, asNumber(config.timeoutSec, 0));
  const graceSec = asNumber(config.graceSec, 20);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent, ctx.agentIdentity), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
  for (const [key, value] of Object.entries(parseObject(config.env))) if (typeof value === "string") env[key] = value;
  // Run identity cannot be overridden by user env or inherited controller state.
  env.PAPERCLIP_RUN_ID = runId;
  const taskId = asString(context.taskId, "") || asString(context.issueId, "");
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  for (const [key, value] of [
    ["PAPERCLIP_WAKE_REASON", context.wakeReason], ["PAPERCLIP_WAKE_COMMENT_ID", context.wakeCommentId ?? context.commentId],
    ["PAPERCLIP_APPROVAL_ID", context.approvalId], ["PAPERCLIP_APPROVAL_STATUS", context.approvalStatus],
  ]) if (typeof value === "string" && value) env[key as string] = value;
  if (Array.isArray(context.issueIds)) env.PAPERCLIP_LINKED_ISSUE_IDS = context.issueIds.filter(value => typeof value === "string").join(",");
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;

  const saved = sessionCodec.deserialize(runtime.sessionParams);
  const conflict = (message: string): AdapterExecutionResult => ({
    exitCode: 1, signal: null, timedOut: false, errorCode: "ompig_assignment_conflict", errorMessage: message,
    sessionParams: saved, sessionId: typeof saved?.requestId === "string" ? saved.requestId : null,
  });
  if (runtime.sessionParams && !saved) return conflict("Invalid saved Durable assignment. Restore valid state before resetting the session; no work was started.");
  const taskKey = runtime.taskKey ?? (taskId || null);
  if (saved?.status === "unanswered" && saved.requestId !== runId) {
    return conflict("The Durable assignment is terminal unanswered. Review its failure and explicitly reset the session before authorizing a new attempt; automatic retries cannot create fresh work.");
  }
  const resumeSaved = Boolean(saved && (!terminal(saved.status) || saved.requestId === runId));
  const requestId = resumeSaved ? saved!.requestId as string : runId;
  let prepared: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | undefined;
  let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  try {
    ctx.signal?.throwIfAborted();
    await ensureAdapterExecutionTargetDirectory(runId, target, adapterExecutionTargetRemoteCwd(target, cwd), { cwd, env, createIfMissing: true });
    prepared = await prepareAdapterExecutionTargetRuntime({
      runId, target, adapterKey: "ompig-slim", workspaceLocalDir: cwd,
      workspaceFileMode: "all", retainRuntime: true, timeoutSec,
      onProgress: line => onLog("stdout", line), onRuntimeProgress: ctx.onRuntimeProgress,
    });
    const executionCwd = prepared.workspaceRemoteDir ?? adapterExecutionTargetRemoteCwd(target, cwd);
    const executionTarget = overrideAdapterExecutionTargetRemoteCwd(prepared.target, executionCwd);
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, executionCwd, env);
    await ensureAdapterExecutionTargetCommandResolvable("node", executionTarget, executionCwd, env);
    if (resumeSaved && (saved!.companyId !== agent.companyId || saved!.agentId !== agent.id
      || saved!.cwd !== executionCwd || saved!.model !== model || saved!.maxTurns !== maxTurns || saved!.taskKey !== taskKey
      || !adapterExecutionTargetSessionMatches(saved!.executionTarget, executionTarget))) {
      return conflict("Durable execution identity, cwd, task or model changed. Restore the original environment and workdesk; refusing to replay.");
    }
    await hydrateFreshSessionHandoff(ctx, { resumedSession: resumeSaved });
    const sections = selectPaperclipPromptSections(context, { resumedSession: false, includeCommunicationGuidance: false });
    const data = { agentId: agent.id, companyId: agent.companyId, runId, company: { id: agent.companyId }, agent, run: { id: runId }, context };
    const prompt = resumeSaved ? "" : joinPromptSections([
      renderTemplate(asString(config.promptTemplate, context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE), data),
      renderTemplate(asString(config.bootstrapPromptTemplate, ""), data),
      selectInitialCommunicationGuidance(context, { resumedSession: false }), sections.wakePrompt, sections.taskContextNote,
      asString(context.paperclipSessionHandoffMarkdown, ""),
      asString(config.instructionsFilePath, "") ? `Read and follow the agent instructions at ${asString(config.instructionsFilePath, "")} before starting.` : "",
      "Durable mode does not auto-load skills. Use bash and the PAPERCLIP_API_URL/PAPERCLIP_API_KEY environment variables for Paperclip. Include X-Paperclip-Run-Id on mutating API calls. Never log credentials.",
    ]);
    const promptHash = resumeSaved ? saved!.promptHash as string : hash(prompt);
    const stateDir = path.posix.join(executionCwd, ".paperclip-ompig", hash(agent.companyId), hash(agent.id), hash(requestId));
    if (resumeSaved && saved!.stateDir !== stateDir) return conflict("Durable state location changed. Restore the original workdesk; refusing to replay.");
    if (resumeSaved) await onLog("stderr", `[paperclip] Resuming immutable Durable assignment ${requestId}; this wake does not admit a replacement prompt.\n`);
    if (remote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) {
      bridge = await startAdapterExecutionTargetPaperclipBridge({ runId, target: executionTarget, runtimeRootDir: prepared.runtimeRootDir,
        adapterKey: "ompig-slim", timeoutSec, hostApiToken: env.PAPERCLIP_API_KEY, onLog });
      if (bridge) Object.assign(env, bridge.env);
    }
    await ctx.onMeta?.({ adapterType: "ompig_slim", command, cwd: executionCwd, commandArgs: ["durable", resumeSaved ? "resume" : "run", "--state", stateDir],
      commandNotes: ["Immutable Durable assignment; workdesk and repository must both survive for recovery. emptyDir deletion is not durable storage."],
      env: buildInvocationEnvForLogs(env), prompt });
    await ctx.onCancellationReady?.();
    ctx.signal?.throwIfAborted();
    ctx.onDispatch?.();
    const acknowledgeStop = stopBoundary.beginInvocation();
    const result = await runAdapterExecutionTargetProcess(runId, executionTarget, "node", ["-e", DURABLE_PROCESS], {
      cwd: executionCwd, env, stdin: JSON.stringify({ command, stateDir, cwd: executionCwd, model, requestId, prompt, promptHash, maxTurns, requireExisting: resumeSaved }),
      timeoutSec, graceSec, onLog, onSpawn: ctx.onSpawn, onRuntimeProgress: ctx.onRuntimeProgress,
      runLogTail: bridge?.runLogTail, settleRunDisposition: bridge?.settleRunDisposition,
      onProcessStopped: () => { stopped = true; acknowledgeStop(); },
    });
    const receipt = parseDurableReceipt(result.stdout, requestId);
    const status = receipt?.status ?? "pending";
    const sessionParams = { version: 1, requestId, companyId: agent.companyId, agentId: agent.id, maxTurns, cwd: executionCwd, model, stateDir, promptHash, status,
      executionTarget: adapterExecutionTargetSessionIdentity(executionTarget), taskKey };
    const accounting = durableUsage(receipt);
    const failed = result.timedOut || result.signal || result.exitCode !== 0 || receipt?.status !== "done";
    return await withWorkspaceRestore(async (): Promise<AdapterExecutionResult> => {
      await stopBoundary.collectBeforeRestore();
      return {
        exitCode: failed && result.exitCode === 0 ? 1 : result.exitCode, signal: result.signal, timedOut: result.timedOut,
        errorMessage: failed ? (receipt?.reason || (result.timedOut ? "Durable host timed out; reconcile process ownership before resuming its saved assignment." : "Durable execution did not produce a completed receipt. Inspect stderr and retained state; no automatic replay was attempted.")) : null,
        errorCode: failed ? "ompig_durable_incomplete" : null,
        sessionId: requestId, sessionDisplayId: requestId, sessionParams, usage: accounting.usage, usageBasis: "session_cumulative",
        provider: model.split("/")[0], model, costUsd: accounting.costUsd,
        summary: typeof receipt?.answer === "string" ? receipt.answer : null,
        resultJson: { durableStatus: status, requestId, stateDir, progress: receipt?.progress ?? null,
          finalResponseRecorded: receipt?.status === "done" && typeof receipt.answer === "string" && Boolean(receipt.answer.trim()),
          workspaceCheckpointed: stopped, infrastructureCrashDurability: false },
      };
    }, async () => {
      // Never copy an active SQLite/WAL or repository while stop is unproven.
      if (stopped) await prepared!.restoreWorkspace(line => onLog("stdout", line));
    });
  } finally {
    await bridge?.stop();
  }
}
