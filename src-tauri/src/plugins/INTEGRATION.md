# Native plugin integration checklist

This directory is deliberately not renderer-facing. The following shared-file
changes are required before enabling it; they must be made by the integration
owner rather than hidden inside this module.

1. The native plugin crates, security store, sandbox module, sidecar bundle,
   and main-window-only typed command boundary are now linked. Keep them
   renderer-inaccessible until the remaining service adapter and G45 gates
   below are complete.
2. Construct `NativeRepositoryStagingBackend` with the native-only trusted
   repository pipeline, and share its `PluginInstaller` with
   `RepositoryArtifactPathResolver`. Canonical TUF decoding, Ed25519
   verification, rollback-protected trust state, public-address-only HTTPS
   fetching, durable prepare/commit/discard journals, and opaque active/staged
   path resolution exist. Production still needs reviewed repository
   configuration and pinned root metadata before a `VerifiedPackageProvider`
   may be constructed.
3. Linux has a fail-closed bubblewrap/seccomp/RLIMIT driver, macOS has a
   fail-closed Seatbelt/RLIMIT driver, and Windows creates a unique
   zero-capability AppContainer with per-SID, reference-counted read-only
   package/sidecar ACL leases and a kill-on-close single-process 256 MiB Job
   before resuming the suspended child. Every platform self-test
   executes filesystem, network, child-process, memory, crash-observation and
   hung-process termination probes. Packaged G45 evidence is still required on
   all three native runners; an incomplete or unavailable self-test prevents
   `PluginService` construction.
4. Package `bbcom-plugin-host` as a trusted sidecar and resolve its native path
   in Tauri setup. Construct one `SidecarHostLauncher` and one process-lifetime
   `PluginService`; schedule `poll_host_exits` in the native runtime.
5. **Protocol/persistence complete.** Protocol 1.1 uses versioned, bounded
   initialize/shutdown messages plus offset-checked opaque state chunks.
   `HostLaunchRequest::project_state` and private `plugin.storage` are injected
   without paths, initialization and shutdown changes are returned explicitly,
   and `PluginStatePersistencePort` atomically enforces the 16 MiB/plugin and
   64 MiB/workspace limits. The two-phase shutdown keeps the host alive until
   the returned state is persisted. Production setup must inject the native
   port; there is no permissive default. Structured memory/timeout/protocol exit
   classification remains part of item 4's platform process-monitor wiring.
6. Native authorization and revocation stores now bind the plugin, verified
   publisher fingerprint, major version, workspace and reviewed permission
   set. Inject those stores into `PluginManager`; absence, mismatch, corruption
   or read failure remains fail-closed.
7. On workspace open, call `open_project`; do not enable plugins. On workspace
   close and application shutdown, call `close_project` before completing the
   native shutdown report.
8. Keep plugin host spawn, package paths, repository staging paths, approval
   receipts and revocation state out of commands, events, capabilities and
   generated renderer bindings. The main-window-only G43 command surface and
   renderer adapter expose only reviewed snapshots/proposals. Its native
   adapter requires a real trusted catalog, current-workspace upstream,
   authorization broker, serial scheduler and exact host instance; setup must
   retain the unavailable service until every dependency is constructible.
9. Do not mark G45/G46 complete until all three platform sandbox and malicious
   package fixtures pass in packaged artifacts.

Active invocation cancellation is implemented without widening the protocol:
the frame pump keeps reading during a guest call, correlates
`CancelRequest.target_request_id`, sets the operation cancellation flag and
interrupts Wasmtime by epoch. Completion and cancellation are linearized, so a
late/unknown/duplicate cancellation is reported as
`PLUGIN_OPERATION_NOT_FOUND` and never affects another operation or plugin.
