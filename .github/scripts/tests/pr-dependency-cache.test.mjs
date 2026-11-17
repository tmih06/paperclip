import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
const jobs = [...workflow.matchAll(/^  ([a-z_][a-z_0-9]*):\n([\s\S]*?)(?=^  [a-z_][a-z_0-9]*:\n|$(?![\s\S]))/gm)];
const installers = jobs.filter(([, , body]) => body.includes("bun install --frozen-lockfile"));

test("PR workflows restore dependency stores without creating branch copies", () => {
  assert.equal(installers.length, 7);
  assert.doesNotMatch(workflow, /^ +cache: pnpm$/m);
  assert.doesNotMatch(workflow, /uses: actions\/cache(?:@|\/save@)/);
  for (const [, job, body] of jobs) {
    for (const step of body.split("      - name:").filter((step) => step.includes("uses: actions/setup-node@"))) {
      assert.match(step, /package-manager-cache: false/, job);
    }
  }
  const policy = jobs.find(([, name]) => name === "policy")[2];
  assert.doesNotMatch(policy, /uses: actions\/cache|cache: pnpm/);
});

for (const [, job, body] of installers) {
  test(`${job}: reuse master keys before installing with an inline stale-lockfile fallback`, () => {
    const locate = body.indexOf("      - name: Locate the Bun install cache");
    const restore = body.indexOf("      - name: Restore the Bun install cache (read only)");
    const install = body.indexOf("      - name: Install dependencies");
    assert.ok(locate >= 0 && locate < restore && restore < install);
    const cache = body.slice(restore, install);
    assert.match(body.slice(locate, restore), /bun pm cache/);
    assert.match(body.slice(locate, restore), /bun -e 'console\.log\(process\.arch\)'/);
    assert.match(cache, /uses: actions\/cache\/restore@[a-f0-9]{40}/);
    assert.ok(cache.includes("key: bun-cache-${{ runner.os }}-${{ steps.bun_cache.outputs.arch }}-${{ hashFiles('bun.lock') }}"));
    assert.ok(cache.includes("restore-keys: bun-cache-${{ runner.os }}-${{ steps.bun_cache.outputs.arch }}-"));
    // Lanes must not wait on the policy job for a regenerated lockfile; each
    // install resolves a stale one inline and then re-validates frozen.
    const installStep = body.slice(install).split("      - name:")[1] ?? body.slice(install);
    assert.match(installStep, /if ! bun install --frozen-lockfile; then/);
    // Plain `bun install --no-save` resolves packages into node_modules but
    // never writes bun.lock, so the frozen retry would still see a stale lock.
    // Bun's lockfile-only resolution is what rewrites it in place.
    assert.match(installStep, /bun install --lockfile-only/);
    assert.doesNotMatch(installStep, /needs\.policy/);
  });
}
