#!/usr/bin/env sh
# ApexRust Quant cross-platform POSIX bootstrapper (Linux & macOS).
# Installs missing prerequisites (user-local by default; asks confirmation before sudo),
# then hands off to `node scripts/apexrust.mjs setup`.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/fnm:$HOME/.fnm:/opt/homebrew/bin:/usr/local/bin:$PATH"

if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell sh 2>/dev/null || true)"
fi

NON_INTERACTIVE=0
AUTO_YES=0
NEED_RUST=1
PREV=""

for arg in "$@"; do
  lower_arg="$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')"
  case "$PREV" in
    --components)
      if [ "$lower_arg" = "web" ]; then NEED_RUST=0; else NEED_RUST=1; fi
      PREV=""
      continue
      ;;
    --role)
      if [ "$lower_arg" = "client" ]; then NEED_RUST=0; fi
      PREV=""
      continue
      ;;
  esac
  case "$lower_arg" in
    --non-interactive) NON_INTERACTIVE=1; AUTO_YES=1 ;;
    -y|--yes) AUTO_YES=1 ;;
    --components=web|--role=client) NEED_RUST=0 ;;
    --components=bot|--components=both) NEED_RUST=1 ;;
    --components) PREV="--components" ;;
    --role) PREV="--role" ;;
  esac
done

say() { printf "==> %s\n" "$*"; }
ok()  { printf "[OK] %s\n" "$*"; }
err() { printf "[FAIL] %s\n" "$*" >&2; }

ask_confirm() {
  question="$1"
  default="${2:-y}"
  if [ "$AUTO_YES" -eq 1 ]; then
    return 0
  fi
  if [ ! -t 0 ] || [ "$NON_INTERACTIVE" -eq 1 ]; then
    [ "$default" = "y" ]
    return $?
  fi
  if [ "$default" = "y" ]; then
    printf "%s [Y/n]: " "$question"
  else
    printf "%s [y/N]: " "$question"
  fi
  read -r reply || return 1
  case "$reply" in
    "") [ "$default" = "y" ] ;;
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

run_with_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return $?
  fi
  printf "\nAdministrator privileges are required to run:\n  sudo %s\n" "$*"
  if [ "$NON_INTERACTIVE" -eq 1 ] || [ ! -t 0 ]; then
    err "Refusing to run sudo unattended. Please run the command above manually and re-run ./install.sh."
    return 1
  fi
  printf "Execute this command with sudo? [y/N]: "
  read -r reply || return 1
  case "$reply" in
    y|Y|yes|YES) sudo "$@" ;;
    *) err "Skipped sudo step."; return 1 ;;
  esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    const valid = (maj === 20 && min >= 19) || (maj === 22 && min >= 12) || maj >= 23;
    process.exit(valid ? 0 : 1);
  ' >/dev/null 2>&1
}

rust_ok() {
  command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1 || return 1
  ver="$(rustc --version | awk '{print $2}')"
  maj="$(printf "%s" "$ver" | cut -d. -f1)"
  min="$(printf "%s" "$ver" | cut -d. -f2)"
  case "$maj:$min" in
    [0-9]*:[0-9]*)
      [ "$maj" -gt 1 ] || { [ "$maj" -eq 1 ] && [ "$min" -ge 85 ]; }
      ;;
    *) return 1 ;;
  esac
}

install_node() {
  if ! command -v curl >/dev/null 2>&1; then
    err "curl is required to install fnm / Node.js automatically."
    return 1
  fi
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    if ask_confirm "Install Node.js LTS using Homebrew (no sudo)?"; then
      brew install node
      return 0
    fi
  fi
  if ask_confirm "Install Node.js v22 LTS into ~/.local/share/fnm (user-local, no sudo)?"; then
    fnm_shell="sh"
    command -v bash >/dev/null 2>&1 && fnm_shell="bash"
    curl -fsSL https://fnm.vercel.app/install | "$fnm_shell" -s -- --skip-shell
    fnm_dir="${XDG_DATA_HOME:-$HOME/.local/share}/fnm"
    export PATH="$fnm_dir:$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
    eval "$(fnm env --shell sh)"
    fnm install 22
    fnm default 22
    fnm use 22
    ok "Installed Node.js $(node -v) via fnm."
    return 0
  fi
  return 1
}

