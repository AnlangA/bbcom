# bbcom plugin contracts v1

This crate owns the plugin package, repository, permissions, and native host
wire contracts. It does not contain a Wasmtime runtime, downloader, installer,
or plugin host implementation.

`build.rs` uses exactly `prost-build 0.14.4` and the platform-specific protoc
binaries from exactly `protoc-bin-vendored 3.2.0`; the crate therefore checks
and tests without a system protoc installation.

## Compatibility rules

- The only WebAssembly interface is WIT package `bbcom:plugin@1.0.0` in
  `../../wit/bbcom-plugin-v1/`. Rust and Protobuf types are host transport and
  validation contracts; they must not introduce additional Wasm imports.
- Protocol major versions are incompatible. A peer whose `protocol_major` is
  not `1` is rejected before its payload is dispatched.
- The sidecar and application must use the exact protocol minor. A minor
  release may add optional Protobuf fields or payload variants but is packaged
  and upgraded together with the application.
- Unknown Protobuf fields are tolerated by protobuf decoding, but an unknown
  `Envelope.payload` variant is rejected because the host cannot safely route
  it. Unknown manifest and repository fields are rejected.
- Golden SDK fixtures pin the current wire encoding. The current protocol is
  `1.2`; older peers receive `PLUGIN_PROTOCOL_VERSION_UNSUPPORTED`, and state
  is never silently discarded.

## Trust boundary

HTTPS and SHA-256 establish transport integrity only. They do not establish a
publisher's identity. Publisher fields are informational only and repository
UIs display this limitation permanently.

Plugin packages contain a single Wasm Component and declarative metadata. DLL,
SO, dylib, executable, install-script, and symlink declarations are not part of
the schema and are rejected as unknown fields.
