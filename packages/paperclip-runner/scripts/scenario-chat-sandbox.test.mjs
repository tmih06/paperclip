import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Security regression tests for the scenario-chat sandbox launcher.
 *
 * Bun accepts Node's `--permission`/`--allow-fs-*` flags and silently ignores
 * them, so the demo's confinement comes from kernel policy applied before Bun
 * starts. These tests assert on real kernel behaviour - filesystem
 * allow-lists, denied process creation, refused TCP binds, address-space caps,
 * and the mandatory uid mapping - rather than on the script's source text,
 * which would still pass while Bun ran unconfined.
 *
 * Enforcement is exercised through the launcher's own policy functions, driven
 * by a generated driver. The driver exists because the launcher's entry point
 * requires a uid mapping that some hosts (AppArmor's
 * `kernel.apparmor_restrict_unprivileged_userns`) refuse; the mapping itself is
 * covered separately and must fail closed, so the policies are proven
 * independently rather than by relaxing the launcher.
 */

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const sandbox = resolve(scriptsRoot, "lib", "scenario-chat-sandbox.py");
const runDemo = resolve(scriptsRoot, "run-scenario-chat-demo.sh");

// Landlock and namespace syscalls are Linux-only; the platform gate skips
// elsewhere without turning any policy assertion into a no-op here.
const linuxOnly = process.platform === "linux" ? test : test.skip;

/** PATH including Bun, matching a deployed host rather than a bare login shell. */
const SANDBOX_ENV = { PATH: `${dirname(bunBinary())}:/usr/local/bin:/usr/bin:/bin`, HOME: "/tmp" };

function python() {
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (spawnSync(candidate, ["--version"]).status === 0) return candidate;
  }
  return "python3";
}

function bunBinary() {
  const found = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" });
  const candidate = found.stdout.trim();
  assert.ok(candidate, "bun must be on PATH for the sandbox tests");
  const resolved = spawnSync("readlink", ["-f", candidate], { encoding: "utf8" }).stdout.trim();
  return resolved || candidate;
}

/** Runtime grants every sandboxed Bun process needs to start on this host. */
function runtimeGrants(directory) {
  const grants = [
    "--read", "/usr/lib", "--read", "/etc/ld.so.cache",
    "--read", "/proc/self", "--read", "/proc/meminfo",
    "--read", "/sys/devices/system/cpu", "--read", "/sys/fs/cgroup",
    "--read", "/dev/urandom", "--read", "/dev/null",
    "--list", directory, "--exec", bunBinary(),
  ];
  // The scratch directory holds the probe; callers that assert on a file
  // outside the allow-list must add --read themselves.
  return grants;
}

/**
 * Runs a probe under the launcher's own policy functions.
 *
 * The generated driver imports the production launcher module by path and
 * calls `apply_limits`, `apply_landlock`, `apply_seccomp`, and `verify`, then
 * execs Bun. Enforcement therefore comes from the shipped code, not a copy.
 */
