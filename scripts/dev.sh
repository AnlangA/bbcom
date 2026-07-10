#!/usr/bin/env bash
# Thin, deterministic pnpm wrapper. Vite/Tauri own child-process lifecycle;
# this script never probes alternative package managers or kills processes.
set -euo pipefail

case "${1:-help}" in
  dev) exec pnpm tauri:dev ;;
  frontend) exec pnpm dev ;;
  build) exec pnpm tauri:build ;;
  check) exec pnpm check ;;
  test) exec pnpm test ;;
  install) exec pnpm install --frozen-lockfile ;;
  help|-h|--help)
    printf '%s\n' 'Usage: scripts/dev.sh {dev|frontend|build|check|test|install}'
    ;;
  *)
    printf 'Unknown command: %s\n' "$1" >&2
    exit 2
    ;;
esac
