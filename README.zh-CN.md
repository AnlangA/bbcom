<div align="center">

# 🔌 bbcom

**跨平台桌面串口调试工具**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](./README.md) · [中文](./README.zh-CN.md)

[下载](https://github.com/AnlangA/bbcom/releases)

</div>

---

## 概述

**bbcom** 是面向嵌入式开发者的 Tauri 桌面串口调试工具。它把多会话
串口收发、协议解析、Modbus 主站、波形绘图、数据导出和可选的 Z.ai
命令/日志助手放在同一个应用里。

项目的前端负责会话状态与协议引擎，以便在高吞吐串口数据下保持界面
响应；Rust 侧负责特权文件/导出会话、校验、操作系统凭据存储和有界 AI
客户端调用。

## 核心亮点

- **多会话串口终端**：每个串口会话拥有独立连接状态、收发统计、
  暂停/继续、搜索、方向过滤和最近捕获恢复。
- **高吞吐渲染链路**：有界 O(1) RX 队列、阈值/定时运行时 drain、虚拟
  滚动和每会话帧失效信号协同工作。
- **Modbus 主站**：支持 RTU 与裸 PDU 传输、FC01-FC06/FC10、连续地址
  批量读写、周期读/写、回放数据源和寄存器绑定波形通道。
- **协议工具**：按分隔符、定长、长度字段解析帧，支持有界重同步和
  绝对流偏移。
- **波形绘图**：可绘制 RX 文本数值或 Modbus 寄存器样本，支持通道
  显隐、统计、自动缩放、暂停、清空和 CSV 导出。
- **自动化辅助**：顺序发送/延时宏、RX 触发响应、快捷命令、发送历史、
  高亮规则、连接预设、DTR/RTS 控制和 250 ms BREAK 脉冲。
- **导出与日志**：支持 TXT、CSV、JSONL、BIN；使用后端有界会话、不透明
  保存授权、增量批次和原子替换。
- **AI 助手**：Linux/BusyBox 命令生成与串口日志分析，包含模型校验、
  请求限制/取消、角色隔离提示词和风险分级。
- **桌面体验**：深色/浅色主题、中英文界面、本地设置持久化、快捷键
  和带明确平台签名状态的安装包发布。

## 截图

<table>
  <tr>
    <td align="center"><b>主窗口</b></td>
    <td align="center"><b>AI 助手</b></td>
  </tr>
  <tr>
    <td><img src="images/主窗口.png" alt="主窗口" width="480"/></td>
    <td><img src="images/ai助手窗口.png" alt="AI 助手" width="480"/></td>
  </tr>
  <tr>
    <td align="center"><b>Modbus 寄存器</b></td>
    <td align="center"><b>波形绘图</b></td>
  </tr>
  <tr>
    <td><img src="images/modbus窗口.png" alt="Modbus 寄存器" width="480"/></td>
    <td><img src="images/绘图窗口.png" alt="波形绘图" width="480"/></td>
  </tr>
</table>

## 功能

### 串口终端

- 显示模式：HEX、ASCII、UTF-8、ANSI、HEX+ASCII 分栏视图。
- 串口参数：波特率、数据位、停止位、奇偶校验、流控、DTR 和 RTS。
- 热插拔刷新、自动重连尝试、毫秒级时间戳、按帧/合并视图。
- 循环发送、快捷命令、发送历史，以及串行化的 4 KiB 写入分块；部分
  写失败后不会进行可能造成重复字节的自动重传。
- RX 文本或 HEX 匹配后自动发送响应，触发器自带冷却时间。
- 会话级关键词高亮，可限定 All/TX/RX，并支持文本或 HEX 匹配。

### 协议与数据工具

- 内置 CRLF、NMEA 0183、AT/Modem、SCPI、NUL 分隔二进制和长度前缀帧
  等解析预设。
- `.bbreg` 导入/导出 Modbus 寄存器表和回放数据源。
- 按时间范围与方向过滤导出内容。
- Checksum、CRC-8、CRC-16/X-25、CRC-16/Modbus、CRC-32 计算。

### AI 工作流

- 独立的始终置顶助手窗口。
- 自然语言生成终端命令，并给出安全/谨慎/危险风险分级。
- 基于当前会话上下文回答串口日志问题。
- 前端模型注册表与 Rust 分发表保持一致。
- 支持显式取消、60 秒超时、有界上下文和最多两个不排队的并发请求。

## 技术栈

| 层级       | 技术                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 桌面       | [Tauri v2](https://v2.tauri.app/)                                                                   |
| 后端       | [Rust](https://www.rust-lang.org/) 2024、tokio、serde、thiserror、crc、zai-rs                       |
| 前端       | [Vue 3](https://vuejs.org/) Composition API + [TypeScript](https://www.typescriptlang.org/)         |
| UI         | [Naive UI](https://www.naiveui.com/)、@lucide/vue                                                   |
| 状态       | [Pinia](https://pinia.vuejs.org/)                                                                   |
| 构建       | [Vite 8](https://vite.dev/)、pnpm                                                                   |
| 串口       | tauri-plugin-serialplugin                                                                           |
| 持久化     | 有界 localStorage 会话快照 + 操作系统 API Key 凭据存储                                              |
| 测试与质量 | Vitest、V8 coverage、WebdriverIO/Jasmine、ESLint、Prettier、cargo test、clippy、llvm-cov、criterion |

## 快速开始

### 环境要求

- Rust 1.97.0（edition 2024）
- Node.js 24.13.0
- pnpm 11.11.0
- `cargo-llvm-cov` 0.8.7 与 `cargo-audit` 0.22.2
- 可在 `PATH` 中找到的 ShellCheck
- 操作系统允许访问串口

`pnpm install --frozen-lockfile` 会自动配置仓库声明的精确 Node.js 运行时，
后续项目脚本均使用该受管运行时。

首次提交前请安装本地质量门禁工具：

```bash
cargo install cargo-llvm-cov --version 0.8.7 --locked
cargo install cargo-audit --version 0.22.2 --locked
# ShellCheck：macOS 使用 `brew install shellcheck`；Ubuntu/Debian 使用
# `sudo apt-get install shellcheck`；Windows 使用 `choco install shellcheck`。
```

Linux 下可能需要把用户加入串口权限组，例如：

```bash
sudo usermod -aG dialout "$USER"
```

### 安装与运行

```bash
pnpm install
pnpm tauri:dev
```

仅前端开发：

```bash
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm tauri:build
```

辅助脚本封装了常用流程：

```bash
chmod +x scripts/dev.sh
./scripts/dev.sh install
./scripts/dev.sh dev
./scripts/dev.sh build
```

## 脚本

| 命令                 | 说明                                  |
| -------------------- | ------------------------------------- |
| `pnpm dev`           | 启动 Vite 开发服务器                  |
| `pnpm build`         | Vue 类型检查并构建前端                |
| `pnpm preview`       | 预览前端构建产物                      |
| `pnpm tauri:dev`     | 以 HMR 方式运行 Tauri 桌面应用        |
| `pnpm tauri:build`   | 构建桌面应用包                        |
| `pnpm format`        | 格式化前端与 Rust 代码                |
| `pnpm format:check`  | 检查前端与 Rust 格式                  |
| `pnpm lint`          | 对 `src/` 运行 ESLint                 |
| `pnpm test:frontend` | 运行前端单元测试                      |
| `pnpm test:rust`     | 运行 Rust 单元测试                    |
| `pnpm test`          | 运行前端与 Rust 测试                  |
| `pnpm cycles`        | 检查 TypeScript 导入环                |
| `pnpm check`         | 运行 lint、格式检查、构建和单元测试   |
| `pnpm precommit`     | 运行提交前必须通过的完整本地门禁      |
| `pnpm version:sync`  | 以 package.json 同步 Cargo/Tauri 版本 |
| `pnpm version:check` | 校验 package/Cargo/Tauri 版本一致     |

## 项目地图

```text
bbcom/
├── src/                         # Vue 前端
│   ├── components/              # 应用外壳、会话视图、终端面板、AI 面板
│   ├── composables/             # 串口连接、Modbus 编排、导出、触发器
│   ├── lib/                     # 无框架依赖的领域逻辑与 IPC 封装
│   │   ├── modbus/              # 请求构建、批处理、传输、循环、回放
│   │   ├── format.ts            # HEX/文本/ANSI/HEX+ASCII 格式化
│   │   ├── serial-rx-queue.ts   # 高速捕获使用的有界 RX 队列
│   │   ├── protocol-parser.ts   # 分隔符/定长/长度字段帧解析
│   │   ├── waveform*.ts         # 波形解析、视口数学与画布渲染辅助
│   │   ├── session-persistence.ts
│   │   └── ipc.ts
│   ├── stores/                  # sessions、serial、app 三个 Pinia store
│   ├── styles/                  # 主题 token 与全局样式
│   ├── types/                   # 按领域拆分的类型桶
│   ├── App.vue                  # 主窗口入口
│   └── AiWindow.vue             # AI 悬浮窗口入口
├── src-tauri/                   # Rust 后端
│   ├── src/commands/            # Tauri 命令：ai、checksum、导出/日志会话、window
│   ├── src/export/              # TXT/CSV/JSONL/BIN 格式化器
│   ├── src/models/              # IPC 数据结构与应用错误类型
│   ├── src/utils/               # HEX、时间戳、校验工具
│   └── benches/hot_paths.rs     # Criterion 基准
├── tests/frontend/              # Vitest 单元测试与独立 Node 基准
├── images/                      # README 截图
├── .github/workflows/           # 仅标签触发的 release 工作流
├── .githooks/pre-commit         # 版本化的本地质量门禁
├── ARCHITECTURE.md              # 维护者架构指南
└── scripts/dev.sh               # 开发辅助脚本
```

模块归属、数据流不变量、上游约束与人工验证建议见
[ARCHITECTURE.md](./ARCHITECTURE.md)。

## 验证

版本化 Git pre-commit hook 强制执行前端 lint、格式检查、构建、测试、全局与
P0 覆盖率、browser mock E2E、架构检查、审计、Rust fmt/Clippy/test/llvm-cov，
以及 base/head 前端基准比较。它会校验仓库固定的 Node、pnpm、Rust、
`cargo-llvm-cov` 与 `cargo-audit` 版本。为确保校验对象正是将要提交的 index，
hook 会拒绝未暂存或非忽略的未跟踪文件；请勿使用 `--no-verify` 绕过它。

GitHub Actions 仅承担 release：精确 `vX.Y.Z` 标签触发后执行三平台打包与
smoke 验证，不再重复运行本地 PR 检查。Windows 与 macOS 在完整签名 Secret
已经配置时启用平台签名。

`vX.Y.Z` 标签会生成草稿 release，其中包含 Windows NSIS、macOS arm64 DMG、
Linux AppImage/deb、明确的签名状态清单、SHA-256、CycloneDX SBOM、许可证
清单、Sigstore bundle 和 GitHub 构建来源证明。v0.5.0 不提供自动更新器。

`pnpm install` 会自动安装 hook。提交 PR 前，如本次提交尚未运行门禁，请手动
执行同一命令：

```bash
pnpm precommit
```

## 常见问题

<details>
<summary><b>支持哪些平台？</b></summary>

bbcom 通过 Tauri v2 面向 Windows、macOS 和 Linux。

</details>

<details>
<summary><b>如何获取 Z.ai API Key？</b></summary>

在 [open.bigmodel.cn](https://open.bigmodel.cn/) 创建 API Key，然后填入
AI 助手设置面板。

</details>

<details>
<summary><b>串口设备不显示怎么办？</b></summary>

- 确认设备已连接，驱动已安装。
- Linux 下检查 `dialout` 等串口权限组。
- macOS 下可执行 `ls /dev/cu.*`。
- 插入设备后重新刷新串口列表。

</details>

## 贡献

请使用 Conventional Commits，保持 TypeScript strict 与 Rust warning-free，
并为行为变更补充聚焦测试。如果修改持久化会话结构，需要提升
`SESSION_STORAGE_VERSION`、添加迁移步骤，并用旧数据回归测试覆盖。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
