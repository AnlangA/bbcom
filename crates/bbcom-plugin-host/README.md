# bbcom plugin host v2

`bbcom-plugin-host` runs one WebAssembly Component in one sidecar process.

The host reads `plugin.toml`, loads the declared component, gives the plugin the
complete current capability set, and exchanges typed protocol-v2 messages with
the application. It does not verify package digests, signatures, publishers,
capability declarations, authorization tickets, or sandbox attestations.

Wasmtime memory, fuel, cancellation, framing, and protocol-shape limits remain
runtime correctness controls. They prevent a broken component from exhausting
the host or corrupting the message stream; they are not plugin trust checks.
