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

# The stub directory carries both doubles. Bootstrap cases need a PATH with the
# curl stub but no bun at all, so that scripts/install.sh takes its download path
# instead of reusing a stub Bun.
BUN_STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install-stubs.XXXXXX")/with-bun"
CURL_ONLY_STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install-stubs.XXXXXX")/curl-only"
mkdir -p "$BUN_STUB_DIR" "$CURL_ONLY_STUB_DIR"
cp "$FIXTURES/bun" "$FIXTURES/curl" "$BUN_STUB_DIR/"
cp "$FIXTURES/curl" "$CURL_ONLY_STUB_DIR/"

cleanup() {
  rm -rf "$(dirname "$BUN_STUB_DIR")"
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
  CASE_CURL_LOG="$CASE_DIR/curl.log"
  mkdir -p "$CASE_HOME"
  : >"$CASE_LOG"
  : >"$CASE_CURL_LOG"
  export HOME="$CASE_HOME"
  export PAPERCLIP_INSTALL_TEST_LOG="$CASE_LOG"
  export PAPERCLIP_INSTALL_TEST_CURL_LOG="$CASE_CURL_LOG"
  unset BUN_INSTALL BUN_CONFIG_REGISTRY NPM_CONFIG_REGISTRY npm_config_registry
  unset NPM_CONFIG_USERCONFIG npm_config_userconfig PAPERCLIP_INSTALL_VERSION
  unset PAPERCLIP_INSTALL_CANARY PAPERCLIP_INSTALL_NO_PROMPT PAPERCLIP_INSTALL_NO_ONBOARD
  unset PAPERCLIP_INSTALL_INSTALL_SERVICE PAPERCLIP_INSTALL_DRY_RUN
  unset PAPERCLIP_INSTALL_BUN_REGISTRY PAPERCLIP_INSTALL_TEST_BUN_VERSION
}

# Runs the installer with only the stub Bun directory and coreutils on PATH.
run_installer() {
  PATH="$BUN_STUB_DIR:/usr/bin:/bin" bash "$INSTALLER" "$@"
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
if PATH="$BUN_STUB_DIR:/usr/bin:/bin" bash -s -- --no-onboard <"$INSTALLER" >"$CASE_DIR/out" 2>&1; then
  fail "piped install without --no-prompt is rejected"
else
  pass "piped install without --no-prompt is rejected"
fi
assert_output_has "the piped rejection asks for --no-prompt" 'requires explicit --no-prompt'

new_case "piped-with-consent"
if PATH="$BUN_STUB_DIR:/usr/bin:/bin" bash -s -- --no-prompt --no-onboard <"$INSTALLER" >"$CASE_DIR/out" 2>&1; then
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
# Bun bootstrap: pinned artifact verification against the real SHA-256 pins
# ---------------------------------------------------------------------------
BUN_PLATFORM=""
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) BUN_PLATFORM="linux-x64" ;;
  Linux-arm64|Linux-aarch64) BUN_PLATFORM="linux-aarch64" ;;
esac
if [ -f /etc/alpine-release ] && [ -n "$BUN_PLATFORM" ]; then
  BUN_PLATFORM="$BUN_PLATFORM-musl"
fi
if [ -n "$BUN_PLATFORM" ] && ! grep -qi avx2 /proc/cpuinfo 2>/dev/null; then
  case "$BUN_PLATFORM" in linux-x64*) BUN_PLATFORM="$BUN_PLATFORM-baseline" ;; esac
fi

if [ -z "$BUN_PLATFORM" ]; then
  skip "Bun bootstrap: the artifact pins in install.sh are Linux-only"
