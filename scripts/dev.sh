#!/usr/bin/env bash
# Development and build helper for bbcom
# Usage: ./scripts/dev.sh <command>
# Commands:
#   dev         Start frontend dev server and Tauri dev (recommended)
#   frontend    Start only the frontend dev server
#   tauri       Start only Tauri dev (requires frontend if using dev assets)
#   build       Build frontend then run Tauri build
#   tauri:build Run only `tauri build`
#   install     Install dependencies (uses detected package manager)
#   lint        Run linter if configured
#   test        Run tests (frontend or Rust tests as configured)
#   help        Show this help message
#
# Make executable: chmod +x bbcom/scripts/dev.sh

set -euo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Detect package manager: prefer pnpm, then yarn, then npm
detect_pkg_manager() {
  if [ -f "pnpm-lock.yaml" ]; then
    echo "pnpm"
  elif [ -f "yarn.lock" ]; then
    echo "yarn"
  else
    echo "npm"
  fi
}

PM=$(detect_pkg_manager)

# Run a command in a new terminal window if possible (macOS, Linux w/ x-terminal-emulator)
open_in_new_terminal() {
  local cmd="$*"
  # macOS
  if [ "$(uname)" = "Darwin" ]; then
    osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT_DIR'; $cmd\""
    return 0
  fi
  # Try x-terminal-emulator (common on Debian/Ubuntu)
  if command -v x-terminal-emulator >/dev/null 2>&1; then
    x-terminal-emulator -e "bash -lc 'cd \"$ROOT_DIR\"; $cmd; bash'" &
    return 0
  fi
  # Fallback: run in background in the same shell
  bash -lc "$cmd" &
  return 0
}

install_deps() {
  case "$PM" in
    pnpm) pnpm install ;;
    yarn) yarn install ;;
    npm) npm install ;;
    *) echo "Unknown package manager: $PM"; exit 1 ;;
  esac
}

frontend_dev() {
  echo "[dev] Starting frontend dev server using $PM"
  case "$PM" in
    pnpm) $PM dev ;;
    yarn) $PM dev ;;
    npm) $PM run dev ;;
    *) echo "Unsupported package manager: $PM"; exit 1 ;;
  esac
}

tauri_dev() {
  echo "[dev] Starting Tauri dev"
  # Prefer the npm script name used in package.json
  case "$PM" in
    pnpm) $PM run tauri:dev ;;
    yarn) $PM run tauri:dev ;;
    npm) $PM run tauri:dev ;;
    *) echo "Unsupported package manager: $PM"; exit 1 ;;
  esac
}

dev_all() {
  echo "[dev] Starting development environment"

  # Clean up any existing process on port 5173
  echo "[dev] Checking for existing processes on port 5173"
  if lsof -ti:5173 >/dev/null 2>&1; then
    echo "[dev] Killing existing process on port 5173"
    lsof -ti:5173 | xargs kill -9 2>/dev/null
    sleep 1
  fi

  # Strategy:
  # 1) Start frontend dev in background
  # 2) Wait for it to be ready
  # 3) Start Tauri dev

  echo "[dev] Starting frontend dev server in background"
  case "$PM" in
    pnpm) $PM dev &;;
    yarn) $PM dev &;;
    npm) $PM run dev &;;
    *) echo "Unsupported package manager: $PM"; exit 1 ;;
  esac

  FRONTEND_PID=$!

  # Wait for frontend to be ready
  echo "[dev] Waiting for frontend to be ready on http://localhost:5173"
  for i in {1..30}; do
    if curl -s http://localhost:5173 > /dev/null 2>&1; then
      echo "[dev] Frontend is ready!"
      break
    fi
    if [ $i -eq 30 ]; then
      echo "[dev] Frontend failed to start in time"
      kill $FRONTEND_PID 2>/dev/null
      exit 1
    fi
    sleep 1
  done

  echo "[dev] Launching Tauri dev"
  tauri_dev

  # Cleanup frontend on exit
  kill $FRONTEND_PID 2>/dev/null
}

build_all() {
  echo "[build] Building frontend"
  case "$PM" in
    pnpm) $PM run build ;;
    yarn) $PM run build ;;
    npm) $PM run build ;;
  esac

  echo "[build] Running Tauri build"
  case "$PM" in
    pnpm) $PM run tauri:build ;;
    yarn) $PM run tauri:build ;;
    npm) $PM run tauri:build ;;
  esac

  echo "[build] Build finished"
}

tauri_build_only() {
  case "$PM" in
    pnpm) $PM run tauri:build ;;
    yarn) $PM run tauri:build ;;
    npm) $PM run tauri:build ;;
  esac
}

run_lint() {
  if [ -f "package.json" ]; then
    # Prefer an npm script called lint
    if grep -q "\"lint\"" package.json; then
      case "$PM" in
        pnpm) $PM run lint ;;
        yarn) $PM run lint ;;
        npm) $PM run lint ;;
      esac
    else
      echo "[lint] No lint script found in package.json"
    fi
  fi
}

run_tests() {
  # Frontend tests
  if [ -f "package.json" ]; then
    if grep -q "\"test\"" package.json; then
      case "$PM" in
        pnpm) $PM run test ;;
        yarn) $PM run test ;;
        npm) $PM run test ;;
      esac
    else
      echo "[test] No test script found in package.json"
    fi
  fi

  # Rust tests (if src-tauri exists)
  if [ -d "src-tauri" ]; then
    echo "[test] Running Rust tests"
    (cd src-tauri && cargo test)
  fi
}

show_help() {
  sed -n '1,200p' "$0" | sed -n '1,40p'
  cat <<'EOF'

Examples:
  # Install deps then start combined dev
  ./scripts/dev.sh install
  ./scripts/dev.sh dev

  # Start only frontend in current terminal
  ./scripts/dev.sh frontend

  # Build production artifacts
  ./scripts/dev.sh build

Notes:
  - Make sure you have the Tauri CLI installed (npm/pnpm/yarn global or devDependency)
  - On some systems starting a GUI terminal may not work from scripts; in that case,
    run the frontend dev and tauri dev commands manually in separate terminals.
EOF
}

main() {
  if [ $# -lt 1 ]; then
    echo "No command specified"
    show_help
    exit 1
  fi

  cmd="$1"
  shift

  case "$cmd" in
    install) install_deps ;;
    dev) dev_all ;;
    frontend) frontend_dev ;;
    tauri) tauri_dev ;;
    build) build_all ;;
    tauri:build|tauri-build) tauri_build_only ;;
    lint) run_lint ;;
    test) run_tests ;;
    help) show_help ;;
    *) echo "Unknown command: $cmd"; show_help; exit 2 ;;
  esac
}

# Execute main with all script args
main "$@"
