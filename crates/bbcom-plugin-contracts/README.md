# bbcom plugin contracts v2

This crate owns plugin manifests, repository metadata, and the typed native
host wire contracts. It contains no Wasmtime runtime, downloader, installer, or
plugin host implementation.

`build.rs` compiles the v2 schema with pinned `prost-build` and vendored
`protoc`. Manifests that do not select plugin API generation 2 are rejected at
the package boundary and never enter inventory or runtime state.

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

## Authority and trust boundary

The closed v2 capability set covers trusted host-rendered surfaces, serial
ports/sessions/I/O/control lines, capture pages, native quick-command and macro
contributions, opaque file grants, plugin-private storage, and portable project
state. A capability grant never gives a guest a path, native serial object,
Tauri API, WebView, socket, process, or environment access.

HTTPS and SHA-256 establish transport and artifact integrity only; they do not
authenticate a publisher. Publisher fields are informational. TUF and publisher
signature verification remain future stable-marketplace gates in ADR-0004.

Plugin packages contain one Wasm Component plus declarative metadata. Native
libraries, executables, install scripts, and symlinks are rejected.