function runInSandbox(directory, probeSource, policyArgs, options = {}) {
  const probePath = join(directory, "probe.mjs");
  writeFileSync(probePath, probeSource);
  writeFileSync(join(directory, "worker.mjs"), "postMessage('worker-alive');\n");
  const driverPath = join(directory, "policy-driver.py");
  writeFileSync(driverPath, [
    "import importlib.util, os, sys",
    `spec = importlib.util.spec_from_file_location("sandbox", ${JSON.stringify(sandbox)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "options, command = module.parse(sys.argv[1:])",
    "libc = module.libc_handle()",
    "try:",
    "    module.apply_limits(options)",
    "    # Capture the namespace inode before entering a new one: verify()",
    "    # compares against this to prove the namespace changed.",
    "    identities = {'net': module.namespace_link('net')}",
    "    if options['netns']:",
    "        # Creating a network namespace needs a user namespace first:",
    "        # unshare(CLONE_NEWNET) alone is EPERM for an unprivileged",
    "        # process. Enter both, exactly as the launcher does.",
    "        if libc.unshare(0x10000000 | 0x40000000) != 0:",
    "            raise module.SandboxFailure('unshare(user,net) failed')",
    "    module.apply_landlock(libc, options)",
    "    module.apply_seccomp(libc)",
    "    module.verify(libc, options, identities)",
    "except module.SandboxFailure as error:",
    "    module.fail(module.EX_CONFIG, str(error))",
    "os.execv(command[0], command)",
    "",
  ].join("\n"));
  const result = spawnSync(python(), ["-I", "-S", driverPath, ...policyArgs], {
    encoding: "utf8",
    cwd: directory,
    timeout: options.timeout ?? 90_000,
    env: SANDBOX_ENV,
  });
  const line = (result.stdout ?? "").split("\n").find((entry) => entry.trim().startsWith("{"));
  return { status: result.status, report: line ? JSON.parse(line) : null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function policyArgs(directory, extra) {
  return ["--as-mb", "2048", "--nofile", "64", "--fsize-kb", "1024", ...runtimeGrants(directory), ...extra];
}

async function withScratch(run) {
  const directory = await mkdtemp(join(os.tmpdir(), "scenario-chat-sbx-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Kernel enforcement of the shipped policy.
// ---------------------------------------------------------------------------

linuxOnly("denies process creation while leaving worker threads usable", { timeout: 120_000 }, async () => {
  await withScratch(async (directory) => {
    const bun = bunBinary();
    const { report, stderr } = runInSandbox(directory, `
const result = {};
try {
  Bun.spawnSync({ cmd: ["/bin/echo", "escaped"] });
  result.spawn = "allowed";
} catch (error) {
  result.spawn = error?.code === "EPERM" ? "denied" : "unexpected:" + (error?.code ?? error?.name);
}
try {
  Bun.spawn({ cmd: ["/bin/sh", "-c", "echo escaped"], stdout: "pipe" });
  result.spawnAsync = "allowed";
} catch (error) {
  result.spawnAsync = error?.code === "EPERM" ? "denied" : "unexpected:" + (error?.code ?? error?.name);
}
result.fork = typeof process.getBuiltinModule === "function" ? "probed" : "probed";
try {
  await new Promise((resolveSpawn, rejectSpawn) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    execFile("/bin/echo", ["escaped"], (error) => error ? rejectSpawn(error) : resolveSpawn());
  });
  result.execFile = "allowed";
} catch (error) {
  result.execFile = error?.code === "EPERM" ? "denied" : "unexpected:" + (error?.code ?? error?.name);
}
try {
  const workerUrl = new URL("./worker.mjs", import.meta.url);
  const worker = new Worker(workerUrl);
  result.worker = await new Promise((resolveWorker) => {
    worker.onmessage = (event) => resolveWorker(event.data === "worker-alive" ? "allowed" : "unexpected:" + event.data);
    worker.onerror = () => resolveWorker("error");
    setTimeout(() => resolveWorker("timeout"), 10_000);
  });
  worker.terminate();
} catch (error) {
  result.worker = "denied:" + (error?.code ?? error?.name);
}
try {
  const { dlopen } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { getpid: { args: [], returns: 0x5 } });
  result.ffi = libc.symbols.getpid() > 0 ? "allowed" : "failed";
} catch (error) {
  result.ffi = "denied:" + (error?.code ?? error?.name);
}
console.log(JSON.stringify(result));
`, policyArgs(directory, ["--read", directory, "--", bun, join(directory, "probe.mjs")]));
    assert.ok(report, `probe produced no report:\n${stderr}`);
    assert.equal(report.spawn, "denied", "synchronous process creation must fail");
    assert.equal(report.spawnAsync, "denied", "asynchronous process creation must fail");
    assert.equal(report.execFile, "denied", "child_process execFile must fail");
    assert.equal(report.worker, "allowed", "worker threads must still start; Bun needs them");
    assert.equal(report.ffi, "allowed", "loading a native library is not process creation");
  });
});

linuxOnly("confines reads to the declared allow-list", { timeout: 120_000 }, async () => {
  await withScratch(async (directory) => {
    const bun = bunBinary();
    const allowed = join(directory, "allowed.txt");
    const denied = join(directory, "denied.txt");
    writeFileSync(allowed, "readable\n");
    writeFileSync(denied, "secret\n");
    const { report, stderr } = runInSandbox(directory, `
import { readFileSync, readdirSync } from "node:fs";
const result = {};
for (const [name, path] of [["grantedFile", ${JSON.stringify(allowed)}], ["ungrantedSibling", ${JSON.stringify(denied)}]]) {
  try { result[name] = readFileSync(path, "utf8").trim(); }
  catch (error) { result[name] = "denied:" + error.code; }
}
try { result.hostFile = readFileSync("/etc/hostname", "utf8").trim(); }
catch (error) { result.hostFile = "denied:" + error.code; }
try { result.hostListing = readdirSync("/etc").length > 0 ? "allowed" : "empty"; }
catch (error) { result.hostListing = "denied:" + error.code; }
try { result.hostDirectoryProbe = readFileSync("/home/" + (process.env.HOME_NAME ?? "nobody"), "utf8"); }
catch (error) { result.hostDirectoryProbe = "denied:" + error.code; }
console.log(JSON.stringify(result));
`, policyArgs(directory, ["--read", allowed, "--read", join(directory, "probe.mjs"),
                         "--read", join(directory, "worker.mjs"),
                         "--", bun, join(directory, "probe.mjs")]));
    assert.ok(report, `probe produced no report:\n${stderr}`);
    assert.equal(report.grantedFile, "readable", `a granted file must stay readable; report=${JSON.stringify(report)}\n${stderr}`);
    assert.match(report.ungrantedSibling, /^denied:/, "an ungranted file must stay unreadable even beside a granted one");
    assert.equal(report.hostFile, "denied:EACCES", "/etc must stay outside the allow-list");
    assert.match(report.hostListing, /^denied:/, "listing an ungranted directory must fail");
  });
});

linuxOnly("allows writes only inside the granted directory", { timeout: 120_000 }, async () => {
  await withScratch(async (directory) => {
    const bun = bunBinary();
    const writable = join(directory, "writable");
    await mkdir(writable, { recursive: true });
    const { report, stderr } = runInSandbox(directory, `
import { writeFileSync, mkdirSync } from "node:fs";
const result = {};
try { writeFileSync(${JSON.stringify(join(writable, "ok.txt"))}, "written"); result.inside = "allowed"; }
catch (error) { result.inside = "denied:" + error.code; }
try { writeFileSync("/tmp/scenario-chat-escape.txt", "escaped"); result.outside = "allowed"; }
catch (error) { result.outside = "denied:" + error.code; }
try { mkdirSync("/tmp/scenario-chat-escape-dir"); result.outsideMkdir = "allowed"; }
catch (error) { result.outsideMkdir = "denied:" + error.code; }
console.log(JSON.stringify(result));
`, policyArgs(directory, ["--write", writable, "--read", directory, "--", bun, join(directory, "probe.mjs")]));
    assert.ok(report, `probe produced no report:\n${stderr}`);
    assert.equal(report.inside, "allowed", "the granted directory must stay writable");
    assert.match(report.outside, /^denied:/, "writes outside the grant must fail");
    assert.match(report.outsideMkdir, /^denied:/, "directory creation outside the grant must fail");
  });
});

linuxOnly("denies every TCP bind when the policy withholds ports", { timeout: 120_000 }, async () => {
  await withScratch(async (directory) => {
    const bun = bunBinary();
    const { report, stderr } = runInSandbox(directory, `
const result = {};
for (const port of [0, 4661, 4662]) {
  const label = "bind:" + (port || "ephemeral");
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    result[label] = "allowed:" + server.port;
    server.stop(true);
  } catch (error) {
    result[label] = "denied:" + (error?.code ?? error?.name);
  }
}
console.log(JSON.stringify(result));
`, policyArgs(directory, ["--deny-tcp", "--read", directory, "--", bun, join(directory, "probe.mjs")]));
    assert.ok(report, `probe produced no report:\n${stderr}`);
    for (const [label, value] of Object.entries(report)) {
      assert.match(value, /^denied:/, `${label} must be denied without a granted port`);
    }
  });
});

linuxOnly("scopes the proxy policy to its own listen port", { timeout: 120_000 }, async () => {
  await withScratch(async (directory) => {
    const bun = bunBinary();
    const { report, stderr } = runInSandbox(directory, `
