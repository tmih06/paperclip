import assert from "node:assert/strict";
import test from "node:test";
import { migratePackageScript } from "./migrate-root-bun-scripts.mjs";

for (const [before, after] of [
  ["vp build", "bun x --bun --no-install vp build"],
  ["vite build --config vite.sdk.config.ts", "bun x --bun --no-install vp build --config vite.sdk.config.ts"],
  ["bun x tsc --noEmit", "bun x --bun --no-install tsc --noEmit"],
  ["bun x --no-install vitest run", "bun x --bun --no-install vitest run"],
  ["bun run build && storybook build", "bun run build && bun x --bun --no-install storybook build"],
  ["bun x --no-install bun src/probe.ts", "bun src/probe.ts"],
  ["cd docs && bun x mintlify dev", "cd docs && bun x --bun mintlify dev"],
  ["cd evals/promptfoo && bun x promptfoo@0.103.3 eval", "cd evals/promptfoo && bun x --bun promptfoo@0.103.3 eval"],
  ["bun scripts/ci-profile/run.mjs bun x playwright playwright test", "bun scripts/ci-profile/run.mjs playwright bun x --bun --no-install playwright test"],
  ["cross-env FOO=1 bun app.ts", "FOO=1 bun app.ts"],
]) {
  test(`package scripts run native Bun tools: ${before}`, () => {
    assert.equal(migratePackageScript(before), after);
    assert.equal(migratePackageScript(after), after);
  });
}
