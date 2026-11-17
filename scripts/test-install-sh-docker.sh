#!/usr/bin/env bash
# Installer checks that need a real container: shellcheck, a genuinely Node-less
# machine, and the real pinned Bun artifact.
#
# The offline argument/env/isolation assertions live in scripts/test-install-sh.sh
# (no Docker, no network). This script covers only what those cannot:
#   - shellcheck over the installer and its fixtures
#   - earning Bun from nothing on a machine with no Node.js, npm, or Bun
#   - the released CLI completing a managed install through the npm bridge
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install-sh.XXXXXX")"
KEEP_RESULTS="${KEEP_RESULTS:-0}"
# The Node-less container is Ubuntu-only; override to run elsewhere.
BASE_IMAGE="${PAPERCLIP_INSTALL_TEST_IMAGE:-ubuntu:24.04}"

cleanup() {
  if [ "$KEEP_RESULTS" = "1" ]; then
    printf 'Kept installer test results at %s\n' "$RESULTS_DIR"
    return
  fi
  rm -rf "$RESULTS_DIR"
}

trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  echo "docker is required" >&2
  exit 1
}

assert_line() {
  local file="$1"
  local expected="$2"
  grep -Fx -- "$expected" "$file" >/dev/null || {
    printf 'Expected %q in %s\n' "$expected" "$file" >&2
    tail -40 "$file" >&2
    exit 1
  }
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -F -- "$expected" "$file" >/dev/null || {
    printf 'Expected %q in %s\n' "$expected" "$file" >&2
    tail -40 "$file" >&2
    exit 1
  }
}

echo "==> shellcheck"
docker run --rm \
  -v "$REPO_ROOT:/work:ro" \
  -w /work \
  koalaman/shellcheck:stable \
  scripts/install.sh \
  scripts/test-install-sh.sh \
  scripts/install-sh-fixtures/bun \
  scripts/install-sh-fixtures/curl

echo "==> offline installer suite (host)"
bash "$REPO_ROOT/scripts/test-install-sh.sh"

echo "==> dependency-free machine: no node, npm, bun, unzip, or python"
docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -v "$RESULTS_DIR:/results" \
  "$BASE_IMAGE" \
  bash -c '
    set -euo pipefail
    apt-get update >/dev/null 2>&1
    apt-get install -y ca-certificates curl >/dev/null 2>&1
    for tool in node npm npx bun unzip python3 corepack; do
      if command -v "$tool" >/dev/null 2>&1; then
        echo "unexpected $tool on the base image" >&2
        exit 1
      fi
    done
    mkdir -p /home/test
    export HOME=/home/test
    timeout 600 bash /paperclip-scripts/install.sh --no-prompt --no-onboard >/results/install.out 2>&1
    echo "install-exit=$?" >>/results/install.out
    # The managed shim must run the CLI on Bun with no Node.js anywhere.
    /home/test/.local/bin/paperclipai --version >/results/shim.out 2>&1
    command -v node >/dev/null 2>&1 && echo "node appeared" >&2 && exit 1
    command -v npm >/dev/null 2>&1 && echo "npm appeared on the default PATH" >&2 && exit 1
    true
  '
assert_contains "$RESULTS_DIR/install.out" "[paperclip] Installed Bun 1.4.4"
assert_contains "$RESULTS_DIR/install.out" "install-exit=0"
assert_contains "$RESULTS_DIR/install.out" "npm is not installed; bridging npm 11.18.0 through Bun"
assert_contains "$RESULTS_DIR/install.out" "Installed paperclipai"
assert_line "$RESULTS_DIR/shim.out" "$(grep -o '^[0-9][^(]*' "$RESULTS_DIR/shim.out" | head -1)"

echo "==> piped install without Bun refuses the bootstrap"
if docker run --rm \
  -v "$REPO_ROOT/scripts:/paperclip-scripts:ro" \
  -e PATH=/usr/local/bin:/usr/bin:/bin \
  "$BASE_IMAGE" \
  bash -c 'cat /paperclip-scripts/install.sh | bash -s -- --no-prompt --no-onboard' \
  >"$RESULTS_DIR/piped-no-bun.out" 2>&1; then
  echo "Expected a piped install without Bun to fail before bootstrap" >&2
  exit 1
fi
assert_line "$RESULTS_DIR/piped-no-bun.out" \
  "[paperclip] error: Bun bootstrap is disabled for piped installs; download install.sh, review it, and run 'bash install.sh --no-prompt'"

echo "Installer Docker checks passed."
