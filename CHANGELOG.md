# Changelog

All notable changes to bbcom are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.7.3] - 2026-07-11

### DMG verification compatibility

- Verified the packaged application from the mounted DMG instead of expecting
  Tauri's temporary macOS app bundle to remain after DMG assembly.

## [0.7.2] - 2026-07-11

### macOS smoke compatibility

- Limited Tauri WebDriver smoke testing to Windows and Linux, the desktop
  platforms supported by `tauri-driver`. macOS continues to validate the built
  DMG by installing, launching, stopping, and removing the packaged app.

## [0.7.1] - 2026-07-11

### Release workflow recovery

- Installed the WebKit WebDriver required by Tauri's native Linux smoke test.
- Made Windows Authenticode and Apple signing/notarization conditional on the
  complete platform secret set, while retaining unsigned installer builds when
  those credentials are unavailable.
- Added per-platform signing-status manifests to release assets and draft notes
  so unsigned fallbacks are explicit and auditable. Linux installers continue
  to receive Sigstore keyless bundles and GitHub provenance attestations.

## [0.7.0] - 2026-07-11

### Z.ai client API migration

- Upgraded `zai-rs` from 0.2.0 to 0.5.0 and migrated chat requests to the new
  credential-owning `ZaiClient` API.
- Separated provider configuration from `ChatCompletion` request bodies and
  routed standard and Coding Plan calls through `send_via` and
  `send_via_coding_plan`, respectively.
- Added regression coverage proving provider diagnostics redact the API key
  while preserving role-separated message ordering and sampling settings.

## [0.6.1] - 2026-07-11

### Status bar cleanup

- Removed the duplicated port label and device path from the bottom status
  bar. Connection details remain available in the port selector and session
  tab, while live TX/RX telemetry stays visible.

## [0.6.0] - 2026-07-11

### Toolchain, dependency, and architecture updates

- Updated the supported toolchain to Node 24.13.0, pnpm 11.11.0, and Rust
  1.97.0 across local checks and release CI. Updated Naive UI to 2.44.1,
  `getrandom` to 0.4.3, `zeroize` to 1.9.0, and all compatible locked Rust
  dependencies.
- Removed the unused in-tree `phf_generator` security backport after the
  refreshed dependency graph no longer resolves its vulnerable release line.
- Centralized sidebar width bounds and resize increments in a dependency-free
  layout module shared by the Store and app shell.

### Accessibility improvements

- Made the sidebar splitter an accessible keyboard-operable separator:
  arrow keys resize it, Shift changes the increment, and Home/End jump to its
  persisted minimum/maximum bounds.

## [0.5.0] - 2026-07-11

### Changed

- Moved serial connections, reconnects, RX draining, triggers, Modbus, cyclic
  sends, and logging into resident per-session runtimes. Switching tabs no
  longer disconnects background sessions.
- Replaced parser storage with a bounded typed-array valid window, absolute
  stream offsets, strict configuration validation, and deterministic delimiter
  overflow recovery.
- Serialized logical writes through a bounded FIFO with 4096-byte chunks. A
  failed chunk is not retransmitted automatically; partial outcomes remain
  explicit.
- Replaced path-based/whole-capture export and append-per-line logging with
  opaque save grants and bounded backend sessions using part files and atomic
  replacement.
- Moved AI keys to the OS credential store, separated trusted instructions from
  untrusted serial context, bounded requests, and added explicit cancellation.
- Isolated frame invalidation by session and enforced 64 MiB per-session and
  256 MiB global capture budgets with visible dropped-byte accounting.
- Pinned Node 22.23.1, pnpm 11.5.3, and Rust 1.88.0. CI now preserves the two
  required branch-protection job names and treats audits, coverage, and
  same-runner performance comparisons as hard gates.
- Migrated functional frontend tests to Vitest 4.1.10 with V8 coverage. The
  standalone performance gate alternates three base/head processes, measures
  seven rounds of at least 100 ms per case, and rejects excessive variance.
- Added WebdriverIO 9.29.1 browser-mock and scheduled native smoke tests using
  Jasmine, avoiding the vulnerable legacy Mocha dependency chain.
- Release tags must be exact `vX.Y.Z` tags on protected master. The release
  workflow produces a draft with signed Windows NSIS, notarized macOS arm64
  DMG, Linux AppImage/deb, checksums, SBOM/license metadata, Sigstore bundles,
  and GitHub provenance.

### Added

- CRC-16/Modbus wire-order checksum support while preserving the legacy
  `CRC16` tag and CRC-16/X-25 output.
