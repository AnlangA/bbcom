# BBCOM protocol-v2 counter example

`counter-v2` is a deliberately small, installable `bbcom:plugin@2.0.0`
Component. It is the reference example for capabilities that are difficult to
show with a static panel:

- one revisioned workspace surface rendered by the trusted host;
- five command-palette contributions;
- plugin-owned native quick-command and macro contributions;
- an exclusive serial transaction lease with one physical write and explicit
  release on every result path;
- portable, schema-versioned project state;
- a host-confirmed dangerous reset action.

The guest is `no_std` on `wasm32`, imports only `bbcom:plugin/host@2.0.0` and
`bbcom:plugin/types@2.0.0`, and cannot open a serial port, file, socket,
process, environment variable, WebView, or Tauri API. Serial writes,
quick-command ownership, and macro ownership remain host controlled.

## Build, audit, and package

The plugin is an independent Cargo workspace and is intentionally absent from
the repository root workspace.

```sh
rustup target add wasm32-wasip2
cargo build --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2 --release --target wasm32-wasip2
cargo test --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2 --test import_audit
cargo run --manifest-path plugins/counter-v2/Cargo.toml \
  -p bbcom-counter-v2-packager -- \
  plugins/counter-v2/target/wasm32-wasip2/release/bbcom_counter_v2.wasm \
  plugins/counter-v2/target/package/counter-v2
```

Select `plugins/counter-v2/target/package/counter-v2` in BBCOM's local-package
or development-directory flow. Do not select `package/`; it contains a digest
template rather than an installable manifest.

The thin counter packager and MCUmgr packager use the same
`plugins/plugin-packager` implementation. Both production-parse the generated
manifest and write the standard `plugin.toml` plus `component/plugin.wasm`
directory shape.

## Example behavior

The surface lets the user select a host session and increment, send, or reset
the counter. `Send using serial lease` asks the host to pause automation,
acquires a generation-bound lease, writes `counter=<value>\n` exactly once,
preserves `partial-write` or `unknown-outcome`, and releases the lease. It
never retries a potentially completed physical write.

The quick-command and macro buttons call the v2 contribution APIs with local
IDs. BBCOM stores them under the plugin-owned namespace and can continue to
run the native entries while the plugin is disabled.

`migrate-state` accepts only snapshots produced by plugin API generation 2.
Corrupt, zero-schema, or unknown-schema input fails before the host finalizes
the replacement.

For watcher behavior and the complete edit-build-reload loop, see
[Plugin v2 development](../../docs/PLUGIN_DEVELOPMENT_V2.md).
