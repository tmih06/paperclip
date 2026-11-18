# Paperclip software factory

This is a personal fork of [Paperclip](https://github.com/paperclipai/paperclip). It moves first-party JavaScript and TypeScript tooling to Bun and uses Paperclip's task and execution infrastructure to build a software factory.

The target is simple: queue a coding ticket, give it one isolated Kubernetes sandbox pod, and get back a pull request ready for a human to review. The factory should keep working through implementation, tests, CI failures, and actionable review feedback within the ticket's budget and permissions. It does not merge or deploy by default.

## Project status

- **Working today:** Bun runs the first-party server, CLI, and development tooling. Paperclip already has task checkout, agent adapters, and Kubernetes sandbox execution. A [recorded Kubernetes run](doc/benchmarks/2026-11-18-ompig-beam-kubernetes-e2e.md) verified a real task in a sandbox pod and collected its output.
- **Target workflow:** reliable ticket intake, one task-owned pod at a time, recovery without duplicate work, and a continuous loop that follows the PR through verification and review readiness. The recorded run is not proof of that full workflow.

See [project goals](doc/GOAL.md) for scope and [product definition](doc/PRODUCT.md) for lifecycle and acceptance criteria. Upstream Paperclip remains the reference for the broader product and its hosted offerings.

## Quickstart

Install the Bun version pinned in [package.json](package.json), then run from this checkout:

```sh
bun install --frozen-lockfile
bun run dev
```

Open [localhost:3100](http://localhost:3100). Local development can use the embedded database. Node.js is needed only for external providers or registry tools that require it. See [development setup](doc/DEVELOPING.md) and the [Kubernetes sandbox provider](packages/plugins/sandbox-providers/kubernetes/README.md) for cluster setup.

## Development

Follow [AGENTS.md](AGENTS.md) for repository rules and verification. Use `bun run verify` for affected checks and `bun run check:bun-migration` after changing runtime commands. See [observability](doc/observability.md) for tracing. Inherited usage telemetry is enabled by default. Set `PAPERCLIP_TELEMETRY_DISABLED=1` to disable it.

## License

[MIT](LICENSE). See the license for upstream copyright and terms.
