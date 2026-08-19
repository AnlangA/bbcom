# bbcom plugin host v2

`bbcom-plugin-host` is the trusted sidecar packaged by BBCOM. Each process owns
exactly one authorized WebAssembly Component and one Wasmtime `Store`.

## Security boundary

- A component is loaded only after strict `plugin.toml` validation, SHA-256
  verification, exact requested-capability comparison, and an application-issued
  launch authorization ticket. A non-v2 manifest fails before Wasmtime parsing.
- The Store has a 64 MiB linear-memory limit, fuel, and epoch interruption.
  Ordinary calls receive 10,000,000 fuel units; declaration-heavy
  `initialize` receives a fixed 50,000,000 while retaining the same two-second
  deadline. A declared long task may run for two hours only while it produces a
  host call, progress update, or heartbeat at least every 30 seconds.
- The linker exposes only `bbcom:plugin@2.0.0`. No WASI linker is installed, so
  guests receive no filesystem, network, environment, process, native serial,
  shell, Tauri, or WebView authority.
- The application launches the sidecar inside the platform sandbox with a
  256 MiB process limit. The host validates the launch policy; packaged Linux,
  macOS, and Windows gates prove the OS-specific enforcement separately.
- IPC uses typed Protobuf v2 Envelopes framed by one little-endian `u32`. Frames
  are limited to 1 MiB and each direction has a 16 MiB bounded queue.

Only one guest operation executes at a time; another command receives `busy`.
Cancellation marks the exact message, cancels host waits, revokes generation-
bound resources, and increments this Store's epoch. A physical serial write
that already started is not presented as safely cancelled and may return
`unknown-outcome`.

Host imports are mediated by the application capability gateway. Serial leases,
file grants, UI surfaces, tasks, and contributions cannot outlive their
workspace/plugin/instance/generation binding.
