# 项目 AI 开发指南 (AGENTS.md)

## 项目概述 (Project Context)

本项目是一个基于 **Rust** 和 **Tauri v2** 框架构建的跨平台桌面端「串口调试助手 (Serial Port Assistant)」。
主要受众为嵌入式软件工程师。软件需要具备极高的运行稳定性、极低的数据处理延迟，并能优雅地处理各种硬件异常断开与高并发数据流。

> **Tauri 版本锁定为 v2**。Tauri v1 与 v2 的 API 差异巨大（如 v2 使用 `Manager` trait、`Emitter` trait、`WebviewWindow` 替代 v1 的 `Window` 等），所有 Tauri 相关代码必须基于 v2 API 编写，禁止混用 v1 API。在使用 Tauri API 前，务必通过 MCP 确认当前使用的是 v2 语法。

---

## 目标 (Objectives)

1. **极致稳定**：作为调试工具，绝不能因为外部硬件的插拔或异常数据导致崩溃。
2. **高性能 IO**：能够流畅处理高波特率下的海量数据流，UI 渲染不卡顿。
3. **架构清晰**：严格遵守前后端分离。串口通信通过 `tauri-plugin-serialplugin` 管理；Rust 后端负责数据校验、导出、配置等计算密集型任务；前端 (Vue 3 + TS) 负责数据展示与用户交互。
4. **跨平台构建友好**：代码结构需天然适配后续在 Windows 和 Linux 环境下的自动化 CI/CD 打包。

---

## 做什么 (What to do)

### 1. 核心功能实现

* **设备发现与管理**：实时热插拔检测，自动刷新可用串口列表。
* **连接配置**：支持标准配置项（波特率、数据位、停止位、校验位、流控）。
* **数据收发**：支持 HEX / ASCII 双向解析与实时切换。支持定时发送、循环发送。
* **高亮与过滤**：为特定帧头或关键字提供数据高亮功能。
* **日志记录与数据导出**：所有收发数据必须带精确时间戳（毫秒级），支持按会话持久化到本地日志文件（`.txt` / `.csv` / `.bin`），并提供一键导出功能。
* **配置持久化**：用户的串口连接参数预设、窗口布局、发送历史等配置应通过 `tauri-plugin-store` 持久化，下次启动自动恢复。
* **多会话管理**：支持同时打开多个串口连接，每个连接独立的数据视图与收发状态，互不干扰。
* **数据统计面板**：实时显示收发字节数、帧数、错误帧数、连接持续时间、当前波特率等关键指标。

### 2. 数据协议与格式约定

* **HEX 格式**：统一使用大写、空格分隔（如 `AA BB CC DD`），禁止小写或无分隔符的连续 HEX。输入时应容错处理（自动去空格、忽略非法字符）。
* **时间戳格式**：统一使用 `YYYY-MM-DD HH:mm:ss.SSS`（毫秒精度），时区跟随系统本地时间。
* **数据帧标识**：每条收发记录必须标注方向（TX/RX）、时间戳、原始数据，以及当前显示模式（HEX/ASCII）。
* **校验和计算**：提供常用的校验和计算工具（Checksum、CRC-8、CRC-16、CRC-32），结果以 HEX 显示。
* **编码约定**：ASCII 模式默认使用 UTF-8 编码。遇到非可打印字符时，显示为 `.` 或 `\xNN` 转义，不得丢弃或静默替换。

### 3. 前后端通信架构

本项目串口通信采用 `tauri-plugin-serialplugin`（社区插件 v2.22.0），架构如下：

* **串口通信**：前端通过插件 JS API 直接管理串口生命周期（打开/关闭/配置/读写）。
* **数据接收**：前端通过 `port.listen()` 回调接收串口数据，使用 `requestAnimationFrame` + 队列实现批量渲染。
* **断开检测**：监听 `plugin-serialplugin-disconnected-{path}` 事件。
* **热插拔检测**：前端每 1-2 秒轮询 `available_ports()` 并 diff 结果。
* **Rust 后端命令**：仅用于计算密集型任务（CRC/校验和计算）和文件 IO（数据导出）。

