# hello-panel example plugin

A minimal, complete bbcom plugin. It demonstrates every layer of the v1
plugin platform without touching application code:

- the guest side of the `bbcom:plugin/plugin@1.0.0` WIT world
  (`wit/bbcom-plugin-v1/plugin.wit`), written as reviewed WAT text following
  the conventions of `tests/fixtures/plugins/malicious`,
- the `plugin.toml` manifest format and on-disk package layout,
- the SHA-256 artifact trust gate,
- guest → host capability calls (`storage-set`), and
- the sidecar's length-prefixed protobuf protocol, driven end to end.

## What the plugin does

`initialize` calls the `storage-set` host import to persist a greeting and
returns a declarative panel with one toggle field:

```text
Hello Panel (beacon off)
  └─ Beacon [toggle] = off
```

`handle-panel-event` returns the "on"/"off" panel variant depending on the
event value (`"on"` switches the beacon on). `shutdown` is a no-op. The plugin
requests no capabilities beyond the implicit `ui.panel` + `plugin.storage`.

## Files

| File | Purpose |
| ---- | ------- |
| `plugin.wat` | The guest Component source (compiled and pinned at run time). |
| `../../crates/bbcom-plugin-host/examples/hello_panel.rs` | Runner that packages, verifies, and executes the plugin. |

## Running it

```sh
cargo build -p bbcom-plugin-host --example hello_panel --bin bbcom-plugin-host
cargo run -p bbcom-plugin-host --example hello_panel
```

Expected output (package root paths vary):

```text
== stage 1: package assembly ==
compiled component: 2041 bytes, sha256 9d8fc2a9...
wrote plugin.toml + component/plugin.wasm under /tmp/…
== stage 1: tamper rejection ==
flipped byte rejected with PLUGIN_COMPONENT_HASH_MISMATCH
== stage 2: in-process engine ==
initialize: panel published, guest called the storage-set host import
persisted storage: hello.greeting = Hello from the hello-panel plugin!
shutdown: clean
== stage 3: sidecar process ==
handshake: plugin dev.bbcom.hello-panel 1.0.0 (bbcom:plugin@1.0.0)
state upload: 2 bytes accepted
initialize: revision 1, plugin storage 56 bytes
persisted storage: hello.greeting = Hello from the hello-panel plugin!
shutdown prepared: revision 2, plugin storage 56 bytes
complete shutdown: sidecar state persisted, process exiting
sidecar exited with 0
```

Stage 2 uses `PluginEngineFactory`/`PluginRuntime` — the exact engine the
sidecar embeds. Stage 3 spawns the real `bbcom-plugin-host` binary (no OS
sandbox in the example; the production launcher additionally wraps it in
bubblewrap/Seatbelt/AppContainer) and speaks the framed protocol:

`HostHello → PutStateChunk → InitializeRequest → GetStateChunk →
ShutdownRequest → CompleteShutdownRequest`

## Package layout produced by the runner

```text
<package root>
├── plugin.toml            # manifest, sha256 pins the compiled component
└── component/
    └── plugin.wasm        # Wasm Component binary (wat::parse_bytes output)
```

with this manifest (digest filled in at run time):

```toml
id = "dev.bbcom.hello-panel"
name = "Hello Panel Example"
version = "1.0.0"
api = "^1.0"
requested-capabilities = []

[component]
path = "component/plugin.wasm"
sha256 = "<64-hex-digit sha256 of plugin.wasm>"

[publisher]
name = "bbcom Examples"
identity = "publisher:bbcom-examples"
website = "https://example.invalid"
```

## Notes for plugin authors

- There is no plugin-author SDK yet: a plugin is any WebAssembly Component
  satisfying the world `bbcom:plugin@1.0.0`. This example hand-writes the
  component in WAT; a Rust guest would normally be built with
  `cargo-component`/`wit-bindgen` against `wit/bbcom-plugin-v1/plugin.wit`.
- Types referenced by imported or exported functions must be *named* types of
  the matching kind, so the component imports the
  `bbcom:plugin/types@1.0.0` interface first and reuses its aliased types for
  both the host import and the world exports (imported types are valid in
  export positions).
- Results that flatten to more than one core value (e.g.
  `result<declarative-panel, string>`) are passed indirectly: exports return
  a pointer to a guest return area, and lowered imports receive a trailing
  return-area parameter.
- No WASI is linked. Any ambient import (files, sockets, clocks, random)
  fails instantiation with `PLUGIN_COMPONENT_INVALID`.
- Distribution to real users goes through the signed TUF-style repository and
  the `plugin_install` Tauri command; the packaged-app repository adapters
  are intentionally empty until reviewed metadata exists (ADR-0004). The
  runner here exercises the trust and runtime machinery directly instead.
- `handle-panel-event` is part of the v1 world but the sidecar protocol does
  not dispatch panel events yet (`InvokeRequest` currently answers
  `PLUGIN_OPERATION_NOT_FOUND`-style unsupported-method errors), so the
  example drives `initialize`/`shutdown` only.
