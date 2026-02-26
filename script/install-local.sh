#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_BIN_DIR="${HOME}/.local/bin"
BIN_DIR="${BREWVA_INSTALL_BIN_DIR:-${DEFAULT_BIN_DIR}}"

UNINSTALL=0
DRY_RUN=0
FORCE=0
BUILD_IF_MISSING=1

print_help() {
  cat <<'EOF'
Install Brewva command from this repository (macOS/Linux).

Usage:
  bash script/install-local.sh [options]

Options:
  --bin-dir <path>      Install target directory (default: ~/.local/bin)
  --uninstall           Remove installed brewva symlink
  --no-build            Do not run build when platform binary is missing
  --build-if-missing    Build distribution binaries when missing (default)
  --force               Overwrite existing non-symlink target
  --dry-run             Print actions without changing files
  -h, --help            Show this help
EOF
}

run() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

ensure_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: required command not found: ${cmd}" >&2
    exit 1
  fi
}

detect_linux_libc() {
  if command -v ldd >/dev/null 2>&1; then
    local output
    output="$(ldd --version 2>&1 || true)"
    if printf '%s' "${output}" | grep -qi "musl"; then
      echo "musl"
      return 0
    fi
    if printf '%s' "${output}" | grep -qiE "glibc|gnu libc"; then
      echo "glibc"
      return 0
    fi
  fi

  if command -v getconf >/dev/null 2>&1 && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    echo "glibc"
    return 0
  fi

  echo "glibc"
}

resolve_platform_dir() {
  local os
  local arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${arch}" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *)
      echo "Error: unsupported CPU architecture: ${arch}" >&2
      exit 1
      ;;
  esac

  case "${os}" in
    Darwin)
      echo "brewva-darwin-${arch}"
      ;;
    Linux)
      local libc
      libc="$(detect_linux_libc)"
      if [[ "${libc}" == "musl" ]]; then
        echo "brewva-linux-${arch}-musl"
      else
        echo "brewva-linux-${arch}"
      fi
      ;;
    *)
      echo "Error: unsupported OS: ${os}. This installer supports macOS/Linux." >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir)
      if [[ $# -lt 2 ]]; then
        echo "Error: --bin-dir requires a value." >&2
        exit 1
      fi
      BIN_DIR="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-build)
      BUILD_IF_MISSING=0
      shift
      ;;
    --build-if-missing)
      BUILD_IF_MISSING=1
      shift
      ;;
    -h | --help)
      print_help
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

INSTALL_PATH="${BIN_DIR}/brewva"

if [[ "${UNINSTALL}" -eq 1 ]]; then
  if [[ ! -e "${INSTALL_PATH}" && ! -L "${INSTALL_PATH}" ]]; then
    echo "brewva is not installed at ${INSTALL_PATH}"
    exit 0
  fi
  run rm -f "${INSTALL_PATH}"
  echo "Removed ${INSTALL_PATH}"
  exit 0
fi

PLATFORM_DIR="$(resolve_platform_dir)"
TARGET_BINARY="${REPO_ROOT}/distribution/${PLATFORM_DIR}/bin/brewva"

if [[ ! -x "${TARGET_BINARY}" ]]; then
  if [[ "${BUILD_IF_MISSING}" -ne 1 ]]; then
    echo "Error: platform binary is missing: ${TARGET_BINARY}" >&2
    echo "Hint: run 'bun run build:binaries' or rerun with --build-if-missing." >&2
    exit 1
  fi
  ensure_command bun
  run bun run --cwd "${REPO_ROOT}" build:binaries
fi

if [[ ! -x "${TARGET_BINARY}" ]]; then
  echo "Error: platform binary still missing after build: ${TARGET_BINARY}" >&2
  exit 1
fi

if [[ -e "${INSTALL_PATH}" && ! -L "${INSTALL_PATH}" ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then
    echo "Error: ${INSTALL_PATH} exists and is not a symlink. Use --force to overwrite." >&2
    exit 1
  fi
  run rm -f "${INSTALL_PATH}"
fi

run mkdir -p "${BIN_DIR}"
run ln -sf "${TARGET_BINARY}" "${INSTALL_PATH}"

echo "Installed brewva -> ${INSTALL_PATH}"
echo "Target binary   -> ${TARGET_BINARY}"

if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  echo
  echo "PATH update required. Add this line to your shell rc:"
  echo "  export PATH=\"${BIN_DIR}:\$PATH\""
fi

echo
echo "Next steps:"
echo "  brewva --help"
echo "  brewva onboard --install-daemon"
