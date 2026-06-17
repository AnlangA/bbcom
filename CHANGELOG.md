# Changelog

All notable changes to bbcom are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### §9 Global wrap-up (batch 14 — final gap closure)
- **T3.3 U-a (responsive toolbar overflow):** added a `@media (max-width: 600px)`
  block to `SessionToolbar.vue` that switches the toolbar to horizontal scroll
  (`overflow-x: auto`, `flex-wrap: nowrap`) on narrow screens, so no controls are
  hidden or clipped. Builds on the existing 1260/1100/900px breakpoints.
- **T3.3 U-b (unified status-pill):** unified the StatusBar's `.stat` and
  `.mini-stat` classes under a shared `.status-pill` base contract (same
  display/flex/gap/white-space/height/padding), so every metric chip shares one
  visual rhythm instead of two subtly-different ones.
- **T1.2 per-file threshold for lib/ — ENFORCED:** added a `coverage:lib`
  script (`c8 --per-file --lines=90` against `src/lib/`, excluding 5
  Tauri-coupled files + locale catalogs) and wired it into CI. Measured at
  98.79% lib/ line coverage with 0 errors. The composable ≥80% threshold
  remains infeasible (lifecycle hooks structurally unreachable headless).
  The overall gate (85% lines / 88% branches, measured at 86.94%) covers the
  rest.
- **Tauri GUI launch — VERIFIED:** `pnpm tauri:dev` was successfully run
  (compiled + launched + ran 35s without crash; macOS WindowServer accessible).
  Visual UI verification (screencapture) blocked by Screen Recording permission.
- **T2.4 socat measurement — blocked:** `socat` is not installed on this machine;
  the reproducible PTY procedure is documented in
  `docs/high-baud-measurement.md`. The headless proxies
  (`serialrxqueue_drop_512` +105%, `sessions_push_50k` −93%) validate the
  frontend hot paths that would be stressed at 921600 baud.
- **T3.9 F-f (updater) — IMPLEMENTED:** added `tauri-plugin-updater` v2.10.1,
  initialized the plugin in `lib.rs`, added the `updater:default` permission to
  `capabilities/default.json`, and registered a `check_for_updates` Tauri command
  (`commands/updater.rs`) that wraps the plugin's check flow behind a typed
  `UpdateInfo` response. Without a configured update endpoint + signing key in
  `tauri.conf.json`, `check` gracefully returns `available: false`. 71 Rust
  tests pass; build + clippy clean.

### §9 Global wrap-up
- **Manual verification checklist:** every item in `ARCHITECTURE.md` is now
  marked ❌ with its specific blocker (hardware-dependent, runtime-dependent,
  network/credential-dependent) and the headless proxy that validates the
  underlying logic. No item can be ✅ in the headless harness — all require a
  physical device, live API credentials, or a running Tauri webview.
- **Architecture diagram:** the ASCII topology diagram in `ARCHITECTURE.md`
  (Webview → composables → lib/ → typed IPC → Rust commands/models/utils/export)
  is confirmed as the architecture deliverable, updated to reflect the current
  module layout (modbus/ subdirectory, ai/ submodules, locales/ split,
  SessionToolbar/ModbusHeader/ParserFrameDetail/WaveformLegend sub-components).
- **T3.9 updater (F-f) — deferred:** the auto-updater requires the
  `tauri-plugin-updater` crate + a signing key + a release-hosted update JSON —
  infrastructure that doesn't exist in this project and is orthogonal to the
  five-axis optimization (performance/architecture/features/UI/testing). It is
  explicitly out of scope for this work and noted for a future infrastructure
  task.

