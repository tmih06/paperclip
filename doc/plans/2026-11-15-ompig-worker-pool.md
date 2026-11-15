# ompig-slim image agents and Docker worker pool

## Contract and ownership

An agent is a reusable image-backed definition. Each run launches an independent clone in a Docker sandbox. Workers, not agent identities, own physical slots. Ticket checkout, company authorization, approval, budgets, run cancellation and verified workspace copyback remain Paperclip-owned.

Implement this as the first-party `integrations/ompig-factory` package: an installable sandbox provider plus an ompig adapter using existing execution-target/bridge contracts, and a standalone authenticated Docker worker. Keeping this integration out of the pnpm workspace avoids changing the repository lock or adding worker-only dependencies to server startup. No edits to the sibling ompig-slim repository. Its existing durable CLI and published workspace binary are the execution contract.

The provider chooses a worker only after a definite capacity rejection; ambiguous creation failures carry exact cleanup ownership through the existing SDK. Worker SQLite reservations and Docker labels survive daemon restart. Expiry acts on actual deadlines, not idle polling. Company-bound credentials, digest allowlists, non-root containers and verified termination are mandatory. Mutable image tags, arbitrary Docker flags, host mounts selected by clients, Docker sockets inside sandboxes and cross-clone writable state are forbidden.

Agent image selection lives in the saved sandbox environment: one immutable image per agent version/environment; multiple environments share the same worker pool. Existing remote workspace realization, staging and copyback are reused rather than implementing a parallel Git/sync protocol. The adapter runs ompig durable inside that target. Durable output `done` is not verified ticket completion. Durable mode does not automatically load normal ompig extensions/skills/MCP; document this limitation. No automatic merge or paid model calls.

A small shared admission-policy change is required if the current per-agent cap would limit the new slot-backed adapter. Preserve all existing adapters' behavior and all daily/company/budget/issue guards; only physical concurrency for this adapter is delegated to worker slots. No new core database schema is needed.

## Work tracking

- [x] Inspect sandbox/provider, adapter, concurrency and ompig durable contracts.
- [x] Implement authenticated Docker workers, durable reservations, lifecycle and expiry.
- [x] Implement the sandbox provider using existing cleanup/stop/sync contracts.
- [x] Implement ompig execution, per-run private state and cancellation using execution targets.
- [x] Enable slot-backed concurrency without changing existing adapters.
- [x] Document images, installation, worker deployment, security and recovery.
- [x] Run focused worker/provider/adapter/admission tests: 33 factory tests pass (one opt-in live Docker test skipped by default); 210 shared/admission/UI-render tests pass; 9 UI helper tests pass after restoring the ignored pnpm-style Lexical link left absent by the previous Bun installation.
- [x] Exercise real Docker locally; report remote/model/CI acceptance gaps. The opt-in root Node 24 smoke passed, including the real ompig durable fixture and adapter staging/bridge/copyback/cancellation path. Five-worker deployment, network firewall, registry, and paid-provider acceptance remain operator work.

## Verification and deployment boundaries

Docker is available locally. Five worker addresses, their capacity, image registry credentials and model credentials have not been supplied; remote installation and paid end-to-end model execution cannot be claimed. Do not modify or stop unrelated host containers. Disk starts at ~2.9 GiB free, so avoid large dependency installs/builds or duplicating existing image layers. Node/pnpm remain the runtime on this branch; the Bun migration is on a separate committed branch.

Verification completed on the final working tree: focused factory tests (33 total, 32 pass + 1 opt-in Docker skip), shared/admission/UI focused tests (210 pass), UI helper tests (9 pass), real root Node 24 Docker/ompig adapter smoke pass, shared/server/UI typechecks pass, JavaScript syntax checks and `git diff --check` pass. `pnpm install --frozen-lockfile --offline` was used to restore pnpm workspace links after the separate Bun migration had left the checkout's node_modules layout incomplete; no lockfile was changed.

## Fork-only, name-only onboarding

