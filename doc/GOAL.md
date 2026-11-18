# Project goal

This personal fork of [Paperclip](https://github.com/paperclipai/paperclip) has two goals: finish the first-party migration to Bun and turn Paperclip into a software factory for coding tickets.

## Make Bun the default

Use Bun for first-party dependency installation, scripts, the control plane, the CLI, tests, and compatible plugin workers. Keep external agents and registry tools on their supported runtimes. Do not port a provider CLI just to eliminate Node from a pod. Measure ticket-to-agent readiness before swapping runtimes to address startup latency.

## Deliver review-ready code from a ticket

An operator queues an actionable ticket with a repository, base branch, and acceptance criteria. Paperclip claims it, starts an isolated Kubernetes pod for it, and runs the coding agent there. The factory implements and tests the change, opens or updates the ticket's PR, then follows CI and actionable review feedback until it can hand off the PR or name a blocker.

**One pod per task** means one active execution pod per claimed task, not one per heartbeat, retry, or agent. Different tasks can run in parallel within resource limits. A replacement pod is allowed only after the prior executor is gone or conclusively fenced off. Task ownership, recoverable work, and the existing PR must survive pod replacement.

The PR is the deliverable. The handoff includes its link, latest commit, verification results, and any remaining approval or blocker. Opening a PR, reporting a successful agent turn, and passing checks on an older commit do not count as readiness. Merge and deployment are outside the default workflow.

## Prove the workflow

The first milestone is one real ticket in a configured repository. Start it through the normal queue. Verify that the change runs in one task-owned pod, lands in the correct PR, passes required checks on the current head, and leaves no active lease after handoff. Then prove that an interrupted run resumes without losing saved work or creating a duplicate executor or PR.

Measure time from ticket claim to the first agent event and from ticket claim to PR readiness. Break out pod scheduling and readiness, workspace preparation, agent startup, and time waiting on CI or review. Use those measurements to decide where to improve latency.

See the [product definition](PRODUCT.md) for the target lifecycle and the distinction between current capabilities and planned behavior.
