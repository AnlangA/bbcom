# bbcom Architecture

A cross-platform serial debug assistant built on **Tauri 2** (Rust backend) +
**Vue 3** (strict-TypeScript frontend). This document captures the module
topology, the data-flow invariants ("sacred cows"), and the verification
strategy so a change can be reasoned about without tracing every file.

## High-level topology

```
┌─────────────────────────────────────────────────────────────────┐
│  Webview (Vue 3 + Pinia + Naive UI)                             │
│                                                                 │
│  components/          composables/            stores/           │
│   ├─ session/          ├─ useSerialConnection  ├─ sessions       │
│   │  └─ SessionView    ├─ useModbusMaster      ├─ app            │
│   ├─ terminal/         ├─ useSessionModbus     └─ serial         │
│   │  (DataPacketList,  ├─ useExport                              │
│   │   ModbusPanel,     ├─ useAutoLog                             │
│   │   ParserPanel,     ├─ useTriggers                            │
│   │   WaveformPanel)   └─ usePortWatcher                         │
│   ├─ send-panel/                                                │
│   └─ app-shell/         lib/  (domain logic, framework-free)    │
│                          ├─ modbus/ (barrel + modbus-core +      │
│                          │    13 domain modules: pdu/transport/  │
│                          │    registers/master-runtime)         │
│                          ├─ format / bytes / lru-cache           │
│                          ├─ serial-rx-queue (ring buffer)        │
│                          ├─ protocol-parser / waveform           │
│                          └─ session-persistence (+ migrate)      │
│                                                                 │
│  types/  (domain barrels: display/serial/macros/modbus/         │
│           waveform/ai/session/checksum/constants → index.ts)    │
└───────────────┬──────────────────────────────────┬──────────────┘
                │ typed IPC (src/lib/ipc.ts)        │ Tauri events
                ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Rust backend (src-tauri/src/)                                  │
│                                                                 │
│  commands/            models/         utils/      export/        │
│   ├─ ai/ (mod/cooldown/ data_frame/    checksum/   formatter     │
│   │       prompts/service/   errors/   hex/                     │
│   │       parser/types/tests) timestamp                          │
│   ├─ checksum.rs          ↑ AppError (thiserror)                 │
│   ├─ export.rs            │                                       │
│   ├─ log.rs               │ serialplugin (RX event → JS)         │
│   └─ window.rs            │ zai-rs (AI chat)                     │
│                            └ tokio::fs (stateless log/export)    │
└─────────────────────────────────────────────────────────────────┘
```

The frontend owns all session state and the serial protocol engines; the Rust
side is a thin, stateless IPC + filesystem + AI-client layer.

## Sacred cows (inviolable invariants)

These are the correctness guarantees a change must not break. Each is covered by
a test or bench.

- **COW-1 — TX single-serialization.** Every transmit (cyclic loop, quick
  command, trigger, AI-fill, Modbus) goes through `useSerialConnection.send` /
  `sendBytes`, which chain onto a single `writeChain` promise so concurrent
  callers never interleave `writeBinary` on the port.
- **COW-2 — Modbus single-busy / single-pending-RX.** `useModbusMaster` keeps a
  busy guard and one pending RX slot (RTU is half-duplex).
- **COW-3 — Auto-log ordering chain.** `useAutoLog` serializes per-session
  appends through a Promise chain; `append_log` is stateless.
- **COW-4 — Scroll single-flight RAF.** `usePacketVirtualScroll` coalesces
  auto-scroll through one in-flight `requestAnimationFrame`.
- **COW-5 — Persistence backward compatibility.** Changing any persisted shape
  requires bumping `SESSION_STORAGE_VERSION` + adding a `MIGRATION_STEPS` entry
  + a legacy-data regression test. `migratePersistedFile` runs the chain on load.

## Key data flows

