# ADR-0005: Plugin protocol v2, capabilities, and trust boundary

- Status: Accepted
- Date: 2026-08-19
- Decision owners: bbcom maintainers
- Supersedes: the plugin-isolation and serial-proposal decisions in ADR-0001;
  the implemented-trust claims in ADR-0004 are narrowed as described below

## Context

The plugin system needs typed, evolvable communication for protocol clients,
long firmware transfers, detached tools, native macro contributions, and atomic
file workflows without giving guests ambient host authority.

The shipped repository path currently verifies package size and SHA-256 but does
not implement the TUF roles or publisher-signature verification described by
ADR-0004. Authorization of capabilities therefore must not be presented as
publisher authentication.

## Decisions

### Version and transport

- `bbcom:plugin@2.0.0` and `bbcom.plugin.host.v2` are the only accepted plugin
  contracts. Other API generations are rejected during manifest validation and
  never enter inventory or Wasmtime.
- Hello messages advertise one major and an inclusive minor range. Peers select
  the highest common minor; no overlap or a different major is incompatible.
- Every Envelope has a non-zero, monotonic message ID. Responses and errors have
  a non-zero `reply_to`. Requests, events, cancellation, and stream messages are
  distinct typed Protobuf variants. Production operations do not dispatch by a
  method string or arbitrary JSON body.
- Frames remain limited to 1 MiB and each plugin queue to 16 MiB. Bounded unary
  chunks are at most 256 KiB and each runtime has at most 32 outstanding host
  requests. The broker also enforces at most four transport streams, but the
  v2.0 WIT deliberately exposes no generic stream resource: `StreamOpen` does
  not yet carry a generation-bound consumer handle. Native rejects unsolicited
  stream envelopes with `unavailable` until a later minor version freezes that
  binding.
- Ordinary guest calls have a two-second deadline, a blocking serial read has a
  ten-second maximum, and an explicitly long-running task has a two-hour
  maximum. A long task must produce progress, a host call, or a heartbeat at
  least every 30 seconds. One guest task executes per runtime; another command
  receives `busy`.
- Cancellation stops cancellable host waits, revokes runtime resources, and
  advances the Wasmtime epoch. A physical write that already started cannot be
  revoked and may return `unknown-outcome`; a plugin must not automatically
  retry a side-effecting operation with that outcome.
- Ordinary guest calls receive 10,000,000 Wasmtime fuel units. `initialize`
  receives a separate fixed 50,000,000-unit allowance so a guest can construct
  the maximum bounded declaration model and publish initial snapshots. This
  does not extend its ordinary two-second epoch deadline or any memory/UI
  limit; fuel exhaustion remains `limit-exceeded`.

### Capability gateway and resources

- The application-layer Plugin Capability Gateway is the only bridge from a
  sidecar to serial sessions, capture, commands/macros, native file grants,
  plugin state, project state, and plugin surfaces.
- The closed v2 capability set is `ui.workspace`, `ui.detached-window`,
  `serial.ports.read`, `serial.sessions.manage`, `serial.io`,
  `serial.control-lines`, `session.capture.read`,
  `session.commands.read-write`, `file.open-read`, `file.save-write`,
  `plugin.storage`, and `project.state.read-write`.
- All exposed serial leases, file grants, and window surfaces are bound to
  workspace, plugin, runtime instance, and generation. A binding becomes stale
  after restart, workspace replacement, or generation change and cannot be
  persisted or reused. A future generic stream resource must carry the same
  binding before native may accept it.
- The stable error taxonomy is `invalid-input`, `permission-denied`,
  `unavailable`, `busy`, `not-found`, `stale-handle`, `disconnected`, `timeout`,
  `cancelled`, `limit-exceeded`, `partial-write`, `unknown-outcome`,
  `protocol-error`, and `io-error`.

### Initialization and state migration

- `initialize` returns the authoritative surface/command model and also calls
  the typed `register-surface`/`register-command` imports before publishing a
  snapshot. The host requires both declarations to match exactly. The imports
  establish ordering in the native projection; the returned model is the
  guest-export contract and is not a second, independent declaration channel.
- All private-storage imports, project-state imports, and the
  `migrate-state` result are runtime-staged until the returned initial model
  has been validated. A migrate error, initialize error, model mismatch, or
  process failure discards the staged values and preserves the previous bytes.
- Portable v2 state is always a typed `{ schema-version, value }` record.
  `schema-version = 0` and half-present records are invalid; every non-zero
  value is guest-owned metadata and is transported and persisted unchanged.
  The host separately tracks plugin API generation (`2`) and never
  substitutes that generation for the guest schema. A guest may reject a
  schema it does not understand before decoding `value`.
- Workspace schema-2 preview rows predate explicit guest-schema metadata.
  Their one-time schema-3 migration records guest schema `1`; this is a
  compatibility interpretation only for those legacy rows, not a runtime
  default. New writes must always carry the guest-provided non-zero schema.
- Immediately before every active or preflight host launch, the native host
  reads project state again from the exact active workspace. The lifecycle
  manager's bootstrap copy is only a projection and cannot overwrite a newer
  guest commit after a same-process crash. Workspace identity mismatch fails
  closed; the read does not re-enter the lifecycle-manager mutex.
