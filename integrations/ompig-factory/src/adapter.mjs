import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPaperclipEnv, buildRuntimeToolsEnv, hydrateFreshSessionHandoff,
  selectPaperclipPromptSections, selectInitialCommunicationGuidance, joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge, overrideAdapterExecutionTargetRemoteCwd,
  runAdapterExecutionTargetShellCommand,
} from "@paperclipai/adapter-utils/execution-target";
import { createAccounting } from "./accounting.mjs";
import { integer, isImmutableImage, requireId, requireValue } from "./protocol.mjs";

export const type = "ompig_factory";
export const label = "ompig-slim Image Agent";
export const models = [];
export const agentConfigurationDoc = `# ompig-slim image agent
Select a Docker Worker Pool sandbox environment whose image digest defines this agent version.
Multiple clones of this identity may run concurrently; worker slots are the physical capacity.
Required adapter config: image (immutable digest matching the selected environment), model (exact provider/model).
Optional: timeoutSec (default 3600), maxTurns (default 100), env (company-secret-backed model/broker credentials).
The image must contain /usr/local/bin/ompig-slim, Node 24.11+, sh, tar and git.
Image instructions may live at /opt/agent/instructions.md. Durable mode does not load ordinary extensions/skills/MCP automatically.
Use isolated task workspaces. Never put worker-management credentials in adapter env.
Agent done is not ticket acceptance: verification, approvals and merging retain their normal gates.
`;

