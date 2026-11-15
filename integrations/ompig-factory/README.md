# ompig-slim Docker software factory

One **agent** is a reusable, image-backed definition. A **clone** is one run of that definition. A **sandbox slot** is physical capacity on a worker. Ten tickets assigned to the same agent can use ten slots concurrently; they do not need ten agent records.

This first-party integration supplies:

- An authenticated, company-scoped Docker worker daemon with a local SQLite slot ledger.
- A Paperclip sandbox-provider plugin, `ompig_factory`, for a pool of workers.
- An external adapter, also `ompig_factory`, running the existing `ompig-slim durable` interface.
- A transcript parser for committed text/tool events and incremental usage checkpoints.
- A sample agent image and worker service configuration.

It is not installed automatically, and it does not contact or install software on discovered Tailscale peers.

## Architecture

```text
Ticket assigned to Developer (agent image digest)
                     |
             Paperclip run admission
      company / checkout / budgets / approval
                     |
           ompig_factory sandbox provider
                     |
          authenticated HTTPS / Tailscale
          +----------+----------+----------+----------+
          |          |          |          |          |
       Worker 1   Worker 2   Worker 3   Worker 4   Worker 5
       2 slots    2 slots    2 slots    2 slots    2 slots
          |
          +-- Sandbox A: Developer clone -> Ticket A
          +-- Sandbox B: Developer clone -> Ticket B
```

An agent's `adapterConfig.image` pins its immutable version. Its saved sandbox environment selects the worker pool and must specify the same image. Before staging or executing agent work, the adapter checks the worker's read-only image attestation. A project/task placement override cannot silently substitute another agent image.

Publishing another image does not update existing clones. To change an agent version, update its image and select a matching environment. For predictable history, create a new versioned environment instead of editing an environment with retained leases.

## Requirements

Control plane:

- This Paperclip revision, self-hosted with permission to install trusted external adapters/plugins.
- The repository's Node/pnpm setup. **This feature does not depend on the separate Bun migration.**
- Network access to the worker origins, plus company secrets for worker/model credentials.

Workers:

- Linux, rootful Docker, and a **real Node 24.11+** executable with `node:sqlite`.
- A root-owned, local persistent data directory; local SQLite locking must work. Do not share a ledger between machines or use NFS.
- Preloaded, explicitly allowlisted immutable images compatible with the worker architecture.
- Synchronized clocks for absolute lease deadlines.
- Enough reserved CPU, RAM and disk for the configured slots; account for other host workloads.

The worker uses Node builtins and Docker CLI only: it needs no npm install, database server, or Go compiler. It may hold a company-scoped broker bearer, but never needs provider API keys or OAuth refresh tokens in its config. ompig-slim itself is the Go binary **inside each sandbox**, not a Node agent.

## 1. Build an agent image

The sample image adds Node for Paperclip's callback bridge/launcher, Git, Python, shell and archive tools to the ompig binary. Add your repository's build tools to a derived image (Go, Rust, pnpm, Bun, browser dependencies, etc.). The sample is not a universal development environment.

From the Paperclip checkout:

```sh
docker build -f integrations/ompig-factory/Dockerfile.agent \
  --build-arg OMPIG_IMAGE=ghcr.io/tmih06/ompig-slim-workspace@sha256:<pinned-source-digest> \
  -t ghcr.io/tmih06/factory-developer:v1 .
```

`OMPIG_IMAGE` is deliberately required. The Dockerfile pins the Node image index. The build's empty-default-ARG warning is expected when no default source image is defined; always supply the source digest.

Build/push both `linux/amd64` and `linux/arm64` when the pool is mixed architecture. Use the published **manifest digest**, not a mutable `v1` or `latest` tag, in Paperclip and worker allowlists. A local `sha256:<image-id>` is accepted for offline testing on a worker where that image is loaded.

Put role instructions at `/opt/agent/instructions.md`. The launcher reads that immutable file before the assignment. Do not bake credentials, previous sessions or ticket checkouts into the image. Do not rely on an image's ENTRYPOINT: the worker replaces it with the lease lifetime guard and explicitly invokes ompig for each run.

## 2. Provision each worker

Copy this integration to the same path used in the service example, or adjust `ExecStart`. No sibling ompig checkout is required on workers.

```sh
sudo install -d -m 0700 /etc/paperclip-factory /var/lib/paperclip-factory
sudo install -m 0600 integrations/ompig-factory/examples/worker.json /etc/paperclip-factory/worker.json
```

Edit the root-owned config:

- Give each host a unique, stable `workerId`.
- Set `slots`, `cpusPerSlot`, and `memoryMiB` to its reserved capacity.
- Set the **actual Paperclip company UUID**.
- Generate an opaque token with `openssl rand -hex 32`; save it as a company secret in Paperclip. Use that company's token on its five workers. Do not commit it.
- Replace the image placeholder with its immutable digest, then preload it with `docker pull <digest>`.
- For multiple companies, add separate company-bound tokens in `clients`. A token cannot inspect/execute/destroy another company's leases. Rotate keys without removing credentials needed for outstanding creation cleanup.
- Choose an egress network as described below. `network: "none"` is intentionally offline and safe for local smoke tests, not sufficient for public model APIs.

The service example is `examples/paperclip-factory.service`. Install Node 24.11+ at its configured **system-wide absolute path** first. On the development host `/usr/bin/node` was Node 18 even though the user's shell selected Node 24; do not assume they are the same. `ProtectHome=true` intentionally prevents using a runtime installed only under a user's home.

Install the edited service and start it:

```sh
sudo install -m 0644 integrations/ompig-factory/examples/paperclip-factory.service /etc/systemd/system/paperclip-factory.service
sudo systemctl daemon-reload
sudo systemctl enable --now paperclip-factory.service
```

Default bind is loopback port 8787. Prefer Tailscale HTTPS Serve:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Restrict the Tailscale policy to the control-plane node/tag. Use the resulting `https://worker-name.<tailnet>.ts.net` origins in Paperclip. Alternatively bind explicitly to the host's Tailscale IPv4 and use `http://100.x.y.z:8787`; plaintext HTTP is accepted only for loopback or Tailscale's CGNAT range. That address must really be routed over your encrypted tailnet. Public plaintext origins and redirects are refused.

Never expose Docker TCP 2375. The worker token belongs only to the control plane and worker daemon—not to agents.

## 3. Configure sandbox network isolation

Before allowing real repository/model access, create a dedicated Docker bridge with `com.docker.network.bridge.enable_icc=false` and set its name in worker config. Startup rejects the default bridge, host networking and bridges without that isolation option.

**That option alone is not an egress firewall.** Configure and test the appropriate Docker host firewall for your backend (iptables/nftables):

- Deny sandbox access to other sandboxes, worker management addresses, your LAN, tailnet, link-local/metadata endpoints, and the control-plane database.
- Allow only required model/Git/package endpoints or an explicit egress proxy, plus needed DNS.
- Do not publish arbitrary sandbox ports or mount the Docker socket.
- Paperclip API callbacks use the existing authenticated callback bridge; the sandbox does not need general tailnet access to Paperclip.

There is no portable automatic host-firewall installer in this package. Keep `network: "none"` until an operator has configured and verified egress. An unrestricted named bridge is not a production sandbox policy.

## 4. Install the provider and adapter

From a development/source checkout, build/link the exact in-repo SDK and adapter utilities:

```sh
node scripts/ensure-plugin-build-deps.mjs
node integrations/ompig-factory/scripts/link-dev.mjs
```

These are explicit checkout-only setup commands, not package install lifecycle hooks. They avoid accidentally testing a published SDK against different core source. Published/relocated distributions must supply compatible peer packages; this integration is currently private/local-path only.

With Paperclip running and the CLI connected as an authorized operator:

```sh
paperclipai plugin install /absolute/path/to/paperclip/integrations/ompig-factory
paperclipai plugin inspect paperclip.ompig-factory
paperclipai adapter install --payload-json '{"packageName":"/absolute/path/to/paperclip/integrations/ompig-factory","isLocalPath":true}'
paperclipai adapter get ompig_factory
```

Both registrations are needed: the plugin provisions containers; the adapter runs ompig. Verify the installed plugin is ready and its `ompig_factory` driver is visible. These registration commands must be run against this feature revision, not an older packaged server.

In **Instance Settings → Environments**, create a sandbox environment using Docker Worker Pool. Example driver fields:

```json
{
  "workers": [
    "https://worker-1.example.ts.net",
    "https://worker-2.example.ts.net",
    "https://worker-3.example.ts.net",
    "https://worker-4.example.ts.net",
    "https://worker-5.example.ts.net"
  ],
  "workerToken": "<select the saved company secret>",
  "image": "ghcr.io/tmih06/factory-developer@sha256:<digest>",
  "model": "provider/model",
  "reuseLease": false,
  "timeoutMs": 3600000
}
```

The host adds its provider envelope (`provider: "ompig_factory"`); use the environment form/normal environment API rather than storing the illustrative secret string literally. Probe inventories workers without allocating a container.