### 4. Rust 后端职责范围

由于串口通信由插件接管，Rust 后端专注于：

* **校验和/CRC 计算**：`crc` crate 实现 CRC-8/16/32，性能远优于 JS。
* **数据导出**：将前端传递的数据格式化并写入本地文件（`.txt` / `.csv` / `.bin`）。
* **HEX 工具**：容错解析、格式化输出。
* **时间戳工具**：统一格式化逻辑。
* **配置读写**：通过 `tauri-plugin-store` 或自定义 JSON 文件管理。
* **错误类型**：统一定义 `AppError` 枚举，实现 `serde::Serialize`。

### 5. 前端开发规范

* **框架**：Vue 3 + TypeScript + Vite，使用 `<script setup>` Composition API。
* **状态管理**：Pinia 管理全局状态（串口列表、会话数据、UI 状态）。
* **核心逻辑封装**：Composables 封装串口操作（`useSerialPort`、`useSerialData`、`usePortWatcher`）。
* **终端渲染**：xterm.js 用于原始终端视图。
* **数据包列表**：`@tanstack/vue-virtual` 实现虚拟滚动，处理海量数据。
* **组件库**：Naive UI 提供基础 UI 组件。
* **路由**：`vue-router` 管理多会话视图切换。
* **TypeScript**：启用 strict mode，所有组件和函数必须标注类型。

---

## 怎么做 (How to do it)

* **错误处理体系**：统一定义 `AppError` 枚举（使用 `thiserror`），实现 `serde::Serialize`，确保所有 Rust 后端的错误都能转化为优雅的 JSON 返回给前端展示。
* **性能优化策略**：
  * 串口数据由插件直接推送到前端，前端通过 `requestAnimationFrame` 合并高频更新。
  * 数据包列表使用虚拟滚动（TanStack Virtual），仅渲染可见区域。
  * xterm.js 内部自带虚拟化，适合高频字符流。
* **代码审查标准**：`cargo clippy` 无警告，`pnpm lint` 无错误。

---

## 项目目录结构 (Project Structure)

