# G45 packaged-host Component fixtures

`g45-malicious.component.wasm` is intentionally reviewed Component Model text,
despite the workflow-stable `.wasm` filename. The installed application compiles
the exact bytes with the pinned `wat` parser and records both the source and
compiled binary SHA-256 digests before launching the packaged
`bbcom-plugin-host`.

The fixture suite proves only behavior that a bbcom v1 Component can actually
exercise: typed host instantiation and handshake, rejection of an undeclared
WASI socket import, Wasm trap classification, runaway-code bounding, the Wasm
memory ceiling, and oversized framed-IPC rejection. Persistent broker permission
denial remains in the reused platform-independent host-state contract test and
is not repeated here. A v1 Component has no linked WASI,
socket, process, filesystem, device, environment, WebView, DOM, or Tauri import,
so the suite does not claim that the Component attempted those ambient actions.
Native sandbox self-test results are emitted separately and must not be
relabelled as Component observations.
