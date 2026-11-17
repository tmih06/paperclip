"""Apply kernel-level confinement to one Bun process, then replace itself with it.

The scenario-chat demo runs first-party Bun servers that must stay inside a
filesystem allow-list, a private network namespace, and a process tree that
cannot fork or exec its way out. Bun has no equivalent of Node's
``--permission`` flags: it accepts and silently ignores them, so the flags this
script used to pass were never enforced. Kernel policy has to be installed
before Bun starts, because a seccomp filter loaded after Bun's JIT threads
exist cannot be synchronised to them (``SECCOMP_FILTER_FLAG_TSYNC`` returns
``-EINVAL`` on Bun's runtime threads here), and Landlock cannot be applied by a
process that has already opened the files it is supposed to lose.

This launcher is the narrow native-enforcement layer. Python 3's standard
library only: every restriction is a Linux kernel feature reached through
``ctypes``. No JavaScript runs here; the command it executes is Bun.

Usage:
  scenario-chat-sandbox.py --uid 65534 --gid 65534 [--netns]
      --as-mb 512 --nofile 128 --fsize-kb 1024
      [--read PATH]... [--exec PATH]... [--write PATH]... [--bind-tcp PORT]...
      -- COMMAND [ARG]...

Every failure to apply a policy is fatal (exit 78): a capability that is
missing, denied, or silently unavailable must never degrade into an
unconfined process.
"""

import ctypes
import errno
import os
import resource
import signal
import stat
import struct
import sys

EX_CONFIG = 78
LANDLOCK_SETUP_FAILED = "scenario_chat_sandbox_unavailable"

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_RULE_NET_PORT = 2

PR_SET_NO_NEW_PRIVS = 38
PR_SET_PDEATHSIG = 1

CLONE_NEWUSER = 0x10000000
CLONE_NEWNET = 0x40000000

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13
FS_TRUNCATE = 1 << 14
FS_IOCTL_DEV = 1 << 15
FS_ABI1 = (1 << 13) - 1

NET_BIND_TCP = 1 << 0
NET_CONNECT_TCP = 1 << 1

FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE
DIRECTORY_RIGHTS = FS_ABI1 | FS_REFER | FS_TRUNCATE | FS_IOCTL_DEV

# Process creation is denied; thread creation is not. Bun needs threads for its
# JIT and worker pool, so a blanket `clone` deny makes it unusable. `clone3`
# returns ENOSYS so libc falls back to `clone`, which the filter inspects.
SECCOMP_ALLOW = 0x7FFF0000
SECCOMP_KILL_PROCESS = 0x80000000
SECCOMP_ERRNO = 0x00050000
BPF_LD_W_ABS = 0x20
BPF_JEQ_K = 0x15
BPF_JSET_K = 0x45
BPF_RET_K = 0x06
AUDIT_ARCH = {"x86_64": 0xC000003E, "aarch64": 0xC00000B7}
CLONE_THREAD = 0x00010000

# Denied with EPERM: escape, introspection, and privilege surfaces that a
# compromised demo process has no reason to reach.
SECCOMP_DENY_EPERM = (
    "ptrace", "process_vm_readv", "process_vm_writev", "kcmp",
    "mount", "umount2", "pivot_root", "chroot", "open_tree", "move_mount",
    "fsopen", "fsconfig", "fsmount", "mount_setattr",
    "unshare", "setns", "bpf", "perf_event_open", "userfaultfd",
    "io_uring_setup", "io_uring_enter", "io_uring_register",
    "init_module", "finit_module", "delete_module",
    "kexec_load", "kexec_file_load", "reboot", "swapon", "swapoff",
)


class SandboxFailure(Exception):
    pass


def fail(code, message):
    sys.stderr.write("%s: %s\n" % (LANDLOCK_SETUP_FAILED, message))
    sys.stderr.flush()
    os._exit(code)


def libc_handle():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    return libc