```
bbcom/
├── AGENTS.md                    # 本文件：项目总指南
├── package.json                 # 前端依赖与脚本
├── vite.config.ts               # Vite 构建配置
├── tsconfig.json                # TypeScript 配置
├── src-tauri/                   # Tauri v2 后端 (Rust)
│   ├── Cargo.toml               # Rust 依赖
│   ├── build.rs                 # tauri_build::build()
│   ├── tauri.conf.json          # Tauri 配置（窗口、权限、打包）
│   ├── capabilities/            # Tauri v2 权限声明
│   │   └── default.json
│   ├── icons/                   # 应用图标
│   └── src/
│       ├── AGENTS.md            # Rust 后端总览
│       ├── main.rs              # 入口：初始化 Tauri app、注册插件和命令
│       ├── lib.rs               # 模块声明、Tauri builder 配置
│       ├── commands/            # Tauri #[command] 函数（IPC 入口）
│       │   ├── AGENTS.md
│       │   ├── mod.rs
│       │   ├── checksum.rs      # 校验和/CRC 计算命令
│       │   ├── export.rs        # 数据导出命令
│       │   └── config.rs        # 配置读写命令
│       ├── models/              # 数据模型（纯类型，零 IO 依赖）
│       │   ├── AGENTS.md
│       │   ├── mod.rs
│       │   ├── errors.rs        # AppError 枚举
│       │   ├── port_config.rs   # PortConfig、BaudRate 等配置类型
│       │   ├── data_frame.rs    # DataFrame：方向、时间戳、原始数据
│       │   └── checksum_type.rs # ChecksumType 枚举（CRC-8/16/32 等）
│       ├── utils/               # 纯函数工具（可独立测试）
│       │   ├── AGENTS.md
│       │   ├── mod.rs
│       │   ├── hex.rs           # HEX 格式化与容错解析
│       │   ├── checksum.rs      # CRC/Checksum 算法实现
│       │   └── timestamp.rs     # 时间戳格式化工具
│       └── export/              # 数据导出逻辑
│           ├── AGENTS.md
│           ├── mod.rs
│           └── formatter.rs     # txt/csv/bin 格式化输出
├── src/                         # 前端 (Vue 3 + TypeScript + Vite)
│   ├── AGENTS.md                # 前端总览
│   ├── App.vue                  # 根组件
│   ├── main.ts                  # 入口：挂载 Vue、注册插件
│   ├── styles/
│   │   └── global.css           # 全局样式
│   ├── components/              # UI 组件
│   │   ├── AGENTS.md
│   │   ├── terminal/
│   │   │   ├── AGENTS.md
│   │   │   ├── TerminalView.vue       # xterm.js 终端视图
│   │   │   └── DataPacketList.vue     # 结构化数据包列表
│   │   ├── port-selector/
│   │   │   ├── AGENTS.md
│   │   │   └── PortSelector.vue       # 串口选择与配置
│   │   ├── send-panel/
│   │   │   ├── AGENTS.md
│   │   │   └── SendPanel.vue          # 发送面板
│   │   ├── status-bar/
│   │   │   ├── AGENTS.md
│   │   │   └── StatusBar.vue          # 底部状态栏
│   │   └── session-tabs/
│   │       ├── AGENTS.md
│   │       └── SessionTabs.vue        # 多会话标签
│   ├── composables/             # Vue composables（核心逻辑）
│   │   ├── AGENTS.md
│   │   ├── useSerialPort.ts           # 串口生命周期管理
│   │   ├── useSerialData.ts           # 数据收发与缓冲
│   │   ├── usePortWatcher.ts          # 热插拔检测
│   │   ├── useConfig.ts               # 配置持久化
│   │   └── useExport.ts               # 数据导出
│   ├── stores/                  # Pinia 状态管理
│   │   ├── AGENTS.md
│   │   ├── serial.ts                  # 串口连接状态
│   │   ├── sessions.ts                # 多会话管理
│   │   └── app.ts                     # 全局 UI 状态
│   ├── lib/                     # 纯 TS 工具函数
│   │   ├── AGENTS.md
│   │   ├── hex.ts                     # HEX 格式化/解析
│   │   └── time.ts                    # 时间戳格式化
│   └── types/                   # TypeScript 类型定义
│       ├── AGENTS.md
│       └── index.ts                   # 共享类型
└── tests/                       # 集成测试
    ├── AGENTS.md
    └── fixtures/                # 模拟串口数据样本
```

### 模块划分原则

* **`commands/` 层保持轻薄**：仅负责参数校验、调用 `utils/` 或 `export/` 的核心逻辑、序列化返回值。禁止在此层编写业务逻辑。
* **`models/` 零依赖**：仅包含类型定义与 `Serialize/Deserialize` 实现，不引入 IO 或框架依赖。
* **`utils/` 纯函数**：无副作用的工具函数，可直接单元测试，不依赖 Tauri 框架。
* **`export/` 与 Tauri 解耦**：格式化逻辑独立于文件写入，便于测试。
* **前端 `composables/` 封装核心逻辑**：组件只管 UI 渲染，业务逻辑全部抽入 composable。
* **新增文件必须注册 `mod.rs`**：每个目录下的模块需在对应的 `mod.rs` 中声明。
* **每个模块目录必须包含 `AGENTS.md`**：描述职责、约束、价值、依赖关系（详见下节）。

---

## 技术栈限定 (Tech Stack Constraints)

### Rust 后端依赖 (`src-tauri/Cargo.toml`)

