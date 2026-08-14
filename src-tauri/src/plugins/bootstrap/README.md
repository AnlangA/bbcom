# Production plugin composition

`ProductionPluginRuntimeBuilder` is the only intended production composition
root. It has no permissive defaults and checks missing dependencies in the
stable order encoded by `PluginBootstrapError`.

Native Tauri setup must resolve and inject, in order:

1. One shared `Arc<PluginInstaller>` rooted below native application data.
2. A `VerifiedPackageProvider` assembled from reviewed HTTPS repository
   configuration, pinned TUF root/trusted state, publisher verification and the
   native fetch port.
3. A `CatalogViewPort` built from that same trusted repository view. It may
   report a verified publisher only after native publisher-signature checks.
4. `CurrentPluginWorkspace` from the Rust workspace service, including
   repository-derived installed artifact descriptors and opaque project state.
5. `NativePluginSecurityStore` from the profile data root.
6. `NativePluginStatePersistencePort` from the private application data root.
7. A `PluginSerialSchedulerPort` that submits only the already-approved
   `BrokerAction` to the application operation/port-lease runtime.
8. A `PluginHostUpstreamPort` bound to the current workspace and exact running
   host identities; it supplies authorization/proposal context and panel-event
   delivery but cannot write serial data.
9. A native `AuditSink`, stateful `ProposalBrokerPort`, and `PanelBrokerPort`.
10. `PlatformSandboxDriver::system()`, the resolved bundled sidecar executable,
    and `PrivateArtifactRoot::open(...)` for the repository package root.

`build()` invokes `SidecarHostLauncher::new`, which executes the sandbox
self-test exactly once. It then constructs `PluginManager`/`PluginService`,
observes durable installed artifacts, opens the workspace without enabling any
plugin, constructs the command core and returns the IPC adapter plus lifecycle.

After a successful build, setup must:

- put `runtime.command_service()` into `PluginCommandState` instead of the
  unavailable command service;
- retain `runtime.lifecycle()` in application-owned state;
- schedule `poll_host_exits()` from the application runtime, never a WebView;
- call `close_project()` during workspace replacement and before the native
  shutdown report can complete;
- leave `UnavailablePluginCommandService` installed when any builder step
  fails, and record only `PluginBootstrapError::code()` in diagnostics.

The market/UI gate must remain closed until G45-W, G45-M and G45-L packaged
fixtures pass. The three native implementations are fail-closed and include
their platform isolation probes, but source inspection or a cross-platform
compile is not a substitute for the packaged native-runner evidence.
