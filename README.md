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

- Real-time serial data TX/RX with **HEX / ASCII / UTF-8 / ANSI** display modes
- Full serial parameter configuration: baud rate (9600 ~ 921600), data bits, stop bits, parity, flow control
- Multi-session management — connect and monitor multiple ports independently
- Recent session captures auto-restore across app restarts (ports stay disconnected until you reconnect)
- Hot-plug detection with automatic device list refresh
- Millisecond-precision timestamps, per-frame and merged view modes
- Cyclic sending with customizable interval (50 ms ~ 1 h)
- **Sequenced macros** with per-step delays — scripted device bring-up (boot commands with wait-for-boot gaps), à la CoolTerm/TeraTerm
- **Macro library import/export** (JSON) — share scripted sequences across sessions and machines
- **Connection presets** — save and reuse named port profiles (baud/data/stop/parity/flow/DTR/RTS)
- **BREAK signal** (250 ms) — one-click Arduino auto-reset / ESP32 bootloader entry
- DTR/RTS handshake line control for boot-mode selection
- **Waveform visualization** — parses numeric RX data (CSV/space/semicolon) and plots a live scrolling chart, Arduino Serial Plotter / serial-studio style. Pause/resume, per-channel show/hide, min/max/avg stats, autoscale Y-axis labels, clear, and one-click CSV export
- **Protocol parser** — reassembles the RX byte stream into discrete frames by delimiter (CRLF/custom hex), fixed length, or length-field header; click any frame for a hex+ASCII dump, filter frames by text, and see live frame/byte/throughput stats. Presets include NMEA 0183, AT/modem, SCPI/instrument, length-prefixed (1B/2B BE+LE), and NUL-delimited binary
- **Modbus master** — RTU (addr+PDU+CRC) and PDU (raw, TCP-gateway style) transports; read FC01-FC04, write single FC05/06, write multiple FC10; contiguous addresses auto-batch; value types span bool/u8/i8/u16/i16/u32/i32/f32 (BE+LE); configurable poll/write intervals and timeout; per-row periodic read (R) or periodic write (W) toggles; registers can bind to waveform channels 0-7 for live plotting; `.bbreg` config import/export, batch Read all / Send all, and data-source Replay streaming
- **Tool tab bar** — Quick commands, Macros, Triggers, Highlights, and History share one compact horizontal tab strip with live count badges, replacing the stacked collapsible-tower layout
- **View-mode switcher** — Terminal, Waveform, and Parser are mutually-exclusive views toggled from the toolbar (one click each), so they never stack and compete for terminal height
- **Scripted triggers** — auto-send a configured response when the RX stream matches a text substring or hex byte sequence, with per-trigger cooldown to prevent loops
- **Dark/Light theme** with a one-click sidebar toggle
- **i18n** — English / 中文 UI with a persisted language preference

### Data Processing

- Virtual scrolling + `requestAnimationFrame` batch rendering
- Direction-colored frames (TX green / RX blue) with direction filtering (All / TX / RX)
- Text & HEX search with debounce
- Per-session keyword highlights for TXT/HEX patterns, scoped to All/TX/RX with color tags
- ANSI escape sequence colored rendering
- Data export: TXT (HEX/ASCII), CSV, JSONL, BIN
- Right-click context menu for quick copy (HEX / ASCII / UTF-8 / full line)

### Checksum Tools

- Checksum / CRC-8 / CRC-16 / CRC-32 calculation

### AI Terminal Assistant

- Independent floating window, always on top, draggable & resizable
- Describe intent in natural language → AI generates Linux/BusyBox commands
- Powered by ZHIPU AI (`zai-rs`), supporting GLM-5.1 / GLM-5 Turbo / GLM-4.7 / GLM-4.5 Air models
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
| Linting           | ESLint 9 + typescript-eslint                                                                |
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
| `pnpm test:frontend` | Run frontend unit tests with Node test runner |
| `pnpm test:rust`     | Run Rust unit tests                           |
| `pnpm coverage:frontend` | Run frontend tests under `c8` with a coverage gate (`.c8rc.json`) |
| `pnpm bench:frontend`| Run frontend hot-path microbenchmarks (regression-gated) |
| `pnpm bench:rust`    | Run Rust `criterion` benchmarks (CRC, export) |
| `pnpm check`         | Run format check, lint, build, and all tests  |

### Performance Benchmarks

The hot paths are covered by regression-gated benchmarks so a performance drop
fails CI just like a test failure:

- **Frontend** (`pnpm bench:frontend`, `tests/frontend/perf.bench.ts`) — measures the per-frame formatting pipeline (`formatHex` / `formatUtf8`), the RX-flush `concatUint8Arrays`, the MERGED-view rebuild, the LRU format-cache hit rate, the `SerialRxQueue` overflow drop path, the 50 000-frame session push, and the Modbus read-batch composition. A baseline is stored in `tests/frontend/.perf-baseline.json` (machine-local, git-ignored); refresh it with `pnpm bench:frontend:write` after an intentional optimization. A regression > 15 % fails the run.
- **Rust** (`pnpm bench:rust`, `src-tauri/benches/hot_paths.rs`) — `criterion` benchmarks for the checksum algorithms (sum8 / CRC-8 / CRC-16 / CRC-32), `format_hex`, and the export formatter (JSONL / TXT-HEX at 1 k and 10 k frames). Reports ns/µs/ms with statistical confidence.
- **Bundle** — `ANALYZE=1 pnpm build` emits `dist/stats.html` (treemap) for chunk-size auditing.

## Project Structure

```
bbcom/
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── commands/           # Tauri IPC commands
│   │   │   ├── ai/             #   AI command generation + log analysis (mod/cooldown/prompts/service/parser)
│   │   │   ├── checksum.rs     #   Checksum / CRC calculation
│   │   │   ├── export.rs       #   Data export entry point
│   │   │   └── window.rs       #   AI assistant window commands
│   │   ├── models/             # Data models
│   │   │   ├── data_frame.rs   #   Data frame (TX/RX + timestamp + bytes)
│   │   │   ├── errors.rs       #   Unified error types
│   │   │   └── checksum_type.rs
│   │   ├── export/             # Export formats (TXT / CSV / JSONL / BIN)
│   │   ├── utils/              # Utilities (HEX format / checksum)
│   │   ├── lib.rs              # App entry, window init & plugin registration
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # Vue 3 frontend
│   ├── components/
│   │   ├── port-selector/      # Serial port selector
│   │   ├── session-tabs/       # Session tab bar
│   │   ├── session/            # Session view
│   │   ├── send-panel/         # Send panel + AI assistant components
│   │   ├── terminal/           # Data frame list (virtual scroll)
│   │   ├── ai/                 # AI floating window panels
│   │   └── status-bar/         # Status bar (TX/RX stats / connection)
│   ├── composables/            # Composable functions
│   │   ├── useSerialConnection.ts # Serial connect / listen / write
│   │   ├── useSessionFrames.ts # Session frame operations
│   │   ├── usePacketFilter.ts  # Direction/search/merged view filtering
│   │   ├── usePacketFormatter.ts # HEX / text / ANSI formatting cache
│   │   ├── usePortWatcher.ts   # Hot-plug monitoring
│   │   ├── useExport.ts        # Export logic
│   │   └── useSessionActions.ts
│   ├── stores/                 # Pinia stores
│   │   ├── sessions.ts         # Multi-session management
│   │   ├── serial.ts           # Serial device list
│   │   └── app.ts              # Global settings (display / AI / shortcuts)
│   ├── lib/                    # Pure TS utilities
│   │   ├── format.ts           # HEX / ASCII / UTF-8 formatting
│   │   ├── bytes.ts            # Uint8Array concatenation
│   │   ├── logger.ts           # Structured frontend logger
│   │   ├── constants.ts        # Baud rate / data bits constants
│   │   ├── ipc.ts              # Typed Tauri command wrappers
│   │   ├── secure-settings.ts  # Tauri Store-backed local secrets
│   │   ├── serial-utils.ts    # Serial port path / list utilities
│   │   ├── serial-config.ts   # Serial port config → enum mapping
│   │   ├── lru-cache.ts        # LRU cache
│   │   └── time.ts
│   ├── types/index.ts          # TypeScript type definitions
│   ├── styles/                 # CSS variables + global styles
│   ├── App.vue                 # Main window
│   ├── AiWindow.vue            # AI floating window
│   └── main.ts                 # Entry point (route: main / AI window)
├── scripts/
│   └── dev.sh                  # Dev helper script
├── tests/frontend/             # Frontend unit tests
├── images/                     # Screenshots
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
│  │  commands: ai / checksum / export / window          │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │  tauri-plugin-serialplugin   (serial TX/RX)         │  │
│  │  tauri-plugin-dialog         (file save dialog)     │  │
│  │  tauri-plugin-store         (local settings)        │  │
│  │  zai-rs                      (ZHIPU AI Chat API)    │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- Serial port managed via `tauri-plugin-serialplugin`; frontend communicates with Rust backend through Tauri Command / Event
- Frontend uses `requestAnimationFrame` + bounded data queues for smooth UI at high baud rates
- AI assistant runs in an independent `WebviewWindow` — hidden (not destroyed) on close, synced via Tauri Event
- AI log context is refreshed on demand instead of streaming every received frame into the floating window
- App settings persist locally; AI API keys migrate from legacy localStorage into Tauri Store

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