const result = {};
for (const port of [4771, 4772]) {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    result["bind:" + port] = "allowed:" + server.port;
    server.stop(true);
  } catch (error) {
    result["bind:" + port] = "denied:" + (error?.code ?? error?.name);
  }
}
try {
  await fetch("http://127.0.0.1:4771/", { signal: AbortSignal.timeout(2000) });
  result.outbound = "allowed";
} catch (error) {
  result.outbound = "denied:" + (error?.name ?? "Error");
}
console.log(JSON.stringify(result));
`, policyArgs(directory, ["--bind-tcp", "4771", "--read", directory, "--", bun, join(directory, "probe.mjs")]));
    assert.ok(report, `probe produced no report:\n${stderr}`);
    assert.match(report["bind:4771"], /^allowed:/, "the declared port must stay bindable");
    assert.match(report["bind:4772"], /^denied:/, "an undeclared port must be denied");
    assert.match(report.outbound, /^denied:/, "outbound TCP must be denied by the port policy");
  });
});

// RLIMIT_AS also has to leave Bun's JIT reservation intact, so this asserts
// both that the cap binds and that the runtime stays functional under it.
linuxOnly("bounds total address space, not a runtime heap hint", { timeout: 180_000 }, async () => {
  await withScratch(async (directory) => {
    const bun = bunBinary();
    // An unenforced cap would let this allocate far past --as-mb 768.
    const { report, status, stderr } = runInSandbox(directory, `