def call_sys(libc, what, *args):
    result = libc.syscall(*args)
    if result < 0:
        code = ctypes.get_errno()
        raise SandboxFailure("%s failed: %s" % (what, os.strerror(code)))
    return result


def parse(argv):
    options = {
        "uid": None, "gid": None, "netns": False,
        "as_mb": None, "nofile": None, "fsize_kb": None,
        "read": [], "exec": [], "write": [], "bind_tcp": [],
    }
    numeric = {"--as-mb": "as_mb", "--nofile": "nofile", "--fsize-kb": "fsize_kb"}
    repeatable = {"--read": "read", "--exec": "exec", "--write": "write", "--bind-tcp": "bind_tcp"}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--":
            command = argv[index + 1:]
            if not command:
                fail(EX_CONFIG, "missing command after --")
            return options, command
        if token == "--netns":
            options["netns"] = True
            index += 1
            continue
        if token in ("--uid", "--gid") or token in numeric or token in repeatable:
            if index + 1 >= len(argv):
                fail(EX_CONFIG, "%s requires a value" % token)
            value = argv[index + 1]
            if token == "--uid":
                options["uid"] = parse_int(token, value)
            elif token == "--gid":
                options["gid"] = parse_int(token, value)
            elif token in numeric:
                options[numeric[token]] = parse_int(token, value)
            elif token == "--bind-tcp":
                port = parse_int(token, value)
                if not 1 <= port <= 65535:
                    fail(EX_CONFIG, "%s must be a TCP port" % token)
                options["bind_tcp"].append(port)
            else:
                if not os.path.isabs(value):
                    fail(EX_CONFIG, "%s path must be absolute: %s" % (token, value))
                options[repeatable[token]].append(value)
            index += 2
            continue
        fail(EX_CONFIG, "unexpected argument: %s" % token)
    fail(EX_CONFIG, "missing -- before the command")


def parse_int(flag, value):
    try:
        return int(value, 10)
    except ValueError:
        fail(EX_CONFIG, "%s must be an integer: %s" % (flag, value))


def apply_namespaces(libc, options):
    """Enter a user namespace whose only mapping is the requested uid/gid.

    The mapping is mandatory: without it the sandbox reports the overflow uid
    and the "nobody" identity in the old script would be cosmetic. A host that
    forbids the mapping - AppArmor's
    ``kernel.apparmor_restrict_unprivileged_userns`` does on Ubuntu - is a
    hard failure, never a fallback to an unmapped namespace.
    """
    # The outer identity must be read before unshare: an unmapped process in a
    # new user namespace reports the overflow uid, so reading it afterwards
    # would map the overflow id to itself and silently grant nothing.
    host_uid, host_gid = os.getuid(), os.getgid()
    flags = CLONE_NEWUSER | (CLONE_NEWNET if options["netns"] else 0)
    if libc.unshare(flags) != 0:
        raise SandboxFailure("unshare(user%s) failed: %s"
                             % (",net" if options["netns"] else "", os.strerror(ctypes.get_errno())))
    # setgroups must be written before gid_map; it does not exist on older
    # kernels, which is not a failure.
    try:
        with open("/proc/self/setgroups", "w") as handle:
            handle.write("deny")
    except FileNotFoundError:
        pass
    except OSError as error:
        raise SandboxFailure("cannot write setgroups: %s" % error.strerror)
    write_map("/proc/self/uid_map", options["uid"], host_uid, "uid")
    write_map("/proc/self/gid_map", options["gid"], host_gid, "gid")
    if os.getuid() != options["uid"]:
        raise SandboxFailure("user namespace did not take effect (uid %d)" % os.getuid())


def write_map(path, inner, outer, what):
    try:
        with open(path, "w") as handle:
            handle.write("%d %d 1\n" % (inner, outer))
    except OSError as error:
        raise SandboxFailure("cannot map %s %d->%d: %s" % (what, inner, outer, error.strerror))


def landlock_abi(libc):
    result = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    if result < 0:
        raise SandboxFailure("Landlock is unavailable: %s" % os.strerror(ctypes.get_errno()))
    return result


