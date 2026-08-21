<div align="center">

# 🔌 bbcom

**Cross-platform desktop serial-port debug assistant**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](./README.md) · [中文](./README.zh-CN.md)

[Download](https://github.com/AnlangA/bbcom/releases)

</div>

---

## Overview

**bbcom** is a Tauri desktop tool for embedded developers who need a fast,
inspectable serial console. It combines multi-session serial TX/RX, protocol
parsing, Modbus master tooling, waveform plotting, export, and an optional
Z.ai-powered command/log assistant in one application.

The frontend owns session state and protocol engines so high-volume serial data
can stay responsive in the webview. Rust owns privileged filesystem/export
sessions, checksums, OS credential storage, and bounded AI client calls.

## Highlights

- **Multi-session serial console** with independent connection state, TX/RX
  counters, pause/resume, search, direction filters, and restored recent
  captures.
- **High-throughput rendering path** using a bounded O(1) RX queue, threshold/
  timer-based runtime drains, virtual scrolling, and per-session frame
  invalidation.
- **Modbus master** for RTU and raw-PDU transports, FC01-FC06/FC10 operations,
  contiguous read/write batching, periodic read/write loops, replay sources,
  and register-to-waveform bindings.
- **Protocol tools** for delimiter, fixed-length, and length-field frame
  parsing with bounded resynchronization and absolute stream offsets.
- **Waveform plotting** for numeric RX streams or Modbus register samples, with
  channel visibility, statistics, autoscale, pause, clear, and CSV export.
- **Automation helpers** including ordered send/delay macros, RX-triggered
  responses, quick commands, send history, highlights, connection presets,
  DTR/RTS control, and a 250 ms BREAK pulse.
- **Export and logging** to TXT, CSV, JSONL, and BIN through bounded backend
  sessions, opaque save grants, incremental batches, and atomic replacement.
- **AI assistant** for Linux/BusyBox command generation and serial-log analysis,
  with model validation, request limits/cancellation, role-separated prompts,
  and risk classification.
- **Desktop polish** with dark/light themes, English/Chinese UI catalogs,
  persisted settings, keyboard shortcuts, and installer releases with explicit
  per-platform signing status.

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
    <td><img src="images/modbus窗口.png" alt="Modbus registers" width="480"/></td>
    <td><img src="images/绘图窗口.png" alt="Waveform plot" width="480"/></td>
  </tr>
</table>

## Core Features

### Serial Console

- Display modes: HEX, ASCII, UTF-8, ANSI, and HEX+ASCII split view.
- Port settings: baud rate, data bits, stop bits, parity, flow control, DTR,
  and RTS.
- Hot-plug port refresh, reconnect attempts, millisecond timestamps, per-frame
  and merged views.
- Cyclic sending, quick commands, send history, and serialized 4 KiB write
  chunks without unsafe automatic retransmission after partial failure.
- Trigger rules that match text or HEX in RX and send a response with cooldown.
- Keyword highlights scoped to All/TX/RX with text or HEX matching.

### Protocol And Data Tools

- Parser presets for CRLF, NMEA 0183, AT/modem, SCPI, NUL-delimited binary, and
  length-prefixed frames.
- Modbus `.bbreg` import/export for register tables and replay data sources.
- Export filters by time range and direction.
- Checksum, CRC-8, CRC-16/X-25, CRC-16/Modbus, and CRC-32 calculations.

### AI Workflows

- Standalone always-on-top assistant window.
- Natural-language prompt to terminal command, with safe/caution/dangerous risk
  classification.
- Serial-log Q&A scoped to the current session context.
- Z.ai model registry shared between frontend validation and Rust dispatch.
- Explicit cancellation, 60-second timeout, bounded context, and at most two
  concurrent requests without a hidden queue.

## Tech Stack

| Layer        | Technology                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Desktop      | [Tauri v2](https://v2.tauri.app/)                                                                   |
| Backend      | [Rust](https://www.rust-lang.org/) 2024, tokio, serde, thiserror, crc, zai-rs                       |
| Frontend     | [Vue 3](https://vuejs.org/) Composition API + [TypeScript](https://www.typescriptlang.org/)         |
| UI           | [Naive UI](https://www.naiveui.com/), @lucide/vue                                                   |
| State        | [Pinia](https://pinia.vuejs.org/)                                                                   |
| Build        | [Vite 8](https://vite.dev/), pnpm                                                                   |
| Serial       | tauri-plugin-serialplugin                                                                           |
| Persistence  | bounded localStorage snapshots + OS credential store for API keys                                   |
| Test/Quality | Vitest, V8 coverage, WebdriverIO/Jasmine, ESLint, Prettier, cargo test, clippy, llvm-cov, criterion |

## Getting Started

### Prerequisites

- Rust 1.97.0 (edition 2024)
- Node.js 24.13.0
- pnpm 11.11.0
- `cargo-llvm-cov` 0.8.7 and `cargo-audit` 0.22.2
- ShellCheck available on `PATH`
- OS permission to access serial ports

`pnpm install --frozen-lockfile` provisions the exact Node.js runtime declared by
the repository, and project scripts run with that managed runtime.

Install the local quality-gate tools before making a commit:

```bash
cargo install cargo-llvm-cov --version 0.8.7 --locked
cargo install cargo-audit --version 0.22.2 --locked
# ShellCheck: macOS `brew install shellcheck`; Ubuntu/Debian
# `sudo apt-get install shellcheck`; Windows `choco install shellcheck`.
```

On Linux you may need to add your user to the serial group, for example:

```bash
sudo usermod -aG dialout "$USER"
```

### Install And Run

```bash
pnpm install
pnpm tauri:dev
```

Frontend-only development:

```bash
pnpm dev
```

Production builds:

```bash
pnpm build
pnpm tauri:build
```

The helper script wraps the same common flows:

```bash
chmod +x scripts/dev.sh
./scripts/dev.sh install
./scripts/dev.sh dev
./scripts/dev.sh build
```

## Scripts

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `pnpm dev`           | Start the Vite dev server                     |
| `pnpm build`         | Type-check the Vue app and build the frontend |
| `pnpm preview`       | Preview the frontend build                    |
| `pnpm tauri:dev`     | Run the Tauri desktop app with frontend HMR   |
| `pnpm tauri:build`   | Build the desktop application bundle          |
| `pnpm format`        | Format frontend and Rust code                 |
| `pnpm format:check`  | Check frontend and Rust formatting            |
| `pnpm lint`          | Run ESLint on `src/`                          |
| `pnpm test:frontend` | Run frontend unit tests                       |
| `pnpm test:rust`     | Run Rust unit tests                           |
| `pnpm test`          | Run frontend and Rust tests                   |
| `pnpm cycles`        | Fail on TypeScript import cycles              |
| `pnpm check`         | Run lint, format check, build, and unit tests |
| `pnpm precommit`     | Run the complete mandatory local commit gate  |
| `pnpm version:sync`  | Sync Cargo/Tauri versions from package.json   |
| `pnpm version:check` | Verify package/Cargo/Tauri versions match     |

## Project Map

```text
bbcom/
├── src/                         # Vue frontend
│   ├── components/              # App shell, session view, terminal panels, AI panels
│   ├── composables/             # Serial connection, Modbus orchestration, export, triggers
│   ├── lib/                     # Framework-free domain logic and IPC wrappers
│   │   ├── modbus/              # Request building, batching, transport, loops, replay
│   │   ├── format.ts            # HEX/text/ANSI/HEX+ASCII formatting
│   │   ├── serial-rx-queue.ts   # Bounded RX queue for high-rate captures
│   │   ├── protocol-parser.ts   # Delimiter/fixed/length-field frame parsing
│   │   ├── waveform*.ts         # Parsing, viewport math, and canvas rendering helpers
│   │   ├── session-persistence.ts
│   │   └── ipc.ts
│   ├── stores/                  # Pinia stores for sessions, serial ports, app settings
│   ├── styles/                  # Theme tokens and global CSS
│   ├── types/                   # Domain type barrels
│   ├── App.vue                  # Main window entry
│   └── AiWindow.vue             # Floating AI window entry
├── src-tauri/                   # Rust backend
│   ├── src/commands/            # Tauri commands: ai, checksum, export/log sessions, window
│   ├── src/export/              # TXT/CSV/JSONL/BIN formatters
│   ├── src/models/              # IPC data and app error models
│   ├── src/utils/               # HEX, timestamp, checksum helpers
│   └── benches/hot_paths.rs     # Criterion benchmarks
├── tests/frontend/              # Vitest unit tests and the standalone Node benchmark
├── images/                      # README screenshots
├── .github/workflows/           # Tag-triggered release workflow
├── .githooks/pre-commit         # Versioned local quality gate
├── ARCHITECTURE.md              # Maintainer architecture guide
└── scripts/dev.sh               # Development helper
```

For module ownership, data-flow invariants, upstream constraints, and manual
verification guidance, read [ARCHITECTURE.md](./ARCHITECTURE.md).

## Verification

The versioned Git pre-commit hook enforces frontend lint/format/build/test,
global and P0 coverage, browser-mock E2E, architecture, audit, Rust
fmt/Clippy/tests/llvm-cov, and the base/head frontend benchmark comparison.
It uses the repository-pinned Node, pnpm, Rust, `cargo-llvm-cov`, and
`cargo-audit` versions. To ensure it validates exactly the index Git will
commit, it rejects unstaged or non-ignored untracked files. Do not use
`--no-verify` to bypass it.

GitHub Actions is intentionally release-only: it runs after an exact
`vX.Y.Z` tag and performs three-platform release assembly and smoke verification
rather than repeating local PR checks. Windows and macOS platform signing is
enabled when the corresponding complete secret set is configured.

Tags matching `vX.Y.Z` produce a draft release containing Windows NSIS, macOS
arm64 DMG, Linux AppImage/deb packages, explicit signing-status manifests,
SHA-256 checksums, a CycloneDX SBOM, license inventories, Sigstore bundles, and
GitHub build provenance. No automatic updater is shipped in v0.5.0.

`pnpm install` installs the hook automatically. Before opening a pull request,
run the exact same gate manually if it has not already run during commit:

```bash
pnpm precommit
```

## FAQ

<details>
<summary><b>Which platforms are supported?</b></summary>

bbcom targets Windows, macOS, and Linux through Tauri v2.

</details>

<details>
<summary><b>How do I get a Z.ai API key?</b></summary>

Create a key at [open.bigmodel.cn](https://open.bigmodel.cn/) and enter it in
the AI assistant settings panel.

</details>

<details>
<summary><b>Why is my serial port missing?</b></summary>

- Confirm the device is connected and the driver is installed.
- On Linux, check group permissions such as `dialout`.
- On macOS, check `ls /dev/cu.*`.
- Reopen the port list after plugging in the device.

</details>

## Contributing

Please use Conventional Commits, keep TypeScript strict, keep Rust warnings
clean, and include focused tests for behavior changes. For persisted session
shape changes, bump `SESSION_STORAGE_VERSION`, add a migration step, and cover
legacy data with a regression test.

## License

This project is licensed under the [MIT License](LICENSE).
