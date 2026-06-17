# bbcom Architecture

This guide is for maintainers who need to change bbcom without re-discovering
the serial, rendering, persistence, and IPC boundaries from scratch.

bbcom is a Tauri 2 desktop application with a strict-TypeScript Vue frontend and
a Rust backend. The most important ownership rule is simple: the frontend owns
sessions and protocol behavior; Rust owns privileged desktop work and small,
typed command surfaces.

## Topology

```text
┌────────────────────────────────────────────────────────────────────┐
│ Webview: Vue 3 + Pinia + Naive UI                                  │
│                                                                    │
│ components/                                                        │
│   app-shell/      main layout, settings, session creation          │
│   session/        session view + toolbar                           │
│   terminal/       packet list, parser, Modbus, waveform panels     │
│   send-panel/     quick commands, macros, triggers, highlights     │
│   ai/             assistant settings and log assistant UI          │
│                                                                    │
│ composables/                                                       │
│   useSerialConnection   serial open/listen/write/reconnect         │
│   useModbusMaster       Modbus read/write/replay orchestration     │
│   useSessionFrames      frame append/clear helpers                 │
│   usePacket*            virtual scroll, filters, format cache      │
│   useExport             dialog + export command routing            │
│   useAutoLog            ordered per-session log appends            │
│                                                                    │
│ stores/                                                            │
│   sessions              all session state and persistence          │
│   serial                available ports and selected config        │
│   app                   theme, language, AI and global settings    │
│                                                                    │
│ lib/                                                               │
│   modbus/               protocol core, batching, transport, loops  │
│   serial-rx-queue       bounded RX buffering                       │
│   protocol-parser       delimiter/fixed/length frame parsing       │
│   waveform*             parsing, viewport math, canvas rendering   │
│   session-persistence   versioned snapshot migration               │
│   ipc                   typed Tauri command wrappers               │
└───────────────┬────────────────────────────────────────────────────┘
                │ Tauri invoke/listen/events
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Rust backend: src-tauri/src/                                       │
│                                                                    │
│ commands/     ai, checksum, export, log, updater, window commands  │
│ export/       TXT/CSV/JSONL/BIN formatters                         │
│ models/       IPC structs and AppError                             │
│ utils/        checksum, HEX, timestamp helpers                      │
│ benches/      checksum/export hot-path benchmarks                   │
└────────────────────────────────────────────────────────────────────┘
```

## Runtime Ownership

- **Frontend session store:** source of truth for ports, frames, parser state,
  Modbus config, macros, triggers, highlights, AI chat state, and persisted
  snapshots.
- **Frontend protocol engines:** parser, waveform, Modbus, triggers, macro
  control flow, and `.bbrec` replay are implemented in framework-free TypeScript
  where possible so they can be unit-tested headlessly.
- **Rust command layer:** filesystem export/logging, checksum calculation,
  updater wrapper, AI network calls, and window management.
- **Tauri plugins:** serialplugin provides serial port access, dialog provides
  save/open UI, store persists local secrets, updater checks releases when
  configured.

## Data Flows

### RX: device to screen

1. `tauri-plugin-serialplugin` emits raw bytes to `useSerialConnection`.
2. Raw-byte observers receive the exact plugin chunk first. Modbus uses this
   path to validate CRCs and match responses before display coalescing happens.
3. The chunk enters `SerialRxQueue`, which caps pending bytes/chunks and records
   cumulative drops.
4. A single `requestAnimationFrame` drains pending chunks into one RX
   `DataFrame`.
5. `useSessionFrames` appends the frame to the session store, auto-log appends
   it if enabled, and trigger rules inspect the completed RX frame.

### TX: caller to device

1. Quick commands, send history, cyclic send, macros, triggers, AI fill, and
   Modbus all enter `useSerialConnection.send` or `sendBytes`.
2. Text/HEX sends pass through `buildSendPayload` for validation and encoding.
3. A single `writeChain` promise serializes every `writeBinary` call in order.
4. A TX `DataFrame` is appended only after the port write succeeds.

### Persistence

1. Mutators call `schedulePersist`.
2. The sessions store emits the explicit frame/reactivity pulse and debounces
   snapshot writes.
3. `serializeSessionSnapshots` caps persisted sessions, frame count, and bytes.
4. Load runs `migratePersistedFile` before hydration. Any persisted shape change
   must bump `SESSION_STORAGE_VERSION`, add a migration step, and include a
   legacy-data regression test.

