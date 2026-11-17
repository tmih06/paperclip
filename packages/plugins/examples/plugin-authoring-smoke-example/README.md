# Plugin Authoring Smoke Example

A Paperclip plugin

## Development

```bash
bun install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
bun run test
```

## Install Into Paperclip

```bash
npx paperclipai plugin install ./
```

## Build Options

- `bun run build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `bun run build:rollup` uses rollup presets from the same SDK.