| Crate | 版本 | 用途 | 说明 |
|-------|------|------|------|
| `tauri` | 2.x | 核心框架 | `features = ["devtools"]` |
| `tauri-build` | 2.x | 构建脚本 | `[build-dependencies]` |
| `tauri-plugin-serialplugin` | 2.x | 串口通信 | 社区插件，内部使用 `serialport-rs` |
| `tauri-plugin-store` | 2.x | 配置持久化 | Key-value 存储 |
| `tauri-plugin-dialog` | 2.x | 文件对话框 | 保存/打开对话框 |
| `tauri-plugin-fs` | 2.x | 文件系统 | 日志文件读写 |
| `serde` | 1.x | 序列化 | `features = ["derive"]` |
| `serde_json` | 1.x | JSON 处理 | |
| `thiserror` | 2.x | 错误处理 | 派生 `AppError` 枚举 |
| `chrono` | 0.4 | 时间戳 | `%.3f` 毫秒精度格式化 |
| `crc` | 3.x | 校验和 | CRC-8/16/32 标准算法 |
| `tracing` | 0.1 | 结构化日志 | 替代 `println!` |
| `tracing-subscriber` | 0.3 | 日志订阅 | `fmt` + `EnvFilter` |
| `hex` | 0.4 | HEX 编解码 | 大写输出 + 容错解码 |
| `uuid` | 1.x | 会话标识 | `features = ["v4"]` |
| `tokio` | 1.x | 异步运行时 | `features = ["full"]` |

### 前端依赖 (`package.json`)

| 包 | 用途 |
|----|------|
| `vue` 3.x | UI 框架 |
| `typescript` | 类型安全 |
| `vite` | 构建工具 |
| `@tauri-apps/api` | Tauri 核心 IPC |
| `tauri-plugin-serialplugin-api` | 串口 JS API |
| `@tauri-apps/plugin-store` | 配置持久化 |
| `@tauri-apps/plugin-dialog` | 文件对话框 |
| `@tauri-apps/plugin-fs` | 文件操作 |
| `pinia` | 状态管理 |
| `vue-router` | 多会话路由 |
| `naive-ui` | UI 组件库 |
| `xterm` | 终端渲染 |
| `@xterm/addon-fit` | xterm 自适应尺寸 |
| `@tanstack/vue-virtual` | 虚拟滚动 |

---

## Tauri v2 关键 API 注意事项

### 必须导入的 Trait

```rust
use tauri::Emitter;  // 必须 import 才能用 app.emit() / window.emit()
use tauri::Manager;  // 用于 app.path()、app.get_webview_window() 等
```

### 路径 API（替代 `dirs` crate）

```rust
// 在 setup 闭包或 command 中
let data_dir = app.path().app_data_dir()?;  // 应用数据目录
let config_dir = app.path().app_config_dir()?;  // 应用配置目录
let log_dir = app.path().app_log_dir()?;  // 日志目录
```

### Async Command

Tauri v2 的 `async fn` command 自动在 tokio 线程池执行，无需手动 spawn。

### 权限声明

Tauri v2 使用 `capabilities/` 目录声明权限，不再使用 v1 的 `allowlist`。串口插件需要在 `capabilities/default.json` 中声明所需权限。

---

## 串口通信架构

### 数据流

```
硬件串口 ←→ tauri-plugin-serialplugin (Rust 层) ←→ 前端 JS API
                                                        ↓
                                               Pinia store + xterm.js
                                               + TanStack Virtual
```

### 关键 API 使用模式

```typescript
// 打开串口
import { SerialPort } from 'tauri-plugin-serialplugin-api';
const port = new SerialPort('COM3');
await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });

// 监听数据
await port.listen((data: string | number[]) => {
  // data 是接收到的原始数据
});

// 写入数据
await port.write('Hello');
await port.writeBinary([0xAA, 0xBB, 0xCC]);

// 断开检测
import { listen } from '@tauri-apps/api/event';
await listen(`plugin-serialplugin-disconnected-COM3`, (event) => {
  // 处理断开
});

// 热插拔检测（轮询）
setInterval(async () => {
  const ports = await SerialPort.available_ports();
  // diff 并更新 UI
}, 1500);
```

### 批量渲染策略

```typescript
// 使用 requestAnimationFrame 合并高频数据
const dataQueue: Uint8Array[] = [];
let rafId: number | null = null;

function onData(data: Uint8Array) {
  dataQueue.push(data);
  if (!rafId) {
    rafId = requestAnimationFrame(() => {
      const merged = mergeBuffers(dataQueue);
      dataQueue.length = 0;
      rafId = null;
      // 更新 xterm 和数据包列表
      updateTerminal(merged);
    });
  }
}
```

---

## 不能做什么 (What NOT to do)

