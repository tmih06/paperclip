#!/usr/bin/env bash
set -euo pipefail

umask 077

: "${SCENARIO_CHAT_PUBLIC_ORIGIN:?SCENARIO_CHAT_PUBLIC_ORIGIN is required}"
: "${SCENARIO_CHAT_COMMIT_SHA:?SCENARIO_CHAT_COMMIT_SHA is required}"
: "${SCENARIO_CHAT_PROXY_PORT:?SCENARIO_CHAT_PROXY_PORT is required}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_root="$(cd "$script_dir/.." && pwd)"
workspace_root="$(cd "$package_root/../.." && pwd)"
socket_dir="${SCENARIO_CHAT_SOCKET_DIR:-/tmp/paperclip-scenario-chat-pap-16917}"
socket_path="$socket_dir/scenario-chat.sock"
sandbox="$script_dir/lib/scenario-chat-sandbox.py"

# Address-space cap rather than a V8 heap hint. Bun does not implement
# --max-old-space-size, so the old 256 MB/64 MB numbers bounded nothing. Bun
# maps its JIT and thread stacks up front and needs ~448 MB of address space to
# start the demo server on the reference host, so the cap is set above that
# measured floor. The proxy starts from the same runtime baseline.
SERVER_AS_MB="${SCENARIO_CHAT_SERVER_AS_MB:-512}"
PROXY_AS_MB="${SCENARIO_CHAT_PROXY_AS_MB:-512}"

fail() {
  printf '{"event":"startup_failed","code":"%s","message":"%s"}\n' "$1" "$2" >&2
  exit 1
}

# Bun ignores Node's --permission family, so confinement cannot come from
# runtime flags. It is applied by the launcher through kernel features before
# Bun starts. Every dependency is mandatory: a missing one must fail closed
# rather than leave the demo unconfined.
[[ -r "$sandbox" ]] || fail sandbox_helper_missing "scenario-chat-sandbox.py is not readable"
python_bin="$(command -v python3 || true)"
[[ -n "$python_bin" ]] || fail sandbox_python_missing "python3 is required to apply kernel sandbox policies"
bun_bin="$(command -v bun || true)"
[[ -n "$bun_bin" ]] || fail bun_runtime_missing "bun is required"
bun_bin="$(readlink -f "$bun_bin")"

install -d -m 700 "$socket_dir"
rm -f "$socket_path"

# Shared runtime grants every policy needs: the loader, entropy, /proc and the
# cgroup/cpu files Bun probes at startup.
runtime_reads=(
  --read /usr/lib
  --read /etc/ld.so.cache
  --read /proc/self
  --read /proc/meminfo
  --read /sys/devices/system/cpu
  --read /sys/fs/cgroup
  --read /dev/urandom
  --read /dev/null
  --exec "$bun_bin"
)

server_pid=""
proxy_pid=""
server_status=""
proxy_status=""

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$proxy_pid" ]]; then kill -TERM "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then kill -TERM "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$proxy_pid" ]]; then wait "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$server_pid" ]]; then wait "$server_pid" 2>/dev/null || true; fi
  rm -f "$socket_path"
}
trap cleanup EXIT INT TERM

# The server has no network egress and no inbound TCP at all: it lives in a
# private network namespace whose only interface is a down loopback. The proxy
# stays outside that namespace and reaches the server over the shared unix
# socket, so the socket is the only channel between the two halves.
env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  NODE_ENV=production \
  SCENARIO_CHAT_PUBLIC_ORIGIN="$SCENARIO_CHAT_PUBLIC_ORIGIN" \
  SCENARIO_CHAT_BASE_PATH="${SCENARIO_CHAT_BASE_PATH:-}" \
  SCENARIO_CHAT_COMMIT_SHA="$SCENARIO_CHAT_COMMIT_SHA" \
  SCENARIO_CHAT_ALLOW_INSECURE_HTTP="${SCENARIO_CHAT_ALLOW_INSECURE_HTTP:-}" \
  SCENARIO_CHAT_SOCKET_PATH="$socket_path" \
  "$python_bin" -I -S "$sandbox" \
    --uid 65534 --gid 65534 --netns --deny-tcp \
    --as-mb "$SERVER_AS_MB" --nofile 128 --fsize-kb 2048 \
    "${runtime_reads[@]}" \
    --read "$package_root/dist" \
    --read "$package_root/dist-scenarios" \
    --read "$package_root/node_modules" \
    --read "$package_root/package.json" \
    --read "$package_root/spec/capability/eval-traceability.yaml" \
    --read "$workspace_root/node_modules" \
    --list "$package_root" \
    --list "$workspace_root" \
    --write "$socket_dir" \
    -- "$bun_bin" "$package_root/dist/live/scenario-chat-demo-server.js" &
