import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { removeTsxPreloads } from "./migrate-bun-test-launchers.mjs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter(file => !/-fixtures\.[cm]?[jt]sx?$/.test(file))
  .filter(file => !/(^|\/)(node_modules|dist|vendor|fixtures|generated)\//.test(file));
const findings = [];
const launch = /\b(?:spawn|spawnSync|execFile|execFileSync|run|runCommand|exec)\s*\(\s*["'](?:pnpm|corepack|tsx|node)["']|\b(?:command|cmd|executable):\s*["'](?:pnpm|corepack|tsx|node)["']/;
for (const file of files) {
  let content;
  try { content = readFileSync(file, "utf8"); } catch { continue; }
  if (/\.[cm]?[jt]sx?$/.test(file) && content.includes("tsx")) {
    if (removeTsxPreloads(file, content) !== content) {
      findings.push(`${file}: obsolete tsx preload or CLI launcher; run bun scripts/migrate-bun-test-launchers.mjs`);
    }
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("/__tests__/")) continue;
  if (file.endsWith("package.json")) {
    const manifest = JSON.parse(content);
    for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
      if (/(?:^|&&\s*|;\s*|\|\|\s*|\|\s*)(?:pnpm|corepack|tsx|node)\s/.test(command)) {
        findings.push(`${file}: script ${name} launches a non-Bun runtime: ${command}`);
      }
    }
    if (manifest.packageManager && !manifest.packageManager.startsWith("bun@")) {
      findings.push(`${file}: packageManager must pin Bun`);
    }
    continue;
  }
  const code = /\.[cm]?[jt]s$/.test(file);
  const commands = /\.sh$|(?:^|\/)Dockerfile[^/]*$|\.Dockerfile$/.test(file)
    || file.startsWith(".github/workflows/") || /^\.github\/actions\/.*\/action\.ya?ml$/.test(file);
  if (!code && !commands) continue;
  for (const [index, line] of content.split("\n").entries()) {
    if (/^\s*(?:\/\/|\*|#(?!\!))/.test(line)) continue;
    const externalNodeEval =
      (file === "packages/adapter-utils/src/sandbox-install-command.ts"
        || file === "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts")
        && line.includes("process.versions.node.split")
      || /^scripts\/verify-(?:cursor|grok)-npm-install\.mjs$/.test(file)
        && line.includes("postinstall:") && line.includes("lifecycle-ran");
    const implicitBunx = !file.startsWith("scripts/migrate-")
      && (/\bbun x (?:(?:--no-install|--cwd\s+\S+)\s+)*(?:vp|vite|vitest|playwright|tsc|storybook)\b/.test(line)
        || /\["x", "--no-install", "(?:vp|vite|vitest|playwright|tsc|turbo)"/.test(line));
    const invalid = (code || commands) && implicitBunx || code && (launch.test(line) || /^#!.*\b(?:node|tsx)\b/.test(line)
      || !externalNodeEval && /(?<![\w/-])node\s+(?:-e|--eval)\s/.test(line)
      || /["'`]\s*(?:node|tsx|pnpm|corepack)\s+(?:--import\s+[^"'`]*tsx|[^"'`]*node_modules\/tsx\/)/.test(line)
      || /node_modules\/(?:\.bin\/tsx|tsx\/dist\/(?:cli|loader)\.mjs)|["']node_modules["']\s*,\s*["']tsx["']/.test(line))
      || commands && /(?:^|\brun:\s*|\bRUN\s+|[;&|]\s*|\$\()\s*(?:exec\s+)?(?:pnpm|corepack|tsx|node)\s/.test(line)
      || commands && /pnpm\/action-setup|pnpm-(?:lock|workspace)\.yaml/.test(line);
    if (invalid) findings.push(`${file}:${index + 1}: ${line.trim()}`);
  }
}
if (findings.length) {
  for (const finding of findings) console.log(finding);
  console.error(`Found ${findings.length} first-party Bun migration violations.`);
  process.exitCode = 1;
} else {
  console.log("First-party entrypoints use Bun. External provider runtimes are not rewritten.");
}