1. **绝对禁止 Panic**：生产代码中严禁 `unwrap()`、`expect()`、`panic!()`。所有可能的失败都必须使用 `Result<T, E>` 冒泡处理。
2. **严禁阻塞主线程**：不要在 Tauri 的 sync command 中执行长耗时操作，使用 async command。
3. **严禁绕过插件直连硬件**：虽然插件从 JS 端调用，但底层仍通过 Tauri IPC 走 Rust 层。禁止使用 Web Serial API 或其他绕过机制。
4. **拒绝隐式类型转换**：HEX/ASCII 转换必须进行边界检查。
5. **避免全量重渲染**：前端数据列表必须使用虚拟滚动，终端必须使用 xterm.js 自有渲染。
6. **禁止在 `models/` 中引入 IO 依赖**：数据模型层必须保持纯类型定义。
7. **禁止在 `commands/` 中编写业务逻辑**：命令层仅做参数校验和调用下层。
8. **禁止在 Rust 代码中使用 `println!`**：统一使用 `tracing` 的 `info!`、`debug!`、`error!` 等宏。

---

## 测试策略 (Testing Strategy)

### Rust 端测试

* **单元测试**（`#[cfg(test)] mod tests`）：与源码放在同一文件中。
  - HEX 格式化与解析（含各种容错边界）
  - CRC/Checksum 计算对比标准测试向量
  - 数据帧序列化/反序列化
  - 导出格式化输出正确性
* **集成测试**（`tests/` 目录）：跨模块协作逻辑。

### 前端测试

* **Composable 单元测试**：使用 `@vue/test-utils` 测试核心逻辑。
* **组件测试**：验证用户交互流程。

### 测试原则

* **新增模块必须有对应测试**。
* **优先测试边界条件**：空数据、最大长度、并发竞争、异常断开。
* **CI 友好**：所有测试必须在无真实硬件环境下可运行。
* `cargo clippy` 无警告，`pnpm lint` 无错误。

---

## 每个模块必须包含 AGENTS.md

每个包含源码的目录下必须有 `AGENTS.md` 文件，格式要求：

```markdown
# 模块名

## 职责 (Responsibilities)
- 这个模块做什么

## 约束 (Constraints)
- 这个模块不能做什么

## 价值 (Value)
- 为什么需要这个模块

## 关系 (Dependencies)
- 依赖哪些其他模块
- 被哪些模块依赖
- 使用了哪些外部 crate
```

---

## Git 与代码协作规范 (Git & Collaboration)

### 提交信息规范 (Conventional Commits)

```
<type>(<scope>): <subject>
```

**type 枚举**：`feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`chore`、`style`

**scope 推荐**：`serial`、`ipc`、`ui`、`config`、`buffer`、`export`、`models`、`composable`、`store`

### 分支策略

* `main`：稳定分支，始终保持可编译、可运行状态。
* `dev`：日常开发集成分支。
* `feat/<功能名>`：功能开发分支。
* `fix/<问题描述>`：Bug 修复分支。

### 代码审查清单

- [ ] `cargo clippy` 无警告
- [ ] `cargo test` 全部通过
- [ ] `pnpm lint` 无错误
- [ ] 无 `unwrap()` / `expect()` / `panic!()` 残留在生产代码中
- [ ] 新增公开接口有文档注释（`///`）
- [ ] 不包含硬编码的路径、密钥或平台特定常量

---

## MCP 工具使用指引 (MCP Tool Usage Guidelines)

AI 在开发过程中**应主动、随时**使用 MCP 工具进行资料查找与技术调研，而非仅凭训练数据中的记忆进行编码。

### 何时必须使用 MCP 查找资料

1. **不确定的 API 用法**：当对某个 crate 的具体函数签名不确定时。
2. **版本兼容性确认**：引入新依赖前确认版本支持。
3. **错误诊断与修复**：遇到编译错误时搜索解决方案。
4. **最佳实践调研**：实现复杂功能前调研社区方案。
5. **平台特定行为**：涉及跨平台差异时查阅官方文档。

### 核心原则

> **宁可多查一次，不可凭记忆错写一行。**
