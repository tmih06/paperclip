import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const binary = process.env.PAPERCLIP_OMPIG_BINARY;
afterEach(() => { vi.unstubAllEnvs(); });

describe.skipIf(!binary)("installed ompig-slim Durable adapter (opt-in, isolated model fixture)", () => {
  it("recovers an interrupted assignment on a new run without duplicate admission or losing workspace files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ompig-binary-"));
    const cwd = path.join(root, "repo");
    const profile = path.join(root, "profile");
    await fs.mkdir(cwd);
    await fs.mkdir(profile);
    await fs.writeFile(path.join(cwd, "preserved.txt"), "uncommitted workspace\n");
    // Never use an ambient broker session, API key, or profile for an integration test.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OMPIG_BROKER_") || /(?:_API_KEY|_TOKEN|_SECRET)$/.test(key)) vi.stubEnv(key, undefined);
    }
    vi.stubEnv("PAPERCLIP_EXECUTION_MODE", "");
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume the fixture request, never log prompts. */ }
      calls++;
      if (calls === 1) return; // Crash point: hold the first model request until timeout.
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Recovered adapter assignment" }, finish_reason: null }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await fs.writeFile(path.join(profile, "models.json"), JSON.stringify({ providers: { fixture: {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-not-a-credential",
      models: [{ id: "model", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
    } } }));
    const ctx: AdapterExecutionContext = {
      runId: "original-assignment", agent: { id: "test-agent", companyId: "test-company", name: "Fixture", adapterType: "ompig_slim", adapterConfig: {} },
      config: { command: path.resolve(binary!), cwd, model: "fixture/model", promptTemplate: "Answer the fixture", timeoutSec: 3, graceSec: 0.2,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: path.join(root, "home"), PIG_HOME: path.join(root, "home"), OMPIG_SLIM_CODING_AGENT_DIR: profile, PI_OFFLINE: "1" } },
      context: { taskId: "task-fixture" }, runtime: { sessionId: null, sessionDisplayId: null, sessionParams: null, taskKey: "task-fixture" },
      onLog: async () => {},
    };
    try {
      const interrupted = await execute(ctx);
      expect(interrupted.timedOut).toBe(true);
      expect(calls).toBe(1);
      expect(interrupted.sessionParams?.requestId).toBe("original-assignment");
      expect(interrupted.sessionParams?.status).not.toBe("done");
      const retry: AdapterExecutionContext = { ...ctx, runId: "recovery-run", config: { ...ctx.config, timeoutSec: 25 },
        runtime: { ...ctx.runtime, sessionParams: interrupted.sessionParams! } };
      const resumed = await execute(retry);
      expect(resumed.exitCode).toBe(0);
      expect(resumed.summary).toBe("Recovered adapter assignment");
      expect(resumed.sessionId).toBe("original-assignment");
      expect(calls).toBe(2);
      // Reopening the original terminal assignment only reads its existing result.
      const duplicate = await execute({ ...ctx, config: { ...ctx.config, timeoutSec: 25 }, runtime: { ...ctx.runtime, sessionParams: resumed.sessionParams! } });
      expect(duplicate.summary).toBe("Recovered adapter assignment");
      expect(calls).toBe(2);
      expect(await fs.readFile(path.join(cwd, "preserved.txt"), "utf8")).toBe("uncommitted workspace\n");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
