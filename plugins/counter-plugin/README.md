# bbcom counter panel plugin

A complete, real-world sample for the `bbcom:plugin/plugin@1.0.0` world
(`wit/bbcom-plugin-v1/plugin.wit`). The plugin renders a declarative panel
with a persistent counter and the number of open sessions, and demonstrates
the host imports a plugin may use:

- `plugin.storage` (`storage-get` / `storage-set`) — the counter survives
  process death because the host snapshots it with the plugin state.
- `session-list` — gated behind the `session.metadata.read` capability; the
  plugin initializes fail-closed when the capability is not granted.
- `publish-panel` — the plugin republishes its panel after every event.

The guest is `#![no_std]` with a bump allocator and its own `cabi_realloc`:
the bbcom host links **no WASI**, so the component must not import any
`wasi:*` interface (this is enforced by the ambient G45 fixtures).

## Layout

- `src/lib.rs` — the guest source (wit-bindgen, wasm32-wasip2).
- `../../tests/fixtures/plugins/counter/` — the packaged artifact:
  `plugin.toml` (digest-pinned manifest) + `component/plugin.wasm`.

## Build

```sh
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2
cp target/wasm32-wasip2/release/bbcom_counter_panel.wasm \
   ../../tests/fixtures/plugins/counter/component/plugin.wasm
sha256sum ../../tests/fixtures/plugins/counter/component/plugin.wasm \
   >> ../../tests/fixtures/plugins/counter/plugin.toml  # update sha256 =
```

The crate is its own cargo workspace so host builds never compile the
wasm32-wasip2 target.

## Tests

- `crates/bbcom-plugin-host/tests/counter_plugin.rs` — in-process contract:
  digest enforcement, panel lifecycle, storage persistence across a fresh
  runtime, capability denial.
- `crates/bbcom-plugin-host/tests/counter_sidecar.rs` — drives the REAL
  sidecar binary over the wire protocol: handshake, seeded state upload,
  initialize, `panel-event` invoke (returns the updated panel as JSON),
  shutdown, state read-back, clean exit.
