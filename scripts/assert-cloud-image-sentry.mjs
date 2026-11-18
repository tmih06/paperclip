#!/usr/bin/env bun
// Mount inside the image's server directory and run with Bun so both Sentry
// resolution paths match the production server. Print only its version.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (!process.versions.bun || !Bun.semver.satisfies(Bun.version, ">=1.4.4")) {
  console.error("The server and its native TypeScript workers require Bun >=1.4.4");
  process.exit(1);
}

await import("@sentry/node");
const require = createRequire(import.meta.url);
let dir = dirname(require.resolve("@sentry/node"));
for (;;) {
  const candidate = join(dir, "package.json");
  if (existsSync(candidate)) {
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    if (parsed.name === "@sentry/node") {
      process.stdout.write(parsed.version);
      process.exit(0);
    }
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
console.error("could not resolve the installed @sentry/node package");
process.exit(1);
