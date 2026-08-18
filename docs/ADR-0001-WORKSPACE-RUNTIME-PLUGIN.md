# ADR-0001: Workspace, runtime, and plugin architecture

- Status: Accepted
- Date: 2026-08-12
- Decision owners: bbcom maintainers
- Amendment: the catalog-storage sentence below is superseded by
  [ADR-0002](ADR-0002-DERIVED-WORKSPACE-CATALOG.md); all other decisions remain
  in force except the repository-trust paragraph, which is superseded by
  [ADR-0004](ADR-0004-PLUGIN-TRUST-AND-RELEASE-GATE.md).

## Context

bbcom currently persists renderer-owned session snapshots, creates resident serial
runtimes from hidden Vue components, and exits the process directly when the main
window closes. The next product line adds complete project workspaces and an
extension market. Those features require one durable state authority, application-
owned task lifetimes, and an isolation boundary for untrusted extensions.

## Decisions

### Workspace authority

- Rust is the only physical writer of project and global application databases.
- The main-window `WorkspaceCoordinator` is the only logical project writer.
- Each managed project is one SQLite file at
  `<app-data>/projects-v1/<workspace-id>.bbcom`; the verified catalog is derived
  from those files as specified by ADR-0002.
- External project files are validated and copied into the managed library. They
  are never edited in place. Writing outside the library is an explicit
  `Export Project Copy` operation through an opaque file grant.
- Opening a project restores documents and resident capture data but always
  starts offline. Serial connections, loops, triggers, macros, Modbus polling,
  replay, automatic logs, AI requests, and plugins never resume automatically.
- Portable project copies are plaintext SQLite by default. Password protection
  is optional and uses the standard age v1 passphrase format; bbcom does not
  define a custom cryptographic container.
- API keys, keyring state, file grants and paths, native handles, running request
  tokens, plugin binaries, and local permission grants are never project data.

### Runtime and operation ownership

- Serial runtimes and background operations are application-scoped services.
  Vue components attach views to them but do not own their lifetime.
- `ApplicationRuntimeRegistry` owns session runtimes;
  `OperationRegistry` owns export, import, AI, and plugin operations;
  `PortLeaseRegistry` owns process-wide serial-port exclusivity.
- A main-window close request is prevented until the application shutdown
  coordinator stops runtime activity, releases port leases, finalizes logs,
  cancels or completes background operations, and flushes project and settings
  repositories. A request identifier binds the close request to its completion.
- Persistence failures are user-visible states (`degraded` or `readOnly`), never
  log-only failures. bbcom does not silently drop unsaved capture data.

### Plugin isolation

- Untrusted plugin code is never loaded as a Rust crate, dynamic library, or
  repository-provided native executable.
- bbcom ships one trusted native `bbcom-plugin-host` sidecar. Every enabled
  plugin receives a separate host process and a separate Wasmtime Component
  Store. The plugin payload is a WebAssembly Component implementing
  `bbcom:plugin@1.0.0` WIT interfaces.
- The main process and sidecar use a versioned, length-prefixed Protobuf protocol.
  The plugin itself receives only explicitly linked WIT capabilities.
- Version 1 plugins have no ambient filesystem, network, process, serial, Tauri,
  keyring, or environment access. Panels are host-rendered declarative UI.
- Serial output is a proposal confirmed by the user and executed through
  bbcom's existing serial write scheduler. The decision is remembered only for
  the current plugin runtime instance (one prompt per
  workspace+plugin+instance+generation, per AGENTS_PLAN); no persistent
  `always allow serial send` grant exists.
- Repository trust is HTTPS plus pinned size and SHA-256. This protects transfer
  integrity, not publisher identity; the market UI must state that limitation.
  Updates are notification-only and require explicit user installation.

### Migration and compatibility

- The workspace release performs exactly one renderer-state reset. Before the
  reset, it creates and verifies an application-private legacy backup.
- The completion marker is written only after backup verification and new-store
  initialization both succeed. Failure or cancellation leaves the marker absent.
- Legacy IndexedDB and localStorage remain read-only and untouched for downgrade
  compatibility. OS keyring entries and user-created files are never reset.
- No later release may introduce another destructive reset under this migration.

## Consequences

- Existing Pinia session APIs remain behind a compatibility facade while callers
  move to document, capture, settings, and runtime services.
- Rust/TypeScript IPC types, error codes, and resource limits must be generated
  from Rust-owned contracts; manual duplicate definitions are prohibited.
- Work may be developed in parallel after its public contract is frozen, but it
  may only merge in dependency order. Root manifests, lockfiles, Tauri entry
  points, capabilities, generated contracts, locale catalogs, and migration
  indexes have a single integration owner.
- The roadmap adds no performance project. Existing performance and bundle gates
  remain regression guards with a one-time feature-budget adjustment.

## Rejected alternatives

- Editing arbitrary external project files in place.
- Renderer-owned SQLite or direct filesystem paths in WebView IPC.
- Restoring an open project by reconnecting or restarting automation.
- Loading untrusted native plugins in the bbcom process.
- Automatically installing or updating plugins.
- Treating HTTPS and SHA-256 as publisher authentication.
- A second destructive migration reset.
