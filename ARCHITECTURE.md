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
│ commands/     ai, checksum, export/log session, window commands    │
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
- **Frontend protocol engines:** parser, waveform, Modbus, triggers, and simple
  send/delay macros are implemented in framework-free TypeScript where possible
  so they can be unit-tested headlessly.
- **Rust command layer:** opaque file grants, streaming export/logging,
  checksum calculation, bounded AI network calls, OS credential storage, and
  window management.
- **Tauri plugins:** serialplugin provides binary serial channels. Native save
  dialogs and credential access remain behind allowlisted Rust commands; no
  updater plugin is shipped.

## Data Flows

### RX: device to screen

1. `tauri-plugin-serialplugin` delivers raw binary channel data to the resident
   session runtime.
2. Raw-byte observers receive the exact plugin chunk first. Modbus uses this
   path to validate CRCs and match responses before display coalescing happens.
3. The chunk enters `SerialRxQueue`, capped at 2 MiB/512 chunks, which records
   cumulative drops.
4. The runtime drains at 64 KiB, 64 chunks, or 16 ms; protocol, trigger,
   Modbus, and logging consumers therefore do not depend on animation frames.
5. `useSessionFrames` appends the coalesced display frame and increments only
   that session's frame version. UI painting is throttled separately.

### TX: caller to device

1. Quick commands, send history, cyclic send, macros, triggers, AI fill, and
   Modbus all enter the session's `SerialWriteScheduler`.
2. Text/HEX sends pass through `buildSendPayload` for validation and encoding.
3. One bounded FIFO operation owns a logical send and writes 4096-byte chunks;
   writers cannot interleave and failed chunks are never retried automatically.
4. A complete TX frame is appended only after full success. A failed write
   records only its confirmed prefix and an explicit partial status.

### Persistence

1. Mutators call `schedulePersist`.
2. Frame mutations increment a per-session version; config mutations do not
   invalidate unrelated frame consumers.
3. `serializeSessionSnapshots` caps persisted sessions, frame count, and bytes.
4. Load validates and migrates before hydration. A future schema is copied to a
   recovery key and persistence becomes read-only instead of overwriting it.

### Export

- The main window requests an opaque, purpose-bound save grant; frontend code
  never sends an arbitrary output path to Rust.
- `begin/append/finish/abort` export sessions accept at most 256 frames and
  512 KiB of raw payload per batch. Rust formats incrementally into a sibling
  part file and atomically replaces the target only after a successful finish.

## Engineering Invariants

These are the rules most likely to protect users from subtle serial bugs:

- **All serial writes are single-filed.** Do not bypass `send`/`sendBytes` or the
  `writeChain`; concurrent serial writes can interleave at the driver.
- **Modbus is half-duplex.** Keep one outstanding transaction at a time through
  `ModbusTransactionRunner` and `ModbusLoopCoordinator`.
- **RX bytes reach protocol observers before display batching.** Protocol
  engines need exact chunks; UI frames may be coalesced.
- **Frame arrays stay shallow and bounded.** Use per-session frame versions and
  raw frame items; limits are 64 MiB per session and 256 MiB globally.
- **Auto-log preserves append order.** Bounded per-session queues append to a
  backend log session; overflow or the first disk error stops logging visibly.
- **Persistence remains migration-safe.** Shape changes require an explicit
  migration and test; future schemas are never re-stamped by older builds.
- **Hot paths stay framework-free when practical.** Queueing, formatting,
  parsing, Modbus batching, waveform math, and export filters should remain
  testable without a Tauri webview.

## Upstream Constraints

- The serial plugin's timeout affects both read timeout and event flush cadence;
  raising it changes UI latency as well as port behavior.
- Serial `watch({ decode: false })` is intentional: it avoids a per-chunk text
  decoder. Every reconnect must unwatch and close the previous handle first.
- Tauri IPC can turn small binary payloads into number arrays; do not introduce
  a channel-based "optimization" without measuring both small and large packets.
- `zai-rs` model types are concrete and not object-safe for the current dispatch
  path, so supported AI models are selected with an explicit match table in
  Rust and mirrored by the frontend registry.
- Automatic updates remain out of scope until signed update metadata, rollback,
  and endpoint operations are designed as a separate feature.

## Quality Gates

| Area                         | Command                  |
| ---------------------------- | ------------------------ |
| Frontend lint                | `pnpm lint`              |
| Formatting                   | `pnpm format:check`      |
| Type-check + frontend build  | `pnpm build`             |
| Frontend tests               | `pnpm test:frontend`     |
| Rust tests                   | `pnpm test:rust`         |
| Frontend coverage            | `pnpm coverage:frontend` |
| `src/lib/` per-file coverage | `pnpm coverage:lib`      |
| Frontend benchmarks          | `pnpm bench:frontend`    |
| Rust benchmarks              | `pnpm bench:rust`        |
| TypeScript import cycles     | `pnpm cycles`            |
| Common local gate            | `pnpm check`             |

CI preserves the branch-protection job names while enforcing dependency audits,
Vitest V8 coverage, Rust fmt/Clippy/tests, and llvm-cov line/function
thresholds. The benchmark gate alternates three independent base/head processes;
each case runs seven rounds of at least 100 ms, rejects CV above 10%, and rejects
a head/base median below 0.85. No audit, coverage, or benchmark command may fail
open.

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
- Export changed: test TXT/CSV/JSONL/BIN plus grant/session limits, cancellation,
  disk failure, and atomic target preservation.
- AI model changed: update both `src/lib/ai-models.ts` and
  `src-tauri/src/commands/ai/service.rs`.
- Modbus changed: run the full Modbus frontend test set and manually test with
  a device when transport timing changed.