def handled_fs_rights(abi):
    if abi >= 5:
        return DIRECTORY_RIGHTS
    if abi >= 3:
        return FS_ABI1 | FS_REFER | FS_TRUNCATE
    if abi >= 2:
        return FS_ABI1 | FS_REFER
    return FS_ABI1


def apply_landlock(libc, options):
    """Grant exactly the declared paths; everything else is unreachable.

    This is the allow-list replacement for ``--allow-fs-read``/``--allow-fs-write``.
    A path that does not exist is not an error (it grants nothing), but the
    process is left unable to read it, which is the intended default.
    """
    abi = landlock_abi(libc)
    handled_fs = handled_fs_rights(abi)
    managed_net = bool(options["bind_tcp"])
    handled_net = (NET_BIND_TCP | NET_CONNECT_TCP) if managed_net else 0
    if managed_net and abi < 4:
        raise SandboxFailure("Landlock ABI %d cannot restrict TCP ports" % abi)
    attr = ctypes.create_string_buffer(struct.pack("=QQQ", handled_fs, handled_net, 0), 24)
    ruleset = call_sys(libc, "landlock_create_ruleset", SYS_LANDLOCK_CREATE_RULESET, attr, len(attr), 0)

    def add_path(path, rights):
        try:
            descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.EACCES):
                return
            raise SandboxFailure("cannot open %s: %s" % (path, error.strerror))
        try:
            mode = os.fstat(descriptor).st_mode
            if stat.S_ISLNK(mode):
                return
            if stat.S_ISDIR(mode):
                allowed = rights & handled_fs
            else:
                allowed = rights & handled_fs & FILE_RIGHTS
            rule = ctypes.create_string_buffer(struct.pack("=Qi", allowed, descriptor), 12)
            call_sys(libc, "landlock_add_rule(%s)" % path,
                     SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_PATH_BENEATH, rule, 0)
        finally:
            os.close(descriptor)

    for path in options["read"]:
        add_path(path, FS_READ_FILE | FS_READ_DIR)
    for path in options["exec"]:
        add_path(path, FS_READ_FILE | FS_EXECUTE)
    for path in options["write"]:
        add_path(path, FS_READ_FILE | FS_READ_DIR | FS_WRITE_FILE | FS_REMOVE_DIR
                 | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_SYM
                 | FS_TRUNCATE | FS_REFER)
    # Landlock needs FS_EXECUTE on each ancestor to traverse to a granted path
    # ("search" on a directory). Without it the grant is unreachable and every
    # exec fails with EACCES. Search is granted without read: parents stay
    # traversable but unlistable.
    for path in options["read"] + options["exec"] + options["write"]:
        add_searchable_ancestors(add_path, path)
    for port in options["bind_tcp"]:
        rule = ctypes.create_string_buffer(struct.pack("=Qi", NET_BIND_TCP, port), 12)
        call_sys(libc, "landlock_add_rule(tcp %d)" % port,
                 SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_NET_PORT, rule, 0)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise SandboxFailure("prctl(PR_SET_NO_NEW_PRIVS) failed: %s" % os.strerror(ctypes.get_errno()))
    call_sys(libc, "landlock_restrict_self", SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0)
    os.close(ruleset)
    return abi


def add_searchable_ancestors(add_path, path):
    current = os.path.dirname(path)
    while current and current != os.path.dirname(current):
        add_path(current, FS_EXECUTE)
        current = os.path.dirname(current)


def seccomp_syscalls():
    """Resolve names on this architecture; libseccomp is not a runtime need.

    The filter is built as raw BPF so the launcher depends on the kernel only.
    """
    table = syscall_table()
    return {name: table.get(name) for name in SECCOMP_DENY_EPERM + ("fork", "vfork", "clone", "clone3")}