### Features (batch 13)
- **T3.9 — export enhancements + display-mode completion + production-write
  chunking (final T-item):**
  - **F-h (HEX+ASCII dual display):** added a `HEXASCII` display mode + the
    `formatHexAscii` formatter — a hex-editor dual view (hex pairs left, ASCII
    right, 16 bytes/line, non-printables as dots). Added to the `DisplayMode`
    type, `formatFrameData`, and the toolbar dropdown. 4 tests.
  - **F8 (production-write chunking):** added `src/lib/write-chunking.ts` —
    `chunkPayload` splits a large TX into ≤4 KiB chunks (serialplugin #29:
    release builds may truncate large writes), and `sendChunked` writes each
    chunk through the caller's serialized write path (COW-1) with retry +
    exponential backoff. 7 tests cover splitting, retry-then-succeed,
    max-retries-give-up, and throw-as-failure.
  - **F-e (export time-range filter):** added `src/lib/export-filters.ts` —
    `filterFramesByTimeRange` filters frames by `[startMs, endMs)` + optional
    direction, for exporting just the relevant portion of a capture. 4 tests
    cover inclusive/exclusive bounds, open-ended ranges, direction filter, and
    input immutability.
  - Frontend suite 509 → 524; 0 circular dependencies.

### Features (batch 12)
- **T3.8 — AI dispatch-table (F13) + SSE streaming (F14):**
  - **F13 dispatch-table (verified + frontend registry):** the Rust
    `send_chat_by_name` match-table (in `commands/ai/service.rs`, split out in
    T2.6) is the canonical model dispatch — not `Box<dyn Model>` (AP-2). Added a
    frontend mirror `src/lib/ai-models.ts`: the single source of truth for model
    IDs, display labels, streaming capability, validation
    (`isValidAiModel`), and dropdown options. 6 tests cover registry completeness,
    validation, label fallback, and the streaming flag.
  - **F14 SSE streaming accumulator:** added `src/lib/ai-stream.ts` — a pure,
    testable accumulator (`createStreamAccumulator` / `assembleStream`) that
    reconstructs the full AI response from incremental SSE delta tokens
    (`delta.content`, per F14), tracks completion, handles keep-alive (empty)
    deltas, and supports mid-stream abort. Decoupled from the Tauri event layer
    so the assembly logic is unit-testable. zai-rs 0.1.15's `enable_stream()
    .stream_sse_for_each` is the upstream API this consumes. 6 tests cover full
    reconstruction, empty-delta handling, post-done/post-abort ignoring, and the
    empty-stream case. Frontend suite 497 → 509; 0 circular dependencies.

### Features (batch 11)
- **T3.7 — conditional macros with control flow (Tera Term TTL gap closed):**
  added `src/lib/macro-control-flow.ts` — a pure, step-indexed interpreter for
  extended macros with `wait` (block until an RX pattern arrives, with a
  timeout), `if`/`else` (conditional branch on the last RX text), `goto`/`label`
  (jump), and a per-run `maxSteps` anti-loop guard (`DEFAULT_MAX_STEPS` = 10 000).
  The interpreter operates on a discriminated-union `ControlStep` type
  (`send | delay | label | goto | wait | if`) through injectable side-effects
  (`send`, `delay`, `lastRxText`, `onRxBytes`) — no DOM/Vue deps, fully unit-
  testable. **12 unit tests** cover: send+delay ordering, send-failure stop,
  wait (immediate match / timeout / async match), if/then, if/else, goto/label
  bounded loop + maxSteps guard, unknown-label stop, and a full bring-up script
  (send AT → wait OK → if OK send CMD else send RETRY). Frontend suite 485 → 497;
  0 circular dependencies.

### Features (batch 10)
- **T3.6 — transport-agnostic protocol interface + .bbrec record/replay:**
  - Added the `ProtocolEngine` interface (`src/lib/protocol-engine.ts`) — a
    transport-agnostic abstraction (`feed(bytes) → frames`, `reset()`, `name`,
    `pending`) that any protocol implementation can satisfy. The existing
    `ProtocolParser` is adapted via `toProtocolEngine`, so future engines (CAN,
    custom binary) can plug into the frame pipeline uniformly.
  - Added `.bbrec` raw byte-stream record/replay (`src/lib/bbrec.ts`): encodes
    captured RX/TX byte chunks (direction + relative timestamp + hex payload) as
    a versioned JSONL file with a magic header; parses it back; and a
    `replayBbrec` function feeds the RX records through any `ProtocolEngine` to
    reproduce the original framing. This enables capture-then-reparse workflows
    (re-run a capture with a different protocol config) and regression testing.
  - **9 unit tests** (`tests/frontend/bbrec.test.ts`) covering hex round-trip,
    encode/parse parity, magic-header validation, malformed-record rejection,
    the engine adapter, and a full record → encode → parse → replay round-trip
    that asserts byte-level fidelity. Frontend suite 476 → 485; 0 circular deps.

### Features (batch 9)
- **T3.5 — StatusBar live metrics:** the status bar now shows, in addition to
  the existing cumulative TX/RX byte counts and the B/s data rate:
  - **frames/s** — a rolling per-second frame-rate sampled from the live frame
    count delta (same 1 s interval as the byte rate).
  - **buffer level** — `frames.length / maxBufferFrames (pct%)`, so the user
    sees how full the rolling buffer is.
  - **cumulative dropped bytes** — mirrored from the `SerialRxQueue` overflow
    counter onto the session (new runtime-only `droppedBytes` field, never
    persisted) via `sessionStore.updateDroppedBytes`, surfaced only when > 0.
  Added 3 i18n keys (`status.frameRate`/`bufferLevel`/`dropped`) to both locales
  (parity test green). 476 tests pass; 0 circular dependencies.

### UI / experience (batch 8)
- **T3.4 — i18n split + missing-key check:** `src/lib/i18n.ts` reduced from
  **940 → 72 lines** by extracting the locale catalogs to `locales/en.ts`,
  `locales/zh.ts`, and a shared `locales/catalog.ts` type module (breaks the
  i18n↔locale import cycle → 0 circular deps). The runtime API (`t`,
  `setLocale`, `locale`, `supportedLocales`, `missingLocaleKeys`,
  `extraLocaleKeys`, `Locale`, `Catalog`) is unchanged — all 38 importers keep
  working. The existing parity tests (`missingLocaleKeys`/`extraLocaleKeys` must
  be empty) serve as the compile-time missing-key gate. 476 tests green.
- **T3.3 — UI polish:**
  - **prefers-reduced-motion (U-f):** added a global `@media
    (prefers-reduced-motion: reduce)` block in `global.css` that collapses all
    animation/transition durations to ~0 and disables smooth scroll — covers the
    send-flash sweep, fade/slide/scale entrances, the connection pulse, and
    sidebar/toolbar transitions (§7.3 UI-touch requirement).
  - **Accessibility (U-d):** the toolbar already exposes `role="group"` +
    `aria-label` on every toggle/button group and per-control labels — verified,
    no additions needed.
  - **Token SSOT (U-e):** all 138 design tokens are centralized in
    `variables.css` (palette, surfaces, spacing, radii, transitions, fonts) with
    a `[data-theme='light']` inversion block — verified, no scattered literals.

### UI / architecture (batch 7)
- **T3.2 — large-component split (all three targets met):**
  - **ModbusPanel 1162 → 376 lines** via three extracted sub-components:
    `ModbusHeader` (identity + timing + actions), `ModbusAddRegisterForm` (draft
    state + add), and `ModbusRegisterRow` (one row's edit/value/R-W logic +
    styles). The panel is now a layout shell wiring the three to the master.
  - **ParserPanel 674 → 366 lines** via `ParserConfigBar` (preset/kind/
    delimiter/fixed/length config, v-model via update-events — no prop
    mutation), `ParserStatsBar` (frame/byte/throughput stats + search), and
    `ParserFrameDetail` (hex/ascii dump + empty state).
  - **WaveformPanel 563 → 340 lines** via `WaveformLegend` (channel legend +
    action buttons + per-channel stats + their styles).
  - All three under the < 400 target; 476 frontend tests green; 0 circular
    dependencies; the sub-components are presentational (props in, events out)
    so the parents remain the state owners.

### UI / architecture (batch 6)
- **T3.1 — SessionView decomposed (target met):** extracted the connection +
  display/view/format toolbar into a dedicated `SessionToolbar.vue`
  component (presentational — receives reactive state, emits one event per
  action, no business logic). `SessionView.vue` is now **348 lines (< 350
  target)**, down from 762 — it is a thin layout orchestrator owning the
  connection/Modbus/export state and wiring toolbar events to the composables.
  All 476 frontend tests green; 0 circular dependencies.
- **T2.4 — high-baud measurement closed out:** added
  `docs/high-baud-measurement.md` documenting the F2/F3 config matrix
  (`timeout`/`size`/baud sweep), a reproducible socat/PTY procedure, the pass
  criteria, and why the device-dependent end-to-end number is a manual checklist
  item (CI has no serial device). The F5 `listen(cb, false)` audit is
  code-verified; the headless proxies are the `serialrxqueue_drop_512` (T2.1)
  and `sessions_push_50k` (T2.2) benches.

### Performance (batch 5)
- **T2.3 — F12 IPC-bypass export LANDED:** added a new Rust command
  `export_data_from_capture_file` (`commands/export.rs`) that reads + parses a
  JSONL temp file of frames instead of receiving up to 100 000 `DataFrame`
  objects through the `invoke` argument. The frontend writes each frame as one
  JSONL line (new `frameToJsonlLine` serializer) via the stateless `append_log`,
  then invokes the capture-file command with just the path — so the dominant
  export cost (serializing the `frames` array across IPC) is avoided (F12). The
  `useExport` composable now defaults to this bypass path (opt out via
  `useCaptureFileBypass: false` or by stubbing `exportFrames`). Verified by 3 new
  Rust contract tests (`ipc_contracts.rs`: round-trip, missing-file, blank-line
  handling) and 4 frontend tests (legacy path + F12 path + shared). Rust suite
  68 → 71; the legacy `export_data` path is retained as a fallback.

### Architecture & modularization (batch 4)
- **T2.2 — sessions `shallowRef` LANDED (target met):** converted the
  `sessions` store from a deep `ref` to a `shallowRef` + a `notifyFramesChanged`
  reactivity channel (`framesVersion` ref + `triggerRef(sessions)`), wired into
  every mutator via `schedulePersist` (and `setModbusRegisterValues`). This is
  AP-3-compliant — no `deep:true` watcher. **Measured: `sessions_push_50k`
  2 ops/s (428 ms) → 32 ops/s (29 ms), a 15× throughput / −93 % latency win**,
  far past the −30 % target. Consumer reactivity verified by a new dedicated
  reactivity-regression test (`sessions-frames-reactivity.test.ts`, computed
  reads of `frames.length`/`txBytes` after `addFrame`/`clearFrames`) plus the
  existing 23-test modbus-master suite (incl. the reconnect-watches-store
  case). 474 frontend tests green.
- **T1.6 — CSP narrowed to actual request domains:** removed the two unused
  `https://open.bigmodel.cn` / `https://api.bigmodel.cn` entries from the
  `connect-src` directive. Verified by grep that the frontend makes **zero**
  network calls (all AI traffic goes through Rust `reqwest`, which the webview
  CSP does not govern). The remaining `connect-src` hosts are `'self'`, the IPC
  origin, and the Vite dev server (dev-only).
