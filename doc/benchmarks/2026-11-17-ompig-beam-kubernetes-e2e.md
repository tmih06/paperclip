# ompig-slim / Beam Free Kubernetes validation

## Historical outcome: configured, but real-answer E2E was blocked

**Update:** The quota cleared and the real task passed on November 18. See
[the successful E2E record](2026-11-18-ompig-beam-kubernetes-e2e.md).
The initial observations below are retained without treating the blocked
attempt as a pass.

A new **OMPIG Beam Free** agent was created in a separate validation instance,
using adapter `ompig_slim` and exact model **`opencode-free/beam-free`**. A real
Kubernetes pod ran the source-built ompig-slim executable and reached the
OpenCode Free gateway. The gateway returned **HTTP 429 `FreeUsageLimitError`**,
with a reset countdown of about **5h02m** at 19:29 UTC on November 17.

**No successful model answer, challenge-file workflow, or completed Paperclip
task was verified. This is not a passing end-to-end result.** No paid model,
paid subscription, alternative provider, or quota bypass was used. No speedup
over OpenCode was measured.

The validation controller was stopped to prevent background verification
retries. Its database and configuration were retained privately for a later
retry; no task pods, Sandboxes, or per-run Secrets remained. The fresh board
identity is synthetic test data, not a copied user credential.

## Scope and identities

The original `docker-server-1` remains stopped. Its old source/plugin bind
mounts are missing, so it was not restarted or repointed. The new agent is
**not installed into that original instance/company**.

| Item | Value |
|---|---|
| Validation controller | `paperclip-ompig-beam-validation`, loopback `127.0.0.1:3110`, stopped |
| Validation database | `paperclip-ompig-beam-validation-db`, separate PostgreSQL 17 database/volume, stopped |
| Company | `a599d591-40f3-4528-a142-a88dbc3808d1` — OMPIG Beam Free Validation |
| Agent | `768602a0-a1b8-490d-b09c-48124823dfe0` — OMPIG Beam Free |
| Agent state | `paused`, lifecycle `verifying`; no failed verification was overridden |
| Environment | `91f9c9b3-d55d-49f8-98f1-753db8647551`, Kubernetes `sandbox-cr` |
| Pending task | `OMP-1`, `9120495b-e9a9-4c3c-8c4a-7836a33d6473`, backlog/unassigned |
| Kubernetes namespace | `pc-ompig-e2e-a599d591-40f3-4528-a142-a88dbc3808d1` |

Relevant agent configuration:

```json
{
  "adapterType": "ompig_slim",
  "adapterConfig": {
    "model": "opencode-free/beam-free",
    "maxTurns": 12,
    "cwd": "/workspace",
    "timeoutSec": 180,
    "env": {
      "PI_OFFLINE": "1",
      "OMPIG_SLIM_CODING_AGENT_DIR": "/home/paperclip/.pi/agent"
    }
  },
  "runtimeConfig": {
    "heartbeat": {"enabled": false, "maxConcurrentRuns": 1}
  },
  "budgetMonthlyCents": 0
}
```

The adapter registry forwards **no API keys**. ompig-slim's native
`opencode-free` provider performs inference directly; no OpenCode CLI or
existing user profile is copied into the pod. `PI_OFFLINE=1` suppresses startup
model discovery, not explicitly requested inference.

## Artifact and isolation evidence

- Read the sibling repo's `AGENTS.md`, `README.md`, `docs/opencode-free.md`,
  `docs/durable.md`, and verification skill.
- Built with the repo's `make build` at ompig-slim commit `51d4583`, version
  `0.2.1`. Binary SHA-256:
  `eff78814d125b13fdc08776a1be252823d9e23b08cd6960997ea19735bcf4650`.
- Local runtime image: `paperclip-ompig-runtime:e2e-51d4583-bun1.4.4`, digest
  `sha256:f51afc85610c9c21bbd6aa1e54b98aaf8491560c3af87c3b7eaab9b2a3c76c84`.
  This layered the binary and Bun 1.4.4 onto the existing local diagnostic image
  and retained genuine Node 24.22.3 for the adapter transport. It was loaded
  into kind locally, not pushed or published.
- The production runtime bundle runs the validation controller under Bun.
  Its fresh PostgreSQL database is unrelated to the original Paperclip data.
  The controller binds only to loopback; task pods do not use host networking.
