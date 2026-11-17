#!/usr/bin/env bash
set -euo pipefail

# Pinned Bun release used to bootstrap Paperclip. The install path is: use a Bun
# already on the machine when it is at least this version, otherwise download the
# pinned artifact from the public registry and verify it against the SHA-256 pins
# in bun_artifact_sha256 before executing anything.
BUN_VERSION="1.4.4"
PAPERCLIP_PACKAGE="paperclipai"
PUBLIC_NPM_REGISTRY="https://registry.npmjs.org"
BUN_ARTIFACT_REGISTRY="${PAPERCLIP_INSTALL_BUN_REGISTRY:-$PUBLIC_NPM_REGISTRY}"

CANARY=0
VERSION=""
REF=""
REPO=""
NO_ONBOARD=0
NO_PROMPT=0
INSTALL_SERVICE=0
DRY_RUN=0
VERBOSE=0
TEMP_DIR=""
PIPED_INSTALL=0

if [ -z "${BASH_SOURCE[0]:-}" ] || [ ! -f "${BASH_SOURCE[0]}" ]; then
  PIPED_INSTALL=1
fi

usage() {
  cat <<EOF
Install Paperclip on macOS, Linux, or WSL2.

Usage:
  curl -fsSLO https://paperclip.ing/install.sh
  bash install.sh [options]
  curl -fsSL https://paperclip.ing/install.sh | bash -s -- --no-prompt [options]

Options:
  --canary                 Install the canary channel
  --version <version>      Install an exact published version
  --no-onboard             Do not start onboarding after installation
  --no-prompt              Run non-interactively
  --install-service        Install the per-user Paperclip service
  --dry-run                Print the install plan without changing files
  --verbose                Enable verbose installer output
  -h, --help               Show this help

Every option also has a PAPERCLIP_INSTALL_* environment equivalent, for example
PAPERCLIP_INSTALL_VERSION=2026.722.0 and PAPERCLIP_INSTALL_NO_PROMPT=1.

Paperclip runs on Bun ${BUN_VERSION} or newer. Pinned Bun ${BUN_VERSION} is installed into
~/.bun/bin when no suitable Bun is available; the download is verified against a
SHA-256 pin and needs no elevated privileges. Node.js is not required to install
or run Paperclip, though external agent providers may need it.

To install from a git branch, tag, or commit, use the Paperclip CLI directly:
bun x paperclipai install --ref <ref>
EOF
}

log() {
  printf '[paperclip] %s\n' "$*"
}

fail() {
  printf '[paperclip] error: %s\n' "$*" >&2
  exit 1
}

parse_bool() {
  local name="$1"
  local value="${2:-}"

  # ${value,,} requires bash 4; macOS ships bash 3.2, so lowercase portably.
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    ""|0|false|no|off) printf '0' ;;
    1|true|yes|on) printf '1' ;;
    *) fail "$name must be one of: 1, 0, true, false, yes, no, on, off" ;;
  esac
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [ -n "$value" ] || fail "$option requires a value"
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

CANARY="$(parse_bool PAPERCLIP_INSTALL_CANARY "${PAPERCLIP_INSTALL_CANARY:-}")"
VERSION="${PAPERCLIP_INSTALL_VERSION:-}"
REF="${PAPERCLIP_INSTALL_REF:-}"
REPO="${PAPERCLIP_INSTALL_REPO:-}"
NO_ONBOARD="$(parse_bool PAPERCLIP_INSTALL_NO_ONBOARD "${PAPERCLIP_INSTALL_NO_ONBOARD:-}")"
NO_PROMPT="$(parse_bool PAPERCLIP_INSTALL_NO_PROMPT "${PAPERCLIP_INSTALL_NO_PROMPT:-}")"
INSTALL_SERVICE="$(parse_bool PAPERCLIP_INSTALL_INSTALL_SERVICE "${PAPERCLIP_INSTALL_INSTALL_SERVICE:-}")"
DRY_RUN="$(parse_bool PAPERCLIP_INSTALL_DRY_RUN "${PAPERCLIP_INSTALL_DRY_RUN:-}")"
VERBOSE="$(parse_bool PAPERCLIP_INSTALL_VERBOSE "${PAPERCLIP_INSTALL_VERBOSE:-}")"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --canary)
      CANARY=1
      shift
      ;;
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --ref)
      require_value "$1" "${2:-}"
      REF="$2"
      shift 2
      ;;
    --repo)
      require_value "$1" "${2:-}"
      REPO="$2"
      shift 2
      ;;
    --no-onboard)
      NO_ONBOARD=1
      shift
      ;;
    --no-prompt)
      NO_PROMPT=1
      shift
      ;;
    --install-service)
      INSTALL_SERVICE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ "$#" -eq 0 ] || fail "unexpected argument: $1"

