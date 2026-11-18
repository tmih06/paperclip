import { beforeEach, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

const fixture = vi.hoisted(() => ({ process: vi.fn(), directory: vi.fn(), command: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetDirectory: fixture.directory,
  ensureAdapterExecutionTargetCommandResolvable: fixture.command,
  runAdapterExecutionTargetProcess: fixture.process,
}));
const target = { kind: "remote", transport: "sandbox", providerKey: "kubernetes", environmentId: "env-a", leaseId: "lease-a", remoteCwd: "/workspace" } as const;
const context = () => ({ adapterType: "ompig_slim", companyId: "company-a", config: { model: "opencode-free/beam-free" }, executionTarget: target });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fixture.process.mockImplementation(async (_run, _target, command, args, options) => {
    options.onProcessStopped?.();
    return { exitCode: 0, signal: null, timedOut: false, stderr: "", stdout: command === "rm" ? ""
      : args.includes("--help") ? "durable resume --events-file"
      : JSON.stringify({ request_id: args[args.indexOf("--request-id") + 1], status: "done", answer: "hello" }) };
  });
});

it("verifies a real bounded hello assignment on the selected sandbox and cleans its workdesk", async () => {
  vi.stubEnv("PAPERCLIP_EXECUTION_MODE", "kubernetes");
  const result = await testEnvironment(context());
  expect(result.checks).toContainEqual(expect.objectContaining({ code: "ompig_hello_probe_passed", level: "info" }));
  const probe = fixture.process.mock.calls.find(call => call[3].includes("run"))!;
  expect(probe[1]).toBe(target);
  expect(probe[3]).toEqual(expect.arrayContaining(["--model", "opencode-free/beam-free", "--max-turns", "1"]));
  expect(fixture.process.mock.calls.at(-1)![2]).toBe("rm");
});

it("does not treat a successful process without the requested receipt as a verified model", async () => {
  const implementation = fixture.process.getMockImplementation()!;
  fixture.process.mockImplementation(async (...args) => args[3].includes("run")
    ? { exitCode: 0, signal: null, timedOut: false, stdout: '{"request_id":"other","status":"done","answer":"hello"}', stderr: "" }
    : implementation(...args));
  const result = await testEnvironment(context());
  expect(result.status).toBe("fail");
  expect(result.checks.some(check => check.code === "ompig_hello_probe_passed")).toBe(false);
});

it("reports an unanswered assignment as failure rather than activating the agent", async () => {
  const implementation = fixture.process.getMockImplementation()!;
  fixture.process.mockImplementation(async (...args) => args[3].includes("run")
    ? { exitCode: 1, signal: null, timedOut: false, stdout: JSON.stringify({ request_id: args[3][args[3].indexOf("--request-id") + 1], status: "unanswered", reason: "model_error" }), stderr: "" }
    : implementation(...args));
  const result = await testEnvironment(context());
  expect(result.status).toBe("fail");
  expect(result.checks).toContainEqual(expect.objectContaining({ code: "ompig_hello_probe_failed", detail: "model_error" }));
});

it("redacts provider diagnostics when no receipt is available", async () => {
  const implementation = fixture.process.getMockImplementation()!;
  fixture.process.mockImplementation(async (...args) => args[3].includes("run")
    ? { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: 'Rejected {"token":"private-probe-token"}' }
    : implementation(...args));
  const result = await testEnvironment(context());
  expect(JSON.stringify(result)).not.toContain("private-probe-token");
  expect(result.status).toBe("fail");
});

it("does not erase a workdesk when process stop is unproven", async () => {
  const implementation = fixture.process.getMockImplementation()!;
  fixture.process.mockImplementation(async (...args) => args[3].includes("run")
    ? { exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "" }
    : implementation(...args));
  expect((await testEnvironment(context())).status).toBe("fail");
  expect(fixture.process.mock.calls.some(call => call[2] === "rm")).toBe(false);
});

it("does not invoke a provider for an invalid model or a forbidden local target", async () => {
  await testEnvironment({ ...context(), config: { model: "invalid" } });
  expect(fixture.process).not.toHaveBeenCalled();
  vi.stubEnv("PAPERCLIP_EXECUTION_MODE", "kubernetes");
  await testEnvironment({ ...context(), executionTarget: null });
  expect(fixture.process).not.toHaveBeenCalled();
});
