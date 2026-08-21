# ADR-0005: Simplified plugin protocol v2

- Status: Accepted
- Date: 2026-08-20

## Decision

BBCOM plugins are WebAssembly Components implementing `bbcom:plugin@2.0.0`.
The application starts one bundled sidecar process for each running plugin and
exchanges length-prefixed protocol-v2 messages with it.

`plugin.toml` is parsed only for component location and display metadata. API,
digest, publisher, and requested-capability fields are compatibility metadata;
they do not gate installation or launch. Every plugin receives the complete
current host capability set. There is no capability prompt, stored grant,
authorization ticket, signature check, digest check, publisher authentication,
marketplace readiness probe, or platform sandbox probe.

The host retains the runtime controls needed for correct operation: Wasmtime
component parsing, memory/fuel/deadline limits, bounded message framing,
resource-generation routing, cancellation, serial transaction ordering, and
workspace lifecycle cleanup. These controls are not presented as plugin trust
or package validation.

AI configuration is unrelated to plugins and is stored as ordinary JSON in the
application data directory. No keychain or encryption migration participates
in application startup.

## Consequences

- Local development directories can be installed and reloaded without digest
  or capability synchronization.
- A plugin with missing, stale, or unknown requested-capability declarations
  still receives all implemented capabilities.
- Plugin packages are not authenticated or isolated from the current user
  beyond the WebAssembly Component runtime itself.
- Filesystem path normalization and protocol-shape checks remain because they
  protect the application from corrupting its own state.