- **T2.2 — see batch 5 above (LANDED):** the conversion described in the
  earlier spike is now implemented and verified (2 → 32 ops/s, 474 tests green).
- **T2.3 — assessed:** the export −40 % target requires the F12 IPC-bypass
  (frontend writes a temp file, Rust reads it) to avoid serializing 10 k frames
  through `invoke`. The formatter-level path was already benchmarked at 0 gain
  and rolled back; the F12 path is an architecture change whose win is realized
  in the Tauri IPC layer, which the headless bench harness cannot measure —
  tracked for a runtime-verified change.

### Architecture & modularization (batch 3)
- **T2.5 — Modbus consolidated into `lib/modbus/`:** unblocked the previous
  `./modbus` path-ambiguity by renaming `src/lib/modbus.ts` →
  `lib/modbus/modbus-core.ts`, then moving the 13 `modbus-*.ts` modules into
  `src/lib/modbus/` with a barrel `index.ts` (re-exporting all). All external
  deep imports rewritten to the barrel. **Pure move + re-export (AP-9):** git
  detects 14 renames; the only edits are import paths; 472 tests green and
  **0 circular dependencies** (madge). The previously-flat 12-file Modbus web
  now has a single `from '@/lib/modbus'` entry point grouped by sub-domain
  (pdu/transport/registers/master-runtime).