if [ "$CANARY" = "1" ] && [ -n "$VERSION" ]; then
  fail "--canary and --version cannot be used together"
fi

if [ -n "$REF" ] || [ -n "$REPO" ]; then
  fail "git-ref installs are not supported by install.sh; run 'bun x paperclipai install --ref <ref>' instead"
fi

if { [ ! -t 0 ] || [ ! -t 1 ]; } && [ "$NO_PROMPT" != "1" ]; then
  fail "non-interactive installation requires explicit --no-prompt; download the script first for interactive review"
fi

if [ "$VERBOSE" = "1" ]; then
  set -x
fi

OS="$(uname -s 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"

case "$OS" in
  Darwin) OS_NAME="macos" ;;
  Linux) OS_NAME="linux" ;;
  *) fail "unsupported operating system: ${OS:-unknown}. Use macOS, Linux, or WSL2." ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) fail "unsupported architecture: ${ARCH:-unknown}. Supported architectures: x64, arm64." ;;
esac

log "Detected $OS_NAME/$ARCH_NAME"

if [ -n "${HOME:-}" ]; then
  BUN_DIR="${BUN_INSTALL:-$HOME/.bun}"
else
  BUN_DIR="${BUN_INSTALL:-}"
fi

bun_version() {
  "$1" --version 2>/dev/null | head -n 1 | tr -d '[:space:]'
}

# Succeeds when version $1 is greater than or equal to version $2.
version_at_least() {
  local have major_a minor_a patch_a major_b minor_b patch_b
  have="${1#v}"
  have="${have%%-*}"
  IFS=. read -r major_a minor_a patch_a <<<"$have"
  IFS=. read -r major_b minor_b patch_b <<<"${2#v}"
  [[ "$major_a" =~ ^[0-9]+$ && "$minor_a" =~ ^[0-9]+$ && "$patch_a" =~ ^[0-9]+$ ]] || return 1
  if [ "$major_a" -ne "$major_b" ]; then
    [ "$major_a" -gt "$major_b" ]
    return
  fi
  if [ "$minor_a" -ne "$minor_b" ]; then
    [ "$minor_a" -gt "$minor_b" ]
    return
  fi
  [ "$patch_a" -ge "$patch_b" ]
}

cpu_supports_avx2() {
  case "$OS_NAME" in
    macos) sysctl -a 2>/dev/null | grep machdep.cpu | grep -qi 'avx2' ;;
    *) grep -qi 'avx2' /proc/cpuinfo 2>/dev/null ;;
  esac
}

running_under_rosetta() {
  [ "$OS_NAME" = "macos" ] || return 1
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]
}

# Prints the @oven/bun-<platform> package suffix for this machine.
detect_bun_platform() {
  local platform
  case "$OS_NAME-$ARCH_NAME" in
    macos-x64) platform="darwin-x64" ;;
    macos-arm64) platform="darwin-aarch64" ;;
    linux-x64) platform="linux-x64" ;;
    linux-arm64) platform="linux-aarch64" ;;
    *) fail "unsupported platform: $OS_NAME/$ARCH_NAME" ;;
  esac

  if [ "$platform" = "darwin-x64" ] && running_under_rosetta; then
    log "Rosetta 2 detected; installing the native arm64 Bun build"
    platform="darwin-aarch64"
  fi

  if [ "$OS_NAME" = "linux" ] && [ -f /etc/alpine-release ]; then
    platform="$platform-musl"
  fi

  # Bun publishes a -baseline build for x64 hosts without AVX2.
  case "$platform" in
    darwin-x64|linux-x64*)
      cpu_supports_avx2 || platform="$platform-baseline"
      ;;
  esac

  printf '%s' "$platform"
}

