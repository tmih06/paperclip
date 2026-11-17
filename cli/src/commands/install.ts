import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { detectBunVersion, isSupportedBunVersion, MINIMUM_BUN_VERSION } from "@paperclipai/shared/bun-version";
import {
  addManagedPathBlock,
  assertManagedShimWritable,
  buildNextManifest,
  flipCurrentAtomic,
  payloadPathFor,
  pruneInstallPayloads,
  readInstallManifest,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
  writeManagedShim,
  type InstallChannel,
  type InstallRecord,
} from "../install-store.js";

const execFileAsync = promisify(execFile);
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_GITHUB_REPO = "paperclipai/paperclip";
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type InstallOptions = { canary?: boolean; version?: string; ref?: string; repo?: string; yes?: boolean };

export type CommandRunner = (
  file: string,
  args: string[],
  options?: Parameters<typeof execFileAsync>[2],
) => Promise<{ stdout: string; stderr: string }>;

type ReleasePackageEntry = { dir: string; name: string };

export async function runCommandWithDiagnostics(
  file: string,
  args: string[],
  options?: Parameters<typeof execFileAsync>[2],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(file, args, { ...options, encoding: "utf8" });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
    if (!stderr || (error instanceof Error && error.message.includes(stderr))) throw error;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, { cause: error });
  }
}

export function resolveGitInstallWorkspacePackages(checkoutPath: string): ReleasePackageEntry[] {
  const manifestPath = path.join(checkoutPath, "scripts", "release-package-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReleasePackageEntry[];
  const packageByName = new Map(manifest.map((entry) => [entry.name, entry]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ReleasePackageEntry[] = [];

  const visit = (packageName: string): void => {
    if (visited.has(packageName)) return;
    if (visiting.has(packageName)) throw new Error(`Circular workspace dependency while staging ${packageName}.`);
    const entry = packageByName.get(packageName);
    if (!entry) throw new Error(`Git install cannot stage workspace dependency ${packageName}; it is missing from scripts/release-package-manifest.json.`);
    visiting.add(packageName);
    const packageJson = JSON.parse(fs.readFileSync(path.join(checkoutPath, entry.dir, "package.json"), "utf8")) as Record<string, unknown>;
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      const dependencies = packageJson[section];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const dependencyName of Object.keys(dependencies)) {
        if (dependencyName.startsWith("@paperclipai/")) visit(dependencyName);
      }
    }
    visiting.delete(packageName);
    visited.add(packageName);
    ordered.push(entry);
  };

  visit("@paperclipai/server");
  return ordered;
}

export function assertSupportedBunVersion(): void {
  const version = detectBunVersion();
  if (!version || !isSupportedBunVersion(version)) {
    throw new Error(`Installing or updating Paperclip requires Bun ${MINIMUM_BUN_VERSION} or newer (found ${version ?? "no Bun runtime"} at ${process.execPath}). Install or upgrade Bun and run 'bun x --bun paperclipai@latest install --yes' to re-pin an existing managed install.`);
  }
}

export function resolveNpmInstallRequest(options: InstallOptions): {
  spec: string;
  channel: InstallChannel;
} {
  if (options.canary && options.version) throw new Error("Choose either --canary or --version, not both.");
  if (options.version) {
    const version = options.version.trim();
    if (!EXACT_VERSION_PATTERN.test(version)) {
      throw new Error(`--version requires an exact published version, received '${options.version}'.`);
    }
    return { spec: version, channel: "pinned" };
  }
  return options.canary ? { spec: "canary", channel: "canary" } : { spec: "latest", channel: "latest" };
}

function parseResolvedVersion(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Bun returned an empty version response.");
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") return parsed[0];
  } catch {
    if (EXACT_VERSION_PATTERN.test(trimmed)) return trimmed;
  }
  throw new Error(`Bun returned an unexpected version response: ${trimmed}`);
}

export async function resolvePublishedVersion(spec: string, runCommand: CommandRunner): Promise<string> {
  const result = await runCommand(
    "bun",
    ["pm", "view", `paperclipai@${spec}`, "version", `--registry=${PUBLIC_NPM_REGISTRY}`],
    { maxBuffer: 1024 * 1024, env: bunInstallEnv() },
  );
  return parseResolvedVersion(result.stdout);
}

