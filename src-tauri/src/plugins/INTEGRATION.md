# Native plugin integration checklist

- Keep package paths, source caches, private state, sidecar handles, and serial
  handles out of renderer contracts.
- Share one canonical installer between package installation and host
  resolution.
- Treat publisher fields as informational; enforce package and component
  SHA-256 integrity without publisher authentication.
- Start one sidecar process per enabled plugin and retain the process-lifetime
  manager/actor in native application state.
- Run the platform sandbox self-test before exposing the plugin command service.
- On Windows, stage the packaged sidecar by SHA-256 below the user-owned
  application-data root before granting the AppContainer read/execute ACL;
  never require permission changes under the application install directory.
- Keep project state in workspace persistence and private `plugin.storage`
  below the application-data state root.
- Validate revisioned surface publications and events through the typed
  capability gateway.
- Route serial access through generation-bound transaction leases and return
  the real scheduler result after physical completion.
- Fetch remote indexes for update discovery only; downloading, installing, and
  switching a version always requires a user command.
- Close or rebind plugin runtimes during workspace transitions and stop them
  before native shutdown completes.

Invocation cancellation remains correlated by request ID and Wasmtime epoch;
late, unknown, or duplicate cancellation cannot affect another operation.
