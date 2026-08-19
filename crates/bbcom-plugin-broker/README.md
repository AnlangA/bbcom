# bbcom plugin broker v2

`bbcom-plugin-broker` is the typed, bounded mediation core. It exposes no
filesystem, network, keyring, Tauri, WebView, serial handle, path, or device API.

The broker validates every v2 Envelope before application dispatch:

- non-zero monotonic message IDs and exact reply correlation;
- the capability required by the concrete Protobuf operation;
- workspace/plugin/instance/generation bindings on every resource;
- request/response oneof shape agreement;
- UI document/revision limits and file/serial chunk limits;
- at most 32 pending host requests and four bounded streams per runtime.

Capability authorization happens before a component is instantiated and is
rechecked at the gateway. Serial I/O uses an exclusive transaction lease; queue
admission is never reported as physical completion. UI is a revisioned node
tree rendered by the trusted host, and file operations use opaque native grants.

Audit events contain only plugin identity, a fixed operation, stable error code,
and byte count. They never contain payload bytes, AI content, tokens, paths,
publisher data, or native handles.
