# Production plugin composition

`ProductionPluginRuntimeBuilder` is the only production composition root. It
has no permissive defaults and returns a stable bootstrap error when a required
port cannot be constructed.

Native setup injects one shared installer, the native unsigned-HTTPS source
registry, the matching catalog projection, the active workspace bindings,
private plugin storage, the serial result scheduler, sidecar upstream ports,
bounded brokers, the platform sandbox, and the bundled sidecar path.

`build()` runs the sandbox self-test before constructing the manager and actor.
The application retains one runtime for the process, polls host exits natively,
and opens/closes workspace contexts through lifecycle hooks. Any composition
failure leaves the unavailable command service installed.

Remote indexes are cached by native code. Fetching an index never installs a
package; package download, SHA-256 verification, installation, and version
switching happen only after an explicit user action.