- **T1.2 — coverage gates tightened + Rust coverage:** the `c8` thresholds are
  now set just below the measured baseline (lines 85 % / branches 88 % /
  functions 88 % / statements 85 %, vs the previous flat 85/80) so a coverage
  regression fails CI; per-domain targets (lib ≥ 90 %, composables ≥ 80 %)
  are tracked. Added a `cargo-tarpaulin` Rust coverage report step to CI
  (Linux, non-blocking, emits an HTML report alongside the frontend `c8` gate).
- **T2.2 — assessed:** a `schedulePersist` single-timer refactor was implemented
  and benchmarked; it showed **0 gain** on `sessions_push_50k` (the bench resets
  the store per iteration, so the per-frame `clearTimeout`/`setTimeout` it
  eliminated isn't the bottleneck) and was rolled back per AP-8. The remaining
  per-frame cost (reactive `push` + `markRaw` + `randomUUID`) requires the
  `shallowRef` conversion (R = 64, touches 19 consumers) — a structural change
  tracked separately.

### Architecture & modularization (batch 2)
- **T2.6 (hard target met):** the AI wire types
  (`TerminalAiRequest`/`Response`, `LogAiRequest`/`Response`) moved out of
  `commands/ai/mod.rs` into `commands/ai/types.rs` (re-exported for
  compatibility); `mod.rs` is now **119 lines (< 120 target)** and is a pure
  command dispatcher.
- **T2.7 — types split by domain + madge CI gate:** the 252-line
  `src/types/index.ts` is now a barrel re-exporting per-domain modules
  (`display`, `serial`, `macros`, `modbus`, `waveform`, `ai`, `session`,
  `checksum`, `constants`). All 91 existing `from '../types'` importers keep
  working unchanged (pure move + re-export, AP-9). Added `madge`
  circular-dependency detection (`pnpm cycles`) wired into CI — **0 cycles**
  confirmed across 109 TS files.
- **T1.5 — window command contracts:** added
  `commands/window_contracts.rs` (5 tests) covering the AI-window command wire
  shapes (`resize_ai_window` camelCase payload + clamp routing, `AiWindowState`
  serialization, emitted event shape). Full contract coverage now spans
  checksum/log/export/AI/window. Rust suite: 63 → 68 tests.

### Notes / deferred (batch 2)
- **T2.3 — Export −40 %:** a formatter-level optimization (hand-written JSONL
  byte-array writer with `itoa`) was implemented and benchmarked — it measured
  **no gain** vs `serde_json`'s `Vec<u8>` fast path (2.15 ms → 2.20 ms, within
  noise), so it was rolled back per AP-8 (no change-then-test). The −40 % target
  requires the F12 IPC-bypass approach (frontend writes a temp file, Rust reads
  it) — a cross-module architecture change tracked separately.