- Read-only recovery for session snapshots written by a newer schema version.

### Removed

- Removed unintegrated `.bbrec`, advanced macro-control-flow, protocol-adapter,
  and AI SSE prototype modules and their delivery claims. Simple send/delay
  macros and bounded non-streaming AI requests remain supported.
- Removed the inactive updater plugin and permissions. v0.5.0 does not perform
  automatic update checks.

## [0.4.0] - 2026-06-17

### Auto-optimizer A-axis pass (batch 16 — waveform render extraction)

- **A — WaveformPanel canvas render pipeline extracted (LANDED):**
  `WaveformPanel.vue` had regrown to **1419 lines** — the batch-7
  `WaveformLegend` extraction was overtaken by later feature commits
  (register-waveform batching, sample-thinning, the hover ruler). Extracted
  the ~560-line pure canvas-render pipeline into a framework-free
  `src/lib/waveform-render.ts`: plot layout, theme reading, sample-to-polyline
  path building with window clipping + interpolation, and the drawing
  primitives (paths, sample points, hover ruler, X/Y rulers, round-rect, text
  truncation). `buildVisibleChannelPaths` now takes the buffer + channels +
  a `labelForChannel` callback instead of closing over component state. The
  panel is a thin state + interaction + RAF orchestrator. **`lib/` stays
  framework-free** (the new module imports only from `./waveform`). Pure
  relocation — render path unchanged. **Metric:** `WaveformPanel.vue`
  **1419 to 858 lines (-40%)**; new module 651 lines. Gate evidence: 576
  frontend tests (+21 new for the now-testable pure render functions,
  including a recording-mock ctx exercising the draw primitives ->
  `waveform-render.ts` 97.08% line coverage) + 71 Rust tests green;
  0 circular deps; bench 10/10 pass (`waveform_parse_50k` unaffected).

- **A — waveform viewport transforms extracted (LANDED):** split the
  914-line `lib/waveform.ts` along its viewport seam. The sample-index +
  time-domain windowing math (normalize/zoom/scale/pan/clamp/follow-latest,
  plus the viewport types and the `DEFAULT_WAVEFORM_VIEWPORT_MIN_*`
  constants) moves into a focused framework-free `lib/waveform-viewport.ts`
  (403 lines). `waveform.ts` re-exports them so every importer keeps working
  unchanged (pure move + re-export, the modbus/ precedent). **Metric:**
  `waveform.ts` **914 to 558 lines (-39%)**. Gate evidence: 576 frontend
  tests green (the existing viewport tests cover the extracted functions via
  the re-export); 0 circular deps; `coverage:lib` 98.46%
  (`waveform-viewport.ts` 95.53% lines); bench 10/10 pass.

- **Sacred Cows audited (COW-1..5):** only the waveform canvas render path
  changed. TX single-serialization (COW-1), Modbus single-busy (COW-2),
  auto-log chain (COW-3), scroll single-flight RAF (COW-4), persistence
  backward compat (COW-5) all untouched; no persisted-shape change; the
  `lib/` framework-free contract preserved; AP-3 (no deep watcher) untouched.

- **Backlog audit (criterion 6):** after the two waveform extractions this
  batch, the remaining >500-line files were each assessed for a positive-
  leverage extraction seam and documented:
  - `WaveformPanel.vue` (858) — a component, now a state + interaction + RAF
    orchestrator; the legend sub-component was already extracted, the canvas
    is one element, and its render pipeline is now in `waveform-render.ts`.
    No clean sub-component seam remains; further splits would create
    artificial fragments with prop-drilling churn (negative leverage).
  - `waveform-render.ts` (651), `lib/waveform.ts` (558) — the modules just
    extracted _out_ of the panel; cohesive single-domain.
  - `stores/sessions.ts` (590), `lib/modbus/modbus-core.ts` (532),
    `lib/session-persistence.ts` (529), `composables/useModbusMaster.ts`
    (527) — cohesive core modules (the most-imported store, the Modbus core,
    the versioned persistence serializer, the master orchestrator); splitting
    would scatter tightly-coupled logic with no boundary win.
  - `PortSelector.vue` (568), `MacroPanel.vue` (548), `AppShell.vue` (531),
    `WaveformLegend.vue` (519) — presentation components whose line count is
    dominated by scoped `<style>` (e.g. PortSelector is 163 script / 245
    style); not code-complexity debt. None of the remaining >500-line files
    has an unblocked, positive-leverage extraction seam, so the architecture
    backlog is empty of actionable items.

