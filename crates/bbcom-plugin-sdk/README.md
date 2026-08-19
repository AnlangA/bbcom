# bbcom-plugin-sdk

Guest-side, `no_std + alloc` building blocks for `bbcom:plugin@2.0.0`.

The SDK contains no filesystem, socket, process, environment, serial-port, or
WASI implementation. Plugins receive host-owned serial leases and file grants
through generated WIT bindings, then adapt those bindings to the traits in this
crate. Resource identifiers are opaque and generation-bound.

The crate is a root-workspace member, but it remains independent of native
bbcom crates so a guest Component cannot inherit their host authority.

## Initialization transaction

`initialize` must register every initial surface and command through the WIT
host imports before publishing a snapshot, then return the exact same
declarations in `plugin-model`. Use `model::register_initial_model` to keep the
registration order and exported model source aligned. The host rejects a
duplicate or mismatch and discards all state staged during initialization.