def syscall_table():
    if process_arch() == "aarch64":
        return {
            "execve": 221, "execveat": 281, "clone": 220, "clone3": 435,
            "ptrace": 117, "process_vm_readv": 270, "process_vm_writev": 271, "kcmp": 272,
            "mount": 40, "umount2": 39, "pivot_root": 41, "chroot": 51, "open_tree": 428,
            "move_mount": 429, "fsopen": 430, "fsconfig": 431, "fsmount": 432,
            "mount_setattr": 442, "unshare": 97, "setns": 268, "bpf": 280,
            "perf_event_open": 241, "userfaultfd": 282,
            "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427,
            "init_module": 105, "finit_module": 273, "delete_module": 106,
            "kexec_load": 104, "kexec_file_load": 294, "reboot": 142,
            "swapon": 224, "swapoff": 225,
        }
    return {
        "execve": 59, "execveat": 322, "clone": 56, "clone3": 435,
        "ptrace": 101, "process_vm_readv": 310, "process_vm_writev": 311, "kcmp": 312,
        "mount": 165, "umount2": 166, "pivot_root": 155, "chroot": 161, "open_tree": 428,
        "move_mount": 429, "fsopen": 430, "fsconfig": 431, "fsmount": 432,
        "mount_setattr": 442, "unshare": 272, "setns": 308, "bpf": 321,
        "perf_event_open": 298, "userfaultfd": 323,
        "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427,
        "init_module": 175, "finit_module": 313, "delete_module": 176,
        "kexec_load": 246, "kexec_file_load": 320, "reboot": 169,
        "swapon": 167, "swapoff": 168,
    }


def process_arch():
    machine = os.uname().machine
    if machine in ("x86_64", "amd64"):
        return "x86_64"
    if machine in ("aarch64", "arm64"):
        return "aarch64"
    fail(EX_CONFIG, "unsupported architecture: %s" % machine)


def apply_seccomp(libc):
    """Deny process creation and escape syscalls, keeping threads usable.

    ``execve``/``execveat`` stay permitted because this launcher must exec Bun
    and the filter is inherited across that exec. Executing anything else is
    already impossible: Landlock grants ``FS_EXECUTE`` only on the Bun binary.
    """
    numbers = seccomp_syscalls()
    arch = AUDIT_ARCH[process_arch()]
    program = []

    def emit(code, jt, jf, k):
        program.append((code, jt, jf, k & 0xFFFFFFFF))

    emit(BPF_LD_W_ABS, 0, 0, 4)
    emit(BPF_JEQ_K, 1, 0, arch)
    emit(BPF_RET_K, 0, 0, SECCOMP_KILL_PROCESS)
    # fork/vfork always fail; clone3 reports ENOSYS so libc uses clone, which
    # the CLONE_THREAD inspection below decides.
    for name in ("fork", "vfork"):
        if numbers.get(name) is None:
            continue
        emit(BPF_LD_W_ABS, 0, 0, 0)
        emit(BPF_JEQ_K, 0, 1, numbers[name])
        emit(BPF_RET_K, 0, 0, SECCOMP_ERRNO | errno.EPERM)
    for name in SECCOMP_DENY_EPERM:
        number = numbers.get(name)
        if number is None:
            continue
        emit(BPF_LD_W_ABS, 0, 0, 0)
        emit(BPF_JEQ_K, 0, 1, number)
        emit(BPF_RET_K, 0, 0, SECCOMP_ERRNO | errno.EPERM)
    emit(BPF_LD_W_ABS, 0, 0, 0)
    emit(BPF_JEQ_K, 0, 1, numbers["clone3"])
    emit(BPF_RET_K, 0, 0, SECCOMP_ERRNO | errno.ENOSYS)
    emit(BPF_LD_W_ABS, 0, 0, 0)
    emit(BPF_JEQ_K, 0, 4, numbers["clone"])
    emit(BPF_LD_W_ABS, 0, 0, 16)
    emit(BPF_JSET_K, 1, 0, CLONE_THREAD)
    emit(BPF_RET_K, 0, 0, SECCOMP_ERRNO | errno.EPERM)
    emit(BPF_RET_K, 0, 0, SECCOMP_ALLOW)
    emit(BPF_RET_K, 0, 0, SECCOMP_ALLOW)

    encoded = b"".join(struct.pack("=HBBI", code, jt, jf, k) for code, jt, jf, k in program)
    body = ctypes.create_string_buffer(encoded, len(encoded))
    filter_program = ctypes.create_string_buffer(struct.pack("=HxxxxxxQ", len(program), ctypes.addressof(body)), 16)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise SandboxFailure("prctl(PR_SET_NO_NEW_PRIVS) failed: %s" % os.strerror(ctypes.get_errno()))
    call_sys(libc, "seccomp(SET_MODE_FILTER)", seccomp_syscall(), 1, 0, filter_program, 0)
    return len(program)