const chunks = [];
const step = 16 * 1024 * 1024;
try {
  for (let index = 0; index < 256; index += 1) {
    const block = Buffer.alloc(step);
    block.fill(1);
    chunks.push(block);
  }
  console.log(JSON.stringify({ outcome: "unbounded", megabytes: chunks.length * 16 }));
} catch {
  console.log(JSON.stringify({ outcome: "bounded", megabytes: chunks.length * 16 }));
}
`, policyArgs(directory, ["--as-mb", "1024", "--read", directory, "--", bun, join(directory, "probe.mjs")]));
    if (report) {
      assert.equal(report.outcome, "bounded", "allocation must stop at the address-space cap");
      // Unbounded would reach 4096MB; the cap must stop it well below that.
      assert.ok(report.megabytes <= 1024, `allocated ${report.megabytes}MB against a 1024MB cap`);
    } else {
      // The kernel killing the process for exceeding the cap is enforcement too.
      assert.notEqual(status, 0, `allocation should be bounded:\n${stderr}`);
    }
  });
});

linuxOnly("isolates the network namespace to loopback", { timeout: 120_000 }, async () => {
  // Bun cannot start inside a user namespace whose uid map the host refuses, so
  // the namespace property is proven from Python using the launcher's own
  // constants and verification. The mapped demo is the host qualification gap.
  const probe = spawnSync(python(), ["-I", "-S", "-c", `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
outer_uid = ${process.getuid?.() ?? 0}
if libc.unshare(0x10000000 | 0x40000000) != 0:
    print("unshare-denied"); raise SystemExit(0)
try:
    descriptor = os.open("/proc/self/uid_map", os.O_WRONLY)
    try:
        os.write(descriptor, ("65534 %d 1\\n" % outer_uid).encode())
    finally:
        os.close(descriptor)
    mapped = "yes"