### Export

- The legacy export command accepts a frame array directly.
- The default large-export path writes frames to a temporary JSONL capture file,
  sends only that path through IPC, then Rust reads and formats the capture.
  This avoids serializing large `Uint8Array` payloads into one huge invoke
  argument.

## Engineering Invariants

These are the rules most likely to protect users from subtle serial bugs:

- **All serial writes are single-filed.** Do not bypass `send`/`sendBytes` or the
  `writeChain`; concurrent serial writes can interleave at the driver.
- **Modbus is half-duplex.** Keep one outstanding transaction at a time through
  `ModbusTransactionRunner` and `ModbusLoopCoordinator`.
- **RX bytes reach protocol observers before display batching.** Protocol
  engines need exact chunks; UI frames may be coalesced.
- **Frame arrays stay shallow.** Large captures must not depend on Vue deep
  reactivity. Use `framesVersion`, `triggerRef(sessions)`, and raw frame items.
- **Auto-log preserves append order.** `useAutoLog` chains writes per session;
  Rust `append_log` is stateless.
- **Persistence remains forward-compatible.** Shape changes require an explicit
  migration and test.
- **Hot paths stay framework-free when practical.** Queueing, formatting,
  parsing, Modbus batching, waveform math, and export filters should remain
  testable without a Tauri webview.

## Upstream Constraints

- The serial plugin's timeout affects both read timeout and event flush cadence;
  raising it changes UI latency as well as port behavior.
- `listen(callback, false)` is intentional: it avoids a per-chunk text decoder
  in the JS path. Binary data should use binary read/write APIs.
- Tauri IPC can turn small binary payloads into number arrays; do not introduce
  a channel-based "optimization" without measuring both small and large packets.
- `zai-rs` model types are concrete and not object-safe for the current dispatch
  path, so supported AI models are selected with an explicit match table in
  Rust and mirrored by the frontend registry.
- The updater plugin is configured but inactive until release endpoints and
  signing keys are provided.

## Quality Gates

| Area | Command |
| --- | --- |
| Frontend lint | `pnpm lint` |
| Formatting | `pnpm format:check` |
| Type-check + frontend build | `pnpm build` |
| Frontend tests | `pnpm test:frontend` |
| Rust tests | `pnpm test:rust` |
| Frontend coverage | `pnpm coverage:frontend` |
| `src/lib/` per-file coverage | `pnpm coverage:lib` |
| Frontend benchmarks | `pnpm bench:frontend` |
| Rust benchmarks | `pnpm bench:rust` |
| TypeScript import cycles | `pnpm cycles` |
| Common local gate | `pnpm check` |

CI runs the frontend lint/format/build/test/coverage/benchmark/cycle jobs and
Rust fmt/clippy/test jobs. Rust coverage is collected as a best-effort
tarpaulin artifact rather than a hard gate.

## Manual Verification

The headless tests cover the pure logic, IPC contracts, and hot-path helpers.
The following paths still need a real desktop runtime, serial device, PTY pair,
or external credential:

- Connect, disconnect, reconnect, DTR/RTS, and BREAK behavior.
- Sustained high-baud captures from a real serial source.
- End-to-end export through native save dialogs.
- Live Modbus RTU/PDU polling, writes, and replay against a device.
- Waveform canvas rendering and parser panel interactions in the app.
- Light/dark visual inspection.
- Live Z.ai requests with a valid API key and network access.

When reporting a manual failure, include platform, device/baud, transport mode,
reproduction steps, and the relevant log line or captured frame.

## Change Checklist

- Serial write path changed: confirm every caller still uses `send` or
  `sendBytes`, then run frontend tests that cover send payloads, macros,
  triggers, and Modbus.
- RX buffering changed: run queue, packet list, parser, waveform, trigger, and
  benchmark tests.
- Persisted session shape changed: bump the version, add a migration, and add a
  legacy snapshot test.
- Export changed: test TXT/CSV/JSONL/BIN plus capture-file and legacy paths.
- AI model changed: update both `src/lib/ai-models.ts` and
  `src-tauri/src/commands/ai/service.rs`.
- Modbus changed: run the full Modbus frontend test set and manually test with
  a device when transport timing changed.