- Prepared update preflight reads the exact active private bytes, but all
  private/project writes remain in runtime memory and are discarded at
  shutdown. It creates no durable prepared-state slot. After package
  activation, the first active runtime repeats migration and commits through
  the ordinary active-state transaction, avoiding a cross-store package/state
  promotion window and orphaned prepared bytes.
- Active finalization commits private state first and portable project state
  second. If the project commit fails, the host restores the previous exact
  private bytes. This is an ordered operation with compensation across private
  file storage and SQLite, not a claim of cross-store atomicity. A failed
  compensation is surfaced as `io-error` and blocks initialization.
- Uninstall durably tombstones the plugin ID before package removal. A typed
  package failure clears that tombstone and preserves the exact old bytes; a
  successful removal deletes only identity-verified records across every
  workspace before clearing it. Cleanup failures and unknown package outcomes
  retain the tombstone, so a same-ID reinstall cannot inherit old storage.
  Startup retries tombstones only when the installer proves the ID absent. If
  a crash leaves the same ID installed, the host does not guess whether it is
  the old artifact or a reinstall: storage stays blocked until uninstall is
  retried.

### Serial ownership

- `serial.io` grants complete user-level serial I/O only through a host-owned
  exclusive protocol lease. It does not expose a native device, operating-system
  path, Tauri command, global force-close operation, or a way around the port
  and write schedulers.
- Lease acquisition drains the active physical write and pauses automatic
  writers and manual controls for that session. RX remains observable by the
  terminal, capture service, and lease in the same byte order.
- Release resumes prior automation only when session and connection generations
  are unchanged and pausing succeeded. Disconnect, plugin stop/crash/disable,
  workspace change, detached-window close, task cancellation, and application
  shutdown revoke the lease.
- Write results report requested bytes, bytes physically sent, and one of
  completed, partial-write, or unknown-outcome. Queue admission is never
  reported as physical completion.

### UI, files, and contributions

- Plugins publish bounded, revisioned UI node trees. The trusted host renders
  column, row, group, tabs, text, badge, key/value, progress, log/code, paged
  table, input, number, select, toggle, button, and confirmed-dangerous-button
  nodes. Plugins receive no HTML, script, DOM, URL, or WebView surface.
- A UI document is at most 512 KiB and 1,024 nodes. Patches identify stable node
  IDs and exact base/next revisions and apply atomically. On a revision conflict
  the plugin republishes a complete snapshot.
- A surface starts in the main plugin workspace and may be detached into one
  token-bound Tauri window. Only one view is editable. A detached window may
  exchange surface events and task cancellation only; it receives no generic
  native or serial command authority.
- Native open/save dialogs return opaque read or atomic-save grants. Plugins see
  only display name, size where applicable, and a generation-bound resource.
  Save writes target a temporary file until commit; cancel removes it. Native
  paths never enter Wasm or renderer payloads. Cancellation immediately
  detaches the plugin request and discards a late grant; an operating-system
  modal picker may remain visible until the user closes it because not every
  platform exposes a safe programmatic-dismiss operation.
- Plugin-owned quick commands and macros use
  `plugin:<plugin-id>:<local-id>` and record `ownerPluginId`. They remain usable
  by the native host while a plugin is disabled. Uninstall deletes them unless
  the user explicitly converts ownership to a normal user entry.

### Authorization and trust statement

- First enable shows the sorted requested capability set. Refusal leaves the
  plugin disabled. The grant is keyed by plugin ID and capability set: digest or
  version changes do not prompt again unless the set expands. Uninstall removes
  the grant; disable does not. Development-directory reloads retain the grant
  and are visibly marked as mutable development content.
- This explicit grant replaces v1 per-instance serial proposal confirmation.
  Dangerous UI actions still require the trusted host-rendered confirmation,
  but a granted macro or API call does not create a second permission prompt.
- SHA-256 proves artifact integrity only. The current implementation has neither
  TUF repository verification nor publisher-signature authentication, so it
  must not show a verified-publisher or stable-marketplace claim. ADR-0004's
  signing and TUF design remains a future release gate, not a description of
  implemented production behavior. Enabling a stable public marketplace still
  requires a separate reviewed trust implementation and all platform sandbox
  gates.

## Consequences

- The v2 WIT imports are the complete guest authority. Guest SDKs remain
  `no_std + alloc` and do not link WASI filesystem, network, process,
  environment, or device imports.
- Private and project state migration is guest-defined and initialization-
  staged; a failed migration or initialization does not overwrite retained v1
  bytes. The two durable stores use the compensating sequence described above,
  rather than a cross-store atomic transaction.
- Persistent plugin-created sessions belong to the workspace. Runtime sessions
  are deleted when the plugin runtime stops. Workspace read-only/degraded state
  rejects plugin persistence mutations with a typed error.
- Protocol v2 is preview-only until Linux, macOS, and Windows packaged-sidecar
  sandbox gates, protocol/security tests, and real Zephyr serial acceptance all
  pass.

## Rejected alternatives

- Giving a plugin a native serial object, path, file descriptor, Tauri API, or
  unrestricted WebView.
- Maintaining v1 and v2 execution stacks indefinitely.
- Treating an enqueued serial write as completed.
- Passing firmware or filesystem transfers through one unbounded message.
- Treating a capability grant, HTTPS, or SHA-256 as publisher identity.