# SHA-256 pins reviewed from the @oven/bun-<platform>@${BUN_VERSION} artifacts on
# the public registry. The installer refuses any artifact whose digest differs
# from the pin shipped in this script, so a changed or substituted artifact stops
# the install instead of running.
bun_artifact_sha256() {
  case "$1" in
    darwin-aarch64) printf '%s' "be5f17d636d699b2eaa2c1a8ac802c87f0815ccb5fe26cbe63d2395354ae5d0d" ;;
    darwin-x64) printf '%s' "b26de5639edc6f7fbe99c6dcf8016eaa75c5b86cccfe83db30aa04bbeade8f7e" ;;
    darwin-x64-baseline) printf '%s' "1f4b4d1fa9e3b1dcb7890e4594703c7d5fac54c950964d89a2770760bc2cacbd" ;;
    linux-x64) printf '%s' "93ca5a2abe45f3bcac6dd55baff8bb06c4ac824b70f89650b54e5c8b80dbef18" ;;
    linux-x64-baseline) printf '%s' "2ce69fadd00b741513c52adb8aad3fbee93170d0abaa3b6d04df47ca8659bd40" ;;
    linux-x64-musl) printf '%s' "284a0bfe9bd624d54c0f20e31521b26deb5c04a2c927dc2804fecd49339a948a" ;;
    linux-x64-musl-baseline) printf '%s' "78e8b76d9ff6dde99aa7709993bac7d0c32590da6e04d053285bbf0cb5f05892" ;;
    linux-aarch64) printf '%s' "ab95e7e692a53d25a1baa98ee395a17f5f264aedfb3cb15811432d54142f70eb" ;;
    linux-aarch64-musl) printf '%s' "20b64dd9e5364e80fc965bed24a052bd21d3ffcd169af720988063c17d275edd" ;;
    *) fail "no pinned Bun $BUN_VERSION artifact for platform $1" ;;
  esac
}

bun_artifact_url() {
  printf '%s/@oven/bun-%s/-/bun-%s-%s.tgz' "$BUN_ARTIFACT_REGISTRY" "$1" "$1" "$BUN_VERSION"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required to verify downloaded artifacts"
  fi
}

print_command() {
  printf '[paperclip] +'
  printf ' %q' "$@"
  printf '\n'
}

ensure_temp_dir() {
  if [ -z "$TEMP_DIR" ]; then
    TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install.XXXXXX")"
  fi
}

download_verified_artifact() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  local actual_sha256

  [ -n "$expected_sha256" ] || fail "no pinned checksum for downloaded artifact: $url"
  command -v curl >/dev/null 2>&1 || fail "curl is required to bootstrap Bun"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$destination" || fail "failed to download $url"
  [ -s "$destination" ] || fail "downloaded artifact is empty: $url"
  actual_sha256="$(sha256_of "$destination")"
  [ "$actual_sha256" = "$expected_sha256" ] ||
    fail "checksum mismatch for downloaded artifact: $url (expected $expected_sha256, got $actual_sha256)"
}

install_bun() {
  local platform="$1"
  local archive="$TEMP_DIR/bun-$platform.tgz"
  local extract_dir="$TEMP_DIR/bun-$platform"
  local staged_binary="$BUN_DIR/bin/.bun.tmp.$$"
  local installed_version

  command -v tar >/dev/null 2>&1 || fail "tar is required to bootstrap Bun"
  log "Installing Bun $BUN_VERSION for $platform"
  download_verified_artifact "$(bun_artifact_url "$platform")" "$archive" "$(bun_artifact_sha256 "$platform")"

  mkdir -p "$extract_dir"
  tar -xzf "$archive" -C "$extract_dir" || fail "failed to extract the Bun $BUN_VERSION artifact"
  [ -f "$extract_dir/package/bin/bun" ] || fail "the Bun $BUN_VERSION artifact did not contain package/bin/bun"

  mkdir -p "$BUN_DIR/bin"
  cp "$extract_dir/package/bin/bun" "$staged_binary"
  chmod 0755 "$staged_binary"
  # Atomic replace: a partially written download can never be left on PATH.
  mv "$staged_binary" "$BUN_DIR/bin/bun"

  installed_version="$(bun_version "$BUN_DIR/bin/bun")"
  [ "$installed_version" = "$BUN_VERSION" ] ||
    fail "installed Bun reported ${installed_version:-no version}; expected $BUN_VERSION"
  log "Installed Bun $installed_version at $BUN_DIR/bin/bun"
}

