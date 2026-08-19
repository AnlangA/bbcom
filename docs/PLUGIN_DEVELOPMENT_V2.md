# Plugin v2 local development and hot reload

BBCOM protocol-v2 plugins are standalone WebAssembly Component workspaces.
They are deliberately not members of the root Cargo workspace: a normal host
build must not silently install a Wasm target or compile third-party guests.

## Prerequisites

Use the repository toolchain and install the Component target once:

```sh
rustup target add wasm32-wasip2 --toolchain 1.97.0
```

The repository currently contains two reference workspaces:

- `plugins/counter-v2` for surfaces, commands, contributions, migration, and a
  minimal serial transaction lease;
- `plugins/mcumgr-client` for streaming file grants and full MCUmgr transports
  and workflows.

Both use the shared bounded guest runtime, Component import audit, and
digest-pinned directory packager under `plugins/`.

## Build an installable development directory

Build the Component before running the import audit. The audit intentionally
fails if it cannot inspect the final release artifact.

```sh
cargo build --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2 --release --target wasm32-wasip2 --locked
cargo test --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2 --test import_audit --locked
cargo run --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2-packager --locked -- \
  plugins/counter-v2/target/wasm32-wasip2/release/bbcom_counter_v2.wasm \
  plugins/counter-v2/target/package/counter-v2
```

The directory selected in BBCOM must contain these final files:

```text
counter-v2/
├── plugin.toml
└── component/
    └── plugin.wasm
```

Do not select a source `package/` directory containing
`plugin.toml.template`. The template has no real component digest and is not
installable.

## Enable development-directory watching

1. Open the Plugin Center.
2. Choose **Development directory** and select the generated directory under
   `target/package/`.
3. Review the development-source warning and requested capabilities, then
   enable the plugin.
4. Leave watching enabled for that development source.
5. After changing guest code, repeat the build and packager commands using the
   same output directory.

The native watcher samples the final `plugin.toml` and declared Component
every 250 ms. A fingerprint must be valid and unchanged for two observations,
giving a 500 ms debounce before reinstall. Digest mismatches, symlinks,
oversized artifacts, and malformed manifests fail closed. A successful change
runs through the normal installation and runtime-restart path even when the
plugin version did not change.

Hot reload preserves host-owned plugin storage. Runtime resource handles,
serial leases, file grants, window tokens, and instance generations are not
reused across the restart. A capability increase requires a new confirmation;
rebuilding with the already confirmed set does not grant additional authority.

### Initialization declarations and state

During `initialize`, register every surface and command through the typed host
imports before publishing its first surface snapshot, then return the same
declarations in `plugin-model`. BBCOM rejects initialization unless the import
registrations and returned model match exactly. This intentional dual delivery
provides deterministic host-import ordering while keeping the returned model
as the authoritative guest-export contract.

Initialization retains the ordinary two-second deadline and has a fixed
50,000,000-unit fuel allowance for bounded model construction and initial
snapshots. Keep initialization deterministic: do not wait for a device or user
dialog, and use a valid disabled placeholder when a select has no live choices.

The host buffers private and portable project-state changes until
initialization and model validation succeed. Prepared preflight reads the active
private bytes but keeps every private/project write in memory; it creates no
durable prepared-state slot. The active runtime repeats state migration after
package activation.

Finalization spans native private-file storage and the workspace database, so
it is not a cross-store atomic transaction. BBCOM commits private bytes first,
then project bytes, and restores the previous exact private blob if the project
commit fails. Guests must propagate any migration/storage error and must not
perform external side effects while migrating state.

`project-state-get` and `project-state-set` exchange a versioned record, not
bare bytes. Schema zero is invalid. BBCOM preserves every non-zero guest schema
unchanged (including versions newer than the host); the guest must accept only
the schemas it can actually decode. Plugin API generation remains separate
host metadata and is fixed to generation 2.

Only workspace schema-2 preview rows lacked this metadata. Their one-time
workspace migration marks the retained bytes as guest schema `1`; no live host
path invents a schema for new project-state writes.

