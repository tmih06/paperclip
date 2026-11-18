import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite-plus";
import { describe, expect, it } from "vitest";
import { MINIMUM_BUN_VERSION, formatBunVersionWarning } from "@paperclipai/shared/bun-version";

// The server entrypoint cannot be imported by a test (it starts a real server),
// so the wiring is proven the way this repository already proves boot-order
// facts: read `server/src/index.ts` and assert on its boot path.
const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const source = readFileSync(entrypoint, "utf8");

type Node = { type: string; [key: string]: unknown };

function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is Node => Boolean(value) && typeof (value as Node).type === "string");
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

describe("server startup runtime warning", () => {
  it("guards on the Bun runtime helper instead of the retired Node.js helper", () => {
    expect(source).toContain('from "@paperclipai/shared/bun-version"');
    expect(source).not.toContain("@paperclipai/shared/node-version");
    expect(source).not.toContain("warnIfUnsupportedNodeVersion");
    // Bun's advertised Node.js compatibility version must never be the input.
    expect(source).not.toMatch(/warnIfUnsupportedBunVersion\(\s*process\.versions\.node/);
  });

  it("calls the guard from the server startup path, not from a request handler", () => {
    const calls: string[] = [];
    walk(parseAst(source, { lang: "ts" }) as unknown as Node, (node) => {
      if (node.type !== "CallExpression") return;
      const callee = node.callee as Node & { name?: string };
      if (callee?.name === "warnIfUnsupportedBunVersion") calls.push(callee.name);
    });
    expect(calls).toHaveLength(1);

    const startupStart = source.indexOf("async function startServerWithDatabaseTeardown(");
    const warnAt = source.indexOf("warnIfUnsupportedBunVersion(");
    const firstDatabaseWork = source.indexOf("await instrumentationReady", startupStart);
    expect(startupStart).toBeGreaterThan(-1);
    expect(warnAt).toBeGreaterThan(startupStart);
    expect(warnAt).toBeLessThan(firstDatabaseWork);
  });

  it("reports the Bun that actually runs this suite", () => {
    expect(process.versions.bun, "server tests must run on Bun").toBeTruthy();
    expect(formatBunVersionWarning()).toBeNull();
    expect(formatBunVersionWarning({ bunVersion: "1.0.0" })).toContain(`requires Bun ${MINIMUM_BUN_VERSION} or newer`);
  });
});