# Prints the usable Bun (>= BUN_VERSION) to use, preferring the installer's own
# ~/.bun/bin so repeated installs stay on the pinned runtime.
find_usable_bun() {
  local candidate version candidates
  on_path="$(command -v bun 2>/dev/null || true)"
  # An unset HOME leaves BUN_DIR empty, so never probe a bare "/bin/bun".
  if [ -n "$BUN_DIR" ]; then
    candidates=("$BUN_DIR/bin/bun")
  else
    candidates=()
  fi
  if [ -n "$on_path" ]; then
    candidates+=("$on_path")
  fi
  for candidate in ${candidates[@]+"${candidates[@]}"}; do
    if [ ! -x "$candidate" ]; then
      continue
    fi
    version="$(bun_version "$candidate")"
    if version_at_least "$version" "$BUN_VERSION"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

PLATFORM="$(detect_bun_platform)"
ORIGINAL_PATH="${PATH:-}"

if BUN_BIN="$(find_usable_bun)"; then
  log "Using Bun $(bun_version "$BUN_BIN") at $BUN_BIN"
elif [ "$DRY_RUN" = "1" ]; then
  if [ -z "$BUN_DIR" ]; then
    fail "HOME is not set; cannot plan the Bun $BUN_VERSION installation directory"
  fi
  if command -v bun >/dev/null 2>&1; then
    log "Bun $(bun_version "$(command -v bun)") is older than $BUN_VERSION"
  else
    log "Bun was not found"
  fi
  log "Plan: install Bun $BUN_VERSION for $PLATFORM into $BUN_DIR/bin"
  log "Plan: verify $(bun_artifact_url "$PLATFORM") against the pinned SHA-256"
else
  if [ "$PIPED_INSTALL" = "1" ]; then
    fail "Bun bootstrap is disabled for piped installs; download install.sh, review it, and run 'bash install.sh --no-prompt'"
  fi
  if [ -z "$BUN_DIR" ]; then
    fail "HOME is not set; cannot install Bun $BUN_VERSION into a per-user directory"
  fi
  if command -v bun >/dev/null 2>&1; then
    log "Bun $(bun_version "$(command -v bun)") is older than $BUN_VERSION"
  else
    log "Bun was not found"
  fi
  ensure_temp_dir
  install_bun "$PLATFORM"
  BUN_BIN="$BUN_DIR/bin/bun"
fi

if [ -n "${BUN_BIN:-}" ]; then
  # Put the selected Bun first so every nested Bun invocation resolves to it.
  PATH="$(dirname "$BUN_BIN"):${PATH:-/usr/local/bin:/usr/bin:/bin}"
  export PATH
  hash -r
  case ":$ORIGINAL_PATH:" in
    *":$(dirname "$BUN_BIN"):"*) ;;
    *) log "Add Bun to PATH for future shells: export PATH=\"$(dirname "$BUN_BIN"):\$PATH\"" ;;
  esac
fi

# Already-published paperclipai releases still shell out to `npm` during install
# (version resolution and payload installation). On a machine with no Node.js
# there is no npm, so provide a bridge that runs the pinned npm on Bun instead of
# requiring a Node.js install. The bridge is only created when npm is genuinely
# missing: an existing npm is used untouched, and `bun x` keeps the public
# registry pinned through --registry plus the isolated config below.
NPM_BRIDGE_VERSION="11.18.0"
npm_bridge_dir() {
  printf '%s' "$(dirname "$BUN_BIN")/.paperclip-npm-bridge"
}

ensure_npm_available() {
  if command -v npm >/dev/null 2>&1; then
    return 0
  fi
  local bridge_dir
  bridge_dir="$(npm_bridge_dir)"
  mkdir -p "$bridge_dir"
  cat >"$bridge_dir/npm" <<EOF
#!/bin/sh
# Paperclip installer bridge: run npm on Bun so no Node.js install is needed.
exec $(printf '%q' "$BUN_BIN") x --bun --registry=$(printf '%q' "$PUBLIC_NPM_REGISTRY") npm@$NPM_BRIDGE_VERSION "\$@"
EOF
  chmod 0755 "$bridge_dir/npm"
  PATH="$bridge_dir:$PATH"
  export PATH
  hash -r
  log "npm is not installed; bridging npm $NPM_BRIDGE_VERSION through Bun for the released CLI"
}

