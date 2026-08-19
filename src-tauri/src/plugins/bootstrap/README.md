# Production plugin composition

`ProductionPluginRuntimeBuilder` is the only production composition root. It
has no permissive defaults and returns a stable bootstrap error when a required
port cannot be constructed.

Native setup injects one shared installer, the native unsigned-HTTPS source
registry, the matching catalog projection, the active workspace bindings,
private and project state ports, the v2 capability gateway, authorization
coordinator, file grants, surface/task projection, detached-window service, the
platform sandbox, and the bundled sidecar path.

On Windows, native setup copies the verified bundled sidecar into the
content-addressed `plugin-host-v2` application-data directory. The sandbox ACL
lease is applied to that user-owned copy, so installed builds do not depend on
permission to modify files under Program Files.

`build()` runs the sandbox self-test before constructing the manager and actor.
The application retains one runtime for the process, polls host exits natively,
and opens/closes workspace contexts through lifecycle hooks. Any composition
failure leaves the unavailable command service installed.

Remote indexes are cached by native code. Fetching an index never installs a
package; package download, SHA-256 verification, installation, and version
switching happen only after an explicit user action. SHA-256 is integrity, not
publisher authentication; ADR-0004's TUF/signature design is still a future
stable-marketplace gate.