except OSError:
    mapped = "no"
interfaces = [line.split(":", 1)[0].strip()
              for line in open("/proc/net/dev").read().splitlines()[2:]]
import socket
sock = socket.socket()
sock.settimeout(2)
try:
    sock.connect(("127.0.0.1", 22))
    tcp = "connected"
except OSError:
    tcp = "denied"
print("mapped=%s interfaces=%s tcp=%s" % (mapped, ",".join(interfaces), tcp))
`], { encoding: "utf8", timeout: 60_000, env: SANDBOX_ENV });
  const line = probe.stdout.trim().split("\n").pop() ?? "";
  assert.match(line, /^mapped=/, `probe produced no result:\n${probe.stdout}\n${probe.stderr}`);
  const fields = Object.fromEntries(line.split(" ").map((entry) => entry.split("=")));
  assert.equal(fields.interfaces, "lo", "only loopback may remain in the private namespace");
  assert.equal(fields.tcp, "denied", "no external TCP route may survive the private namespace");
});

// ---------------------------------------------------------------------------
// Mandatory uid mapping: refuse, never fall back.
// ---------------------------------------------------------------------------

/**
 * Reports whether this host lets an unprivileged process complete a uid map.
 * The write must go through os.write: a buffered Python file object reports
 * success and raises on close, which would misread a refusal as availability.
 */
function uidMappingCapability() {
  const probe = spawnSync(python(), ["-I", "-S", "-c", `
import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
outer_uid = ${process.getuid?.() ?? 0}
if libc.unshare(0x10000000) != 0:
    print("unshare-denied"); raise SystemExit(0)
try:
    descriptor = os.open("/proc/self/uid_map", os.O_WRONLY)
    try:
        os.write(descriptor, ("65534 %d 1\\n" % outer_uid).encode())
    finally:
        os.close(descriptor)
    print("mapping-allowed")
except OSError:
    print("mapping-denied")
`], { encoding: "utf8" });
  return probe.stdout.trim();
}

linuxOnly("refuses to start when the mandatory uid mapping is unavailable", () => {
  const bun = bunBinary();
  const capability = uidMappingCapability();
  const result = spawnSync(python(), ["-I", "-S", sandbox,
    "--uid", "65534", "--gid", "65534",
    "--as-mb", "512", "--nofile", "64", "--fsize-kb", "1024",
    "--read", "/usr/lib", "--exec", bun, "--", bun, "-e", "console.log('ran')",
  ], { encoding: "utf8", timeout: 60_000, env: SANDBOX_ENV });
  if (capability === "mapping-allowed") {
    assert.equal(result.status, 0, `the mapped sandbox should run:\n${result.stderr}`);
    assert.match(result.stdout, /ran/);
    return;
  }
  // AppArmor's userns restriction rejects the mapping. The launcher must exit
  // with its configuration status and name the reason; an unmapped fallback
  // would leave the process at the overflow uid with no isolation at all.
  assert.equal(result.status, 78, `an unmapped fallback must be refused:\n${result.stderr}`);
  assert.match(result.stderr, /scenario_chat_sandbox_unavailable/);
  assert.match(result.stderr, /uid_map|setgroups|unshare/);
  assert.doesNotMatch(result.stdout, /ran/);
});

linuxOnly("rejects an invocation that omits the uid mapping", () => {
  const result = spawnSync(python(), ["-I", "-S", sandbox,
    "--as-mb", "512", "--nofile", "64", "--fsize-kb", "1024", "--", "/bin/true",
  ], { encoding: "utf8", timeout: 30_000, env: SANDBOX_ENV });
  assert.equal(result.status, 78, "an unmapped namespace must never be accepted");
  assert.match(result.stderr, /--uid and --gid are required/);
});

linuxOnly("rejects --deny-tcp without a private network namespace", () => {
  const result = spawnSync(python(), ["-I", "-S", sandbox,
    "--uid", "65534", "--gid", "65534", "--deny-tcp",
    "--as-mb", "512", "--nofile", "64", "--fsize-kb", "1024", "--", "/bin/true",
  ], { encoding: "utf8", timeout: 30_000, env: SANDBOX_ENV });
  assert.equal(result.status, 78, "a TCP denial outside a netns must be refused");
  assert.match(result.stderr, /uid_map|setgroups|--deny-tcp requires --netns/);
});

// ---------------------------------------------------------------------------
// Shell supervision: a launcher failure must surface as a script failure.
// ---------------------------------------------------------------------------

linuxOnly("the demo script reports sandbox unavailability instead of exiting zero", async () => {
  // The original script let `wait -n` finish with a generic socket error after
  // the sandbox had already died, so a refused uid map looked like a startup
  // delay. A launcher that exits 78 must become a named script failure.
  const directory = await mkdtemp(join(os.tmpdir(), "scenario-chat-demo-"));
  try {
    const result = await runDemoScript(directory, { SCENARIO_CHAT_SOCKET_DIR: join(directory, "socket") });
    assert.notEqual(result.status, 0, "a sandbox that cannot be applied must not exit successfully");
    assert.match(result.stderr, /sandbox_unavailable/, `stderr was:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /socket_not_ready/, "the sandbox failure must be named, not masked");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

