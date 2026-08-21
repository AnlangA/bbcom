# bbcom plugin contracts v2

This crate owns plugin manifests, repository metadata, and the typed native
host wire contracts. It contains no Wasmtime runtime, downloader, installer, or
plugin host implementation.

`build.rs` compiles the v2 schema with pinned `prost-build` and vendored
`protoc`. A manifest supplies component location and display metadata; legacy
API, digest, publisher, and capability fields do not gate loading.

## Compatibility rules

- The executable WebAssembly interface is `bbcom:plugin@2.0.0` in
  `../../wit/bbcom-plugin-v2/plugin.wit`.
- Protocol majors are incompatible. Peers with major 2 negotiate the highest
  common minor from inclusive ranges. Unknown Protobuf fields follow normal
  Protobuf compatibility rules; unknown payload variants are rejected.
- Every Envelope has a non-zero monotonic message ID. Replies carry `reply_to`;
  requests, responses, events, cancellation, and streams are distinct typed
  variants.
- One frame is limited to 1 MiB, one direction's queue to 16 MiB, and a stream
  chunk to 256 KiB. A runtime has at most four streams and 32 pending host
  requests.
- WIT, Protobuf, renderer IPC projections, and resource-limit validators are
  tested together. Adding a capability or operation requires updating all four
  boundaries and their shape tests.

## Runtime capabilities

The v2 capability set covers host-rendered surfaces, serial
ports/sessions/I/O/control lines, capture pages, native quick-command and macro
contributions, opaque file grants, plugin-private storage, and portable project
state. A capability grant never gives a guest a path, native serial object,
Tauri API, WebView, socket, process, or environment access.

Every plugin receives the complete current capability set automatically. The
host performs no digest, signature, publisher, requested-capability,
authorization-ticket, or marketplace-trust validation.