else
  FAKE_ROOT="$WORK_DIR/fake-bun"
  mkdir -p "$FAKE_ROOT/package/bin"
  # Stand-in payload; the installer only checks the digest, layout, and version.
  printf '#!/bin/sh\nprintf "1.4.4\\n"\n' >"$FAKE_ROOT/package/bin/bun"
  chmod +x "$FAKE_ROOT/package/bin/bun"
  TAMPERED_ARTIFACT="$WORK_DIR/tampered-$BUN_PLATFORM.tgz"
  tar -czf "$TAMPERED_ARTIFACT" -C "$FAKE_ROOT" package

  new_case "bootstrap-checksum-mismatch"
  export PAPERCLIP_INSTALL_TEST_ARTIFACT="$TAMPERED_ARTIFACT"
  if PATH="$CURL_ONLY_STUB_DIR:/usr/bin:/bin" bash "$INSTALLER" --no-prompt --no-onboard \
    >"$CASE_DIR/out" 2>&1; then
    fail "an artifact that does not match the shipped pin stops the bootstrap"
  else
    pass "an artifact that does not match the shipped pin stops the bootstrap"
  fi
  assert_output_has "the failure is reported as a checksum mismatch" 'checksum mismatch for downloaded artifact'
  if [ -e "$CASE_HOME/.bun/bin/bun" ]; then
    fail "no Bun binary is installed on checksum mismatch"
  else
    pass "no Bun binary is installed on checksum mismatch"
  fi
  assert_log_empty "a checksum mismatch never invokes bun"
  if grep -q "bun-$BUN_PLATFORM-1.4.4.tgz" "$CASE_CURL_LOG"; then
    pass "the installer requested the pinned platform artifact"
  else
    fail "the installer requested the pinned platform artifact"
    sed 's/^/  got: /' "$CASE_CURL_LOG" >&2
  fi
  if grep -q "URL=https://registry.npmjs.org/@oven/bun-$BUN_PLATFORM/-/bun-$BUN_PLATFORM-1.4.4.tgz" \
    "$CASE_CURL_LOG"; then
    pass "the artifact URL is the pinned public-registry location"
  else
    fail "the artifact URL is the pinned public-registry location"
    sed 's/^/  got: /' "$CASE_CURL_LOG" >&2
  fi
  unset PAPERCLIP_INSTALL_TEST_ARTIFACT

  new_case "bootstrap-missing-artifact"
  mkdir -p "$CASE_DIR/missing"
  export PAPERCLIP_INSTALL_TEST_ARTIFACT="$CASE_DIR/missing/absent.tgz"
  if PATH="$CURL_ONLY_STUB_DIR:/usr/bin:/bin" bash "$INSTALLER" --no-prompt --no-onboard \
    >"$CASE_DIR/out" 2>&1; then
    fail "a failed artifact download stops the bootstrap"
  else
    pass "a failed artifact download stops the bootstrap"
  fi
  assert_output_has "the download failure is reported" 'failed to download'
  assert_log_empty "a failed download never invokes bun"
  unset PAPERCLIP_INSTALL_TEST_ARTIFACT

  new_case "bootstrap-without-curl"
  # Build a PATH holding only the tools the bootstrap needs, minus curl and bun,
  # so the installer must fail closed instead of silently skipping verification.
  NO_CURL_BIN="$WORK_DIR/no-curl-bin"
  mkdir -p "$NO_CURL_BIN"
  for tool in awk bash basename cat chmod cp dirname grep head mktemp mv rm sed sha256sum \
    shasum tar tr uname; do
    resolved="$(command -v "$tool" 2>/dev/null || true)"
    if [ -n "$resolved" ]; then
      ln -sf "$resolved" "$NO_CURL_BIN/$tool"
    fi
  done
  if PATH="$NO_CURL_BIN" bash "$INSTALLER" --no-prompt --no-onboard \
    >"$CASE_DIR/out" 2>&1; then
    fail "a missing curl stops the bootstrap"
  else
    pass "a missing curl stops the bootstrap"
  fi
  assert_output_has "the missing curl is named" 'curl is required to bootstrap Bun'
  assert_log_empty "a missing curl never invokes bun"
fi

# ---------------------------------------------------------------------------
# npm bridge for released CLIs (only when npm is genuinely missing)
# ---------------------------------------------------------------------------
# Build a PATH with Bun and coreutils but no npm, matching a machine that has
# never had Node.js installed.
NO_NPM_BIN="$WORK_DIR/no-npm-bin"
mkdir -p "$NO_NPM_BIN"
for tool in awk bash basename cat chmod cp curl dirname env grep head mkdir mktemp \
  mv rm sed sha256sum shasum tar tr uname; do
  resolved="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    ln -sf "$resolved" "$NO_NPM_BIN/$tool"
  fi
done
cp "$FIXTURES/bun" "$NO_NPM_BIN/bun"

if PATH="$NO_NPM_BIN" bash -c 'command -v npm >/dev/null 2>&1'; then
  skip "npm bridge: the reduced PATH still exposes npm"