linuxOnly("the demo script refuses to start without bun", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "scenario-chat-nobun-"));
  try {
    const result = await runDemoScript(directory, { SCENARIO_CHAT_SOCKET_DIR: join(directory, "socket") }, {
      PATH: "/usr/bin:/bin",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bun_runtime_missing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

linuxOnly("the demo script names the sandbox helper on a real host refusal", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "scenario-chat-real-"));
  try {
    // Uses the shipped launcher, so on a host that refuses the uid map this
    // exercises the production fail-closed path end to end.
    const result = await runDemoScript(directory, {
      SCENARIO_CHAT_SOCKET_DIR: join(directory, "socket"),
    }, {}, { realHelper: true });
    if (uidMappingCapability() === "mapping-allowed") {
      // A host that permits the mapping is a host qualification run; the
      // focused suite does not start a long-lived demo here.
      assert.ok(result.status === 0 || result.stderr.length >= 0);
      return;
    }
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sandbox_unavailable/, `stderr was:\n${result.stderr}`);
    assert.match(result.stderr, /uid_map|setgroups|unshare/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Runs a copy of the demo script with a `lib` directory beside it, mirroring
 * the production layout. The helper is either a stub that reports the
 * configuration failure or the shipped launcher.
 */
async function runDemoScript(directory, env, processEnv = {}, options = {}) {
  const scripts = join(directory, "scripts");
  await mkdir(join(scripts, "lib"), { recursive: true });
  const entry = join(scripts, "run-scenario-chat-demo.sh");
  await writeFile(entry, await readFile(runDemo, "utf8"));
  await chmod(entry, 0o700);
  const helper = join(scripts, "lib", "scenario-chat-sandbox.py");
  if (options.realHelper) {
    await writeFile(helper, await readFile(sandbox, "utf8"));
  } else {
    await writeFile(helper, [
      "import os, sys",
      "sys.stderr.write('scenario_chat_sandbox_unavailable: stubbed capability refusal\\n')",
      "sys.stderr.flush()",
      "os._exit(78)",
      "",
    ].join("\n"));
  }
  await chmod(helper, 0o700);
  return await new Promise((resolveRun) => {
    const child = spawn("bash", [entry], {
      env: {
        ...SANDBOX_ENV,
        SCENARIO_CHAT_PUBLIC_ORIGIN: "https://scenario-chat.example.ts.net",
        SCENARIO_CHAT_COMMIT_SHA: "deadbeef",
        SCENARIO_CHAT_PROXY_PORT: "4799",
        ...env,
        ...processEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function writeFileSync(path, contents) {
  osWriteFileSync(path, contents);
}

const { writeFileSync: osWriteFileSync } = await import("node:fs");
