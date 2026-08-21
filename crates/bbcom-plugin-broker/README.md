# bbcom plugin broker v2

`bbcom-plugin-broker` routes typed protocol-v2 messages between a plugin host
process and the application services.

The broker validates every v2 Envelope before application dispatch:

- non-zero monotonic message IDs and exact reply correlation;
- the capability required by the concrete Protobuf operation;
- workspace/plugin/instance/generation bindings on every resource;
- request/response oneof shape agreement;
- UI document/revision limits and file/serial chunk limits;
- at most 32 pending host requests and four bounded streams per runtime.

Every plugin receives the complete current capability set. Serial I/O still
uses an exclusive transaction lease so concurrent application writes remain
ordered. UI is a revisioned node tree rendered by the host, and file operations
use application-owned handles.

Audit events contain only plugin identity, a fixed operation, stable error code,
and byte count. They never contain payload bytes, AI content, tokens, paths,
publisher data, or native handles.
