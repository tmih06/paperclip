# ompig-slim / Beam Free: real Kubernetes E2E passed

## Result

The post-quota-reset test passed on **2026-11-18 at 01:11 UTC**. Agent
**OMPIG Beam Free**, `768602a0-a1b8-490d-b09c-48124823dfe0`, used exactly
**`opencode-free/beam-free`** through native ompig-slim Durable execution in a
Kubernetes task pod. No paid fallback or alternative provider was used.

Task **OMP-1**, `9120495b-e9a9-4c3c-8c4a-7836a33d6473`, is **done**. Run
`19b42b8c-f73a-4f42-b77b-deeaa5c628ca` succeeded with exit code 0, a completed
Durable receipt, and the final answer marker `OMPIG_BEAM_FREE_E2E_OK`.

The agent independently read a random challenge file whose value was not in
the assignment, wrote `beam-proof.json`, executed a Python verification,
posted a completion comment through the Paperclip callback bridge, and marked
the task done. The caller then independently checked the proof against the
original file, the final answer, the issue/comment state, the restored job
assignment and SQLite workdesk, and the released Kubernetes lease.

[Redacted machine-readable evidence](2026-11-18-ompig-beam-kubernetes-e2e.json)
records the exact run, receipt, usage, pod security, phase timestamps, file
proof and cleanup. The challenge is synthetic, not a credential.

## Scope

This is the **separate validation instance** at `127.0.0.1:3110`, company
`a599d591-40f3-4528-a142-a88dbc3808d1`. It is not the original stopped
`docker-server-1` deployment. The original controller's missing bind mounts
were not recreated or repointed. Its existing data was not used or changed.
The validation agent is **idle / ready**, with heartbeat scheduling disabled.
The validation controller/database are retained for inspection; neither is a
production rollout. Their setup credentials are short-lived and private.

The source-built ompig-slim 0.2.1 binary, image digest, initial quota failure,
configuration, and setup constraints remain documented in the
[November 17 record](2026-11-17-ompig-beam-kubernetes-e2e.md). The initial 429
result is preserved as historical evidence, not overwritten by this pass.
Only the validation controller's expired service-account credential was
renewed for this retry. Certificate checks, host isolation, network policy,
and the original namespace limits remained enforced.

## Integration fixes exposed by the real workflow

1. **Missing native-sync workspace root.** Acquisition returned no `remoteCwd`,
   while the sync hook required one. Workspace realization returned separate
   metadata and did not update that lease. The provider now records its actual
   mounted `/workspace` root on acquisition and preserves a recorded root on
   resume. Missing metadata still fails closed in sync; roots are never
   inferred from untrusted transfer operations. Regression tests failed before
   the fix, then passed. The real task subsequently used native sync successfully.
2. **Controller-only managed instruction path in a sandbox prompt.** The adapter
   told the remote model to read the controller's instruction working-copy
   path, which did not exist inside the pod. The adapter now asynchronously
   loads the configured instructions and includes their contents in the initial
   immutable prompt, following the existing OpenCode adapter pattern. Resuming
   an admitted assignment does not reread or replace its prompt. A regression
   checks that the controller-only path is not sent to the sandbox.
3. **Validation harness scope.** An interim manual wake incorrectly used a
   `context` field that the public endpoint does not accept. It launched a
   company-scoped run without the task assignment; that run reached its 12-turn
   limit and was not a pass. The harness was corrected to use the public
   `payload.issueId` / `payload.taskId` fields. After operator review, the
   terminal unanswered test session was explicitly reset before authorizing a
   new attempt. The successful run is issue-scoped and identifies OMP-1.

The two failed attempts (`5d035f5d-696d-48ed-87a9-9bcc074b36df`, missing sync
root; `5f3f7b6e-3c6c-4ace-8142-060c7f0d98c9`, turn limit) remain in the
validation database. Neither counts as successful evidence or was silently
replayed. The validation's private logs may include agent-authored commands;
no raw logs, bearer credentials, profiles, or databases are committed.

## Isolation, persistence, and cleanup

Observed task pod: `pc-01m7p3ajv56vkt8hakmaz8ej3r` in namespace
`pc-ompig-e2e-a599d591-40f3-4528-a142-a88dbc3808d1`.

- Maximum **2 task pods**, aggregate **4 CPU / 8 GiB**.
- Task limit **2 CPU / 4 GiB**, requests **250m / 512 MiB**.
- Non-root UID/GID 1000, `RuntimeDefault` seccomp, read-only root filesystem,
  all capabilities dropped, privilege escalation disabled.
- No host network/PID/IPC, hostPath mounts, or service-account token in the pod.
- The model ran only in its selected Kubernetes pod. Native tools read/write
  the pod workspace; API requests used the scoped callback bridge.
- Both challenge and generated proof were collected back after the child
  stopped. The complete assignment's `job.json` and `session.sqlite` were
  present in the restored `.paperclip-ompig` workdesk, with the correct run
  identity and exact provider/model.
- The recorded lease is `released`; task pods, Sandbox resources, and per-run
  Secrets were all absent after completion.

This proves **clean-stop workspace/workdesk collection**, not crash-durable
storage. The pod still uses emptyDir; node loss or deletion before collection
can lose work. `infrastructureCrashDurability` correctly remains false.

## Timing and usage

Run creation: `01:11:16.280Z`; started: `01:11:16.728Z`; finished:
`01:11:51.172Z`. Runtime from started to finished: **34.444 seconds**.

- Workspace sync completed about 5.7 seconds after run start.
- Callback bridge/log streaming was ready about 6.8 seconds after start.
- First tool events arrived about 9.1 seconds after start.
- Model/tool/API work and finalization occupied the remainder.

The harness observed about 48.8 seconds from its task-update operation to the
settled run, including its deliberate wait before the explicit scoped wake.
That is not a dispatch-only latency measurement. This was one functional
sample with 10 tool-call events, not a controlled performance comparison.
**No speedup over OpenCode is claimed.**

Paperclip recorded 19,804 input tokens, 2,182 output tokens, and 93,376 cached
input tokens for `opencode-free/beam-free`. Its accounting marks the run
**unpriced** with `costUsd: null`; that is unknown accounting, not proof of a
zero-dollar bill. The selected upstream route is OpenCode Free and no paid
credentials or paid model were configured.

## Verification and handoff

- Kubernetes provider suite: **212 passed across 20 files**, including
  acquisition-time native sync and resumed workspace-root handling.
- ompig adapter suite: **20 passed across 3 files**, including the source-built
  binary's recovery/dedup/hello workflow and managed-instruction injection.
- Adapter typecheck and Kubernetes provider build passed; runtime bundle used
  for the successful task was rebuilt after the instruction fix.
- Real free-provider task: **passed**, with independent file, receipt, API,
  workdesk, security and cleanup checks above.

Installing this agent in the main instance still requires restoring that
controller's missing mounts through a separately reviewed recovery/deployment
step. This validation did not restore or deploy the original service.