- [x] Replace the provider/login/review wizard with organization naming followed by agent naming → Finish. Keep the account-aware draft ownership gate, company navigation fences, governed setup/hire/approval APIs, and stable setup IDs for retry.
- [x] Resolve the default (or sole active) factory environment and inherit its pinned image and admin-configured `model`. Missing pools, ambiguous defaults, missing models, unavailable adapters, and failed worker inventory probes fail closed; never fall back to Local.
- [x] Replace tests for retired Claude/Codex onboarding screens with factory default-selection and hire/error/retry/cancellation tests; retain draft/account ownership and company-route regressions.
- [x] Verify the revision locally: 68 onboarding/wrapper tests pass, 233 adjacent route/state/config-render tests pass, UI typecheck passes, factory suite passes (32 + one opt-in Docker skip), and `git diff --check` passes. No paid model calls were made.
- [x] Chromium verification: live dev stack shows only agent name and Finish; a missing pool reports the real prerequisite with no writes. A separately identified API-fixture browser scenario verifies the configured-pool name → single factory hire → dashboard transition. All operator mutation requests were intercepted; no user agents were changed. This fixture is **not** evidence of remote worker deployment or real model authentication.

Five-worker deployment, a live configured-pool onboarding hire, model credentials, final CI, and remote network isolation remain unverified/operator prerequisites. Advanced agent editing retains existing adapter implementations; onboarding alone is Docker-only.

## Local two-slot deployment (operator requested)

- Local systemd service `paperclip-factory-local.service` is enabled and running on `127.0.0.1:8787`. Installed worker sources and pinned Node 24 executable live under `/opt/paperclip-factory-local`; configuration/token are root-only at `/etc/paperclip-factory-local/worker.json`; SQLite/lease state is under `/var/lib/paperclip-factory-local`.
- Capacity: two slots, each capped at 1 CPU and 2048 MiB RAM. The preloaded immutable local image is `paperclip-ompig-factory@sha256:3f533f41102839ca57050c9f4f9d374587afa958a1061ede78ec1046c344ee95` (real ompig durable binary verified). Sandboxes use `network: none`; no external model/Git egress is enabled.
- The pool `Local Docker Factory (2 slots)` (`f07d44c2-a775-4f69-b11f-bee03add95ff`) is registered for company `tmih06` through the normal APIs, uses a company secret reference, is the instance default, and is visible in environment settings. No existing agent was unpaused or reconfigured. No model/default-model credential was invented: naming-only onboarding still requires that operator configuration.
- The first real Core environment probe exposed `factory_agent_required`: explicit platform probes have no saved agent. Added a failing provider regression, then normalized only explicit `resolveSnapshotIdentity` probes to an operation-owned `probe-…` container identity. Ordinary run allocations still reject missing agents. Provider tests passed red → green; the full integration suite now has 34 passes and one opt-in skip.
- The real Paperclip environment probe now passes and records Linux/arm64/musl qualification. A separate live worker check allocated two independent containers simultaneously, executed commands as UID 1000 with private files, verified the CPU/memory/read-only/offline settings, rejected the third request with `409 factory_slots_full`, restarted the worker while both were occupied, and confirmed both reservations survived. Only those test containers were destroyed; final capacity is 0 occupied / 2 slots. Root-only evidence is `/var/lib/paperclip-factory-local/verification.json`.
- This proves local capacity and the provider/Core probe, not paid model authentication, remote worker deployment, or a complete ticket-to-model workflow.

## Compose credential broker and connected clones

