<div align="center">

# 🔌 bbcom

**Cross-Platform Serial Port Debug Assistant**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](./README.md) · [中文](./README.zh-CN.md)

[⬇️ Download](https://github.com/AnlangA/bbcom/releases)

</div>

---

## Overview

**bbcom** is a cross-platform desktop serial port debugging tool built with **Tauri v2 + Rust + Vue 3 + TypeScript**, designed for embedded developers' daily debugging workflows.

### Key Highlights

- 🔥 **Multi-Session** — Connect and monitor multiple serial ports simultaneously
- ⚡ **High Performance** — Virtual scrolling + RAF batch rendering stays smooth at high baud rates
- 🤖 **AI Terminal Assistant** — Natural language to shell commands, powered by ZHIPU AI
- 📊 **Waveform Visualization** — Parses numeric RX data and plots a live scrolling chart, Arduino Serial Plotter style
- 🛠️ **Modbus Master** — RTU/PDU transports, FC01-FC10 batched poll read/write, register-to-waveform channel binding
- 🎨 **Dark/Light Theme** — Comfortable for long debugging sessions with TX/RX color-coded frames, one-click toggle
- 💾 **Data Export** — TXT, CSV, JSONL, BIN formats
- 🔒 **CRC Checksums** — Checksum / CRC-8 / CRC-16 / CRC-32 calculation
- 🌐 **i18n** — English / 中文 UI with a persisted language preference

## Screenshots

<table>
  <tr>
    <td align="center"><b>Main Window</b></td>
    <td align="center"><b>AI Assistant</b></td>
  </tr>
  <tr>
    <td><img src="images/主窗口.png" alt="Main window" width="480"/></td>
    <td><img src="images/ai助手窗口.png" alt="AI assistant" width="480"/></td>
  </tr>
  <tr>
    <td align="center"><b>Modbus Registers</b></td>
    <td align="center"><b>Waveform Plot</b></td>
  </tr>
  <tr>
    <td><img src="images/modbus窗口.png" alt="Modbus registers window" width="480"/></td>
    <td><img src="images/绘图窗口.png" alt="Waveform plot window" width="480"/></td>
  </tr>
</table>

## Features

### Serial Communication

- Real-time serial data TX/RX with **HEX / ASCII / UTF-8 / ANSI / HEX+ASCII** display modes (the HEX+ASCII dual view is a hex-editor split: hex pairs left, ASCII right, 16 bytes/line, non-printables as dots)
- Full serial parameter configuration: baud rate (9600 ~ 921600), data bits, stop bits, parity, flow control
- Multi-session management — connect and monitor multiple ports independently
- Recent session captures auto-restore across app restarts (ports stay disconnected until you reconnect), via a **versioned persistence migration chain** so persisted data stays forward-compatible
- Hot-plug detection with automatic device list refresh
- Millisecond-precision timestamps, per-frame and merged view modes
- Cyclic sending with customizable interval (50 ms ~ 1 h)
- **Sequenced macros with control flow** — `send`/`delay` plus `wait` (block until an RX pattern, with timeout), `if`/`else` (conditional branch on last RX), `goto`/`label` (jump), and a `maxSteps` anti-loop guard. Full Tera Term TTL–style bring-up scripts
- **Macro library import/export** (JSON) — share scripted sequences across sessions and machines
- **Connection presets** — save and reuse named port profiles (baud/data/stop/parity/flow/DTR/RTS)
- **BREAK signal** (250 ms) — one-click Arduino auto-reset / ESP32 bootloader entry
- DTR/RTS handshake line control for boot-mode selection
- **Large-write chunking** — TX payloads are split into ≤4 KiB chunks with retry + exponential backoff, so large sends aren't truncated by the serial plugin in release builds
- **Waveform visualization** — parses numeric RX data (CSV/space/semicolon) and plots a live scrolling chart, Arduino Serial Plotter / serial-studio style. Pause/resume, per-channel show/hide, min/max/avg stats, autoscale Y-axis labels, clear, and one-click CSV export
- **Protocol parser** — reassembles the RX byte stream into discrete frames by delimiter (CRLF/custom hex), fixed length, or length-field header; click any frame for a hex+ASCII dump, filter frames by text, and see live frame/byte/throughput stats. Presets include NMEA 0183, AT/modem, SCPI/instrument, length-prefixed (1B/2B BE+LE), and NUL-delimited binary
- **`.bbrec` record/replay** — capture the raw RX/TX byte stream to a versioned JSONL file and replay it through any protocol engine later (re-parse a capture with a different config, or use as regression data)
- **Modbus master** — RTU (addr+PDU+CRC) and PDU (raw, TCP-gateway style) transports; read FC01-FC04, write single FC05/06, write multiple FC10; contiguous addresses auto-batch; value types span bool/u8/i8/u16/i16/u32/i32/f32 (BE+LE); configurable poll/write intervals and timeout; per-row periodic read (R) or periodic write (W) toggles; registers can bind to waveform channels 0-7 for live plotting; `.bbreg` config import/export, batch Read all / Send all, and data-source Replay streaming
- **Tool tab bar** — Quick commands, Macros, Triggers, Highlights, and History share one compact horizontal tab strip with live count badges, replacing the stacked collapsible-tower layout
- **View-mode switcher** — Terminal, Waveform, and Parser are mutually-exclusive views toggled from the toolbar (one click each), so they never stack and compete for terminal height
- **Scripted triggers** — auto-send a configured response when the RX stream matches a text substring or hex byte sequence, with per-trigger cooldown to prevent loops
- **Live status metrics** — beyond cumulative TX/RX byte counts and B/s data rate, the status bar shows frames/s, buffer fill level (%), and cumulative dropped bytes (only when > 0)
- **Auto-update check** — optional update notification via `tauri-plugin-updater` (gracefully returns "no update" when no endpoint is configured)
- **Dark/Light theme** with a one-click sidebar toggle
- **i18n** — English / 中文 UI with a persisted language preference

### Data Processing

- Virtual scrolling + `requestAnimationFrame` batch rendering
- `SerialRxQueue` O(1) ring buffer with head-index drops (periodic compaction) — smooth at high baud rates without unbounded memory growth
- Direction-colored frames (TX green / RX blue) with direction filtering (All / TX / RX)
- Text & HEX search with debounce
- Per-session keyword highlights for TXT/HEX patterns, scoped to All/TX/RX with color tags
- ANSI escape sequence colored rendering
- Data export: TXT (HEX/ASCII), CSV, JSONL, BIN — large exports bypass IPC by writing a temp capture file the Rust side reads back (F12), so 100k-frame exports stay responsive
- **Time-range / direction export filter** — export only the frames in a `[startMs, endMs)` window, optionally restricted to TX or RX
- Right-click context menu for quick copy (HEX / ASCII / UTF-8 / full line)

### Checksum Tools

- Checksum / CRC-8 / CRC-16 / CRC-32 calculation

### AI Terminal Assistant

- Independent floating window, always on top, draggable & resizable
- Describe intent in natural language → AI generates Linux/BusyBox commands
- Powered by ZHIPU AI (`zai-rs`), supporting GLM-5.1 / GLM-5 Turbo / GLM-4.7 / GLM-4.5 Air models, dispatched via a static match table (not `Box<dyn Model>`, so model selection is dyn-safe)
- **Streaming responses** — incremental SSE deltas are accumulated into the full reply with keep-alive handling and mid-stream abort support
- Command risk classification (Safe / Cautious / Dangerous) with auto-blocking of dangerous commands
- Serial log analysis assistant with per-session context and evidence extraction
- Optional Coding Plan mode for improved complex command generation quality
- One-click copy or fill into the send input box

### User Experience

- Dark/Light theme with green accent color, one-click sidebar toggle
- Configuration persistence — auto-restore serial params, display mode, parser templates, Modbus config, AI settings, and recent session captures
- Keyboard shortcuts: `Ctrl+N` new session, `Ctrl+W` close session, `Ctrl+L` clear buffer, `Esc` pause/resume capture, `Ctrl+Enter` send
- LRU cache for formatted results, ensuring performance with large data frames
- Send history + quick command management
- English / 中文 UI with a persisted language preference

## Tech Stack

| Layer             | Technology                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Desktop Framework | [Tauri v2](https://v2.tauri.app/)                                                           |
| Backend           | [Rust](https://www.rust-lang.org/) (tokio / serde / chrono / crc / zai-rs)                  |
| Frontend          | [Vue 3](https://vuejs.org/) Composition API + [TypeScript](https://www.typescriptlang.org/) |
| Build             | [Vite 6](https://vite.dev/)                                                                 |
| UI Components     | [Naive UI](https://www.naiveui.com/) (Dark Theme)                                           |
| State Management  | [Pinia](https://pinia.vuejs.org/)                                                           |
| Virtual Scroll    | [@tanstack/vue-virtual](https://tanstack.com/virtual)                                       |
| ANSI Rendering    | [ansi_up](https://github.com/drudru/ansi_up)                                                |
| Auto-Update       | [tauri-plugin-updater](https://v2.tauri.app/plugin/updater/)                                |
| Benchmarks        | [criterion](https://bheisler.github.io/criterion.rs/) (Rust) + node:test (frontend)         |
| Linting           | ESLint 9 + typescript-eslint                                                                |
| Test Coverage     | [c8](https://github.com/bcoe/c8) (frontend) + cargo-tarpaulin (Rust)                        |
| Dependency Graph  | [madge](https://github.com/dependents/madge) (circular-dep gate)                            |
| Package Manager   | [pnpm](https://pnpm.io/)                                                                    |

## Getting Started

### Prerequisites

- **Rust** stable (edition 2024, minimum 1.85)
- **Node.js** 22+
- **pnpm** 10+
- Serial port access permissions on your OS

### Option 1: Using the Dev Script

```bash
chmod +x scripts/dev.sh

# Install dependencies
./scripts/dev.sh install

# Start dev environment (frontend + Tauri)
./scripts/dev.sh dev

# Build for production
./scripts/dev.sh build
```

Additional commands: `frontend` (frontend only), `tauri` (Tauri only), `lint`, `test`, `help`

### Option 2: Manual Commands

```bash
# Install dependencies
pnpm install

# Development mode
pnpm tauri:dev

# Frontend only
pnpm dev

# Production build
pnpm build          # Frontend type check + build
pnpm tauri:build    # Tauri packaging
```

### Available Scripts

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `pnpm dev`           | Start Vite frontend dev server                |
| `pnpm build`         | Vue type check + Vite build                   |
| `pnpm preview`       | Preview frontend build output                 |
| `pnpm tauri:dev`     | Start Tauri dev mode (with frontend HMR)      |
| `pnpm tauri:build`   | Build production desktop installer            |
| `pnpm format`        | Format frontend + Rust code                   |
| `pnpm format:check`  | Check formatting without writing              |
| `pnpm lint`          | Lint the frontend with ESLint 9               |
| `pnpm test:frontend` | Run frontend unit tests with Node test runner |
| `pnpm test:rust`     | Run Rust unit tests                           |
| `pnpm test`          | Run frontend + Rust unit tests                |
| `pnpm coverage:frontend` | Run frontend tests under `c8` with a coverage gate (`.c8rc.json`) |
| `pnpm coverage:lib`  | Per-file `c8` gate: each `src/lib/` file ≥ 90 % line coverage |
| `pnpm bench:frontend`| Run frontend hot-path microbenchmarks (regression-gated) |
| `pnpm bench:frontend:write` | Rewrite the frontend perf baseline after an intentional optimization |
| `pnpm bench:rust`    | Run Rust `criterion` benchmarks (CRC, export) |
| `pnpm cycles`        | Detect circular dependencies (madge)          |
| `pnpm check`         | Run format check, lint, build, and all tests  |

### Performance Benchmarks

The hot paths are covered by regression-gated benchmarks so a performance drop
fails CI just like a test failure:

- **Frontend** (`pnpm bench:frontend`, `tests/frontend/perf.bench.ts`) — measures the per-frame formatting pipeline (`formatHex` / `formatUtf8`), the RX-flush `concatUint8Arrays`, the MERGED-view rebuild, the LRU format-cache hit rate, the `SerialRxQueue` overflow drop path, the 50 000-frame session push, and the Modbus read-batch composition. A baseline is stored in `tests/frontend/.perf-baseline.json` (machine-local, git-ignored); refresh it with `pnpm bench:frontend:write` after an intentional optimization. A regression > 15 % fails the run.
- **Rust** (`pnpm bench:rust`, `src-tauri/benches/hot_paths.rs`) — `criterion` benchmarks for the checksum algorithms (sum8 / CRC-8 / CRC-16 / CRC-32), `format_hex`, and the export formatter (JSONL / TXT-HEX at 1 k and 10 k frames). Reports ns/µs/ms with statistical confidence.
- **Unit tests** — 576 frontend tests (`pnpm test:frontend`, node:test runner) + 71 Rust tests (`pnpm test:rust`, incl. cross-language IPC contract tests), 0 circular dependencies (`pnpm cycles`), and an 85 % line / 88 % branch coverage gate (`pnpm coverage:frontend`, with a stricter ≥ 90 % per-file gate on `src/lib/`).
- **Bundle** — `ANALYZE=1 pnpm build` emits `dist/stats.html` (treemap) for chunk-size auditing.

## Project Structure

```
bbcom/
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── commands/           # Tauri IPC commands
│   │   │   ├── ai/             #   AI command generation + log analysis
│   │   │   │                     (mod/cooldown/prompts/service/parser/types/tests)
│   │   │   ├── checksum.rs     #   Checksum / CRC calculation
│   │   │   ├── export.rs       #   Data export entry point (incl. F12 capture-file bypass)
│   │   │   ├── log.rs          #   Stateless append_log (auto-log / export JSONL)
│   │   │   ├── updater.rs      #   check_for_updates (tauri-plugin-updater wrapper)
│   │   │   ├── window.rs       #   AI assistant window commands
│   │   │   ├── ipc_contracts.rs      # Cross-language IPC wire-shape tests
│   │   │   └── window_contracts.rs   # AI-window command contract tests
│   │   ├── models/             # Data models
│   │   │   ├── data_frame.rs   #   Data frame (TX/RX + timestamp + bytes)
│   │   │   ├── errors.rs       #   Unified error types (thiserror)
│   │   │   └── checksum_type.rs
│   │   ├── export/             # Export formats (TXT / CSV / JSONL / BIN)
│   │   ├── utils/              # Utilities (HEX format / checksum / timestamp)
│   │   ├── lib.rs              # App entry, window init & plugin registration
│   │   └── main.rs
│   ├── benches/hot_paths.rs    # criterion benches (checksums / format / export)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # Vue 3 frontend
│   ├── components/
│   │   ├── port-selector/      # Serial port selector (+ connection presets)
│   │   ├── session-tabs/       # Session tab bar
│   │   ├── session/            # Session view (SessionView + SessionToolbar)
│   │   ├── send-panel/         # Send panel + AI assistant components
│   │   ├── terminal/           # Data list + protocol panels (virtual scroll)
│   │   │                        (DataPacketList, ModbusPanel + Header/AddForm/RegisterRow,
│   │   │                         ParserPanel + ConfigBar/StatsBar/FrameDetail, WaveformPanel + Legend)
│   │   ├── ai/                 # AI floating window panels
│   │   ├── app-shell/          # Top-level app shell + sidebar
│   │   └── status-bar/         # Status bar (TX/RX stats, frames/s, buffer level, dropped)
│   ├── composables/            # Composable functions
│   │   ├── useSerialConnection.ts # Serial connect / listen / write (TX single-serialization)
│   │   ├── useSessionFrames.ts # Session frame operations
│   │   ├── useSessionModbus.ts # Modbus master orchestration
│   │   ├── useModbusMaster.ts  # Modbus single-busy / single-pending-RX guard
│   │   ├── useAutoLog.ts       # Per-session append_log ordering chain
│   │   ├── useTriggers.ts      # Scripted RX→TX triggers (cooldown-guarded)
│   │   ├── usePacketFilter.ts  # Direction/search/merged view filtering
│   │   ├── usePacketFormatter.ts # HEX / text / ANSI formatting cache
│   │   ├── useExport.ts        # Export logic (F12 capture-file bypass)
│   │   ├── usePortWatcher.ts   # Hot-plug monitoring
│   │   └── useSessionActions.ts
│   ├── stores/                 # Pinia stores
│   │   ├── sessions.ts         # Multi-session management (shallowRef + notifyFramesChanged)
│   │   ├── serial.ts           # Serial device list
│   │   └── app.ts              # Global settings (display / AI / shortcuts)
│   ├── lib/                    # Pure TS, framework-free domain logic
│   │   ├── modbus/             # Modbus barrel (15 modules: core/pdu/transport/
│   │   │                        registers/master-runtime)
│   │   ├── format.ts           # HEX / ASCII / UTF-8 / HEX+ASCII formatting
│   │   ├── bytes.ts            # Uint8Array concatenation
│   │   ├── waveform.ts         # Waveform parse / channel stats
│   │   ├── waveform-viewport.ts# Viewport transforms (normalize/zoom/scale/pan)
│   │   ├── waveform-render.ts  # Canvas render pipeline (framework-free)
│   │   ├── protocol-parser.ts  # Delimiter/fixed/length-field frame reassembly
│   │   ├── protocol-engine.ts  # Transport-agnostic ProtocolEngine interface
│   │   ├── bbrec.ts            # .bbrec raw byte-stream record/replay
│   │   ├── macro-control-flow.ts # Extended macros (wait/if/goto/label)
│   │   ├── macro-library.ts    # Macro library import/export (JSON)
│   │   ├── trigger-engine.ts   # RX substring/hex-match trigger engine
│   │   ├── serial-rx-queue.ts  # O(1) ring buffer (head-index drops)
│   │   ├── write-chunking.ts   # ≤4 KiB TX chunking + retry (F8)
│   │   ├── export-filters.ts   # Time-range / direction export filter
│   │   ├── ai-models.ts        # AI model registry (dispatch-table mirror)
│   │   ├── ai-stream.ts        # SSE delta accumulator (F14)
│   │   ├── session-persistence.ts # Versioned migrate chain (COW-5)
│   │   ├── connection-presets.ts # Named port profiles
│   │   ├── logger.ts           # Structured frontend logger
│   │   ├── ipc.ts              # Typed Tauri command wrappers
│   │   ├── secure-settings.ts  # Tauri Store-backed local secrets
│   │   ├── constants.ts        # Baud rate / data bits constants
│   │   ├── serial-utils.ts     # Serial port path / list utilities
│   │   ├── serial-config.ts    # Serial port config → enum mapping
│   │   ├── lru-cache.ts        # LRU cache
│   │   └── locales/            # i18n catalogs (en.ts / zh.ts / catalog.ts)
│   ├── types/                  # Per-domain TS type barrels
│   │   ├── index.ts            #   re-export barrel
│   │   ├── display.ts serial.ts macros.ts modbus.ts
│   │   ├── waveform.ts ai.ts session.ts checksum.ts constants.ts
│   ├── styles/                 # CSS variables (283 tokens) + global styles
│   ├── App.vue                 # Main window
│   ├── AiWindow.vue            # AI floating window
│   └── main.ts                 # Entry point (route: main / AI window)
├── scripts/
│   └── dev.sh                  # Dev helper script
├── tests/frontend/             # Frontend unit tests (72 files, node:test runner)
│   └── perf.bench.ts           #   regression-gated microbenchmarks
├── docs/                       # Supplementary docs (e.g. high-baud measurement)
├── images/                     # Screenshots
├── .github/workflows/          # ci.yml (lint/build/test/coverage/cycles) + release.yml
├── .c8rc.json                  # c8 coverage gate (85% lines / 88% branches)
├── package.json
├── vite.config.ts
├── eslint.config.mjs
└── tsconfig.json
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Vue 3 Frontend (Naive UI + Pinia + Virtual Scroll)      │
│  ┌───────────┐  ┌────────────┐  ┌───────────────────┐   │
│  │PortSelect  │  │SessionView │  │ AI Terminal Asst  │   │
│  └─────┬─────┘  └─────┬──────┘  └────────┬──────────┘   │
│        │               │                  │              │
│  ┌─────┴───────────────┴──────────────────┴───────────┐  │
│  │          Tauri IPC (invoke / listen / emit)         │  │
│  └───────────────────────┬────────────────────────────┘  │
├──────────────────────────┼───────────────────────────────┤
│  Rust Backend             │                               │
│  ┌────────────────────────┴───────────────────────────┐  │
│  │  commands: ai / checksum / export / log / updater   │  │
│  │            window                                   │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │  tauri-plugin-serialplugin   (serial TX/RX)         │  │
│  │  tauri-plugin-dialog         (file save dialog)     │  │
│  │  tauri-plugin-store          (local settings)       │  │
│  │  tauri-plugin-updater        (auto-update check)    │  │
│  │  zai-rs                      (ZHIPU AI Chat API)    │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- Serial port managed via `tauri-plugin-serialplugin`; frontend communicates with Rust backend through Tauri Command / Event
- Frontend owns all session state and the protocol engines (Modbus, parser, waveform); the Rust side is a thin, stateless IPC + filesystem + AI-client layer
- Frontend uses `requestAnimationFrame` + a bounded O(1) ring buffer (`SerialRxQueue`) for smooth UI at high baud rates; the `sessions` store is a `shallowRef` so 50 k-frame captures stay interactive
- TX is single-serialized through one `writeChain` promise so concurrent senders (cyclic loop, macros, triggers, AI-fill, Modbus) never interleave writes on the port
- Persistence is versioned — a `migratePersistedFile` chain runs on every load so a persisted-shape change stays forward-compatible
- AI assistant runs in an independent `WebviewWindow` — hidden (not destroyed) on close, synced via Tauri Event; responses stream as SSE deltas
- App settings persist locally; AI API keys migrate from legacy localStorage into Tauri Store

> For the full module topology, the inviolable invariants ("sacred cows"), the
> upstream hard constraints, and the manual-verification checklist, see
> [ARCHITECTURE.md](./ARCHITECTURE.md).

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Commit Messages** — Follow [Conventional Commits](https://www.conventionalcommits.org/)
2. **Code Style** — ESLint 9 + typescript-eslint (`no-console: error`, `eqeqeq: error`)
3. **Rust** — Edition 2024, `tracing` for logging, `thiserror` for error handling
4. **TypeScript** — Strict mode (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
5. **Checks** — Run `pnpm check` before opening a PR

### Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add something'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

## FAQ

<details>
<summary><b>Which platforms are supported?</b></summary>

bbcom supports **Windows**, **macOS**, and **Linux**, thanks to Tauri v2's cross-platform architecture.

</details>

<details>
<summary><b>How do I get a ZHIPU AI API key?</b></summary>

Sign up at [open.bigmodel.cn](https://open.bigmodel.cn/) and create an API key. Enter it in the AI Assistant settings panel within bbcom.

</details>

<details>
<summary><b>Why is the serial port not showing up?</b></summary>

- Make sure the device is connected and drivers are installed
- On Linux, you may need to add your user to the `dialout` group: `sudo usermod -aG dialout $USER`
- On macOS, check `ls /dev/cu.*` in Terminal
</details>

## License

This project is licensed under the [MIT License](LICENSE).
