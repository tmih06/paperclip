import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const fixture = vi.hoisted(() => ({
  process: vi.fn(), restore: vi.fn(), directory: vi.fn(), command: vi.fn(), prepare: vi.fn(),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return { ...actual,
    ensureAdapterExecutionTargetDirectory: fixture.directory,
    ensureAdapterExecutionTargetCommandResolvable: fixture.command,
    prepareAdapterExecutionTargetRuntime: fixture.prepare,
    runAdapterExecutionTargetProcess: fixture.process,
    adapterExecutionTargetUsesPaperclipBridge: () => false,
  };
});

function context(patch: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return { runId: "run-1", agent: { id: "agent-a", companyId: "company-a", name: "Builder", adapterType: "ompig_slim", adapterConfig: {} },
    config: { cwd: "/work/repo", model: "fixture/model", promptTemplate: "Implement task" },
    runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: "task-1" },
    context: { taskId: "task-1" }, onLog: vi.fn(), ...patch };
}
function assignment() {
  return JSON.parse(fixture.process.mock.calls.at(-1)![4].stdin as string);
}
function done(status = "done") {
  fixture.process.mockImplementation(async (_id, _target, _command, _args, options) => {
    options.onProcessStopped?.();
    const input = JSON.parse(options.stdin);
    return { exitCode: status === "done" ? 0 : 1, signal: null, timedOut: false, stderr: "", pid: 10, startedAt: "now",
      stdout: JSON.stringify({ request_id: input.requestId, status, answer: "Finished", usage: [{ input_tokens: 5, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 1, cost_usd: 0.01 }] }) + "\n" };
  });
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fixture.prepare.mockImplementation(async input => ({ target: input.target ?? { kind: "local" }, workspaceRemoteDir: input.target?.kind === "remote" ? "/workspace/repo" : null,
    runtimeRootDir: null, restoreWorkspace: fixture.restore }));
  done();
});

describe("ompig Durable execution", () => {
  it("starts one company/agent scoped assignment under the execution workspace and accounts for the receipt", async () => {
    const result = await execute(context());
    const input = assignment();
    expect(input.requestId).toBe("run-1");
    expect(input.stateDir).toMatch(/^\/work\/repo\/\.paperclip-ompig\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
    expect(input.prompt).toContain("Implement task");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "run-1", summary: "Finished", usageBasis: "session_cumulative", usage: { inputTokens: 6, outputTokens: 2, cachedInputTokens: 3, cacheWriteTokens: 1 }, costUsd: 0.01 });
    expect(fixture.restore).toHaveBeenCalledOnce();
  });

  it("loads managed instructions instead of asking a sandbox to read the controller-only path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ompig-instructions-"));
    const instructionsFilePath = path.join(root, "AGENTS.md");
    try {
      await writeFile(instructionsFilePath, "Follow the scoped task and verify the output.");
      await execute(context({ config: { ...context().config, instructionsFilePath },
        executionTarget: { kind: "remote", transport: "sandbox", providerKey: "kubernetes", environmentId: "env-a", leaseId: "lease-a", remoteCwd: "/workspace/repo" } }));
      expect(assignment().prompt).toContain("Follow the scoped task and verify the output.");
      expect(assignment().prompt).not.toContain(instructionsFilePath);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("resumes pending immutable work across a new Paperclip run without replacing its prompt", async () => {
    fixture.process.mockResolvedValueOnce({ exitCode: 143, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" });
    const first = await execute(context());
    const original = assignment();
    expect(first.sessionParams?.status).toBe("pending");
    expect(fixture.restore).not.toHaveBeenCalled();
    const result = await execute(context({ runId: "run-2", runtime: { ...context().runtime, sessionParams: first.sessionParams! },
      config: { ...context().config, promptTemplate: "A changed wake must not overwrite the original assignment" } }));
    const resumed = assignment();
    expect(resumed).toMatchObject({ requestId: "run-1", requireExisting: true, prompt: "", promptHash: original.promptHash, stateDir: original.stateDir });
    expect(result.sessionId).toBe("run-1");
    expect(result.exitCode).toBe(0);
  });

  it("creates a new workdesk after a terminal answer instead of reusing its immutable prompt", async () => {
    const first = await execute(context());
    const previous = assignment();
    await execute(context({ runId: "run-2", runtime: { ...context().runtime, sessionParams: first.sessionParams! } }));
    expect(assignment()).toMatchObject({ requestId: "run-2", requireExisting: false });
    expect(assignment().stateDir).not.toBe(previous.stateDir);
  });

  it("does not automatically create new work after terminal unanswered", async () => {
    done("unanswered");
    const first = await execute(context());
    fixture.process.mockClear();
    const result = await execute(context({ runId: "run-2", runtime: { ...context().runtime, sessionParams: first.sessionParams! } }));
    expect(result.errorCode).toBe("ompig_assignment_conflict");
    expect(fixture.process).not.toHaveBeenCalled();
  });

  it.each(["model", "task", "agent", "state", "budget"])("refuses a pending assignment when %s changes", async kind => {
    fixture.process.mockResolvedValueOnce({ exitCode: 143, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" });
    const first = await execute(context());
    const next = context({ runId: "run-2", runtime: { ...context().runtime, sessionParams: first.sessionParams! } });
    if (kind === "model") next.config.model = "fixture/other";
    if (kind === "task") next.runtime.taskKey = "other-task";
    if (kind === "agent") next.agent.id = "other-agent";
    if (kind === "state") next.runtime.sessionParams!.stateDir = "/other/workdesk";
    if (kind === "budget") next.config.maxTurns = 10;
    fixture.process.mockClear();
    expect((await execute(next)).errorCode).toBe("ompig_assignment_conflict");
    expect(fixture.process).not.toHaveBeenCalled();
  });

  it("never falls back to the host in forced Kubernetes mode", async () => {
    vi.stubEnv("PAPERCLIP_EXECUTION_MODE", "kubernetes");
    await expect(execute(context())).rejects.toThrow("local fallback is forbidden");
    expect(fixture.process).not.toHaveBeenCalled();
  });

  it("uses only the selected sandbox for directory, command and process operations", async () => {
    vi.stubEnv("PAPERCLIP_EXECUTION_MODE", "kubernetes");
    const target = { kind: "remote", transport: "sandbox", providerKey: "kubernetes", environmentId: "env-a", leaseId: "lease-a", remoteCwd: "/workspace/repo" } as const;
    await execute(context({ executionTarget: target }));
    expect(fixture.directory.mock.calls[0]![1]).toBe(target);
    expect(fixture.process.mock.calls[0]![1]).toMatchObject(target);
    expect(assignment().stateDir).toMatch(/^\/workspace\/repo\//);
    expect(fixture.prepare.mock.calls[0]![0]).toMatchObject({ workspaceFileMode: "all", retainRuntime: true });
  });

  it("returns failure for success exit without the expected assignment receipt", async () => {
    fixture.process.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, stdout: '{"request_id":"wrong","status":"done"}', stderr: "" });
    expect(await execute(context())).toMatchObject({ exitCode: 1, errorCode: "ompig_durable_incomplete" });
  });
});