- **T2.4 — 921600 baud measurement:** the `listen(cb, false)` audit (F5) is
  complete (the single RX listener already skips the per-chunk TextDecoder).
  The `size↑/timeout↓` measurement at 921600 baud needs a physical serial
  device and is captured as a manual-verification checklist item in
  `ARCHITECTURE.md`.
- Added `ARCHITECTURE.md` (topology diagram, sacred cows, data flows, upstream
  constraints, verification strategy, manual verification checklist).

### Testing & quality foundation
- Added unit tests for all 13 previously-untested Vue composables (`useTriggers`,
  `useSessionShortcuts`, `useAppShortcuts`, `useSessionFrames`, `useExport`,
  `useAutoLog`, `useSessionActions`, `usePacketVirtualScroll`, `usePortWatcher`,
  `useAiWindowState`, `useAiWindowSession`, `useAiSessionBridge`,
  `useSerialConnection`), bringing the frontend suite from 398 to 472 tests.
  Several composables were refactored to accept injectable side-effects so the
  logic is testable without a Tauri/DOM runtime.
- Added cross-language **IPC contract tests** (`src-tauri/src/commands/ipc_contracts.rs`)
  that deserialize the exact frontend wire payloads for `calculate_checksum`,
  `append_log`, `export_data`, and the AI request structs, so a renamed field or
  drifted serde tag is caught before runtime. Rust suite: 54 → 63 tests.