if [ "$DRY_RUN" = "0" ] && [ -n "${BUN_BIN:-}" ]; then
  ensure_npm_available
fi

PACKAGE_SPEC="$PAPERCLIP_PACKAGE@latest"
if [ "$CANARY" = "1" ]; then
  PACKAGE_SPEC="$PAPERCLIP_PACKAGE@canary"
elif [ -n "$VERSION" ]; then
  PACKAGE_SPEC="$PAPERCLIP_PACKAGE@$VERSION"
fi

INSTALL_ARGS=(install)
[ "$CANARY" = "1" ] && INSTALL_ARGS+=(--canary)
[ -n "$VERSION" ] && INSTALL_ARGS+=(--version "$VERSION")
[ "$NO_PROMPT" = "1" ] && INSTALL_ARGS+=(--yes)

ensure_temp_dir
# Bun reads its own user config (~/.bunfig.toml, ~/.npmrc) in addition to
# environment variables, so the install runs with an empty XDG config directory
# and a clean npmrc. Together with the explicit registry flags this keeps the
# install on the public registry when the home directory carries a stale or
# hostile registry override.
NPM_USERCONFIG="$TEMP_DIR/npmrc"
printf 'registry=%s\n@paperclipai:registry=%s\n' "$PUBLIC_NPM_REGISTRY" "$PUBLIC_NPM_REGISTRY" >"$NPM_USERCONFIG"
chmod 600 "$NPM_USERCONFIG"
BUN_XDG_CONFIG="$TEMP_DIR/xdg-config"
mkdir -p "$BUN_XDG_CONFIG"
ISOLATED_ENV=(env
  "BUN_CONFIG_REGISTRY=$PUBLIC_NPM_REGISTRY"
  "NPM_CONFIG_REGISTRY=$PUBLIC_NPM_REGISTRY"
  "npm_config_registry=$PUBLIC_NPM_REGISTRY"
  "NPM_CONFIG_USERCONFIG=$NPM_USERCONFIG"
  "npm_config_userconfig=$NPM_USERCONFIG"
  "XDG_CONFIG_HOME=$BUN_XDG_CONFIG")
# --bun runs the CLI on Bun regardless of the shebang in the published entrypoint.
BUN_RUN=(bun x --bun "--registry=$PUBLIC_NPM_REGISTRY" "$PACKAGE_SPEC")
INSTALL_COMMAND=("${ISOLATED_ENV[@]}" "${BUN_RUN[@]}" "${INSTALL_ARGS[@]}")

log "Delegating to the Paperclip CLI"
if [ "$DRY_RUN" = "1" ]; then
  print_command "${INSTALL_COMMAND[@]}"
  if [ "$INSTALL_SERVICE" = "1" ]; then
    print_command "${ISOLATED_ENV[@]}" "${BUN_RUN[@]}" service install
  fi
  exit 0
fi

print_command "${INSTALL_COMMAND[@]}"
"${INSTALL_COMMAND[@]}"

if [ "$INSTALL_SERVICE" = "1" ]; then
  log "Installing the Paperclip service"
  print_command "${ISOLATED_ENV[@]}" "${BUN_RUN[@]}" service install
  "${ISOLATED_ENV[@]}" "${BUN_RUN[@]}" service install
fi

if [ "$NO_ONBOARD" = "0" ] && [ -t 0 ] && [ -t 1 ]; then
  if command -v paperclipai >/dev/null 2>&1; then
    exec paperclipai onboard
  elif [ -x "${HOME:-}/.local/bin/paperclipai" ]; then
    exec "${HOME}/.local/bin/paperclipai" onboard
  else
    fail "Paperclip was installed, but 'paperclipai' is not available on PATH. Open a new shell and run 'paperclipai onboard'."
  fi
fi

if [ "$NO_ONBOARD" = "0" ]; then
  log "Installation complete. Next: paperclipai onboard"
else
  log "Installation complete."
fi
