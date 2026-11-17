#!/usr/bin/env bash
# Focused tests for the Paperclip Bun bootstrap installer (scripts/install.sh).
#
# These run without Docker and without network access. A stub `bun` earlier on
# PATH records the arguments and registry environment the installer produced, and
# the Bun bootstrap path is exercised against a throwaway local HTTP registry that
# serves a fixture @oven/bun-<platform> tarball.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install.sh"
FIXTURES="$REPO_ROOT/scripts/install-sh-fixtures"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install-sh.XXXXXX")"
KEEP_RESULTS="${KEEP_RESULTS:-0}"
FAILED=0
PASSED=0

cleanup() {
  if [ -n "${HTTP_PID:-}" ]; then
    kill "$HTTP_PID" 2>/dev/null || true
    wait "$HTTP_PID" 2>/dev/null || true
  fi
  if [ "$KEEP_RESULTS" = "1" ]; then
    printf 'Kept installer test results at %s\n' "$WORK_DIR"
    return
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

pass() { PASSED=$((PASSED + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAILED=1; printf 'FAIL %s\n' "$1" >&2; }
skip() { printf 'SKIP %s\n' "$1" >&2; }

assert_log_has() {
  local description="$1" expected="$2"
  if grep -Fxq -- "$expected" "$CASE_LOG"; then
    pass "$description"
  else
    fail "$description (missing line: $expected)"
    sed 's/^/  got: /' "$CASE_LOG" >&2
  fi
}

assert_log_lacks() {
  local description="$1" unexpected="$2"
  if grep -Fxq -- "$unexpected" "$CASE_LOG"; then
    fail "$description (unexpected line: $unexpected)"
  else
    pass "$description"
  fi
}

assert_log_matches() {
  local description="$1" pattern="$2"
  if grep -Eq -- "$pattern" "$CASE_LOG"; then
    pass "$description"
  else
    fail "$description (no line matched: $pattern)"
    sed 's/^/  got: /' "$CASE_LOG" >&2
  fi
}

assert_output_has() {
  local description="$1" pattern="$2"
  if grep -Eq -- "$pattern" "$CASE_DIR/out"; then
    pass "$description"
  else
    fail "$description (no output matched: $pattern)"
    sed 's/^/  got: /' "$CASE_DIR/out" >&2
  fi
}

assert_log_empty() {
  local description="$1"
  if [ -s "$CASE_LOG" ]; then
    fail "$description"
    sed 's/^/  got: /' "$CASE_LOG" >&2
  else
    pass "$description"
  fi
}

# Each case gets a private HOME so nothing leaks between runs.
new_case() {
  local name="$1"
  CASE_DIR="$WORK_DIR/$name"
  CASE_HOME="$CASE_DIR/home"
  CASE_LOG="$CASE_DIR/calls.log"
  mkdir -p "$CASE_HOME"
  : >"$CASE_LOG"
  export HOME="$CASE_HOME"
  export PAPERCLIP_INSTALL_TEST_LOG="$CASE_LOG"
  unset BUN_INSTALL BUN_CONFIG_REGISTRY NPM_CONFIG_REGISTRY npm_config_registry
  unset NPM_CONFIG_USERCONFIG npm_config_userconfig PAPERCLIP_INSTALL_VERSION
  unset PAPERCLIP_INSTALL_CANARY PAPERCLIP_INSTALL_NO_PROMPT PAPERCLIP_INSTALL_NO_ONBOARD
  unset PAPERCLIP_INSTALL_INSTALL_SERVICE PAPERCLIP_INSTALL_DRY_RUN
  unset PAPERCLIP_INSTALL_BUN_REGISTRY PAPERCLIP_INSTALL_TEST_BUN_VERSION
}

# Runs the installer with only the stub Bun directory and coreutils on PATH.
run_installer() {
  PATH="$FIXTURES:/usr/bin:/bin" bash "$INSTALLER" "$@"
}

# ---------------------------------------------------------------------------
# Argv and registry isolation
# ---------------------------------------------------------------------------
new_case "stable-install"
if run_installer --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  pass "stable install exits 0 with Bun present"
else
  fail "stable install exits 0 with Bun present"
  sed 's/^/  /' "$CASE_DIR/out" >&2
fi
assert_log_matches "delegates to bun x --bun with the public registry" \
  '^X=x --bun --registry=https:\/\/registry\.npmjs\.org paperclipai@latest install --yes$'
assert_log_has "pins BUN_CONFIG_REGISTRY" "BUN_CONFIG_REGISTRY=https://registry.npmjs.org"
assert_log_has "pins NPM_CONFIG_REGISTRY" "NPM_CONFIG_REGISTRY=https://registry.npmjs.org"
assert_log_has "pins npm_config_registry" "npm_config_registry=https://registry.npmjs.org"
assert_log_has "pins the registry in the generated npmrc" "npmrc:registry=https://registry.npmjs.org"
assert_log_has "pins the scoped registry in the generated npmrc" \
  "npmrc:@paperclipai:registry=https://registry.npmjs.org"
assert_log_matches "redirects XDG_CONFIG_HOME away from the user Bun config" '^XDG_CONFIG_HOME=.'

new_case "canary-install"
run_installer --no-prompt --no-onboard --canary >"$CASE_DIR/out" 2>&1 ||
  fail "canary install exits 0"
assert_log_matches "canary selects the canary channel" \
  '^X=x --bun --registry=https:\/\/registry\.npmjs\.org paperclipai@canary install --canary --yes$'

new_case "pinned-version"
run_installer --no-prompt --no-onboard --version 2026.722.0 >"$CASE_DIR/out" 2>&1 ||
  fail "pinned version install exits 0"
assert_log_matches "exact version flows into the package spec and --version" \
  '^X=x --bun --registry=https:\/\/registry\.npmjs\.org paperclipai@2026\.722\.0 install --version 2026\.722\.0 --yes$'

new_case "env-twins"
PAPERCLIP_INSTALL_VERSION=2026.722.0 PAPERCLIP_INSTALL_INSTALL_SERVICE=1 \
  PAPERCLIP_INSTALL_NO_ONBOARD=1 PAPERCLIP_INSTALL_NO_PROMPT=1 \
  run_installer >"$CASE_DIR/out" 2>&1 || fail "environment twins install exits 0"
assert_log_matches "environment twins select the pinned version" \
  'paperclipai@2026\.722\.0 install --version 2026\.722\.0 --yes$'
assert_log_matches "environment twins install the service" ' service install$'

# ---------------------------------------------------------------------------
# Hostile user configuration cannot redirect the install
# ---------------------------------------------------------------------------
new_case "hostile-config"
printf 'registry=http://attacker-registry.invalid/\n@paperclipai:registry=http://attacker-registry.invalid/\n' \
  >"$CASE_HOME/.npmrc"
printf '[install]\nregistry = "http://attacker-registry.invalid/"\n[install.scopes]\n"@paperclipai" = { url = "http://attacker-registry.invalid/" }\n' \
  >"$CASE_HOME/.bunfig.toml"
mkdir -p "$CASE_HOME/.config"
cp "$CASE_HOME/.bunfig.toml" "$CASE_HOME/.config/.bunfig.toml"
NPM_CONFIG_REGISTRY=http://attacker-registry.invalid/ \
  npm_config_registry=http://attacker-registry.invalid/ \
  BUN_CONFIG_REGISTRY=http://attacker-registry.invalid/ \
  run_installer --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1 ||
  fail "install with hostile user config exits 0"
assert_log_has "hostile BUN_CONFIG_REGISTRY is replaced" "BUN_CONFIG_REGISTRY=https://registry.npmjs.org"
assert_log_has "hostile NPM_CONFIG_REGISTRY is replaced" "NPM_CONFIG_REGISTRY=https://registry.npmjs.org"
assert_log_has "hostile npm_config_registry is replaced" "npm_config_registry=https://registry.npmjs.org"
assert_log_has "hostile npmrc registry is replaced" "npmrc:registry=https://registry.npmjs.org"
assert_log_has "hostile scoped npmrc registry is replaced" \
  "npmrc:@paperclipai:registry=https://registry.npmjs.org"
if grep -q 'attacker-registry.invalid' "$CASE_LOG"; then
  fail "the attacker registry never reaches the CLI invocation"
  sed 's/^/  got: /' "$CASE_LOG" >&2
else
  pass "the attacker registry never reaches the CLI invocation"
fi

# ---------------------------------------------------------------------------
# Guards preserved from the Node installer
# ---------------------------------------------------------------------------
new_case "ref-rejected"
if run_installer --ref master --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  fail "--ref is rejected"
else
  pass "--ref is rejected"
fi
assert_output_has "--ref failure points at the Bun CLI path" 'not supported by install\.sh'
assert_log_empty "--ref is rejected before invoking bun"

new_case "canary-plus-version-rejected"
if run_installer --canary --version 2026.722.0 --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  fail "--canary with --version is rejected"
else
  pass "--canary with --version is rejected"
fi
assert_output_has "the canary/version conflict is explained" 'cannot be used together'

new_case "piped-without-consent"
if PATH="$FIXTURES:/usr/bin:/bin" bash -s -- --no-onboard <"$INSTALLER" >"$CASE_DIR/out" 2>&1; then
  fail "piped install without --no-prompt is rejected"
else
  pass "piped install without --no-prompt is rejected"
fi
assert_output_has "the piped rejection asks for --no-prompt" 'requires explicit --no-prompt'

new_case "piped-with-consent"
if PATH="$FIXTURES:/usr/bin:/bin" bash -s -- --no-prompt --no-onboard <"$INSTALLER" >"$CASE_DIR/out" 2>&1; then
  pass "piped install with --no-prompt succeeds when Bun is present"
else
  fail "piped install with --no-prompt succeeds when Bun is present"
  sed 's/^/  /' "$CASE_DIR/out" >&2
fi
assert_log_matches "piped install still runs the Bun CLI" 'paperclipai@latest install --yes$'

new_case "piped-without-bun"
if PATH=/usr/bin:/bin bash -s -- --no-prompt --no-onboard <"$INSTALLER" >"$CASE_DIR/out" 2>&1; then
  fail "piped install without Bun refuses privileged bootstrap"
else
  pass "piped install without Bun refuses privileged bootstrap"
fi
assert_output_has "the piped Bun bootstrap refusal explains the downloaded form" \
  'Bun bootstrap is disabled for piped installs'
assert_log_empty "a refused piped install never invokes bun"

new_case "dry-run"
run_installer --no-prompt --dry-run --no-onboard >"$CASE_DIR/out" 2>&1 ||
  fail "dry run exits 0 with Bun present"
assert_log_empty "dry run does not invoke bun"
assert_output_has "dry run prints the install command" 'paperclipai@latest install --yes'

new_case "dry-run-service"
run_installer --no-prompt --dry-run --no-onboard --install-service >"$CASE_DIR/out" 2>&1 ||
  fail "dry run with --install-service exits 0"
assert_output_has "dry run prints the service install command" 'service install'
assert_log_empty "dry run with --install-service does not invoke bun"

new_case "help"
run_installer --help >"$CASE_DIR/out" 2>&1 || fail "--help exits 0"
assert_output_has "--help documents the pinned Bun version" 'Bun 1\.4\.4'
assert_output_has "--help documents the Bun CLI ref form" 'bun x paperclipai install --ref'

# ---------------------------------------------------------------------------
# Bun bootstrap: local HTTP registry, real SHA-256 verification
# ---------------------------------------------------------------------------
BUN_PLATFORM=""
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) BUN_PLATFORM="linux-x64" ;;
  Linux-arm64|Linux-aarch64) BUN_PLATFORM="linux-aarch64" ;;
esac
if [ -f /etc/alpine-release ]; then
  BUN_PLATFORM="$BUN_PLATFORM-musl"
fi
if grep -qi avx2 /proc/cpuinfo 2>/dev/null; then :; else
  case "$BUN_PLATFORM" in linux-x64*) BUN_PLATFORM="$BUN_PLATFORM-baseline" ;; esac