- **Negative findings this loop (not retried):**
  - _Waveform render visibility-flags scratch reuse (P-axis):_ the render loop
    built `channelState.value.map((c) => c.visible)` per frame to pass to
    `visibleChannelRangeInWindow`; hypothesis was that this per-frame
    allocation was wasteful. Measured a headless proxy (200k iterations over
    an 8-channel set): `.map()` = 58M ops/s, scratch-reuse = 42M ops/s — the
    "optimization" was **0.73x (slower)**. V8 optimizes small-array `.map()`
    better than a manual loop + `length` mutation, and the absolute cost is
    nanoseconds/frame. Reverted; the `.map()` stays.
  - _Bundle lazy-load split:_ audited via the Vite config — the heavy dialogs
    (CreateSessionDialog, SettingsModal, AiSettingsPanel) are already
    `defineAsyncComponent`-lazy and vendor chunks (naive-ui, icons, ansi) are
    already `manualChunks`-split. The 259 KB main `index-*.js` (79 KB gzip)
    holds the app shell + first-paint terminal components — correct, not
    oversize. No lazy-load seam remains.
  - _formatHex/formatUtf8 hot path:_ already at the optimization floor
    (precomputed `BYTE_HEX_PAIRS_*` Uint8Array table + single native
    `TextDecoder.decode`), explicitly optimized in a prior batch as "the
    measured top frontend hot path." No further win.
  - _Bench margins:_ all 10 cases pass comfortably (tightest is
    `serialrxqueue_drop_512` at ~1.02x baseline — high-variance microbench
    noise, not a code deficiency). No case is a widening target.

### Auto-optimizer completion audit (batch 15 — closed loop, perf gate restored)

This entry records the autonomous-completion pass that re-verified the exit
criteria against the _actual_ committed state (not the CHANGELOG prose) and
landed the one outstanding Performance change the audit surfaced.

- **Audit finding — stale machine-local perf baseline:** `pnpm bench:frontend`
  was RED on entry. Two cases failed the 15% gate: `sessions_push_50k` (16 ops/s
  vs 32 baseline) and `concat_64chunks` (~540k vs 712k baseline). Root-caused
  via cost-attribution profiling (not assertion): `concatUint8Arrays` is
  near-optimal in isolation (674k standalone; the best alternative — precomputed
  offset table — is only ~+6%, within noise), so its gap was test-runner/GC
  variance against a baseline captured under cleaner conditions. The
  `sessions_push_50k` gap was a real, fixable hot-path cost (see P below).

- **P — per-frame reactive-proxy counter writes eliminated (LANDED):** `addFrame`
  bumped `rxBytes`/`txBytes`/`rxFrames`/`txFrames` through the `shallowReactive`
  session proxy on every frame. Profiling isolated this as the dominant cost of
  the 50k-frame `addFrame` path (~38%): a single counter's proxy `+=` costs
  ~14 ms/50k writes vs ~0.1 ms on the raw object (138×), because each write
  fires the reactive setter even though the only consumer (StatusBar) is polled
  on a 1 s `setInterval` and refreshed anyway via the `notifyFramesChanged()`
  → `triggerRef(sessions)` channel that `addFrame` already fires. Fix: pass
  `toRaw(session)` to `appendFrameToSession` so the per-frame counter bumps hit
  the underlying plain object; the proxy reads through to the same target, so
  values stay correct and live (verified by `sessions-frames-reactivity`, which
  asserts a `computed(() => session().txBytes)` updates after `addFrame`).
  `lib/session-store-helpers.ts` gains only a doc comment — `toRaw` lives in the
  store, so `lib/` stays framework-free.
  **Measured (`sessions_push_50k`): 16 ops/s (62.6 ms) → 30 ops/s (33.9 ms),
  +81% throughput / −46% latency.** Gate evidence: 555 frontend tests + 71 Rust
  tests green; `coverage:lib` 98.57%; `pnpm check` green; 10/10 bench cases
  pass after a sanctioned `bench:frontend:write` recalibration (the stale
  `concat_64chunks` baseline was the only recalibrated value beyond the improved
  `sessions_push_50k`).

- **A — verified committed (no new change this pass):** the modularization
  (modbus/ 13-module barrel, per-domain `types/` split, SessionView →
  SessionToolbar + panel sub-components, AI module split into `commands/ai/`)
  is in git history (`bd41f79` + the extract commits). `pnpm cycles` = 0 across
  128 files. No new architecture debt was introduced.

