import path from "node:path";
import type { MatrixExecution, RunnerTaskFlow } from "./types.js";

export function runnerE2EPlaywrightCaseTimeoutMs(flow: RunnerTaskFlow, deadlineMs: number) {
  return (flow === "kimi_native_lifecycle" ? 2 * deadlineMs : deadlineMs) + 90_000;
}

export function runnerE2EPlaywrightWatchdogMs(executions: readonly MatrixExecution[]) {
  // Playwright starts its web server before any case timeout begins.
  return executions.reduce((total, execution) => total + runnerE2EPlaywrightCaseTimeoutMs(
    execution.task.flow, execution.task.attemptTimeoutMs[execution.environment.id],
  ), 0) + 5 * 60_000;
}

export const runnerE2EPlaywrightShutdownSignal = "SIGINT" as const;

// Let the restart-aware supervisor reap Paperclip and finish its log streams.
// Its stop path allows 30 seconds for SIGTERM and 5 seconds for SIGKILL.
export const runnerE2EWebServerGracefulShutdown = {
  signal: "SIGTERM" as const,
  timeout: 45_000,
};

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function runnerE2EWebServerCommand(repositoryRoot: string) {
  const server = path.join(repositoryRoot, "tests/runner-e2e/server.ts");
  // Playwright runs this command through a shell; Bun executes the TypeScript
  // server directly so the supervised child is the server itself.
  return `bun ${shellQuote(server)}`;
}

// Keep the supervisor's child PID equal to the actual TypeScript process.
export function runnerE2ETypeScriptProcessArgs(repositoryRoot: string, entry: string, args: string[] = []) {
  return [entry, ...args];
}

export function runnerE2EPlaywrightInvocation(repositoryRoot: string, args: string[]) {
  return { command: process.execPath, args: [path.join(repositoryRoot, "node_modules/@playwright/test/cli.js"), ...args] };
}
