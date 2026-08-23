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
│ bootstrap/                                                         │
│   main.ts                 window entry                             │
│   bootstrap-application.ts  DI wiring (provide/inject)             │
│   provide-keys.ts           centralized InjectionKey symbols       │
│                                                                    │
│ design-system/            visual primitives + Naive theme tokens     │
│                                                                    │
│ features/                                                          │
│   app-shell/      layout, settings, session creation, sidebar geom  │
│   sessions/       session store, runtime, bridges, session UI      │
│   terminal/       packet list, parser, Modbus, MCUMgr, shell, waveform │
│   send-panel/     quick commands, macros, triggers, highlights       │
│   serial/         port lease, connection lifecycle, port selector    │
│   workspace/      project library, activation, save queues, export   │
│   ai/             assistant settings and log assistant UI            │
│   settings/       global app settings                                │
│   platform/       operation registry, notifications, shutdown, IPC   │
│   device-profiles/                                                 │
│                                                                    │
│ lib/                  protocol engines + shared algorithms only    │
│   modbus/             protocol core, batching, transport, loops      │
│   serial-shell/       terminal TX keys, encoding, newline maps       │
│   serial-rx-queue     bounded RX buffering                           │
│   protocol-parser     delimiter/fixed/length frame parsing           │
│   waveform*           parsing, viewport math, canvas rendering       │
│   session-persistence snapshot serialize/hydrate (v2 gate only)      │
│   base64              dependency-free byte/payload codec             │
│                                                                    │
│ types/                cross-feature primitives only                  │
│   display, checksum, errors, constants                             │
│   (feature types live under features/*/domain/ with @/types shims)  │
└───────────────┬────────────────────────────────────────────────────┘
                │ Tauri invoke/listen/events
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Rust backend: src-tauri/src/ + crates/bbcom-workspace              │
│                                                                    │
│ commands/     ai, checksum, export/log session, mcumgr, workspace  │
│ export/       TXT/CSV/JSONL/BIN formatters                         │
│ models/       IPC structs, AppError, single IpcError mapper        │
│ utils/        checksum, HEX, timestamp helpers                      │
└────────────────────────────────────────────────────────────────────┘
```

## Layer Rules

`scripts/check-architecture.mjs` enforces import direction:

| Layer       | Path                        | May depend on                                 |
| ----------- | --------------------------- | --------------------------------------------- |
| entry       | `bootstrap/main.ts`         | bootstrap, feature barrels, design-system     |
| bootstrap   | `bootstrap/**`              | feature barrels, design-system, lib, types    |
| domain      | `features/*/domain/**`      | lib, types (cross-feature only)               |
| application | `features/*/application/**` | domain, lib, types, ports                     |
| store       | `features/*/store/**`       | application, domain, types                    |
| ui          | `features/*/ui/**`          | store, application, design-system, lib, types |
| lib         | `lib/**`                    | types                                         |
| types       | `types/**`                  | lib (parser types only)                       |

Hard rules:

- `domain/` stays framework-free (no Vue, Pinia, Tauri SDK).
- `application/` does not import `.vue` components or `@tauri-apps/api`.
- Cross-feature imports go through `features/<name>/index.ts` barrels when possible.
- Lower layers (`lib/`, `features/*/runtime/`) must not import UI.

## Runtime Ownership

- **Workspace application service:** sole durability owner for sessions, frames,
  layout metadata, and feature projections. SQLite workspaces use schema v5;
  older on-disk schemas are rejected (no in-place migration).
- **Session store:** in-memory aggregate for the active workspace. User
  mutations and runtime capture are gated by the workspace activation snapshot.
- **Platform registry:** `OperationRegistry`, `ApplicationRuntimeRegistry`, and
  `ApplicationNotificationRouter` live in `features/platform/application/` and
  are wired once in `bootstrap-application.ts`.
- **Injection keys:** `SESSION_APPLICATION_SERVICES_KEY`, `WORKSPACE_APPLICATION_KEY`,
  `APPLICATION_SHUTDOWN_KEY`, and `SESSION_UI_STATE_KEY` are defined in
  `bootstrap/provide-keys.ts`.
- **Frontend protocol engines:** parser, waveform, Modbus, serial shell,
  triggers, and simple send/delay macros remain framework-free TypeScript.
- **Rust command layer:** file dialogs, streaming export/logging, checksum
  calculation, bounded AI network calls, workspace persistence, window
  management, and MCUMgr/SMP (`mcumgr-toolkit` over a directly opened serial
  handle).

## Data Flows

### RX: device to screen

1. `tauri-plugin-serialplugin` delivers raw binary channel data to the resident
   session runtime.
2. Raw-byte observers receive the exact plugin chunk first (Modbus CRC matching
   and trigger responses). These are protocol engines, not displays.
3. The chunk enters `SerialRxQueue` (2 MiB / 512 chunks cap).
4. The runtime drains at 64 KiB, 64 chunks, or 16 ms.
5. `SessionCaptureController` appends the coalesced display frame and bumps the
   per-session frame version. This capture buffer is the independent send/receive
   system for the session.
6. Display surfaces project that buffer: packet list, parser, serial shell,
   waveform, and status counters all consume live capture frames (or derived
   samples) rather than keeping a private RX copy.

### TX: caller to device

1. Quick commands, macros, triggers, AI fill, Modbus, and the serial shell enter
   the session `SerialWriteScheduler`.
2. Text/HEX sends pass through `buildSendPayload`.
3. One bounded FIFO operation owns a logical send (4096-byte chunks).
4. A complete TX frame is appended only after full success, so every display that
   reads capture sees the same transmitted bytes.

### Persistence

1. Mutators mark session configuration dirty; the workspace application service
   owns durable writes through debounced config saves and bounded frame queues.
2. Frame/byte totals come from `CaptureAccountingStore` in platform.
3. Legacy localStorage session snapshots are read-only compatibility data:
   `session-persistence.ts` accepts only version **2** and discards older blobs
   on load. Workspace feature projections stamp `schemaVersion: 2`.

### Export

- Save grants are purpose-bound; the frontend never sends arbitrary paths.
- Export sessions accept bounded frame batches; Rust formats incrementally and
  atomically replaces the target after a successful finish.

## Engineering Invariants

- All serial writes are single-filed through `send` / `sendBytes`.
- Modbus is half-duplex through `ModbusTransactionRunner`.
- MCUMgr operations own the port exclusively (port yield).
- RX bytes reach protocol observers before display batching.
- Display UIs (terminal packet list, parser, shell, waveform) read the session
  capture buffer; they do not keep a private TX/RX copy.
- Frame arrays stay shallow and bounded (64 MiB per session, 256 MiB global).
- Auto-log preserves append order with visible stop on overflow or disk error.
- Hot paths stay framework-free when practical.

## Quality Gates

| Area               | Command               |
| ------------------ | --------------------- |
| Frontend lint      | `pnpm lint`           |
| Formatting         | `pnpm format:check`   |
| Type-check + build | `pnpm build`          |
| Frontend tests     | `pnpm test:frontend`  |
| Rust tests         | `pnpm test:rust`      |
| Import cycles      | `pnpm cycles`         |
| Architecture       | `pnpm architecture`   |
| Fast commit gate   | `pnpm precommit`      |
| Full pre-push gate | `pnpm precommit:full` |

## Change Checklist

- Serial write path changed: confirm every caller still uses `send` or
  `sendBytes`, then run send/macro/trigger/Modbus frontend tests.
- RX buffering changed: run queue, packet list, parser, waveform, and trigger tests.
- Persisted session or workspace projection shape changed: bump the version and
  update both TypeScript adapters and `bbcom-workspace` schema if needed.
- Export changed: test all formats plus grant/session limits and cancellation.
- AI model changed: update `src/lib/ai-models.ts` and Rust AI service registry.
- Modbus or MCUMgr changed: run the relevant frontend and Rust command tests.