BBCOM reloads this record from the active workspace immediately before every
host launch. A crash restart in the same process therefore receives the latest
durable bytes and schema rather than the lifecycle manager's earlier snapshot.

### Serial session lifetime and local IDs

`create-serial-session` accepts either `persistent` or `runtime`. Persistent
sessions enter the active workspace and therefore fail while that workspace is
read-only. Runtime sessions remain renderer-memory-only, may be created for a
current read-only workspace, and are disconnected and removed when that exact
plugin runtime is revoked. They are never written to the workspace database.

`local-id` de-duplicates repeated creates only during the current application
gateway lifetime. BBCOM does not yet persist plugin ownership metadata for
serial sessions, so after an application restart the same persistent
`local-id` creates a new session. Plugins that need durable discovery should
store the returned host `session-id` in project state and first reconcile it
against `serial-sessions`; a missing ID must be treated as deleted, not silently
recreated during a side-effecting workflow.

Serial framing is intentionally limited to the modes the host driver can
actually apply: parity is `none`, `odd`, or `even`, and stop bits are `one` or
`two`. Mark/space parity and 1.5 stop bits are not protocol-v2 values.

`capture-read` uses two paths with the same sequence contract. Runtime sessions
page the renderer's bounded in-memory capture. Persistent sessions first wait
for a workspace durability barrier and then page the active workspace database
through a native, pathless hydration port. The page is capped by both
`max-frames` and `max-bytes`; the host never skips an oversized frame. If
`from-sequence` predates the first retained database or memory frame, the host
returns `stale-handle` rather than relabelling a later frame as continuous.
Plugins should resume from `next-sequence` and treat a stale page as an explicit
history gap. Cancellation covers the flush and hydration waits; the complete
operation retains the ordinary two-second deadline.

### Bounded chunks and transport streams

All production v2 file, serial, capture, and state APIs currently transfer
bounded unary chunks of at most 256 KiB. The Protobuf broker implements and
tests the generic four-stream window/backpressure state machine, but the WIT
package intentionally exposes no generic stream resource yet: the current
`StreamOpen` shape cannot bind a consumer to a generation-scoped lease, file
grant, capture page, or task. Native therefore rejects unsolicited stream
envelopes with `unavailable`. Do not advertise or depend on generic streams
until a future minor version adds that binding to both WIT and Protobuf.

Cancelling an open/save request immediately releases the plugin task and any
late file grant is discarded. Platform file pickers are operating-system modal
dialogs, however, and cannot be programmatically dismissed on every supported
platform; the visible picker may remain until the user closes it.

## MCUmgr development directory

Use the equivalent explicit workspace commands:

```sh
cargo build --manifest-path plugins/mcumgr-client/Cargo.toml \
  -p bbcom-mcumgr-guest --release --target wasm32-wasip2 --locked
cargo test --manifest-path plugins/mcumgr-client/Cargo.toml \
  -p bbcom-mcumgr-guest --test import_audit --locked
cargo run --manifest-path plugins/mcumgr-client/Cargo.toml \
  -p bbcom-mcumgr-packager --locked -- \
  plugins/mcumgr-client/target/wasm32-wasip2/release/bbcom_mcumgr_guest.wasm \
  plugins/mcumgr-client/target/package/mcumgr-client
```

Select `plugins/mcumgr-client/target/package/mcumgr-client` as the development
directory.

## Required pre-commit checks

Run native tests and Clippy in the plugin's own workspace, then lint the real
Wasm target:

```sh
cargo test --manifest-path plugins/counter-v2/Cargo.toml \
  --workspace --all-features --locked
cargo clippy --manifest-path plugins/counter-v2/Cargo.toml \
  --workspace --all-targets --all-features --locked -- -D warnings
cargo clippy --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2 --target wasm32-wasip2 \
  --release --locked -- -D warnings
```

The blocking CI job repeats this sequence for both reference plugins, audits
their final Component imports and exports, and generates both installable
directories. It then sends those exact directories through the production
local-package installer (digest check, Component validation, v2 capability
parse, prepare, commit, and restart enumeration). Adding a plugin to the root
workspace instead is not an accepted substitute.
