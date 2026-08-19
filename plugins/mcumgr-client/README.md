# BBCOM MCUmgr client plugin

This standalone Cargo workspace contains a real `bbcom:plugin@2.0.0`
component and its transport-independent MCUmgr protocol core. The component
has no WASI imports and cannot open native serial ports, paths, sockets,
processes, or environment variables. Every authority is an explicit
`bbcom:plugin/host@2.0.0` resource supplied by BBCOM.

## Layout

- `src/` — zero-dependency `#![no_std] + alloc` SMP/CBOR protocol core.
- `guest/` — plugin-v2 guest, UI/state model, WIT adapter, bounded workflows,
  and a reclaiming 40 MiB Wasm arena under the 64 MiB host limit.
- `package/plugin.toml.template` — complete v2 package metadata; the packager
  replaces its single digest marker.
- `packager/` — native build-time tool that creates an installable directory
  containing `plugin.toml` and `component/plugin.wasm`.

## Delivered capabilities

The guest exports `initialize`, `handle-event`, `run-command`,
`migrate-state`, and `shutdown`. It publishes nine host-rendered surfaces:

1. Overview
2. Firmware
3. Files
4. OS
5. Stats
6. Settings
7. Shell
8. Groups / Raw
9. Automation

The command catalogue covers Zephyr OS, Image, Stats, Settings, FS, Shell,
Enum, Zephyr storage erase, legacy image/core operations, and arbitrary SMP
read/write requests. Raw input accepts JSON (converted to CBOR) or validated
CBOR hex; responses show structured CBOR and raw hex.

Both Zephyr serial transports are implemented:

- SMP over console: `0x0609` first fragment, `0x0414` continuation, strict
  Base64, LF framing, declared length, CRC16-XMODEM, noise scanning, and
  fragmented/coalesced RX.
- Raw UART: SMP header + CBOR length reassembly with bounded noise scanning.

Each operation acquires an exclusive BBCOM serial transaction lease and
releases it on success or failure. Read-only commands can use the configured
bounded retry count; a command with side effects is never retried after its
physical write may have started. `partial-write` and `unknown-outcome` remain
distinct host errors.

Firmware upload uses a host read grant in two streaming passes: it parses the
MCUboot header/TLVs and computes SHA-256, then sends bounded image chunks.
The complete firmware is never resident in Wasm memory. Filesystem upload is
also chunked; download writes directly to a host save grant and calls `commit`
only after the declared target length is complete. Any failure calls `cancel`.
File grants are never persisted.

Dangerous image test/confirm/erase, reset, setting deletion, and Zephyr storage
erase actions all carry mandatory, action-specific confirmation text. The
trusted renderer confirms them before the guest receives the action event.

Automation can add native BBCOM quick commands and macros through the
plugin-owned contribution namespace. No plugin HTML, JavaScript, DOM, URL, or
WebView is used.

## Build and package

The subtree is intentionally outside the repository's root Cargo workspace.
Build and audit the real component, then generate a digest-pinned installable
directory:

```sh
rustup target add wasm32-wasip2
cargo build \
  --manifest-path plugins/mcumgr-client/Cargo.toml \
  -p bbcom-mcumgr-guest --release --target wasm32-wasip2
cargo test \
  --manifest-path plugins/mcumgr-client/Cargo.toml \
  -p bbcom-mcumgr-guest --test import_audit
cargo run \
  --manifest-path plugins/mcumgr-client/Cargo.toml \
  -p bbcom-mcumgr-packager -- \
  plugins/mcumgr-client/target/wasm32-wasip2/release/bbcom_mcumgr_guest.wasm \
  plugins/mcumgr-client/target/package/mcumgr-client
```

Install `plugins/mcumgr-client/target/package/mcumgr-client` through BBCOM's
local-package flow. The manifest requests the full v2 user-level serial,
surface/window, file-grant, state, capture, and command/macro capability set;
the host's first-enable capability confirmation remains authoritative.

## Tests

```sh
cargo test --manifest-path plugins/mcumgr-client/Cargo.toml --workspace
cargo check --manifest-path plugins/mcumgr-client/Cargo.toml \
  --workspace --all-targets --all-features
cargo clippy --manifest-path plugins/mcumgr-client/Cargo.toml \
  --workspace --all-targets --all-features -- -D warnings
```

The blocking Component CI job also builds the release `bbcom-plugin-host` and
runs `src-tauri/tests/mcumgr_production_chain.rs`. That gate sends the packaged
artifact through the real installer prepare/commit transaction, authorization,
sidecar handshake, typed capability gateway, and the ordinary two-second
initialize deadline. It requires all 65 initial typed RPCs to produce exactly
9 rendered surfaces and 44 command contributions before a clean shutdown.

The tests include SMP/CBOR golden vectors, transport fragmentation/noise/CRC
cases, state corruption and UI validation, JSON/hex raw input, fake serial
servers for console and raw mode, MCUboot parsing, streaming firmware and file
workflows, atomic save behavior, and an actual component-model import audit.
The audit validates the component and rejects WASI, filesystem, network,
process, environment, Tauri, and native serial imports. Only the v2 host and
v2 types interfaces are allowed.

See [NOTICE.md](NOTICE.md) for the exact upstream references and license
attribution.

For the development-directory watcher and edit-build-hot-reload loop, see
[Plugin v2 development](../../docs/PLUGIN_DEVELOPMENT_V2.md).
