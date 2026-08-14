# bbcom plugin broker

`bbcom-plugin-broker` is the trusted G43 mediation core. It is deny-by-default
and exposes no filesystem, network, keyring, Tauri, WebView, serial handle, or
device API.

## Authorization boundary

- Protocol v1 implicitly grants only `ui.panel` and `plugin.storage`.
- Every other reusable grant is looked up using the complete G40
  `AuthorizationKey`: plugin ID, publisher identity, plugin major version, and
  workspace ID. Missing, denied, differently scoped, and unavailable-store
  records all fail closed.
- `publisher_identity` has a deliberately narrower broker meaning than display
  metadata: it must be the canonical
  `publisher:sha256-<64 lowercase hex>` fingerprint of an upstream-verified
  publisher public key. Cryptographic package/index verification belongs to
  G42/G46 and is a prerequisite for constructing this key. The broker rejects
  names and unverified identities; it does not claim to verify signatures.
- `AuthorizationStore` is injected by the application and must use
  application-profile storage outside `.bbcom` project data and plugin-private
  storage. Its API accepts no path.
- `serial.write-proposal` can never be persisted. Each bounded proposal is
  approved once against the same operation and session. Rejection, expiration,
  context changes, and replay produce no action.
- Network is a review-only risk marker in v1. It is always unavailable. A
  capture/AI-read plus network request sets `extra_confirmation`, even though
  no network execution path exists.

## Declarative UI and audit

Panels use only the five controls in `bbcom:plugin@1.0.0`: text, number,
toggle, select, and button. The v1 panel is flat (depth one), bounded, and
rejects HTML, script-like text, and URLs. The trusted host renders it.

Audit events are structurally limited to plugin ID, a fixed operation, a stable
error code, and a byte count. They cannot contain payload bytes, AI content,
tokens, paths, publisher data, or handles.

## Fixed limits

- One broker frame: 1 MiB.
- One direction's admitted queue: 16 MiB.
- Normal broker mediation: 5 seconds (the Wasm host remains stricter at 2
  seconds).
- Long-running mediation: 60 seconds.
- Serial confirmation lifetime: 60 seconds.
