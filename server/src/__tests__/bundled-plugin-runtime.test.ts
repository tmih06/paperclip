import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";

const roots: string[] = [];
const sdk = fileURLToPath(new URL("../../../packages/plugins/sdk/dist/index.js", import.meta.url));
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("native Bun plugin workers", () => {
  it.each(["development TypeScript", "prebuilt JavaScript"])("boots %s without loading host or image transpilers", async mode => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-plugin-runtime-")));
    roots.push(root);
    const marker = path.join(root, "injected-loader-executed");
    const outside = path.join(root, "outside-loader.mjs");
    fs.writeFileSync(outside, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "bad");`);
    const legacy = path.join(root, "cli/node_modules/tsx/dist/loader.mjs");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.symlinkSync(outside, legacy);
    const entrypoint = path.join(root, mode === "development TypeScript" ? "src/worker.ts" : "server/dist-runtime/worker.mjs");
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    const annotation = mode === "development TypeScript" ? ": string" : "";
    fs.writeFileSync(entrypoint, `
      import { definePlugin, runWorker } from ${JSON.stringify(sdk)};
      const runtime${annotation} = process.versions.bun ?? "not-bun";
      const plugin = definePlugin({
        async setup() {},
        async onHealth() { return { status: "ok", message: runtime }; },
      });
      runWorker(plugin, import.meta.url);
    `);
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.bun-runtime-fixture", apiVersion: 1, version: "0.1.0",
      displayName: "Bun runtime fixture", description: "Native worker runtime regression",
      author: "Paperclip", categories: ["ui"], capabilities: [], entrypoints: { worker: entrypoint },
    };
    const manager = createPluginWorkerManager();
    const inherited = [...process.execArgv];
    process.execArgv.push("--import", outside);
    try {
      const worker = await manager.startWorker(manifest.id, {
        entrypointPath: entrypoint, manifest, config: {}, apiVersion: 1,
        instanceInfo: { instanceId: "runtime-fixture", hostVersion: "0.0.0" },
        hostHandlers: {}, execArgv: [], autoRestart: false,
      });
      expect(worker.status).toBe("running");
      await expect(manager.call(manifest.id, "health", {})).resolves.toMatchObject({
        status: "ok", message: process.versions.bun,
      });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...inherited);
      await manager.stopAll();
    }
  });
});