/** Factory injects only normalized execution-target helpers; no worker protocol leaks into Core. */
export function createServerAdapter(dependencies = {}) {
  const prepare = dependencies.prepare ?? prepareAdapterExecutionTargetRuntime;
  const run = dependencies.run ?? runAdapterExecutionTargetProcess;
  const bridge = dependencies.bridge ?? startAdapterExecutionTargetPaperclipBridge;
  const probe = dependencies.probe ?? runAdapterExecutionTargetShellCommand;
  return {
    type, models, supportsLocalAgentJwt: true, runtimeToolDelivery: "environment",
    supportsInstructionsBundle: false, requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc,
    getRuntimeCommandSpec: () => ({ command: "ompig-slim", detectCommand: "ompig-slim" }),
    getConfigSchema: () => ({ fields: [
      { key: "image", label: "Agent image digest", type: "text", required: true, hint: "Must match the saved worker-pool environment image" },
      { key: "model", label: "Model", type: "text", required: true, hint: "Exact provider/model identity" },
      { key: "maxTurns", label: "Maximum tool rounds", type: "number", default: 100 },
      { key: "timeoutSec", label: "Run timeout (seconds)", type: "number", default: 3600 },
    ] }),
    async testEnvironment(ctx) {
      const testedAt = new Date().toISOString();
      try {
        requireValue(ctx.executionTarget?.kind === "remote" && ctx.executionTarget.transport === "sandbox", "factory_requires_sandbox_environment");
        requireValue(isImmutableImage(ctx.config.image), "factory_image_digest_required");
        const imageCheck = await probe("ompig-image-probe", ctx.executionTarget, "/bin/cat /run/factory-control/image", { cwd: "/workspace", env: {}, timeoutSec: 10, graceSec: 5 });
        requireValue(imageCheck.exitCode === 0 && imageCheck.stdout.trim() === ctx.config.image, "factory_agent_image_mismatch");
        const result = await probe("ompig-probe", ctx.executionTarget,
          `node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<24 || (major===24 && minor<11)) process.exit(1)' && /usr/local/bin/ompig-slim durable --help && git --version && tar --version`, {
            cwd: "/workspace", env: {}, timeoutSec: 30, graceSec: 5,
          });
        requireValue(result.exitCode === 0 && !result.timedOut, "factory_image_probe_failed");
        return { adapterType: type, testedAt, status: "pass", checks: [{ code: "factory_image_ready", level: "info", message: "Sandbox contains the ompig durable runtime and workspace tools." }] };
      } catch (error) {
        return { adapterType: type, testedAt, status: "fail", checks: [{ code: error.code ?? "factory_probe_failed", level: "error", message: error.message }] };
      }
    },
    async execute(ctx) {
      requireId(ctx.runId);
      const target = ctx.executionTarget;
      requireValue(target?.kind === "remote" && target.transport === "sandbox" && target.providerKey === "ompig_factory", "factory_requires_worker_pool_environment");
      requireValue(typeof ctx.stopRemoteStartup === "function", "factory_requires_verified_stop");
      requireValue(isImmutableImage(ctx.config.image), "factory_image_digest_required");
      const model = ctx.config.model;
      requireValue(typeof model === "string" && model.includes("/") && model.length <= 300, "factory_model_required");
      const timeoutSec = integer(ctx.config.timeoutSec ?? 3600, 1, 86400, "factory_invalid_timeout");
      const maxTurns = integer(ctx.config.maxTurns ?? 100, 1, 10000, "factory_invalid_turn_budget");
      const cwd = ctx.context.paperclipWorkspace?.cwd ?? ctx.config.cwd;
      requireValue(typeof cwd === "string" && path.isAbsolute(cwd), "factory_workspace_required");
      requireValue(typeof ctx.context.executionWorkspaceId === "string", "factory_task_workspace_required");
      const env = {};
      for (const [key, value] of Object.entries(ctx.config.env ?? {})) {
        if (typeof value === "string" && !key.startsWith("PAPERCLIP_")) env[key] = value;
      }
      Object.assign(env, buildPaperclipEnv(ctx.agent, ctx.agentIdentity), buildRuntimeToolsEnv(ctx.runtimeTools), { PAPERCLIP_RUN_ID: ctx.runId });
      if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
      const accounting = createAccounting(ctx.runId, ctx.onUsage);
      let prepared, handle, started = false, stopped = false, cancelStop;
      const abort = () => {
        cancelStop ??= Promise.resolve().then(() => ctx.stopRemoteStartup()).then(() => { stopped = true; });
        // Observe rejection now; finalization still awaits and propagates it, never inventing a receipt.
        void cancelStop.catch(() => {});
      };
      ctx.signal?.addEventListener("abort", abort, { once: true });
      try {
        await ctx.onCancellationReady?.();
        ctx.signal?.throwIfAborted();
        const imageCheck = await probe(ctx.runId, target, "/bin/cat /run/factory-control/image", { cwd: "/workspace", env: {}, timeoutSec: 10, graceSec: 5 });
        requireValue(imageCheck.exitCode === 0 && imageCheck.stdout.trim() === ctx.config.image, "factory_agent_image_mismatch");
        ctx.signal?.throwIfAborted();
        await hydrateFreshSessionHandoff(ctx, { resumedSession: false });
        const sections = selectPaperclipPromptSections(ctx.context, { resumedSession: false });
        const prompt = joinPromptSections([
          selectInitialCommunicationGuidance(ctx.context, { resumedSession: false }),
          sections.wakePrompt, sections.taskContextNote, ctx.context.paperclipSessionHandoffMarkdown,
          "Work only on this assignment. Verify the acceptance criteria, preserve evidence, and report blockers. Do not merge or claim acceptance without the configured checks and approvals.",
        ].filter(value => typeof value === "string"));
        prepared = await prepare({ runId: ctx.runId, target, adapterKey: type, workspaceLocalDir: cwd,
          timeoutSec, detectCommand: "ompig-slim", onProgress: line => ctx.onLog("stdout", line),
          onRuntimeProgress: ctx.onRuntimeProgress,
          assets: [{ key: "launcher", localDir: path.dirname(fileURLToPath(import.meta.url)) }],
        });
        ctx.signal?.throwIfAborted();
        const remoteCwd = prepared.workspaceRemoteDir ?? target.remoteCwd;
        const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target, remoteCwd);
        handle = await bridge({ runId: ctx.runId, target: runtimeTarget, runtimeRootDir: prepared.runtimeRootDir,
          adapterKey: type, timeoutSec, hostApiToken: ctx.authToken, onLog: ctx.onLog });
        if (handle) Object.assign(env, handle.env);
        env.PAPERCLIP_TASK_ID = String(ctx.context.taskId ?? ctx.context.issueId ?? "");
        const launcher = path.posix.join(prepared.assetDirs.launcher, "clone-entrypoint.mjs");
        await ctx.onMeta?.({ adapterType: type, command: "node", cwd: remoteCwd,
          commandArgs: [launcher], env: {}, commandNotes: [`Agent image: ${ctx.config.image}; private per-run ompig workdesk.`] });
        ctx.signal?.throwIfAborted();
        ctx.onDispatch?.();
        started = true;
        const result = await run(ctx.runId, runtimeTarget, "node", [launcher], {
          cwd, env, stdin: JSON.stringify({ runId: ctx.runId, cwd: remoteCwd, model, maxTurns, prompt }),
          timeoutSec, graceSec: 10, onSpawn: ctx.onSpawn, onRuntimeProgress: ctx.onRuntimeProgress,
          onProcessStopped: () => { stopped = true; },
          onLog: async (stream, chunk) => { if (stream === "stdout") await accounting.consume(chunk); await ctx.onLog(stream, chunk); },
          runLogTail: handle?.runLogTail, settleRunDisposition: handle?.settleRunDisposition,
        });
        if (result.timedOut || ctx.signal?.aborted) { abort(); await cancelStop; }
        const { receipt, ...usage } = await accounting.finish();
        const success = !result.timedOut && !ctx.signal?.aborted && result.exitCode === 0 && receipt?.status === "done";
        return { exitCode: success ? 0 : result.exitCode || 1, signal: result.signal, timedOut: result.timedOut,
          ...usage, model, provider: model.split("/")[0], clearSession: true,
          summary: receipt?.answer ?? null,
          ...(success ? {} : { errorCode: ctx.signal?.aborted ? "cancelled" : result.timedOut ? "timeout" : receipt?.status === "unanswered" ? "ompig_unanswered" : "factory_invalid_ompig_receipt",
            errorMessage: "ompig execution did not produce a successful terminal answer; inspect the retained run evidence." }),
          resultJson: { requestId: ctx.runId, status: receipt?.status ?? "interrupted", accepted: false },
        };
      } catch (error) {
        if (started && !stopped) abort();
        if (cancelStop) await cancelStop;
        if (ctx.signal?.aborted && stopped) {
          const { receipt, ...usage } = await accounting.finish();
          return { exitCode: null, signal: "SIGTERM", timedOut: false, errorCode: "cancelled",
            errorMessage: "Run cancelled after verified sandbox termination.", ...usage, model, clearSession: true };
        }
        throw error;
      } finally {
        ctx.signal?.removeEventListener("abort", abort);
        let restoreSafe = !started;
        try {
          if (cancelStop) await cancelStop;
          if (stopped) { await ctx.onProviderStopped?.(); restoreSafe = true; }
        } finally {
          try { await handle?.stop(); }
          finally {
            // Interrupted or unconfirmed work retains its remote files for Core recovery.
            if (restoreSafe && !cancelStop) {
              await prepared?.restoreWorkspace(line => ctx.onLog("stdout", line));
              await prepared?.cleanupWorkspaceSnapshot?.();
            }
          }
        }
      }
    },
  };
}