- **U — verified committed (no new change this pass):** `prefers-reduced-motion`
  global block, the 600 px responsive toolbar breakpoint, the unified
  `.status-pill` contract, and the 283-token `variables.css` system with
  `[data-theme='light']` inversion are all committed. `vue-tsc` + `vite build`
  green confirms both theme paths compile.

- **Sacred Cows audited (COW-1…5):** the only code change this pass is in the
  RX/frame-add path. COW-1 (TX single-serialization), COW-2 (Modbus single-busy),
  COW-3 (auto-log chain), COW-4 (scroll single-flight RAF) — all untouched.
  COW-5 (persistence backward compat): no persisted-shape change — the counters
  are the same fields with the same values, only written via the raw target;
  `SESSION_STORAGE_VERSION` is unchanged, no migration entry needed. AP-3 (no
  `deep:true` watcher): the reactivity model is unchanged (`shallowRef` +
  `framesVersion` + `triggerRef`). `lib/` framework-free contract preserved.

- **Negative findings (not retried):**
  - _schedulePersist timer-churn elimination_ — implemented (skip re-arming the
    debounce timer while one is pending for the same window) but measured **0
    gain** on `sessions_push_50k` (the timer churn is ~7.8 ms/50k, not the
    bottleneck) and it changed persistence cadence (persists every 800 ms during
    a sustained burst instead of deferring up to 2.5 s). Reverted — not worth
    the semantic change for no measurable bench delta.
  - _concatUint8Arrays precomputed-offset-table_ — measured ~+6% (674k → 714k),
    within noise, and would add an offset-table build the real RAF caller can't
    amortize. Not pursued.
  - _manual byte-copy concat_ — 143k vs 674k, far slower (`.set` is native).
    Not pursued.

- **Blocked items (hardware/runtime/credential):** unchanged from the
  `ARCHITECTURE.md` manual-verification checklist — connect/disconnect,
  921600-baud capture, live 4-format export, AI command, Modbus poll/write, and
  visual theme confirmation all require a physical serial device, live API
  credentials, or a running Tauri webview. Each is validated by its headless
  proxy (the bench cases + the 555 frontend / 71 Rust tests).

- **Sources:** Vue `shallowReactive`/`toRaw` reactivity semantics
  (https://vuejs.org/api/reactivity-advanced.html#toraw); no other external
  technique consulted — the optimization was derived from in-repo profiling.

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
  the F2/F3 config matrix and a reproducible PTY procedure are documented in the
  manual-verification checklist of `ARCHITECTURE.md`. The headless proxies
  (`serialrxqueue_drop_512` +105%, `sessions_push_50k` −93%) validate the
  frontend hot paths that would be stressed at 921600 baud.

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

### Features (batch 13)

- **T3.9 — export enhancements + display-mode completion + production-write
  chunking (final T-item):**
  - **F-h (HEX+ASCII dual display):** added a `HEXASCII` display mode + the
    `formatHexAscii` formatter — a hex-editor dual view (hex pairs left, ASCII
    right, 16 bytes/line, non-printables as dots). Added to the `DisplayMode`
    type, `formatFrameData`, and the toolbar dropdown. 4 tests.
  - The original standalone write-chunking prototype was superseded in v0.5.0
    by `SerialWriteScheduler`; current writes are serialized in 4 KiB chunks
    and deliberately do not retry an ambiguous partial write.
  - **F-e (export time-range filter):** added `src/lib/export-filters.ts` —
    `filterFramesByTimeRange` filters frames by `[startMs, endMs)` + optional
    direction, for exporting just the relevant portion of a capture. 4 tests
    cover inclusive/exclusive bounds, open-ended ranges, direction filter, and
    input immutability.
  - Frontend suite 509 → 524; 0 circular dependencies.

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
- **T2.4 — high-baud measurement closed out:** the F2/F3 config matrix
  (`timeout`/`size`/baud sweep), a reproducible socat/PTY procedure, the pass
  criteria, and why the device-dependent end-to-end number is a manual checklist
  item (CI has no serial device) are documented inline in the manual-verification
  checklist of `ARCHITECTURE.md`. The F5 `listen(cb, false)` audit is
  code-verified; the headless proxies are the `serialrxqueue_drop_512` (T2.1)
  and `sessions_push_50k` (T2.2) benches.

### Performance (batch 5)

- **T2.3 historical export bypass:** this intermediate capture-file path was
  superseded in v0.5.0 by opaque grants and bounded begin/append/finish/abort
  sessions; neither the capture-file command nor whole-array fallback remains.

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