- Adapter probes created actual Sandbox resources and Ready pods. The final
  diagnostic pod independently confirmed the provider error in the canonical
  Durable SQLite assistant record rather than inferring it from a generic
  `model_error` receipt.
- Namespace quota stayed at **2 pods / 4 CPU / 8 GiB aggregate**. Pod/container
  limits remained **2 CPU / 4 GiB**. Verified non-root UID 1000,
  `RuntimeDefault` seccomp, all capabilities dropped, read-only root filesystem,
  no privilege escalation, no host network/PID/IPC/hostPath, and no mounted
  Kubernetes service-account token. The task home/workspace/tmp were emptyDir.
- The existing enforcing Calico policies remained in use. The new test
  namespace allowed OpenCode's resolved public IPv4 addresses plus DNS; no
  broad private-network access or TLS bypass was added.
- emptyDir is **not crash-durable storage**. No pod-deletion recovery claim is
  made, and no real-task workspace copy-back was verified.

The redacted machine-readable observations are in
[`2026-11-17-ompig-beam-kubernetes-e2e.json`](2026-11-17-ompig-beam-kubernetes-e2e.json).
Private setup files, credentials, and the full database are not committed.

## Defects found and fixed

1. **Configured custom adapters were rejected by Kubernetes validation.**
   `adapterType` was checked only against built-ins, despite an authoritative
   registry explicitly registering `ompig_slim`. Validation now uses the
   nonempty registry when supplied and otherwise the existing built-ins. It
   still rejects unknown adapters and built-ins omitted from that registry.
   Regression tests reproduced both prior failures before the fix.
2. **Diagnostics-only verification could never activate this adapter.**
   The old environment test always returned a storage warning without a model
   hello result. Paperclip correctly refused to activate it. The adapter now
   makes a fresh, bounded, one-turn Durable hello assignment, requires its
   matching completed receipt and answer, and emits the normal verified-probe
   check only on success. A failed/unanswered model remains a failure. Probe
   workdesks are cleaned only after process stop is confirmed. The test's
   inference/allowance semantics are documented in the adapter README.

## Infrastructure faults resolved during setup

The test controller initially rejected its non-loopback bind in local-trusted
mode. The bind was corrected, not the guard. The small diagnostic image could
not initialize embedded PostgreSQL, so the validation topology uses a separate
PostgreSQL 17 container, like the original deployment. A Kubernetes certificate
hostname mismatch was resolved by using the API server's certified address
`172.18.0.2`; certificate verification stayed enabled.

New pods initially failed CNI setup with `Unauthorized`. The existing Calico
CNI token had expired at **2026-11-17 06:43:17 UTC**. Its existing service
account still had the required RBAC. Only that account's credential was renewed
through TokenRequest, expiring **2026-11-18 19:19:49 UTC**. No roles, network
policies, workload deployments, sysctls, or sandbox restrictions were loosened.
Automatic CNI credential renewal remains an operational follow-up; this
short-lived renewal is not a permanent rotation fix.

## Verification

- Adapter tests: **19 passed across 3 files**, including the actual 0.2.1
  binary with an isolated loopback model. The binary test covers interrupted
  assignment recovery, deduplication, retained workspace files, and the actual
  one-turn hello verification path; it is not
  an OpenCode Free success or a Kubernetes storage qualification.
- Kubernetes provider unit tests: **210 passed across 20 files**.
- Adapter typecheck, Kubernetes provider build, production runtime bundling,
  Oxc syntax checks, Bun migration audit, and whitespace checks passed.
- Real Kubernetes/Durable/OpenCode Free attempt: **blocked by upstream 429**.
  Native usage records identify `opencode-free/beam-free`, zero input/output
  tokens, zero recorded cost, and the quota error. There is no verified answer.

## Remaining work

After the upstream allowance resets, renew the validation controller's
short-lived Kubernetes credential if necessary, start its separate database,
rebuild the runtime bundle
from the committed adapter code, restart only the isolated validation
controller, and retry the agent's normal lifecycle verification. Do not force
its lifecycle state or treat the storage warning alone as a model pass.

Once the real hello succeeds, run `OMP-1`: read the random challenge file,
write and independently verify `beam-proof.json`, check the final answer and
Paperclip task/comment state, capture the actual task pod's security/resources,
and prove workspace/workdesk collection and lease cleanup. Until then the
agent is configured but **not validated for end-to-end use**. Installing it in
the main instance also requires restoring that controller's missing mounts
through a separately reviewed deployment/recovery step.
