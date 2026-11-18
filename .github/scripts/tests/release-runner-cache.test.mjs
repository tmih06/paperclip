import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../workflows/release-verify.yml", import.meta.url), "utf8");
const runner = workflow.split("  verify_paperclip_runner:")[1].split("  build:")[0];

test("Runner dependency caching selects the package's pinned compiler before computing its key", () => {
  const select = runner.indexOf("      - name: Select the pinned Runner Rust toolchain");
  const cache = runner.indexOf("      - name: Cache Runner Rust dependencies");
  assert.ok(select >= 0 && cache > select);
  const setup = runner.slice(select, cache);
  assert.match(setup, /working-directory: packages\/paperclip-runner/);
  assert.match(setup, /rustup show active-toolchain/);
  assert.match(setup, /echo "RUSTUP_TOOLCHAIN=\$toolchain" >> "\$GITHUB_ENV"/);
  assert.match(runner, /uses: Swatinem\/rust-cache@[0-9a-f]{40} # v[0-9.]+/);
  // The target path feeds the entry's version hash, so it must not resolve
  // under the checkout, whose root differs between the fleet and GitHub-hosted
  // runners. The pin step publishes a $HOME-anchored path to the same directory.
  const pin = runner.indexOf("      - name: Pin the Runner Rust workspace path");
  assert.ok(pin >= 0 && cache > pin, "the workspace path must be pinned before the cache step");
  assert.match(runner, /workspaces: \$\{\{ steps\.runner_rust_workspace\.outputs\.path \}\} -> target/);
  assert.match(runner, /shared-key: release-runner-v2/);
});

test("the shared cache excludes workspace artifacts and only restores or saves the exact master-push source", () => {
  assert.match(runner, /cache-workspace-crates: false/);
  assert.match(runner, /cache-bin: false/);
  const cacheStep = runner.split("      - name: Cache Runner Rust dependencies")[1].split("      - name: Install dependencies")[0];
  const unwrap = (value) => value?.match(/^\$\{\{ (.+) \}\}$/)?.[1];
  const saveIf = unwrap(cacheStep.match(/^\s*save-if: (.+)$/m)?.[1]);
  const restoreIf = unwrap(cacheStep.match(/^\s*if: (.+)$/m)?.[1]);
  assert.ok(saveIf && restoreIf, "the cache step needs both a restore guard and a save guard");
  const sha = "a".repeat(40);
  const canonical = { repository: "paperclipai/paperclip", event_name: "push", ref: "refs/heads/master", sha };
  // Fork release dispatches are a trusted source too. Their cache lives in the
  // fork's own repository scope, so saving there cannot seed master's entry.
  const fork = { repository: "tmih06/paperclip", event_name: "workflow_dispatch", ref: "refs/heads/master", sha };
  const canSave = (context) => runInNewContext(saveIf, context);
  const canRestore = (context) => runInNewContext(restoreIf, context);
  for (const lane of ["protocol", "rust", "server-integration"]) {
    const context = (overrides, ref) => ({ matrix: { lane }, github: { ...canonical, ...overrides }, inputs: { ref } });
    // Only the Rust lane writes the shared entry, and only for an exact-source
    // trusted push. A save anywhere else lets a non-canonical run seed the
    // entry that verification later restores from.
    assert.equal(canSave(context({}, sha)), lane === "rust", "the canonical master push saves only from the Rust lane");
    assert.equal(canSave(context(fork, sha)), lane === "rust", "a fork release dispatch saves only from the Rust lane");
    for (const overrides of [{ event_name: "pull_request", ref: "refs/pull/1/merge" }, { event_name: "workflow_dispatch" },
      { repository: "someone/paperclip" }, { ref: "refs/heads/feature" }]) {
      assert.equal(canSave(context(overrides, sha)), false, `untrusted source must not save: ${JSON.stringify(overrides)}`);
    }
    assert.equal(canSave(context({}, "b".repeat(40))), false, "an unmerged source must not save");
    assert.equal(canSave(context(fork, "b".repeat(40))), false, "a fork save must name the exact source too");
    // Reading the entry is the safe half of the contract: every lane restores.
    assert.equal(canRestore(context({}, sha)), true);
  }
  assert.doesNotMatch(runner, /cache-on-failure: true|cache-all-crates: true/);
});

test("parallel lanes cover check:all exactly once and never bypass verification", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../../packages/paperclip-runner/package.json", import.meta.url))).scripts;
  const checks = [...runner.matchAll(/^            checks: (.+)$/gm)].flatMap(([, value]) => value.split(" "));
  assert.deepEqual(checks, scripts["check:all"].split(" && ").map((command) => command.replace(/^bun run /, "")));
  assert.deepEqual([...runner.matchAll(/^          - lane: (.+)$/gm)].map(([, value]) => value), ["protocol", "rust", "server-integration"]);
  assert.match(runner, /fail-fast: false/);
  assert.doesNotMatch(runner, /max-parallel: 1|^    needs:|continue-on-error:/m);
  const verify = runner.split("      - name: Verify Paperclip Runner\n")[1].split("      - name:")[0];
  assert.match(verify, /RUNNER_CHECKS: \$\{\{ matrix.checks \}\}/);
  assert.match(verify, /set -euo pipefail/);
  assert.match(verify, /for check in \$RUNNER_CHECKS; do\s+bun run --filter @paperclipai\/paperclip-runner "\$check"\s+done/);
  const verifyIf = verify.match(/^\s*if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.equal(verifyIf, "matrix.lane != 'server-integration'");
  for (const lane of ["protocol", "rust", "server-integration"]) {
    assert.equal(runInNewContext(verifyIf, { matrix: { lane } }), lane !== "server-integration");
  }
  assert.doesNotMatch(verify, /cache-hit/);
  assert.doesNotMatch(runner, /id-token: write|packages: write|secrets: inherit/);
});

test("only the trusted Rust lane writes, and warms both build profiles before saving", () => {
  const cache = runner.split("      - name: Cache Runner Rust dependencies")[1].split("      - name: Install dependencies")[0];
  const warm = runner.split("      - name: Warm debug dependencies for the shared Runner cache")[1];
  assert.match(warm, /run: bun run --filter @paperclipai\/paperclip-runner build:rust/);
  const expr = (body, field) => body.match(new RegExp(`^ +${field}: \\$\\{\\{ (.+) \\}\\}$`, "m"))[1];
  // A lane that saves the shared cache must also warm it, or the entry it
  // publishes is colder than the one the other lanes restore. Hold the two
  // guards to one source set so neither can drift from the other.
  const saves = (context) => runInNewContext(expr(cache, "save-if"), context);
  const warms = (context) => runInNewContext(expr(warm, "if"), context);
  const sha = "a".repeat(40);
  const base = { repository: "paperclipai/paperclip", event_name: "push", ref: "refs/heads/master", sha };
  for (const lane of ["protocol", "rust", "server-integration"]) {
    for (const [overrides, ref, trusted] of [
      [{}, sha, true],
      [{ event_name: "pull_request", ref: "refs/pull/1/merge" }, sha, false],
      [{ event_name: "pull_request_target" }, sha, false],
      [{ event_name: "workflow_dispatch" }, sha, false],
      [{ repository: "someone/paperclip" }, sha, false],
      [{ ref: "refs/heads/feature" }, sha, false],
      [{}, "b".repeat(40), false],
      // Fork release dispatches are a trusted source too. They cache
      // dependencies only, and every invocation still builds and verifies its
      // own workspace code.
      [{ repository: "tmih06/paperclip", event_name: "workflow_dispatch" }, sha, true],
    ]) {
      const context = { matrix: { lane }, github: { ...base, ...overrides }, inputs: { ref } };
      assert.equal(saves(context), trusted && lane === "rust", `save-if: ${JSON.stringify(overrides)}`);
      assert.equal(warms(context), trusted && lane === "rust", `warm if: ${JSON.stringify(overrides)}`);
    }
  }
});