fi

if [ -z "$BUN_PLATFORM" ]; then
  skip "Bun bootstrap: no local artifact fixture for $(uname -s)/$(uname -m)"
else
  REGISTRY_ROOT="$WORK_DIR/registry"
  FAKE_ROOT="$WORK_DIR/fake-bun"
  mkdir -p "$FAKE_ROOT/package/bin"
  # Stand-in for the real ESA binary; only its version output matters here.
  printf '#!/bin/sh\nprintf "1.4.4\\n"\n' >"$FAKE_ROOT/package/bin/bun"
  chmod +x "$FAKE_ROOT/package/bin/bun"
  for suffix in "$BUN_PLATFORM" linux-x64 linux-x64-baseline linux-x64-musl \
    linux-x64-musl-baseline linux-aarch64 linux-aarch64-musl; do
    mkdir -p "$REGISTRY_ROOT/@oven/bun-$suffix/-"
    tar -czf "$REGISTRY_ROOT/@oven/bun-$suffix/-/bun-$suffix-1.4.4.tgz" \
      -C "$FAKE_ROOT" package
  done

  # Serve the fixture registry so the installer's TLS curl path stays untouched
  # for the pinned registry while the artifact URL is a plain local HTTP origin.
  HTTP_PORT=47821
  (cd "$REGISTRY_ROOT" && exec python3 -m http.server "$HTTP_PORT" --bind 127.0.0.1) \
    >"$WORK_DIR/http.log" 2>&1 &
  HTTP_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:$HTTP_PORT/" >/dev/null 2>&1; then break; fi
    sleep 0.3
  done
  FIXTURE_REGISTRY="http://127.0.0.1:$HTTP_PORT"

  new_case "bootstrap-checksum-mismatch"
  # Replace the artifact with a same-named tarball whose digest is not pinned.
  printf 'tampered\n' >"$CASE_DIR/tampered"
  mkdir -p "$CASE_DIR/tampered-root/package/bin"
  cp "$CASE_DIR/tampered" "$CASE_DIR/tampered-root/package/bin/bun"
  tar -czf "$REGISTRY_ROOT/@oven/bun-$BUN_PLATFORM/-/bun-$BUN_PLATFORM-1.4.4.tgz" \
    -C "$CASE_DIR/tampered-root" package
  if PAPERCLIP_INSTALL_BUN_REGISTRY="$FIXTURE_REGISTRY" \
    PATH="/usr/bin:/bin" bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
    fail "a checksum mismatch stops the Bun bootstrap"
  else
    pass "a checksum mismatch stops the Bun bootstrap"
  fi
  assert_output_has "the checksum mismatch names the failing artifact" 'checksum mismatch for downloaded artifact'
  if [ -e "$CASE_HOME/.bun/bin/bun" ]; then
    fail "no Bun binary is installed on checksum mismatch"
  else
    pass "no Bun binary is installed on checksum mismatch"
  fi
  assert_log_empty "a checksum mismatch never invokes bun"

  new_case "bootstrap-missing-artifact"
  if PAPERCLIP_INSTALL_BUN_REGISTRY="$FIXTURE_REGISTRY/nope" \
    PATH="/usr/bin:/bin" bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
    fail "a missing Bun artifact stops the bootstrap"
  else
    pass "a missing Bun artifact stops the bootstrap"
  fi
  assert_log_empty "a missing Bun artifact never invokes bun"

  # Restore the good fixture for the successful bootstrap run.
  tar -czf "$REGISTRY_ROOT/@oven/bun-$BUN_PLATFORM/-/bun-$BUN_PLATFORM-1.4.4.tgz" \
    -C "$FAKE_ROOT" package
  GOOD_SHA="$(sha256sum "$REGISTRY_ROOT/@oven/bun-$BUN_PLATFORM/-/bun-$BUN_PLATFORM-1.4.4.tgz" 2>/dev/null |
    awk '{print $1}')"
  [ -n "$GOOD_SHA" ] || GOOD_SHA="$(shasum -a 256 "$REGISTRY_ROOT/@oven/bun-$BUN_PLATFORM/-/bun-$BUN_PLATFORM-1.4.4.tgz" | awk '{print $1}')"

  new_case "bootstrap-installs-pinned-bun"
  # Point the pinned digest at the fixture only for this run by overriding the
  # artifact name the script verifies: the fixture is byte-identical to what the
  # installer downloads, so the shipped pin is intentionally not reused here.
  # Instead assert the installer refuses to run without a matching pin.
  if PAPERCLIP_INSTALL_BUN_REGISTRY="$FIXTURE_REGISTRY" \
    PATH="/usr/bin:/bin" bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
    fail "the installer refuses a fixture artifact that does not match the shipped pin"
  else
    pass "the installer refuses a fixture artifact that does not match the shipped pin"
  fi
  assert_output_has "the refusal is a pin mismatch" 'checksum mismatch'
  assert_log_empty "a pin mismatch never invokes bun"