### Fork onboarding defaults

On this fork onboarding is Docker-only: enter the first agent name and click **Finish**. There is no Claude/Codex selection, provider sign-in, model picker, or review step. The agent inherits the pinned `image` and `model` above, explicitly binds to the worker-pool environment, and finishes through the normal governed hire/approval APIs. Configure model credentials in that environment’s variables (secret references), not in the onboarding form. No model call is made during onboarding; the worker inventory probe verifies availability, not model authentication.

Set this pool as the instance default. A sole active factory pool is also accepted when the old instance default is Local; several pools require an explicit default. Missing/incompatible configuration, disabled adapters, and unreachable workers stop setup with an actionable error, never a Local/host CLI fallback. Worker provisioning and credentials are a one-time operator prerequisite, not questions asked of each agent. Existing provider-login drafts return to the name screen and reuse their held setup ID.

The advanced agent configuration form still supports explicit manual configuration; this change removes provider choices from onboarding, not the adapter implementations. For manual `ompig_factory` agents, choose that environment and set:

```json
{
  "image": "ghcr.io/tmih06/factory-developer@sha256:<the-same-digest>",
  "model": "provider/model",
  "maxTurns": 100,
  "timeoutSec": 3600,
  "env": {}
}
```

Use normal company-secret-backed `env` bindings for model credentials. Native broker credentials/profile setup is not automatically provisioned by this integration. Never put the management `workerToken` in adapter env. The harness-minted `PAPERCLIP_API_KEY` always wins over configured values; server process credentials are not inherited.

Configure the project for **isolated task workspaces / Git worktrees**, with a source repository and base ref, before assigning parallel tickets. The existing workspace manager owns checkout, staging, merge-safe copyback and cleanup. The adapter refuses local/no-task execution. It does not make a second Git scheduler or automatically give all clones a shared writable checkout.

Enable ordinary assignment/on-demand wakes and assign tickets to the same agent. The UI explains slot-backed concurrency instead of presenting a misleading per-agent concurrency setting. Daily run/cost limits, budget hard stops, project limits, company permissions, checkout and approval gates still apply.

## 5. Compose remote credential broker

`compose.yml` runs the **real ompig-slim broker**, not an OpenAI-compatible inference gateway. The broker owns the provider vault/OAuth refresher and synchronizes profiles. Each clone fetches access credentials from it and then calls its provider **directly**. Provider egress is still required. The broker bearer permits broad vault mutations and reads of access credentials: use one trusted broker/bearer per company, not a shared multi-tenant vault.

The Compose sidecar works with the host worker service; it does not replace the existing Paperclip dev stack or give the broker the Docker socket. The broker runs as UID 10001 with a persistent named `/data` volume, resource limits, no capabilities, and a read-only root filesystem. Never mount that volume in agents. It binds only the dedicated local bridge gateway; health checks are public, data routes require the bearer.

### Provision the local bridge and bearer

Drain the worker and wait for zero occupied slots before changing its network. On a Linux/rootful Docker host using the iptables backend:

```sh
NODE=$(command -v node) # real Node 24.11+
sudo "$NODE" integrations/ompig-factory/scripts/configure-network.mjs
sudo install -d -m 0700 /etc/paperclip-factory-local
sudo sh -c 'umask 077; test ! -e /etc/paperclip-factory-local/broker-token && openssl rand -hex 32 > /etc/paperclip-factory-local/broker-token'
sudo chown 10001:10001 /etc/paperclip-factory-local/broker-token
sudo chmod 0400 /etc/paperclip-factory-local/broker-token
```

The network helper owns only `paperclip-factory-egress` (`172.30.250.0/24`, interface `pc-factory0`) and its `PCFACTORY-*` firewall chains. It refuses an unrelated network or drifted rules and never flushes unrelated chains. Subnet overlap is an error, not permission to alter another network. It disables peer-container communication, denies private/tailnet/metadata destinations and host services, and allows only public TCP 443, Cloudflare DNS (`1.1.1.1`/`1.0.0.1`, TCP/UDP 53), and the local broker on gateway TCP 8765. It does not enable arbitrary Git SSH, HTTP, LAN or database access. Additional approved endpoints require an explicit firewall change.

These are **host firewall rules**, not a universal network sandbox. They must exist before any connected clone starts. Install `examples/paperclip-factory-network.service`, adjusting its Node/source paths, and add `Requires=paperclip-factory-network.service` plus `After=paperclip-factory-network.service` to the worker unit. Enable the network service for boot. Never change an active sandbox's network in place. The helper is Linux/iptables-specific; other hosts keep `network: "none"` until their equivalent policy is configured and tested.