- Integrated **`c8`** frontend coverage with a coverage gate (`.c8rc.json`,
  85 % line / 80 % branch threshold). Run via `pnpm coverage:frontend`.
  Current overall coverage is ~90 %.
- Added a **PR-level CI workflow** (`.github/workflows/ci.yml`) running lint,
  format check, type-check + build, frontend tests, the bench smoke run, the
  coverage gate, and the Rust fmt + clippy (`-D warnings`) + test gates.

### Reliability (sacred-cow hardening)
- Added a **versioned persistence migration framework** (`migratePersistedFile` +
  `MIGRATION_STEPS`) wired into session loading, so a future persisted-shape
  change is forward-compatible and regression-tested (COW-5). Includes legacy-data
  regression tests.
- Confirmed the `listen(cb, false)` audit (F5): the serial RX listener is the only
  plugin data listener and already skips the per-chunk TextDecoder.

### Performance
- **`SerialRxQueue` overflow drop path** switched from O(n) `Array.shift()` to an
  O(1) head-index with periodic compaction. Measured **90 k → 185 k ops/s
  (+105 %)** on the 512-chunk overflow benchmark — beyond the −50 % latency
  target. Behavior-preserving (all queue tests + byte-drop counts unchanged).
- Added bench coverage for the three previously-uncovered hot paths
  (`SerialRxQueue` drop, 50 k-frame session push, Modbus read-batch composition).

### Architecture
- Split the 558-line `commands/ai.rs` into a focused module directory
  (`commands/ai/{mod,cooldown,prompts,service,parser,tests}.rs`): `mod.rs` is a
  thin command dispatcher, with the rate-limit guard, system prompts, Z.ai
  client dispatch, and JSON parsing each isolated. All 54→63 Rust tests preserved.
- Extracted the Modbus-master orchestration (~140 lines of imperative logic) from
  `SessionView.vue` into a dedicated `useSessionModbus` composable.
- Deduplicated `tauri.conf.json` build keys; confirmed capabilities are already
  least-privilege.
- Fixed all `clippy` warnings (`write!` → `writeln!`, inlined format args) so the
  CI `clippy -D warnings` gate is clean.

### Notes / deferred
- The Modbus-file consolidation into a `lib/modbus/` subdirectory is deferred: a
  barrel at `lib/modbus/` collides with `lib/modbus.ts` on the `./modbus` import
  path used by ~30 internal cross-imports (verified breakage), and the physical
  move is R≥4 across 21 importers with no structural benefit over the current
  flat layout.
- The `sessions` `shallowRef` conversion (T2.2) is deferred as R=64 (above the
  split-first threshold): it touches the most-imported store (19 consumers) and
  requires a spike to validate reactivity across every consumer before landing.
