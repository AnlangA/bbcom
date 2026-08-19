# G45 packaged-host Component fixtures

All five reviewed fixtures implement the real `bbcom:plugin@2.0.0` guest
contract. The primary artifact keeps its workflow-stable `.wasm` filename but
contains Component Model text, as do the four `.wat` variants. The installed
application compiles those exact reviewed bytes with the pinned `wat` parser
and records both source and compiled binary SHA-256 digests before launching
the packaged `bbcom-plugin-host`.

The suite exercises:

- the complete v2 handshake and all five guest exports;
- rejection of an undeclared WASI socket import;
- Wasm trap classification;
- runaway-code fuel or timeout bounding;
- the 64 MiB Wasm memory ceiling;
- oversized framed-IPC rejection.

The Components have no linked WASI, socket, process, filesystem, device,
environment, WebView, DOM, or Tauri authority. The ambient variant declares an
unlinked `wasi:sockets/network@0.2.0` instance solely to prove that
instantiation fails closed. Native sandbox self-test results remain separate
and must not be relabelled as Component observations.

## Reproducible source

`guest/` is a standalone, no-WASI Rust Component workspace. Its four mutually
selected features produce the primary, trap, runaway, and memory behavior.
The shared `bbcom-component-to-wat` tool converts each binary Component into
the checked-in reviewable WAT and injects the ambient import into a copy of the
primary fixture.

Regenerate every fixture from the repository root with:

```sh
bash tests/fixtures/plugins/malicious/generate.sh
```

The generator uses locked manifests and never adds the fixture guest to the
root Cargo workspace. CI regenerates the suite and requires a clean diff, so a
WIT or toolchain change cannot silently leave stale fixtures behind.

`crates/bbcom-plugin-host/tests/g45_v2_fixtures.rs` production-parses and
instantiates the primary fixture through `PluginEngineFactory`, calls
`initialize`, `handle-event`, `run-command`, `migrate-state`, and `shutdown`,
and verifies the three malicious initialization classifications plus the
ambient-link rejection.