install_rust() {
  if ! command -v curl >/dev/null 2>&1; then
    err "curl is required to install rustup automatically."
    return 1
  fi
  if command -v rustup >/dev/null 2>&1; then
    if ask_confirm "Update Rust toolchain via rustup to stable (>= 1.85.0)?"; then
      rustup toolchain install stable
      rustup default stable
      return 0
    fi
    return 1
  fi
  if ask_confirm "Install Rust via rustup into ~/.cargo (user-local, no sudo)?"; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    export PATH="$HOME/.cargo/bin:$PATH"
    ok "Installed Rust ($(rustc --version))."
    return 0
  fi
  return 1
}

ensure_linux_build_deps() {
  if command -v cc >/dev/null 2>&1 && command -v pkg-config >/dev/null 2>&1 && pkg-config --exists openssl 2>/dev/null && command -v curl >/dev/null 2>&1; then
    ok "C compiler, pkg-config & OpenSSL dev headers available."
    return 0
  fi
  say "Rust dependencies (openssl-sys) require a C compiler, pkg-config, OpenSSL headers, and curl."
  if command -v apt-get >/dev/null 2>&1; then
    run_with_sudo sh -c "apt-get update && apt-get install -y build-essential pkg-config libssl-dev curl git"
  elif command -v dnf >/dev/null 2>&1; then
    run_with_sudo dnf install -y gcc pkgconf-pkg-config openssl-devel curl git
  elif command -v yum >/dev/null 2>&1; then
    run_with_sudo yum install -y gcc pkgconfig openssl-devel curl git
  elif command -v pacman >/dev/null 2>&1; then
    run_with_sudo pacman -Sy --noconfirm base-devel pkgconf openssl curl git
  else
    err "Unsupported Linux package manager. Install gcc/clang, pkg-config, OpenSSL dev headers, and curl manually."
    return 1
  fi
}

ensure_macos_clt() {
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode Command Line Tools installed."
    return 0
  fi
  say "Xcode Command Line Tools are required to compile Rust crates on macOS."
  if ask_confirm "Launch \`xcode-select --install\` now?"; then
    xcode-select --install || true
    err "Finish the Apple Command Line Tools installer popup, then re-run ./install.sh."
  fi
  return 1
}

say "Bootstrapping ApexRust Quant prerequisites..."

if ! command -v git >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      run_with_sudo sh -c "apt-get update && apt-get install -y git curl" || exit 1
    elif command -v dnf >/dev/null 2>&1; then
      run_with_sudo dnf install -y git curl || exit 1
    elif command -v yum >/dev/null 2>&1; then
      run_with_sudo yum install -y git curl || exit 1
    elif command -v pacman >/dev/null 2>&1; then
      run_with_sudo pacman -Sy --noconfirm git curl || exit 1
    else
      err "Git is required. Please install git and re-run ./install.sh."
      exit 1
    fi
  elif [ "$(uname -s)" = "Darwin" ]; then
    ensure_macos_clt || exit 1
  else
    err "Git is required. Please install git and re-run ./install.sh."
    exit 1
  fi
fi

if node_ok; then
  ok "Node.js $(node -v)"
else
  install_node || { err "Node.js ^20.19.0 or >= 22.12.0 is required."; exit 1; }
fi

if [ "$NEED_RUST" -eq 1 ]; then
  if [ "$(uname -s)" = "Linux" ]; then
    ensure_linux_build_deps || exit 1
  elif [ "$(uname -s)" = "Darwin" ]; then
    ensure_macos_clt || exit 1
  fi

  if rust_ok; then
    ok "$(rustc --version)"
  else
    install_rust || { err "Rust >= 1.85.0 is required for the trading engine."; exit 1; }
  fi
fi

say "Launching ApexRust interactive setup CLI..."
exec node "$SCRIPT_DIR/scripts/apexrust.mjs" setup "$@"