export function resolveGitInstallRequest(options: InstallOptions): { repo: string; ref: string; pinned: boolean } | null {
  if (!options.ref && !options.repo) return null;
  if (!options.ref) throw new Error("--repo requires --ref.");
  if (options.canary || options.version) throw new Error("--ref cannot be combined with --canary or --version.");
  const repo = (options.repo ?? DEFAULT_GITHUB_REPO).trim();
  const ref = options.ref.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`--repo must be an owner/name GitHub repository, received '${repo}'.`);
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) throw new Error(`Invalid GitHub ref '${options.ref}'.`);
  return { repo, ref, pinned: /^[0-9a-f]{7,40}$/i.test(ref) };
}

async function runGitHubCurl(
  args: string[],
  runCommand: CommandRunner,
  options?: Parameters<CommandRunner>[2],
): Promise<{ stdout: string; stderr: string }> {
  // Anonymous GitHub requests are rate-limited per source IP (CI runners and
  // corporate NAT exhaust the shared quota); honor an ambient token when present.
  // The token travels via a curl --config file so it never appears in process args.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) return runCommand("curl", args, options);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclipai-gh-"));
  const configFile = path.join(configDir, "headers");
  try {
    fs.writeFileSync(configFile, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
    return await runCommand("curl", ["--config", configFile, ...args], options);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

export async function resolveGitHubRef(repo: string, ref: string, runCommand: CommandRunner): Promise<string> {
  const result = await runGitHubCurl(["--fail", "--silent", "--show-error", "--location", "--header", "Accept: application/vnd.github+json", "--header", "User-Agent: paperclipai-install", `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`], runCommand, { maxBuffer: 4 * 1024 * 1024 });
  let sha: unknown;
  try { sha = (JSON.parse(result.stdout) as { sha?: unknown }).sha; } catch { throw new Error(`GitHub returned an invalid response while resolving ${repo}@${ref}.`); }
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`GitHub did not return a full commit SHA for ${repo}@${ref}.`);
  return sha.toLowerCase();
}

function payloadEntrypoint(payloadPath: string): string {
  return path.join(payloadPath, "node_modules", "paperclipai", "dist", "index.js");
}

// Bun reads ~/.npmrc and ~/.bunfig.toml in addition to environment variables, so
// a stale or hostile registry override in the home directory would otherwise
// redirect a managed install. Point Bun at a throwaway config root and force the
// public registry through both registry variables and the explicit CLI flag.
function bunInstallEnv(): NodeJS.ProcessEnv {
  return { ...process.env, BUN_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY, NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY };
}

export async function smokePayload(payloadPath: string, expectedVersion: string, runCommand: CommandRunner): Promise<void> {
  const entrypoint = payloadEntrypoint(payloadPath);
  if (!fs.existsSync(entrypoint)) throw new Error(`Installed package is missing its CLI entrypoint: ${entrypoint}`);
  const result = await runCommand(process.execPath, [entrypoint, "--version"], { maxBuffer: 1024 * 1024 });
  const reportedVersion = result.stdout.trim().split(/\s+/)[0];
  if (reportedVersion !== expectedVersion) {
    throw new Error(`Installed CLI smoke check reported ${reportedVersion || "no version"}; expected ${expectedVersion}.`);
  }
}

export async function installNpmPayload(
  version: string,
  runCommand: CommandRunner,
  paths = resolveInstallStorePaths(),
): Promise<{ payloadPath: string; reused: boolean }> {
  const payloadPath = payloadPathFor(paths, "npm", version);
  if (fs.existsSync(payloadPath)) {
    await smokePayload(payloadPath, version, runCommand);
    return { payloadPath, reused: true };
  }
  const sourceRoot = path.dirname(payloadPath);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to install into unsafe payload root ${sourceRoot}.`);
  }
  fs.chmodSync(paths.cliRoot, 0o700);
  fs.chmodSync(paths.installsRoot, 0o700);
  fs.chmodSync(sourceRoot, 0o700);
  const stagingPath = path.join(sourceRoot, `.${version}.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(stagingPath, { recursive: true, force: true });
  try {
    // Bun installs the published payload directly; no Node.js or npm is needed.
    // `--trust` is required because the published graph carries lifecycle
    // scripts (embedded-postgres hydrates native symlinks and the server stages
    // its Copilot assets). npm ran them automatically, so this preserves that
    // behavior instead of silently shipping a broken payload.
    await runCommand(
      "bun",
      [
        "add",
        "--cwd",
        stagingPath,
        "--trust",
        `--registry=${PUBLIC_NPM_REGISTRY}`,
        `paperclipai@${version}`,
      ],
      { cwd: sourceRoot, env: bunInstallEnv(), maxBuffer: 16 * 1024 * 1024 },
    );
    await smokePayload(stagingPath, version, runCommand);
    fs.renameSync(stagingPath, payloadPath);
    return { payloadPath, reused: false };
  } finally {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }
}

function gitBuildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  // Source builds need devDependencies (esbuild, typescript); ambient NODE_ENV=production
  // makes package managers omit them, so the checkout build must not inherit it.
  delete env.NODE_ENV;
  return env;
}

// Workspace packages carry `workspace:*` specifiers and `publishConfig`
// entrypoint overrides. `bun pm pack` resolves neither, so materialize the
// publish manifest into a throwaway copy of the package before packing. The
// checkout is never mutated, and the tarball that lands in the payload matches
// what the registry publishes.
export function materializePublishManifestForPack(packageDir: string, destinationDir: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as Record<string, unknown> & {
    version?: string;
    publishConfig?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const publishManifest: Record<string, unknown> = { ...manifest };
  for (const key of ["main", "types", "exports", "bin"]) {
    if (manifest.publishConfig?.[key] !== undefined) publishManifest[key] = manifest.publishConfig[key];
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const declared = publishManifest[section];
    if (!declared || typeof declared !== "object") continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(declared as Record<string, string>).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        const prefix = range === "^" || range === "~" ? range : "";
        return [name, `${prefix}${manifest.version ?? ""}`];
      }),
    );
  }
  delete publishManifest.publishConfig;

  const stagedDir = path.join(destinationDir, `.pack-${path.basename(packageDir)}-${process.pid}-${Date.now()}`);
  fs.cpSync(packageDir, stagedDir, { recursive: true, dereference: false });
  fs.writeFileSync(path.join(stagedDir, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`);
  return stagedDir;
}

async function packWorkspacePackage(
  packageDir: string,
  destinationDir: string,
  runCommand: CommandRunner,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const stagedDir = materializePublishManifestForPack(packageDir, destinationDir);
  try {
    await runCommand("bun", ["pm", "pack", "--destination", destinationDir], { cwd: stagedDir, env, maxBuffer: 32 * 1024 * 1024 });
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }
}

export async function installGitPayload(repo: string, sha: string, runCommand: CommandRunner, paths = resolveInstallStorePaths()): Promise<{ payloadPath: string; reused: boolean; version: string }> {
  const identifier = sha.slice(0, 12);
  const payloadPath = payloadPathFor(paths, "git", identifier);
  if (fs.existsSync(payloadPath)) {
    const metadata = JSON.parse(fs.readFileSync(path.join(payloadPath, "node_modules", "paperclipai", "package.json"), "utf8")) as { version: string };
    await smokePayload(payloadPath, metadata.version, runCommand);
    return { payloadPath, reused: true, version: metadata.version };
  }
  const sourceRoot = path.dirname(payloadPath);
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to install into unsafe payload root ${sourceRoot}.`);
  }
  fs.chmodSync(paths.cliRoot, 0o700);
  fs.chmodSync(paths.installsRoot, 0o700);
  fs.chmodSync(sourceRoot, 0o700);
  const stagingRoot = path.join(sourceRoot, `.${identifier}.tmp-${process.pid}-${Date.now()}`);
  const checkoutPath = path.join(stagingRoot, "source");
  const archivePath = path.join(stagingRoot, "source.tar.gz");
  const stagedPayload = path.join(stagingRoot, "payload");
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(checkoutPath, { recursive: true, mode: 0o700 });
  const buildEnv = (extra: NodeJS.ProcessEnv = {}) => gitBuildEnv({ ...extra });
  try {
    await runGitHubCurl(["--fail", "--silent", "--show-error", "--location", "--output", archivePath, `https://codeload.github.com/${repo}/tar.gz/${sha}`], runCommand, { maxBuffer: 4 * 1024 * 1024 });
    await runCommand("tar", ["-xzf", archivePath, "--strip-components=1", "-C", checkoutPath], { maxBuffer: 4 * 1024 * 1024 });
    await runCommand("bun", ["install", "--frozen-lockfile"], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
    await runCommand("bash", ["scripts/build-npm.sh", "--skip-checks", "--skip-typecheck"], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
    await runCommand("bun", ["run", "--filter", "@paperclipai/server", "build"], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
    const metadata = JSON.parse(fs.readFileSync(path.join(checkoutPath, "cli", "package.json"), "utf8")) as { version: string };
    const workspacePackages = resolveGitInstallWorkspacePackages(checkoutPath);
    for (const [index, workspacePackage] of workspacePackages.entries()) {
      const packageDir = path.join(checkoutPath, workspacePackage.dir);
      const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { bundleDependencies?: string[]; bundledDependencies?: string[] };
      const bundledDependencies = packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? [];
      if (bundledDependencies.length > 0) {
        const stagedPackage = path.join(stagingRoot, `workspace-package-${index}`);
        await runCommand(process.execPath, [path.join(checkoutPath, "scripts", "prepare-bundled-package.mjs"), packageDir, stagedPackage], { cwd: checkoutPath, env: buildEnv(), maxBuffer: 32 * 1024 * 1024 });
        await packWorkspacePackage(stagedPackage, stagingRoot, runCommand, buildEnv());
      } else {
        await packWorkspacePackage(packageDir, stagingRoot, runCommand, buildEnv({ PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" }));
      }
    }
    await packWorkspacePackage(path.join(checkoutPath, "cli"), stagingRoot, runCommand, buildEnv());
    const tarballs = fs.readdirSync(stagingRoot).filter((entry) => entry.endsWith(".tgz"));
    const cliTarball = tarballs.find((entry) => entry === `paperclipai-${metadata.version}.tgz`);
    const workspaceTarballs = tarballs.filter((entry) => entry !== cliTarball);
    if (!cliTarball || workspaceTarballs.length !== workspacePackages.length) {
      throw new Error(`Git install packaging produced ${workspaceTarballs.length} workspace tarballs; expected ${workspacePackages.length}.`);
    }
    await runCommand(
      "bun",
      ["add", "--cwd", stagedPayload, "--trust", `--registry=${PUBLIC_NPM_REGISTRY}`, path.join(stagingRoot, cliTarball), ...workspaceTarballs.map((entry) => path.join(stagingRoot, entry))],
      { cwd: stagingRoot, env: buildEnv(bunInstallEnv()), maxBuffer: 32 * 1024 * 1024 },
    );
    await smokePayload(stagedPayload, metadata.version, runCommand);
    fs.renameSync(stagedPayload, payloadPath);
    return { payloadPath, reused: false, version: metadata.version };
  } finally { fs.rmSync(stagingRoot, { recursive: true, force: true }); }
}

function pathContains(directory: string): boolean {
  const normalized = path.resolve(directory);
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((entry) => path.resolve(entry) === normalized);
}

function shellRcPath(): string | null {
  const home = process.env.HOME;
  if (!home) return null;
  const shell = path.basename(process.env.SHELL ?? "");
  if (shell === "bash") return path.join(home, ".bashrc");
  if (shell === "zsh") return path.join(home, ".zshrc");
  return null;
}

async function ensureShimOnPath(options: InstallOptions): Promise<void> {
  const paths = resolveInstallStorePaths();
  const binDir = path.dirname(paths.shimPath);
  if (pathContains(binDir)) return;
  const manualInstruction = `export PATH="$HOME/.local/bin:$PATH"`;
  const rcPath = shellRcPath();
  if (!process.stdin.isTTY || !process.stdout.isTTY || !rcPath) {
    console.log(pc.yellow(`Add Paperclip to PATH for this shell:\n  ${manualInstruction}`));
    return;
  }
  const confirmed = options.yes === true ? true : await p.confirm({ message: `Add ~/.local/bin to PATH in ${rcPath}?`, initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) {
    console.log(pc.yellow(`PATH was not changed. Run:\n  ${manualInstruction}`));
    return;
  }
  const changed = addManagedPathBlock(rcPath);
  console.log(changed ? pc.green(`Updated ${rcPath}.`) : pc.dim(`${rcPath} already contains the PATH block.`));
}

async function confirmGitInstall(options: InstallOptions, repo: string, ref: string): Promise<void> {
  const warning = `Installing ${repo}@${ref} executes dependency and build scripts from that repository.`;
  console.log(pc.yellow(`Warning: ${warning}`));
  if (options.yes === true) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${warning} Re-run with --yes to consent in non-interactive environments.`);
  }
  const confirmed = await p.confirm({
    message: `${warning} Continue?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    throw new Error("Git-ref install cancelled before downloading or executing repository code.");
  }
}

export async function installCommand(
  options: InstallOptions,
  dependencies: { runCommand?: CommandRunner; now?: () => Date } = {},
): Promise<void> {
  assertSupportedBunVersion();
  const runCommand = dependencies.runCommand ?? runCommandWithDiagnostics;
  const gitRequest = resolveGitInstallRequest(options);
  if (gitRequest) {
    await confirmGitInstall(options, gitRequest.repo, gitRequest.ref);
    const sha = await resolveGitHubRef(gitRequest.repo, gitRequest.ref, runCommand);
    const paths = resolveInstallStorePaths();
    const installed = await withInstallStoreLock(async () => {
      assertManagedShimWritable(paths);
      const currentManifest = readInstallManifest(paths);
      const payload = await installGitPayload(gitRequest.repo, sha, runCommand, paths);
      const record: InstallRecord = { source: "git", version: payload.version, channel: "pinned", repo: gitRequest.repo, ref: gitRequest.ref, sha, payloadPath: payload.payloadPath, installedAt: (dependencies.now?.() ?? new Date()).toISOString() };
      const nextManifest = buildNextManifest(record, currentManifest);
      const oldTarget = fs.existsSync(paths.currentPath) ? fs.readlinkSync(paths.currentPath) : null;
      flipCurrentAtomic(payload.payloadPath, paths);
      try { writeInstallManifestAtomic(nextManifest, paths); } catch (error) { if (oldTarget) flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths); else fs.rmSync(paths.currentPath, { force: true }); throw error; }
      writeManagedShim(paths); pruneInstallPayloads(nextManifest, paths); return payload;
    }, paths);
    await ensureShimOnPath(options);
    console.log(pc.green(`${installed.reused ? "Activated cached" : "Installed"} paperclipai git payload ${sha.slice(0, 12)}.`));
    return;
  }
  const request = resolveNpmInstallRequest(options);
  console.log(`Resolving paperclipai@${request.spec} from ${PUBLIC_NPM_REGISTRY}...`);
  const version = await resolvePublishedVersion(request.spec, runCommand);
  console.log(`Installing paperclipai@${version}...`);

  const paths = resolveInstallStorePaths();
  const installed = await withInstallStoreLock(async () => {
    assertManagedShimWritable(paths);
    const currentManifest = readInstallManifest(paths);
    const payload = await installNpmPayload(version, runCommand, paths);
    const record: InstallRecord = {
      source: "npm",
      version,
      channel: request.channel,
      payloadPath: payload.payloadPath,
      installedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    };
    const nextManifest = buildNextManifest(record, currentManifest);
    const oldTarget = fs.existsSync(paths.currentPath) ? fs.readlinkSync(paths.currentPath) : null;
    flipCurrentAtomic(payload.payloadPath, paths);
    try {
      writeInstallManifestAtomic(nextManifest, paths);
    } catch (error) {
      if (oldTarget) flipCurrentAtomic(path.resolve(paths.cliRoot, oldTarget), paths);
      else fs.rmSync(paths.currentPath, { force: true });
      throw error;
    }
    writeManagedShim(paths);
    pruneInstallPayloads(nextManifest, paths);
    return payload;
  }, paths);
  await ensureShimOnPath(options);

  console.log(pc.green(`${installed.reused ? "Activated cached" : "Installed"} paperclipai ${version} (${request.channel}).`));
  console.log(pc.dim(`Payload: ${installed.payloadPath}`));
  console.log(`Run ${pc.cyan("paperclipai --version")} to verify the managed install.`);
}