### Start the broker and connect deployed workers

Create `/etc/paperclip-factory-local/broker.env` with mode 0600 (not in Git):

```dotenv
OMPIG_BROKER_IMAGE=ghcr.io/tmih06/ompig-slim-broker@sha256:<real-published-digest>
OMPIG_BROKER_TOKEN_FILE=/etc/paperclip-factory-local/broker-token
FACTORY_BROKER_BIND_IP=172.30.250.1
```

Use a real immutable image digest compatible with the ompig client; never `latest`. A preloaded local repository digest also works. Docker Compose bind-mounted secrets preserve host file ownership, hence UID 10001/mode 0400 above. The bearer is loaded from the file into the broker process environment at startup, never passed in command arguments.

```sh
sudo docker compose --project-name paperclip-factory-local \
  --env-file /etc/paperclip-factory-local/broker.env \
  -f integrations/ompig-factory/compose.yml up -d --wait
```

In the root-only worker JSON, set `network: "paperclip-factory-egress"`, `dns: ["1.1.1.1", "1.0.0.1"]`, and add a `broker` object to **that company's** `clients` entry:

```json
{
  "companyId": "<actual-company-uuid>",
  "token": "<existing-worker-management-token>",
  "broker": {
    "url": "http://172.30.250.1:8765",
    "token": "<bearer from broker-token, NOT the worker-management token>"
  }
}
```

Keep both secrets out of Git, shell arguments and logs. Restart the worker after copying the updated worker sources/config. The worker injects `OMPIG_BROKER_URL` and `OMPIG_BROKER_TOKEN` for the owning company at exec time, overrides assignment-supplied broker destinations, and removes token-file overrides. It never persists the bearer in lease metadata, assignments, images, or Docker container configuration. The agent can read its broker bearer/access credentials by design, but never receives the worker-management token. Rotating the broker bearer requires updating both the secret file and the worker's corresponding config, then restarting both services.

Every broker-backed clone has a private `/state/<run-id>/profile/agent` directory. The launcher performs a bounded authenticated preflight before starting durable execution; native ompig startup handles profile sync and the remote credential store. Failed authorization, redirects or broker downtime block launch, rather than falling back to local provider credentials. Do not set direct provider API-key overrides if the broker is intended to own provider authentication.

For a remote worker, use the broker's HTTPS origin or encrypted private transport; `172.30.250.1` is local to this Docker host, not a remote deployment address. Configure the equivalent narrow firewall on each host. The worker's HTTPS/Tailscale management origin is separate from the broker URL.

### Enroll provider accounts once

A new broker volume is **empty**. No account or private profile is copied implicitly. Use ompig-slim's supported `broker setup --url … --token-file … --verify` and `/login` flow from an operator client, or explicitly authorize `broker migrate --from-local` after stopping old account refresh owners. Do not copy an open `agent.db` or run cloned OAuth refresh databases concurrently. See ompig-slim's `docs/remote-broker.md` for migration, trusted-client permissions and backups.

Configure the exact `provider/model` on the Paperclip worker-pool environment for name-only onboarding. Custom model endpoints belong in the broker's synchronized model configuration; keep API keys in the vault rather than embedding them in model documents, which native profile sync intentionally copies to clients. Ordinary model roles/extensions/skills remain outside durable mode. An authenticated broker health check does **not** prove a paid provider account is configured, model access works, or a ticket passed.

## Execution, waiting and recovery

