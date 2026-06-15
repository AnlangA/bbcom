<div align="center">

# 🔌 bbcom

**跨平台桌面串口调试工具**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](./README.md) · [中文](./README.zh-CN.md)

[⬇️ 下载](https://github.com/AnlangA/bbcom/releases)

</div>

---

## 概述

**bbcom** 是一款跨平台桌面串口调试工具，基于 **Tauri v2 + Rust + Vue 3 + TypeScript** 构建，面向嵌入式开发者的日常调试场景。

### 核心亮点

- 🔥 **多会话管理** — 同时连接并监控多个串口，独立收发互不干扰
- ⚡ **高性能渲染** — 虚拟滚动 + 批量渲染，高波特率下 UI 流畅不卡顿
- 🤖 **AI 终端助手** — 自然语言描述意图，AI 自动生成终端命令
- 🎨 **深色主题** — TX/RX 方向着色，长时间调试更舒适
- 💾 **数据导出** — 支持 TXT、CSV、JSONL、BIN 四种格式
- 🔒 **校验工具** — Checksum / CRC-8 / CRC-16 / CRC-32 计算

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
</table>

## 功能

### 串口通信

- 实时串口数据收发，支持 **HEX / ASCII / UTF-8 / ANSI** 四种显示模式
- 完整的串口参数配置：波特率（9600 ~ 921600）、数据位、停止位、奇偶校验、流控
- 多会话管理 — 同时连接并监控多个串口，独立收发互不干扰
- 最近会话捕获自动恢复（重启后保留最近日志，串口不会自动重连）
- 热插拔检测，串口设备列表自动刷新
- 毫秒级精确时间戳，按帧/合并两种查看模式
- 循环发送，可自定义间隔（50ms ~ 1h）
- 宏命令序列发送，支持每步延迟、导入/导出 JSON
- BREAK 信号发送（250ms），用于 Arduino 自动复位 / ESP32 下载模式
- 协议解析模板：按分隔符、定长、长度字段拆分 RX 字节流
- 脚本触发器：RX 文本或 HEX 匹配后自动发送响应，带冷却时间防止循环触发

### 数据处理

- 虚拟滚动（`@tanstack/vue-virtual`）+ `requestAnimationFrame` 批量渲染，高波特率下 UI 流畅不卡顿
- 数据帧按方向着色（TX 绿 / RX 蓝），支持方向过滤（全部 / TX / RX）
- 文本搜索 & HEX 搜索，带防抖
- 会话级关键词高亮：支持 TXT/HEX 模式、全部/TX/RX 范围和颜色标记
- ANSI 转义序列着色渲染
- 数据导出：TXT（HEX / ASCII）、CSV、JSONL、BIN 四种格式
- 右键菜单快速复制 HEX / ASCII / UTF-8 / 完整行

### 校验工具

- Checksum / CRC-8 / CRC-16 / CRC-32 校验计算

### AI 终端助手

- 独立悬浮窗口，始终置顶，可拖拽、可调整大小
- 自然语言描述意图，AI 自动生成 Linux/BusyBox 终端命令
- 基于 ZHIPU AI（`zai-rs`），支持 GLM-5.1 / GLM-5 Turbo / GLM-4.7 / GLM-4.5 Air 模型
- 命令风险分级（安全 / 谨慎 / 危险），危险命令自动拦截
- 串口日志分析助手，基于当前会话上下文提取依据和建议
- 可选启用 Coding Plan 模式，提升复杂命令的生成质量
- 生成结果一键复制或填入发送输入框

### 用户体验

- 深色主题，绿色主色调
- 配置持久化 — 自动恢复上次串口参数、显示模式、协议解析模板、AI 设置和最近会话捕获
- 快捷键：`Ctrl+N` 新建会话、`Ctrl+W` 关闭会话、`Ctrl+L` 清空、`Esc` 暂停/继续捕获、`Ctrl+Enter` 发送
- LRU 缓存格式化结果，保证大量数据帧下的渲染性能
- 发送历史记录 + 快捷指令管理

## 技术栈

| 层级      | 技术                                                                                        |
| --------- | ------------------------------------------------------------------------------------------- |
| 桌面框架  | [Tauri v2](https://v2.tauri.app/)                                                           |
| 后端      | [Rust](https://www.rust-lang.org/)（tokio / serde / chrono / crc / zai-rs）                 |
| 前端      | [Vue 3](https://vuejs.org/) Composition API + [TypeScript](https://www.typescriptlang.org/) |
| 构建      | [Vite 6](https://vite.dev/)                                                                 |
| UI 组件库 | [Naive UI](https://www.naiveui.com/)（Dark Theme）                                          |
| 状态管理  | [Pinia](https://pinia.vuejs.org/)                                                           |
| 虚拟滚动  | [@tanstack/vue-virtual](https://tanstack.com/virtual)                                       |
| ANSI 渲染 | [ansi_up](https://github.com/drudru/ansi_up)                                                |
| 代码规范  | ESLint 9 + typescript-eslint                                                                |
| 包管理    | [pnpm](https://pnpm.io/)                                                                    |

## 快速开始

### 环境要求

- **Rust** stable（edition 2024，最低 1.85）
- **Node.js** 22+
- **pnpm** 10+
- 操作系统串口访问权限

### 方式一：使用开发脚本

```bash
chmod +x scripts/dev.sh

# 安装依赖
./scripts/dev.sh install

# 启动开发环境（前端 + Tauri）
./scripts/dev.sh dev

# 构建生产包
./scripts/dev.sh build
```

其他命令：`frontend`（仅前端）、`tauri`（仅 Tauri）、`lint`、`test`、`help`

### 方式二：手动命令

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm tauri:dev

# 仅前端
pnpm dev

# 生产构建
pnpm build          # 前端类型检查 + 构建
pnpm tauri:build    # Tauri 打包
```

### 可用脚本

| 命令                 | 说明                                   |
| -------------------- | -------------------------------------- |
| `pnpm dev`           | 启动 Vite 前端开发服务器               |
| `pnpm build`         | Vue 类型检查 + Vite 构建               |
| `pnpm preview`       | 预览前端构建产物                       |
| `pnpm tauri:dev`     | 启动 Tauri 开发模式（含前端热重载）    |
| `pnpm tauri:build`   | 构建生产桌面安装包                     |
| `pnpm format`        | 格式化前端 + Rust 代码                 |
| `pnpm format:check`  | 检查格式（不写入）                     |
| `pnpm test:frontend` | 使用 Node test runner 运行前端单元测试 |
| `pnpm test:rust`     | 运行 Rust 单元测试                     |
| `pnpm check`         | 运行格式检查、lint、build 和全部测试   |

## 项目结构

```
bbcom/
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── commands/           # Tauri IPC 命令
│   │   │   ├── ai.rs           #   AI 命令生成 + 日志分析
│   │   │   ├── checksum.rs     #   校验和 / CRC 计算
│   │   │   ├── export.rs       #   数据导出入口
│   │   │   └── window.rs       #   AI 助手窗口命令
│   │   ├── models/             # 数据模型
│   │   │   ├── data_frame.rs   #   数据帧（TX/RX + 时间戳 + 字节数据）
│   │   │   ├── errors.rs       #   统一错误类型
│   │   │   └── checksum_type.rs
│   │   ├── export/             # 导出格式实现（TXT / CSV / JSONL / BIN）
│   │   ├── utils/              # 工具函数（HEX 格式化 / 校验算法）
│   │   ├── lib.rs              # 应用入口，窗口初始化与插件注册
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # Vue 3 前端
│   ├── components/
│   │   ├── port-selector/      # 串口选择器
│   │   ├── session-tabs/       # 会话标签栏
│   │   ├── session/            # 会话视图
│   │   ├── send-panel/         # 发送面板 + AI 助手组件
│   │   ├── terminal/           # 数据帧列表（虚拟滚动）
│   │   ├── ai/                 # AI 悬浮窗口面板
│   │   └── status-bar/         # 状态栏（收发统计 / 连接状态）
│   ├── composables/            # 组合式函数
│   │   ├── useSerialConnection.ts # 串口连接 / 监听 / 写入
│   │   ├── useSessionFrames.ts # 会话数据帧操作
│   │   ├── usePacketFilter.ts  # 方向过滤 / 搜索 / 合并视图
│   │   ├── usePacketFormatter.ts # HEX / 文本 / ANSI 格式化缓存
│   │   ├── usePortWatcher.ts   # 热插拔监听
│   │   ├── useExport.ts        # 导出逻辑
│   │   └── useSessionActions.ts
│   ├── stores/                 # Pinia 状态
│   │   ├── sessions.ts         # 多会话管理
│   │   ├── serial.ts           # 串口设备列表
│   │   └── app.ts              # 全局设置（显示模式 / AI 配置 / 快捷键）
│   ├── lib/                    # 纯 TS 工具
│   │   ├── format.ts           # HEX / ASCII / UTF-8 格式化
│   │   ├── bytes.ts            # Uint8Array 拼接
│   │   ├── logger.ts           # 结构化前端日志
│   │   ├── constants.ts        # 波特率 / 数据位等常量
│   │   ├── ipc.ts              # 类型化 Tauri 命令封装
│   │   ├── secure-settings.ts  # 基于 Tauri Store 的本地密钥设置
│   │   ├── serial-utils.ts    # 串口路径 / 列表工具
│   │   ├── serial-config.ts   # 串口配置 → 枚举映射
│   │   ├── lru-cache.ts        # LRU 缓存
│   │   └── time.ts
│   ├── types/index.ts          # TypeScript 类型定义
│   ├── styles/                 # CSS 变量 + 全局样式
│   ├── App.vue                 # 主窗口
│   ├── AiWindow.vue            # AI 悬浮窗口
│   └── main.ts                 # 入口（路由分发主窗口 / AI 窗口）
├── scripts/
│   └── dev.sh                  # 开发辅助脚本
├── tests/frontend/             # 前端单元测试
├── images/                     # 截图
├── package.json
├── vite.config.ts
├── eslint.config.mjs
└── tsconfig.json
```

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│  Vue 3 前端 (Naive UI + Pinia + Virtual Scroll)          │
│  ┌───────────┐  ┌────────────┐  ┌───────────────────┐   │
│  │串口选择器   │  │ 会话视图    │  │  AI 终端助手      │   │
│  └─────┬─────┘  └─────┬──────┘  └────────┬──────────┘   │
│        │               │                  │              │
│  ┌─────┴───────────────┴──────────────────┴───────────┐  │
│  │          Tauri IPC (invoke / listen / emit)         │  │
│  └───────────────────────┬────────────────────────────┘  │
├──────────────────────────┼───────────────────────────────┤
│  Rust 后端                │                               │
│  ┌────────────────────────┴───────────────────────────┐  │
│  │  commands: ai / checksum / export / window          │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │  tauri-plugin-serialplugin   (串口收发)              │  │
│  │  tauri-plugin-dialog         (文件保存对话框)         │  │
│  │  tauri-plugin-store         (本地设置)               │  │
│  │  zai-rs                      (ZHIPU AI Chat API)    │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- 串口通过 `tauri-plugin-serialplugin` 管理，前端通过 Tauri Command / Event 与 Rust 后端通信
- 前端使用 `requestAnimationFrame` + 有界数据队列，确保高波特率下 UI 流畅
- AI 助手为独立 `WebviewWindow`，关闭时隐藏而非销毁，通过 Tauri Event 同步窗口状态
- AI 日志上下文按需刷新，不会把每一帧串口数据持续广播到悬浮窗口
- 应用设置本地持久化；AI API Key 会从旧 localStorage 迁移到 Tauri Store

## 贡献指南

欢迎贡献！请遵循以下规范：

1. **提交信息** — 遵循 [Conventional Commits](https://www.conventionalcommits.org/)
2. **代码风格** — ESLint 9 + typescript-eslint（`no-console: error`、`eqeqeq: error`）
3. **Rust** — edition 2024，`tracing` 日志，`thiserror` 错误处理
4. **TypeScript** — 严格模式（`strict: true`、`noUnusedLocals`、`noUnusedParameters`）
5. **检查** — 发起 PR 前运行 `pnpm check`

### 开发流程

1. Fork 本仓库
2. 创建功能分支（`git checkout -b feat/my-feature`）
3. 提交更改（`git commit -m 'feat: add something'`）
4. 推送到分支（`git push origin feat/my-feature`）
5. 发起 Pull Request

## 常见问题

<details>
<summary><b>支持哪些平台？</b></summary>

bbcom 支持 **Windows**、**macOS** 和 **Linux**，得益于 Tauri v2 的跨平台架构。

</details>

<details>
<summary><b>如何获取 ZHIPU AI API Key？</b></summary>

在 [open.bigmodel.cn](https://open.bigmodel.cn/) 注册并创建 API Key，然后在 bbcom 的 AI 助手设置面板中填入即可。

</details>

<details>
<summary><b>串口设备不显示怎么办？</b></summary>

- 确认设备已连接且驱动已安装
- Linux 下可能需要将用户加入 `dialout` 组：`sudo usermod -aG dialout $USER`
- macOS 下可在终端执行 `ls /dev/cu.*` 检查设备
</details>

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