**RX (receive):** serialplugin emit → `useSerialConnection` data listener
(`listen(cb, false)` — skips per-chunk TextDecoder, F5) → `SerialRxQueue`
(ring buffer with head-index drops, O(1)) → RAF-batched `flushQueue` →
`addFrame` (markRaw frame into the session) → auto-log append + trigger feed.
Raw-byte observers (Modbus master) receive the exact chunk before coalescing.

**TX (transmit):** any caller → `send`/`sendBytes` → `writeChain.then(doSend)`
→ `buildSendPayload` (validate + encode, the COW-1 input gate) →
`port.writeBinary` → TX frame added to the session.

**Persistence:** session mutations mark the store dirty → debounced
`schedulePersist` (800 ms, max-wait 2.5 s) → `serializeSessionSnapshots` →
`saveJson` (localStorage). On load, `migratePersistedFile` walks
`MIGRATION_STEPS` then `hydrateSession`.

## Upstream hard constraints (decision boundaries)

- **F2** `timeout` is BOTH the port read-timeout AND the plugin emit flush
  interval (default 200 ms), clamped `.min(1)` — it cannot be raised to extend
  the read-timeout independently.
- **F5** `listen(cb, false)` skips the JS-side per-chunk TextDecoder; bbcom
  already passes `false` on its single RX listener (audited, no stragglers).
- **F6** `read()` is lossy-UTF8 — binary data must use `read_binary`/`write_binary`.
- **F10** Tauri `Channel<Vec<u8>>` < 1 KiB degrades to `number[]` (slow); ≥ 1 KiB
  is true binary. **AP-1**: do not Channel small packets as a "binary optimization".
- **F12** Very large transfers are fastest via a temp file (`convertFileSrc`).
- **F13** `zai-rs` `ModelName` is not dyn-safe → model dispatch is a match table,
  not `Box<dyn Model>` (**AP-2**).

## T2.2 — `sessions` shallowRef conversion (LANDED)

The `sessions` store is a `shallowRef` with a `notifyFramesChanged` reactivity
channel (`framesVersion` ref + `triggerRef(sessions)`), wired into every
mutator through `schedulePersist` (and `setModbusRegisterValues`). This is
AP-3-compliant — no `deep:true` watcher. Consumers that read
`session.frames.length` (DataPacketList, StatusBar, ParserPanel, WaveformPanel,
SessionTabs, SessionView, AiLogAssistant) stay reactive because every mutator
triggers the channel.

**Measured (`sessions_push_50k`): 2 ops/s (428 ms) → 32 ops/s (29 ms), 15×
throughput / −93 % latency** — far past the −30 % target. A micro-spike had
earlier confirmed the raw shape: deep `ref` 55.2 ms vs `shallowRef`+trigger
5.5 ms (~10×) for a 50 k-frame push.

**Reactivity safety:** a dedicated regression test
(`tests/frontend/sessions-frames-reactivity.test.ts`) asserts computed reads of
`frames.length`/`txBytes` reflect `addFrame`/`clearFrames`; the 23-test
modbus-master suite (incl. the reconnect-watches-store case) guards the
non-frame mutators. 576 frontend tests green.

## Verification strategy

| Gate | Command | Notes |
|---|---|---|
| Lint + format | `pnpm lint`, `pnpm format:check`, `cargo fmt --check`, `cargo clippy -D warnings` | clippy denies warnings |
| Type-check + build | `pnpm build` (vue-tsc --noEmit + vite) | strict TS |
| Frontend tests | `pnpm test:frontend` | node:test runner, 576 tests across 72 files |
| Rust tests | `pnpm test:rust` | 71 tests incl. cross-language IPC contracts |
| Coverage gate | `pnpm coverage:frontend` | c8, `.c8rc.json` (85% lines / 88% branches / 88% functions) |
| Per-file lib/ gate | `pnpm coverage:lib` | c8 `--per-file --lines=90` against `src/lib/` (excl. Tauri-coupled files) |
| Bench regression | `pnpm bench:frontend` | 15% gate vs machine-local baseline |
| Circular deps | `pnpm cycles` | madge, 0 cycles |
| Full check | `pnpm check` | lint + format + build + tests |

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR. The
tag-triggered cross-platform build matrix (Windows / Linux / macOS) lives in
`.github/workflows/release.yml`.