- Added `integrations/ompig-factory/compose.yml`: the real ompig broker image runs as UID 10001 with a persistent private vault volume, file-backed bearer, health check, constrained resources, and a bind only on the local sandbox bridge gateway. It is a credential/profile broker, **not an inference proxy**. The existing root worker remains a systemd service; no Docker socket or vault volume is exposed to clones/the broker.
- Worker `clients[].broker` holds a company-owned URL/bearer and injects it only into that company's exec environment, overriding assignment broker destinations/token-file overrides without persisting the bearer in lease metadata. No provider keys or refresh tokens are baked into images or copied from private user state.
- Broker-backed clone startup creates a per-run profile and performs bounded authenticated preflight; native ompig owns profile sync and remote vault resolution. Broker outage/authentication failure blocks launch. Direct provider egress remains necessary.
- Added a Linux/rootful Docker network helper and boot service example. It creates only the labelled `paperclip-factory-egress` network/`pc-factory0` bridge and scoped `PCFACTORY-*` chains, refusing drift without flushing unrelated rules. Only the local broker, public HTTPS and selected public DNS are admitted; host control-plane, metadata/private/tailnet/peer traffic are denied.
- Local deployment is active: Compose project `paperclip-factory-local`, broker `http://172.30.250.1:8765`, secrets outside Git in `/etc/paperclip-factory-local`, worker loopback `127.0.0.1:8787`, two slots. The network helper is installed under `/opt/paperclip-factory-local` and enabled via `paperclip-factory-network.service`; the worker requires it before startup. This supersedes the initial offline-network configuration above. No unrelated workloads were stopped.
- Verification: default integration suite 39 total / 37 pass / 2 opt-in skips; explicit real Compose/native-ompig broker test passes using two simultaneous durable clones and synthetic inference. The synthetic key exists only in the temporary broker vault, not the model document or clone env. Tests verify no local credential database, wrong-auth/outage rejection, and vault persistence across broker restart. Temporary test network/volume/rules are removed. No paid model calls.
- Live installed worker checks passed on both simultaneous slots: authenticated broker access, public HTTPS egress, blocked host API, blocked metadata endpoint, and a blocked peer HTTP listener with a positive same-container listener check. Core's environment/platform probe also passes. Final capacity is 0 occupied / 2 slots; live broker is healthy and binds only the private gateway. Root-only evidence: `/var/lib/paperclip-factory-local/broker-verification.json`.
- At initial broker deployment the vault was empty; no model/default credential was invented or migrated. The explicit provider enrollment below supersedes that initial account/default-model prerequisite. Remote-worker HTTPS/Tailscale ingress and exact egress exceptions, final CI, and a real ticket workflow remain unverified.

## Explicit Deploy / DeepSeek enrollment

- At the operator's request, saved the supplied Deploy API key in the broker's credential vault (provider `deploy`, API-key credential). The temporary private provisioning input was deleted after successful storage. No key was committed, embedded in model documents, placed in worker management configuration, or printed in verification output.
- Published the exact requested endpoint/model metadata in broker `models.json`: OpenAI completions at `https://api-sf1.deploy.com/api/v1`, model `deepseek-ai/deepseek-v4.1-flash-1017`, reasoning enabled, text/image input, 1,000,000-token context, 32,768 max output, and the requested developer-role/reasoning-effort/max-token compatibility flags. Broker settings default and Paperclip pool default are both `deploy/deepseek-ai/deepseek-v4.1-flash-1017`.
- Found and fixed provider validation dropping the optional `model` during normalization. A regression failed with `normalizedConfig.model === undefined`, then passed after preserving/validating the trimmed model. Reloaded the provider with zero occupied slots and saved/read back the environment default through the normal API.
- Live acceptance on a **fresh actual local clone** passed: native broker/profile auto-sync, remote-vault credential resolution, and one bounded durable connectivity run against the real provider. It returned `done` with answer `OK` (reported usage 1,184 input / 65 output tokens; no price/cost was invented). This was an explicitly scoped live connectivity check, not a paid call added to the automated test suite.
- After inference, verified the clone's synchronized provider/model metadata exactly matches the supplied fields, the model document contains no embedded `apiKey`, and no local `agent.db`/`auth.json` credential store exists. The verification clone was destroyed; final occupancy is 0 / 2. Root-only evidence is `/var/lib/paperclip-factory-local/deploy-verification.json`.
- This proves real text inference with broker-backed credentials, not image-input acceptance, maximum context/output limits, model quality, a completed repository ticket, or remote-host deployment.
