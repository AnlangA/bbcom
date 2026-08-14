# Native repository fetch port

`NativeRepositoryFetchPort` is the blocking, native-only `FetchPort` for G42.
It deliberately has no background updater and is not exported to the WebView.

For every GET it validates a strict HTTPS URL, performs a fresh
`ToSocketAddrs` lookup, rejects the entire answer if any address is not public,
and pins all reviewed socket addresses with reqwest `resolve_to_addrs`. The
one-request client disables redirects, environment/system proxies, cookies,
automatic compression, and content decoding. Connect and whole-request
timeouts are both five seconds. Response bodies are read through a
`maximum_bytes + 1` limiter. A single raw `Location` value is returned to the
trust core, which remains the authority for redirect origin and count.

The adjacent `Cargo.toml` is an isolated compile harness while the shared
`plugins/mod.rs` remains owned by the integration agent. Remove its `[workspace]`
boundary when this module is added to the main Tauri module graph.
