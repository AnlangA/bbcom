# bbcom plugin manager

This crate is the trusted application-level state machine between the plugin
repository, authorization broker, and one-process-per-plugin host. It does not
launch a platform process or edit installation files itself. Those operations
are injected through narrow ports whose atomicity and isolation requirements
are part of the API contract.

Lifecycle policy is fixed:

- installation and updates are manual;
- opening a project stops every plugin and never starts one;
- a permission expansion remains staged and disabled until a fresh review;
- an update preflights the new component against a private copy of plugin data
  before atomically switching package and data;
- three unexpected exits inside ten minutes disable the plugin and atomically
  restore the newest eligible previous version and its data snapshot;
- rollback never starts a plugin and never bypasses an artifact revocation;
- project state is bounded opaque data, including state for unknown plugins.

`bbcom-plugin-repository::PluginInstaller::activate_rollback` now provides the
atomic package-and-data rollback commit needed by a native `InstallationPort`
adapter. The application still has to supply that adapter, private prepared
storage, the sidecar launcher, revocation source, and authorization receipt
store; this crate deliberately does not claim those platform integrations.