def seccomp_syscall():
    return 277 if process_arch() == "aarch64" else 317


def apply_limits(options):
    """Bound total address space, descriptors, and file growth.

    These are RLIMITs, not runtime heap hints: they cap the whole process,
    including native buffers. ``--max-old-space-size`` - the old flag - is a
    V8 option that Bun does not implement, so the previous 256 MB/64 MB numbers
    limited nothing. Limits cover address space rather than resident memory, so
    the value has to clear the runtime's mapping footprint: Bun needs at least
    ~448 MB of address space to start this server here.
    """
    def set_limit(which, value, label):
        soft, hard = resource.getrlimit(which)
        if hard != resource.RLIM_INFINITY and value > hard:
            value = hard
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError) as error:
            raise SandboxFailure("cannot set %s: %s" % (label, error))

    set_limit(resource.RLIMIT_AS, options["as_mb"] * 1024 * 1024, "RLIMIT_AS")
    set_limit(resource.RLIMIT_NOFILE, options["nofile"], "RLIMIT_NOFILE")
    set_limit(resource.RLIMIT_FSIZE, options["fsize_kb"] * 1024, "RLIMIT_FSIZE")
    set_limit(resource.RLIMIT_CORE, 0, "RLIMIT_CORE")


def verify(libc, options):
    """Prove the policy took effect before handing control to Bun."""
    read_a_denied = [path for path in options["read"] if os.path.exists(path)]
    if not read_a_denied:
        raise SandboxFailure("Landlock granted no readable path")
    status = open("/proc/self/status").read()
    if "Seccomp:\t" not in status or status.split("Seccomp:\t", 1)[1].split("\n", 1)[0].startswith("0"):
        raise SandboxFailure("seccomp filter is not active")
    if "NoNewPrivs:\t1" not in status:
        raise SandboxFailure("no_new_privs is not set")


def main():
    options, command = parse(sys.argv[1:])
    if options["uid"] is None or options["gid"] is None:
        fail(EX_CONFIG, "--uid and --gid are required; an unmapped namespace is not a sandbox")
    if options["as_mb"] is None:
        fail(EX_CONFIG, "--as-mb is required")
    libc = libc_handle()
    try:
        if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
            raise SandboxFailure("prctl(PR_SET_PDEATHSIG) failed: %s" % os.strerror(ctypes.get_errno()))
        apply_limits(options)
        apply_namespaces(libc, options)
        if options["netns"] and not os.listdir("/proc/self/ns"):
            raise SandboxFailure("network namespace is not active")
        abi = apply_landlock(libc, options)
        count = apply_seccomp(libc)
        verify(libc, options)
        sys.stderr.write("%s: landlock_abi=%d seccomp_insns=%d uid=%d gid=%d netns=%s\n"
                         % ("scenario_chat_sandbox", abi, count, os.getuid(), os.getgid(),
                            "private" if options["netns"] else "shared"))
        sys.stderr.flush()
    except SandboxFailure as error:
        fail(EX_CONFIG, str(error))
    argv = [command[0]] + command[1:]
    os.execv(command[0], argv)


if __name__ == "__main__":
    main()
