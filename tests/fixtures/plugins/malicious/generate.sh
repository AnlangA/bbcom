#!/usr/bin/env bash
set -euo pipefail

fixture_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$fixture_root/../../../.." && pwd)
guest_manifest="$fixture_root/guest/Cargo.toml"
printer_manifest="$repository_root/plugins/plugin-component-audit/Cargo.toml"
component="$fixture_root/guest/target/wasm32-wasip2/release/g45_v2_fixture_guest.wasm"

build_fixture() {
  local feature=$1
  local output=$2
  cargo build \
    --manifest-path "$guest_manifest" \
    --release \
    --target wasm32-wasip2 \
    --no-default-features \
    --features "$feature" \
    --locked
  cargo run \
    --manifest-path "$printer_manifest" \
    --bin bbcom-component-to-wat \
    --locked -- \
    "$component" \
    "$fixture_root/$output"
}

build_fixture primary g45-malicious.component.wasm
cargo run \
  --manifest-path "$printer_manifest" \
  --bin bbcom-component-to-wat \
  --locked -- \
  "$component" \
  "$fixture_root/g45-ambient-import.component.wat" \
  --ambient-import
build_fixture trap g45-trap.component.wat
build_fixture runaway g45-runaway.component.wat
build_fixture memory g45-memory.component.wat
