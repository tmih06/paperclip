# Scenario chat Scenario Chat

The scenario chat is an interactive surface over the same package-local Capability
runner and [mock control plane](capability-mock-control-plane-port.md) that the
[scenario explorer](capability-scenario-explorer.md) reads. You pick a scenario,
send prompts, and watch the mock Paperclip activity for every turn instead of
having it hidden behind the conversation. It contacts no Paperclip service,
holds no credential, and introduces no ACPX implementation.

Sources: `src/scenarios/chat-session.ts`, `src/scenarios/chat-script.ts`,
`src/scenarios/scenario-execution.ts`, and `examples/scenario-explorer/`.
Interaction contract:
[Scenario chat mobile chat UX](design/scenario-chat-ux.md).

## The turn model

A **session** is one long-lived mock control plane. Unlike a 7F single-shot
run, the state a turn changes is still there for the next turn — which is what
makes a per-turn diff mean anything.

- **Turn 0 is the session seed**: checkout, wake routing, and the first tool
  exposure decision, all performed by the control plane before anyone can type.
  It renders with control-plane styling because no agent tool was involved.
- **Turns 1..N** are one user message each, plus everything the runtime
  recorded until the agent settled.

Every timeline entry carries the `turn` it belongs to, and the artifact carries
a `turns[]` array. The UI groups on those records; it never derives a turn
boundary, a per-turn diff, or a per-turn verdict itself.

## What each turn records

| Record | Produced by |
| --- | --- |
| Exposed tools (always / optional with unlocking grant / control-plane — no tool) | the 7D authorization engine |
| Semantic calls and typed results | the 7D tool runtime |
| Authorization decisions, missing claims, redactions | the 7D authorization engine |
| Control-plane actions with audit and decision references | the 7C mock core |
| State diff over the ten entity domains | immutable fixture snapshots |
| Wake / reconciliation events | the 7C mock core's own scheduled wakes |
| Turn parity verdict | `capabilityTurnParity` |

A turn is judged on what that turn did. A session-level expectation about work
the board has not asked for yet would read as a failure of turn 1 rather than
as work still to come, so the session verdict stays separate and is judged over
the whole transcript.

## Scripts and drivers

Every one of the 106 corpus scenarios opens in chat. Two carry authored
multi-turn conversations because the acceptance matrix names them:

- `ix-checkbox-01` — read the options, open a checkbox interaction, then the
  board answers it. That answer is a **control-plane-owned action with no agent
  tool**, and it is what makes the control plane schedule the continuation wake.
- `ap-mcp-gate-01` — read the approval queue (allowed), then attempt the gated
  request without the decide claim (**denied**). The denial is a turn outcome
  with its own authorization slice, not a broken session.

Every other scenario falls back to its 7F plan as a single scripted turn, which
keeps the whole corpus openable without inventing dialogue the traceability rows
do not support. Past the end of a script the session stays usable: the agent
re-reads the task context so the turn still shows real mock activity.

**Scripted (deterministic)** is the working driver: your prompt drives the next
recorded turn against the in-page mock core. **Codex (bounded)** is disabled
with a named reason unless the local provider relay is running — the same rule
the explorer applies. No provider credential ever reaches the page in either
mode.

## Routes

```
#/chat                                       chat home (picker + intro)
#/chat/<case-id>                             live session, seeded at turn 0
#/chat/<case-id>?replay=fake                 scripted session, auto-played once
#/chat/<case-id>?replay=fake&view=activity&turn=<n>
#/chat/<case-id>?replay=fake&filter=<tools|authorization|control|diff|parity>
#/chat/<case-id>?replay=fake&stage=streaming holds the last turn mid-stream
```

The shell reports `data-chat-state` (`seeding` / `pending` / `streaming` /
`settled` / `failed`) so captures and tests wait on a state rather than a
timeout. `replay=fake` plays the script once per session: an explicit **Reset
session** returns to the seeded turn 0 and stays there.

## Boundary

- No network request leaves the page's own origin, and nothing the board types
  is written to `localStorage`.
- The chat renders records the runtime produced. It computes no exposure,
  evaluates no claim, applies no redaction, and re-times nothing.
- Redaction happens at the artifact boundary, so a raw secret cannot reach a
  rendered record even if an upstream layer returned one.

## Commands

```sh
bun run --filter @paperclipai/paperclip-runner run demo:scenarios       # open the surface
bun run --filter @paperclipai/paperclip-runner run test:scenarios       # runtime + component tests
bun run --filter @paperclipai/paperclip-runner run test:browser:scenarios
# Recorded evidence generation is deferred from this release.
```

The deployed demo is started by `scripts/run-scenario-chat-demo.sh`. See
[Deployed demo sandbox](#deployed-demo-sandbox) for what that script enforces.

## Deployed demo sandbox

`scripts/run-scenario-chat-demo.sh` starts the demo server and its loopback
proxy as two Bun processes. Bun accepts Node's `--permission` and
`--allow-fs-*` flags and silently ignores them, so confinement cannot come from
runtime flags. It is applied by `scripts/lib/scenario-chat-sandbox.py`, a
Python-stdlib launcher that installs kernel policy and then `exec`s Bun, so no
JavaScript runs outside Bun.

| Boundary | Mechanism |
| --- | --- |
| Server has no network | `unshare(CLONE_NEWUSER\|CLONE_NEWNET)`: only a down `lo` remains |
| Proxy listens on one port | Landlock TCP rules grant `SCENARIO_CHAT_PROXY_PORT` and nothing else |
| Filesystem allow-list | Landlock grants only the declared read/list/write paths |
| No child processes | seccomp denies `execve`/`execveat`/`fork`/`vfork` and `clone` without `CLONE_THREAD` |
| No escape or introspection | seccomp denies `ptrace`, `mount`, `unshare`, `setns`, `bpf`, module and I/O-uring calls |
| Owner `nobody` | mandatory `uid_map`/`gid_map` to 65534 |
| Bounded resources | `RLIMIT_AS`, `RLIMIT_NOFILE`, `RLIMIT_FSIZE`, `RLIMIT_CORE` |

Worker threads stay available: `clone` with `CLONE_THREAD` is permitted, and
the seccomp filter is installed before Bun starts so it covers the runtime's
own threads.

Every capability is mandatory. A missing or refused kernel feature exits 78;
the script turns that into `{"event":"startup_failed","code":"sandbox_unavailable"}`
and exits non-zero. In particular, a host that forbids the uid mapping - AppArmor's
`kernel.apparmor_restrict_unprivileged_userns=1`, the Ubuntu default - is a hard
failure. The launcher never falls back to an unmapped namespace, because a
process there keeps the overflow uid and the `nobody` identity would be cosmetic.

That restriction is a **host qualification gap**, not a supported mode: the
mapped demo cannot be started on such a host. The focused tests in
`scripts/scenario-chat-sandbox.test.mjs` prove each policy against the kernel
independently of the mapping, so a refused mapping fails loudly rather than
silently disabling coverage.

`RLIMIT_AS` bounds virtual address space, not resident memory. Bun reserves a
multi-gigabyte JIT region at rest, and a cap at or below ~1 GB makes that
reservation fail, after which Bun silently disables the JIT and `bun:ffi`
breaks. The default 2 GB clears the reservation reliably. It is a looser bound
than a cgroup memory limit; an unprivileged process cannot create one here.

Walkthrough: [Scenario chat scenario chat tutorial](tutorials/scenario-chat.md).
