# Plugin runtime composition

`ProductionPluginRuntimeBuilder` connects the installer, lifecycle manager,
workspace state, capability gateway, UI projection, and bundled sidecar.

The application launches the sidecar directly. There is no authorization
coordinator, platform sandbox probe, marketplace trust gate, signature check,
or plugin digest gate. If a required runtime dependency is unavailable, the
plugin command service reports a stable bootstrap error and retries when the
workspace changes.