- Each run has its own container and `/state/<run-id>` workdesk. Only immutable image layers may be shared between clones.
- `/workspace` and `/state` are private host-backed directories. Both survive a stop/restart; the container's ephemeral home and `/tmp` do not.
- ompig runs in durable mode. Normal extensions, Code Mode, MCP servers, model roles and skill auto-loading are **not** inherited from the interactive agent. Include required behavior explicitly in the image/instructions or add it to the harness deliberately.
- Committed events stream into Paperclip. Usage checkpoints are cumulative per run and final receipts replace, not double-count, event totals. Missing pricing/usage is marked unpriced/incomplete, not free. Set provider-side quotas too; an already-issued model call may finish before a budget cancellation takes effect.
- When all slots are occupied, the provider waits on worker release events. Long-poll requests are bounded and exist only while an assignment is waiting; configured-but-idle workers do not scan. Acquisition timeout is bounded by the environment timeout, then normal Core recovery policy applies.
- Placement retries on another host only after a definite pre-allocation full/draining/disk-reserve response. A lost create response is **not** permission to start another clone elsewhere.
- Each worker journals reservations before Docker calls. A second daemon cannot open the same ledger. Restart reconstructs deadlines/reservations.
- A negative cleanup acknowledgement leaves a tombstone, so a delayed request cannot resurrect a cancelled allocation.
- Failed/unconfirmed creation or stop holds capacity. A provisional create with no observable container remains quarantined; it is not silently declared absent. Inspect Docker/worker health and resolve the original operation rather than deleting the ledger or inventing a free slot.
- Successful release destroys the container/files only after Core's normal verified copyback path. Stop-and-retain and `reuseLease` never fall back to deletion.
- A fixed, capability-free root PID-1 lifetime guard enforces absolute expiry even without the worker daemon. **Every agent/control exec runs as UID/GID 1000**, with no capabilities, no new privileges, read-only root filesystem, PID/CPU/RAM limits, and no host-selected mounts supplied by clients. The root guard is not an agent process; its different UID prevents the agent from pausing the expiry sleep.
- Expiry stops and retains files; it does not delete evidence. Retained stopped sandboxes consume disk but no active slot. Destroy through the owning Paperclip lifecycle once retention is no longer needed.
- After interruption, reusing the same immutable workdesk assignment resumes its journal; a new Paperclip run gets a new workdesk and the retained task checkout. Cross-worker recovery requires an explicit safe workspace/state transfer. There is no automatic live migration or exactly-once guarantee for Git pushes/API side effects.
- ompig `done` means an answer was produced. It does **not** mark a ticket accepted, guarantee tests passed, create/merge a PR, or bypass review. Define acceptance in ticket instructions and normal Paperclip review/completion policy. Runtime state stays outside the repository.

Send `SIGHUP` to drain a worker without interrupting existing work (`systemctl kill --signal=HUP paperclip-factory.service`). It refuses new allocations and wakes waiting acquisitions. Observe occupied slots reaching zero before upgrade/restart. Set `draining: true` in its root config as well if draining must survive a crash. Restarting with draining false restores admission. Do not perform rolling runtime/image upgrades against live workdesks without compatibility qualification and backups.

Docker shares the host kernel: these are not microVMs. Host bind volumes do **not** have automatic per-clone disk quotas; `minFreeBytes` is admission protection, not a write quota. Configure quota-backed storage and retention before production use. Initial slots have fixed worker-defined CPU/RAM profiles; GPU placement, dynamic sizing and automatic registry pulls are not implemented.

## Verification

```sh
pnpm test:ompig-factory
```

This ensures SDK outputs, links local development peers, and runs worker/provider/adapter/accounting/parser tests. Compose configuration is checked when Docker Compose CLI is available; it needs no running daemon. Real Docker and broker integration cases skip by default. The existing release-registry CI script includes these tests; `turbo.json` includes integration changes in that lane's inputs.

For real Docker plus actual ompig tool execution and actual adapter staging/bridge/copyback, build the sample image and run on a disposable Linux Docker host:

```sh
IMAGE=$(docker image inspect paperclip-ompig-factory:smoke --format '{{.Id}}')
NODE=$(command -v node) # verify this is real Node >=24.11 before sudo
sudo env PAPERCLIP_FACTORY_DOCKER_IMAGE="$IMAGE" \
  PAPERCLIP_FACTORY_DURABLE_SMOKE=1 PAPERCLIP_FACTORY_ADAPTER_SMOKE=1 \
  "$NODE" --import tsx/esm --test integrations/ompig-factory/test/docker.test.mjs
```

For real Compose broker → two native durable clones → deterministic inference, use compatible pinned images:

```sh
sudo env PAPERCLIP_FACTORY_DOCKER_IMAGE="<agent-repository@sha256:digest>" \
  PAPERCLIP_FACTORY_BROKER_IMAGE="<broker-repository@sha256:digest>" \
  "$NODE" --test integrations/ompig-factory/test/broker.test.mjs
```

This test uses a temporary Compose project/vault, an internal isolated Docker network and exact, temporary host firewall exceptions for its synthetic broker/model endpoints. It proves profile sync, remote-only key resolution, independent clones, no local credential database, fail-closed invalid authentication/outage, and vault persistence across restart. Cleanup removes only its own containers, volume, network and rules.

These tests use deterministic local SSE model fixtures, synthetic credentials, private temporary repositories and uniquely labelled containers. They make **no paid model calls** and never prune unrelated images/containers. They prove harness/infrastructure behavior, not model quality, five-host acceptance or production readiness. Required CI and actual deployment verification remain separate.
