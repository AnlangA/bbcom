# bbcom plugin host

`bbcom-plugin-host` is a trusted sidecar packaged by bbcom. Each process owns
exactly one enabled Wasm Component and one Wasmtime `Store`. A repository may
provide the component named by its signed package metadata, but never a native
executable, install script, dynamic library, or replacement host.

## Security boundary

- The component is loaded only after strict `plugin.toml` validation and a
  SHA-256 match. Symlinks and non-regular files are rejected.
- The store has a 64 MiB linear-memory limit, fuel consumption, and epoch
  interruption. Normal calls have a 2 second deadline, long calls 60 seconds.
- The component linker exposes only `bbcom:plugin@1.0.0`. No WASI linker is
  installed, so plugins receive no filesystem, socket, environment, process,
  clock, random, device, shell, Tauri, or WebView authority.
- The main process must launch the sidecar with a platform sandbox enforcing a
  256 MiB process limit. This crate validates that launcher policy but does not
  attempt to weaken or emulate the operating-system sandbox.
- IPC is protobuf v3 `Envelope` framed by one little-endian `u32`. Frames are
  limited to 1 MiB and each direction has a 16 MiB bounded queue.

Protocol major mismatches are rejected. Minor versions are accepted only when
the peer uses the same major and all received fields are understood by the v1
envelope rules. The first frame must be `HostHello` within five seconds.

The stdin pump remains active while the dispatch thread is inside Wasmtime. It
registers each guest request by `Envelope.request_id`; a matching
`CancelRequest.target_request_id` sets the operation's cancellation state and
increments only this process's Store epoch through a Store-free interrupt
handle. The operation and the accepted cancellation each receive exactly one
`PLUGIN_CANCELLED` terminal response. A duplicate, unknown, or already-finished
target receives `PLUGIN_OPERATION_NOT_FOUND`. Deadline policy is unchanged:
normal calls remain bounded at two seconds and long calls at sixty seconds.