server_pid=$!

for _ in $(seq 1 200); do
  if [[ -S "$socket_path" ]]; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    # Report the sandbox's own exit status. 78 is the launcher's
    # configuration/permission failure, which includes a host that refuses the
    # mandatory uid mapping.
    if wait "$server_pid"; then server_status=0; else server_status=$?; fi
    server_pid=""
    if [[ "$server_status" == 78 ]]; then
      fail sandbox_unavailable "the kernel sandbox could not be applied"
    fi
    fail server_exited "the demo server exited before its socket was ready"
  fi
  sleep 0.05
done
if [[ ! -S "$socket_path" ]]; then
  fail socket_not_ready "the demo server did not create its socket"
fi

# The proxy is reachable from the tailnet, so it keeps the host network
# namespace but is confined to its own listen port: Landlock denies it every
# other TCP bind and all outbound connections, and seccomp still forbids
# process creation.
env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  NODE_ENV=production \
  SCENARIO_CHAT_PUBLIC_ORIGIN="$SCENARIO_CHAT_PUBLIC_ORIGIN" \
  SCENARIO_CHAT_PROXY_PORT="$SCENARIO_CHAT_PROXY_PORT" \
  SCENARIO_CHAT_PROXY_HOST="${SCENARIO_CHAT_PROXY_HOST:-127.0.0.1}" \
  SCENARIO_CHAT_ALLOW_INSECURE_HTTP="${SCENARIO_CHAT_ALLOW_INSECURE_HTTP:-}" \
  SCENARIO_CHAT_SOCKET_PATH="$socket_path" \
  "$python_bin" -I -S "$sandbox" \
    --uid 65534 --gid 65534 \
    --as-mb "$PROXY_AS_MB" --nofile 128 --fsize-kb 1024 \
    --bind-tcp "$SCENARIO_CHAT_PROXY_PORT" \
    "${runtime_reads[@]}" \
    --read "$package_root/dist/live/scenario-chat-loopback-proxy.js" \
    --read "$package_root/dist/live/scenario-chat-proxy-config.js" \
    --read "$socket_dir" \
    --write "$socket_dir" \
    -- "$bun_bin" "$package_root/dist/live/scenario-chat-loopback-proxy.js" &
proxy_pid=$!

# Supervise both halves explicitly. The previous `wait -n` left the surviving
# process running behind the cleanup trap and reported only a generic
# socket_not_ready, so a sandbox that failed to apply could look like a plain
# startup delay. Now the first exiting child ends the demo and its status is
# the script's status.
set +e
while true; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"; server_status=$?; server_pid=""
    break
  fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    wait "$proxy_pid"; proxy_status=$?; proxy_pid=""
    break
  fi
  sleep 0.1
done
set -e

if [[ -n "$proxy_status" && "$proxy_status" != 0 ]]; then
  fail proxy_exited "the loopback proxy exited with status $proxy_status"
fi
if [[ -n "$server_status" && "$server_status" != 0 ]]; then
  if [[ "$server_status" == 78 ]]; then
    fail sandbox_unavailable "the kernel sandbox could not be applied"
  fi
  fail server_exited "the demo server exited with status $server_status"
fi
exit 0
