# bbcom plugin broker

`bbcom-plugin-broker` is the bounded mediation core. It exposes no filesystem,
network, keyring, Tauri, WebView, serial handle, or device API.

Manifest-declared capabilities that the host implements are granted
automatically. Unknown capabilities are rejected by the contracts layer;
known but unwired capabilities are reported as unavailable.

`serial.write-proposal` never grants direct serial access. The broker creates a
bounded proposal, validates it against the current operation/session context,
and produces a single-use action only after the current runtime generation has
been accepted. Panels use only the bounded declarative controls: text, number,
toggle, select, and button.

Audit events contain only plugin ID, a fixed operation, a stable error code,
and a byte count. They cannot contain payload bytes, AI content, tokens, paths,
publisher data, or handles.

Fixed limits:

- One broker frame: 1 MiB.
- One direction's admitted queue: 16 MiB.
- Normal mediation: 5 seconds; sidecar calls remain bounded to 2 seconds.
- Long-running mediation and serial confirmation: 60 seconds.