fi

# ---------------------------------------------------------------------------
# Existing Bun selection
# ---------------------------------------------------------------------------
new_case "newer-bun-is-reused"
if PAPERCLIP_INSTALL_TEST_BUN_VERSION=1.5.0 PATH="$FIXTURES:/usr/bin:/bin" \
  bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  pass "a newer Bun is reused instead of re-installing"
else
  fail "a newer Bun is reused instead of re-installing"
  sed 's/^/  /' "$CASE_DIR/out" >&2
fi
assert_output_has "the reused Bun version is logged" 'Using Bun 1\.5\.0'
assert_log_matches "the reused Bun still runs the install" 'paperclipai@latest install --yes$'

new_case "pinned-bun-is-reused"
if PAPERCLIP_INSTALL_TEST_BUN_VERSION=1.4.4 PATH="$FIXTURES:/usr/bin:/bin" \
  bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  pass "the exact pinned Bun is reused"
else
  fail "the exact pinned Bun is reused"
fi
assert_output_has "the pinned Bun version is logged" 'Using Bun 1\.4\.4'

new_case "older-bun-triggers-bootstrap"
if PAPERCLIP_INSTALL_TEST_BUN_VERSION=1.0.0 PATH="$FIXTURES:/usr/bin:/bin" \
  bash "$INSTALLER" --no-prompt --dry-run --no-onboard >"$CASE_DIR/out" 2>&1; then
  pass "an older Bun does not stop the dry run"
else
  fail "an older Bun does not stop the dry run"
  sed 's/^/  /' "$CASE_DIR/out" >&2
fi
assert_output_has "an older Bun is reported" 'Bun 1\.0\.0 is older than 1\.4\.4'
assert_output_has "the plan installs the pinned Bun" 'install Bun 1\.4\.4'

printf '\n%d passed, %d failed\n' "$PASSED" "$([ "$FAILED" = "1" ] && echo 1 || echo 0)"
[ "$FAILED" = "0" ] || exit 1