else
  new_case "npm-bridge-created"
  if PATH="$NO_NPM_BIN" bash "$INSTALLER" --no-prompt --no-onboard \
    >"$CASE_DIR/out" 2>&1; then
    pass "install succeeds with no npm on PATH"
  else
    fail "install succeeds with no npm on PATH"
    sed 's/^/  /' "$CASE_DIR/out" >&2
  fi
  assert_output_has "the npm bridge is reported" 'bridging npm 11\.18\.0 through Bun'
  # The bridge lives beside the Bun the installer selected (the reduced PATH Bun).
  BRIDGE_SH="$NO_NPM_BIN/.paperclip-npm-bridge/npm"
  if [ -f "$BRIDGE_SH" ]; then
    pass "the npm bridge is written next to the pinned Bun"
  else
    fail "the npm bridge is written next to the pinned Bun"
    ls -la "$NO_NPM_BIN" >&2
  fi
  # The bridge must pin the public registry and run npm on Bun, never Node.
  if grep -q -- '--registry=https://registry.npmjs.org' "$BRIDGE_SH"; then
    pass "the npm bridge pins the public registry"
  else
    fail "the npm bridge pins the public registry"
    sed 's/^/  got: /' "$BRIDGE_SH" >&2
  fi
  if grep -q 'x --bun' "$BRIDGE_SH"; then
    pass "the npm bridge runs npm through bun x --bun"
  else
    fail "the npm bridge runs npm through bun x --bun"
    sed 's/^/  got: /' "$BRIDGE_SH" >&2
  fi
  if grep -q 'npm@11\.18\.0' "$BRIDGE_SH"; then
    pass "the npm bridge pins the npm version"
  else
    fail "the npm bridge pins the npm version"
    sed 's/^/  got: /' "$BRIDGE_SH" >&2
  fi
  rm -rf "$NO_NPM_BIN/.paperclip-npm-bridge"

  new_case "npm-present-is-untouched"
  # With npm available the installer must not create or shadow a bridge.
  if PATH="$BUN_STUB_DIR:/usr/bin:/bin" bash -c 'command -v npm >/dev/null 2>&1'; then
    PATH="$BUN_STUB_DIR:/usr/bin:/bin" bash "$INSTALLER" --no-prompt --no-onboard \
      >"$CASE_DIR/out" 2>&1 || fail "install succeeds when npm already exists"
    if [ -e "$BUN_STUB_DIR/.paperclip-npm-bridge/npm" ]; then
      fail "an existing npm is left alone (no bridge created)"
    else
      pass "an existing npm is left alone (no bridge created)"
    fi
    if grep -q 'bridging npm' "$CASE_DIR/out"; then
      fail "an existing npm is not bridged"
    else
      pass "an existing npm is not bridged"
    fi
  else
    skip "an existing npm is left alone: no npm available on this host"
  fi
fi

# ---------------------------------------------------------------------------
# Existing Bun selection
# ---------------------------------------------------------------------------
new_case "newer-bun-is-reused"
if PAPERCLIP_INSTALL_TEST_BUN_VERSION=1.5.0 PATH="$BUN_STUB_DIR:/usr/bin:/bin" \
  bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  pass "a newer Bun is reused instead of re-installing"
else
  fail "a newer Bun is reused instead of re-installing"
  sed 's/^/  /' "$CASE_DIR/out" >&2
fi
assert_output_has "the reused Bun version is logged" 'Using Bun 1\.5\.0'
assert_log_matches "the reused Bun still runs the install" 'paperclipai@latest install --yes$'

new_case "pinned-bun-is-reused"
if PAPERCLIP_INSTALL_TEST_BUN_VERSION=1.4.4 PATH="$BUN_STUB_DIR:/usr/bin:/bin" \
  bash "$INSTALLER" --no-prompt --no-onboard >"$CASE_DIR/out" 2>&1; then
  pass "the exact pinned Bun is reused"
else
  fail "the exact pinned Bun is reused"
fi
assert_output_has "the pinned Bun version is logged" 'Using Bun 1\.4\.4'

new_case "older-bun-triggers-bootstrap"
if PAPERCLIP_INSTALL_TEST_BUN_VERSION=1.0.0 PATH="$BUN_STUB_DIR:/usr/bin:/bin" \
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
