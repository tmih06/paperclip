# ompig-slim Durable adapter

Adapter type: `ompig_slim`. Requires a pinned `ompig-slim` executable and Node
inside the selected environment. It never downloads tools or copies profiles or
credentials from the host. Configure an exact `provider/model`, credentials via
secret-backed environment variables or a provisioned profile, and a workspace.

`execute`, `testEnvironment`, and `sessionCodec` are exported from
`@paperclipai/adapter-ompig-slim/server`. The environment test verifies the
workspace, commands and Durable CLI protocol, then makes one bounded, one-turn
hello assignment against the configured model. It consumes that provider's
allowance (and may incur charges for a paid model). A protocol-only check is
not enough to activate the agent. Failed or unanswered probes remain failures;
there is no automatic switch to another model or provider.

For native keyless OpenCode Free inference, set `model` to
`opencode-free/beam-free` and use an ompig-slim build containing that provider.
It does not require an OpenCode CLI or a copied user profile. The historical
0.1.10 runtime example below is not qualification of that newer provider; the
source-pinned 0.2.1 real Kubernetes task passed after an upstream quota reset.
The evidence and limits are recorded in
`doc/benchmarks/2026-11-18-ompig-beam-kubernetes-e2e.md`.

## Local kind runtime

```sh
docker build -f docker/Dockerfile.ompig-runtime -t paperclip-ompig-runtime:0.1.10 .
kind load docker-image paperclip-ompig-runtime:0.1.10 --name paperclip
# Set runtimeImage to paperclip-ompig-runtime:0.1.10 for ompig_slim in docker/kubernetes-adapters.json.
```

## Sandbox startup

The adapter checks for both executables in one sandbox command after staging the workspace. The controller can reuse verified seed archives for identical workspace snapshots within the same instance, company, and workspace. The cache is bounded and is not a recovery checkpoint. Each pod still receives its own workspace.

The adapter honors the instance duplex bridge opt-in only when the provider advertises support. Kubernetes currently uses the file bridge. A supported provider can fall back to the file bridge when duplex startup fails.

## Assignment and storage boundary

Every run uses `durable run --state <workspace>/.paperclip-ompig/<company>/<agent>/<run>`.
All identifiers are hashed path segments. A repeated identical run uses
`durable resume` only after checking its immutable assignment. There is no
unknown-session fallback: missing saved state, changed identity/cwd/model/prompt,
or an unfinished assignment from a different run fails closed. A new turn after
a terminal answer starts a fresh workdesk using Paperclip's bounded handoff.
`unanswered` remains terminal for its assignment; retry needs operator review,
not an automatic fresh workdesk. Keep the workdesk until retention/acceptance
policy explicitly disposes of it.

The full workdesk (SQLite database, WAL, job intent and lock file) is below the
execution workspace, so clean-stop workspace sync can collect it along with
repository changes. No copy-out is attempted before process stop is verified.
Sync is NOT a transactionally consistent, continuous backup: deleting an
emptyDir pod, losing a node, or losing the controller before collection can lose
both assignment state and uncommitted files. For infrastructure-crash recovery,
persist both on locking/WAL-capable storage, retain the same absolute cwd and
execution identity, and test the chosen CSI class. An adapter receipt does not
certify persistence. Never delete owner.lock to bypass a running writer.

Durable emits committed text/tool events through its optional event file. The
adapter transports those to Paperclip and parses the final JSON receipt and
usage. If a release includes a receipt-level `progress` field, it is forwarded
as optional metadata; the adapter does not claim model-compaction checkpoint
recovery. The released 0.1.10 binary passed focused SIGKILL/resume, dedup,
status, workspace-preservation, and identity-mismatch smoke checks; the newer
full compaction acceptance remains a known release-compatibility gap.
SIGTERM/SIGINT leave work recoverable; Core owns the whole process tree.
Interrupted external effects are not exactly-once. `done` means an answer, not
passing tests or approval.

## Opt-in binary integration test

Set `PAPERCLIP_OMPIG_BINARY` to a pinned executable and run
`bun x --bun --no-install vitest run packages/adapters/ompig-slim/src/server/durable-binary.test.ts`.
The skipped-by-default test creates an isolated temporary `models.json`, local
mock streaming model, profile, workspace and Durable state; it removes ambient
broker/API credentials, verifies interrupted new-run resume and duplicate
admission behavior, and cleans up. It does not certify pod-deletion recovery.