## Manual verification checklist

These runtime paths need a physical serial device and/or a running Tauri app
and cannot be executed in the headless test harness. Each is marked with its
status and the reason it cannot be automated here.

- ❌ **Connect / disconnect / reconnect** — requires a physical serial device
      (or socat PTY pair) + a running Tauri webview. The connection lifecycle
      (`useSerialConnection` start/stop/reconnect) is unit-tested via
      `buildSendPayload` and the sessions-frames-reactivity guard, but the
      end-to-end port-open/listen/write loop is driver-dependent.
      **Status: ❌ — hardware/runtime-dependent.**
- ❌ **High-baud capture (921600)** — requires a physical device generating a
      sustained byte stream. See
      [`docs/high-baud-measurement.md`](docs/high-baud-measurement.md) for the
      F2/F3 config matrix and a reproducible socat/PTY procedure. Headless
      proxies: `serialrxqueue_drop_512` (T2.1, +105%), `sessions_push_50k`
      (T2.2, 2→32 ops/s). **Status: ❌ — hardware-dependent (no device
      available).**
- ❌ **4-format export** — requires a live capture to export. The export path is
      covered by the Rust formatter tests (8), the IPC contract tests (3), and
      the F12 capture-file contract tests (3); the F12 path is verified to
      produce byte-identical output. But the end-to-end dialog → file write
      needs the running app. **Status: ❌ — runtime-dependent (Tauri dialog +
      file picker).**
- ❌ **AI command + log** — requires a Z.ai API key + network access. The AI
      command dispatch (F13 dispatch-table), cooldown guard, request/response
      serde contracts, and SSE accumulator (F14) are all unit-tested. But the
      live API call cannot run headless. **Status: ❌ —
      network/credential-dependent.**
- ❌ **Modbus poll + write + replay** — requires a physical Modbus slave device.
      The master loop, batching, replay coordinator, write source, and status
      reporting are covered by 23 modbus-master tests. But the live RTU/PDU
      transport needs a device. **Status: ❌ — hardware-dependent.**
- ❌ **Waveform + parser** — requires live RX data. The waveform buffer,
      channel stats, parser frame collector, and `.bbrec` record/replay are
      unit-tested. The canvas rendering loop needs the running app.
      **Status: ❌ — runtime-dependent (canvas + live data).**
- ❌ **Light / dark** — requires the running Tauri webview to visually confirm
      both themes. The CSS token system (`variables.css`, 138 tokens +
      `[data-theme='light']` inversion) and `prefers-reduced-motion` are
      verified; `vue-tsc` confirms the theme code compiles. But visual
      confirmation needs the app. **Status: ❌ — runtime-dependent (visual
      inspection).**

**GUI launch verified:** `pnpm tauri:dev` was successfully run on this
machine — the Tauri app compiled, launched, and ran for 35+ seconds without
crashing (macOS WindowServer is accessible from this terminal session). However,
`screencapture` lacks Screen Recording permission, so visual UI verification
(themes, panel rendering, layout) cannot be captured. The items requiring a
physical serial device remain blocked (socat unavailable, no hardware).

**lib/ per-file coverage gate (T1.2) — ENFORCED:** `coverage:lib` runs c8
`--per-file --lines=90` against `src/lib/` (excluding Tauri-coupled files),
passing at ~98% with 0 errors. The composable ≥80% threshold remains
infeasible (lifecycle hooks structurally unreachable headless). The automated suite (576 frontend + 71 Rust
tests, 0 circular deps, ~87% coverage, 15% bench gate) covers every path that
CAN be tested headless. The remaining paths are documented with their blocker
and the headless proxy that validates the underlying logic.

Failures should include reproduction steps, the baud/device, and the relevant
log line.
