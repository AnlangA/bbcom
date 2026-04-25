<div align="center">

# 🔌 bbcom

**跨平台桌面串口调试工具**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [中文](README_zh.md)

</div>

---

## 📖 概述

**bbcom** 是一款跨平台桌面串口调试工具，基于 **Tauri v2 + Rust + Vue 3 + TypeScript** 构建，面向嵌入式开发者的日常调试场景。它支持多会话管理、高性能数据渲染、AI 终端助手、CRC 校验计算和数据导出等丰富功能。

---

## ✨ 核心亮点

- 🔥 **多会话管理** — 同时连接并监控多个串口，独立收发互不干扰
- ⚡ **高性能渲染** — 基于 `@tanstack/vue-virtual` 虚拟滚动 + `requestAnimationFrame` 批量渲染，高波特率下 UI 依然流畅
- 🤖 **AI 终端助手** — 自然语言描述意图，AI 自动生成 Linux/BusyBox 命令，搭载 ZHIPU AI (GLM 系列模型)
- 🎨 **深色主题** — TX(绿色)/RX(蓝色) 方向着色，长时间调试更舒适
- 💾 **数据导出** — 支持 TXT(HEX/ASCII)、CSV、JSONL、BIN 四种格式
- 🔒 **校验工具** — Checksum / CRC-8 / CRC-16 / CRC-32 计算

---

## 📸 截图

<table>
  <tr>
    <td align="center"><b>主窗口</b></td>
    <td align="center"><b>AI 助手</b></td>
  </tr>
  <tr>
    <td><img src="images/主窗口.png" alt="主界面" width="480"/></td>
    <td><img src="images/ai助手窗口.png" alt="AI 终端助手" width="480"/></td>
  </tr>
</table>

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本要求 |
|---|---|
| [Node.js](https://nodejs.org/) | >= 22 |
| [pnpm](https://pnpm.io/) | >= 10 |
| [Rust](https://www.rust-lang.org/) | >= 1.85 |
| [Tauri CLI](https://v2.tauri.app/) | 2.x |

> **macOS**: 需安装 Xcode Command Line Tools
> **Linux**: 需安装 WebKit2GTK 等系统依赖，详见 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/your-username/bbcom.git
cd bbcom

# 2. 安装前端依赖
pnpm install

# 3. 启动开发环境（前端开发服务器 + Tauri 桌面应用）
pnpm tauri:dev

# 或使用脚本助手
chmod +x scripts/dev.sh
./scripts/dev.sh dev
```

### 构建

```bash
# 构建生产版本
pnpm tauri:build

# 或使用脚本
./scripts/dev.sh build
```

---

## 🎯 功能详情

### 🔌 串口通信

- **实时收发** — 支持 HEX / ASCII / UTF-8 / ANSI 多种显示模式
- **完整参数配置** — 波特率 (9600 ~ 921600)、数据位、停止位、校验位、流控
- **多会话管理** — 同时连接多个串口，独立运行、互不干扰
- **热插拔检测** — 自动刷新设备列表，即插即用
- **时间戳** — 毫秒级精度，支持逐帧和合并两种视图模式
- **循环发送** — 可自定义间隔 (50 ms ~ 1 h)

### 💻 数据处理

- **虚拟滚动渲染** — 基于 `@tanstack/vue-virtual`，万级数据帧无压力
- **方向着色** — TX 绿色 / RX 蓝色，支持方向过滤（全部 / TX / RX）
- **搜索功能** — 支持文本和 HEX 搜索，带防抖处理
- **ANSI 渲染** — 支持 ANSI 转义序列彩色显示
- **数据导出** — TXT (HEX/ASCII)、CSV、JSONL、BIN
- **右键菜单** — 快速复制 (HEX / ASCII / UTF-8 / 整行)

### 🤖 AI 终端助手

- **独立悬浮窗** — 可置顶、拖拽、调整大小
- **自然语言转命令** — 描述意图，AI 自动生成 Linux/BusyBox 命令
- **多模型支持** — GLM-5.1 / GLM-5 Turbo / GLM-4.7 / GLM-4.5 Air
- **风险分级** — 安全 / 谨慎 / 危险 三级分类，自动拦截危险命令
- **编码计划模式** — 可选开启，提升复杂命令生成质量
- **一键操作** — 复制命令或直接填入发送输入框

### 🔐 校验工具

- Checksum (累加和校验)
- CRC-8
- CRC-16
- CRC-32

### 🎨 用户体验

- **深色主题** — 绿色强调色，护眼舒适
- **配置持久化** — 自动恢复串口参数、显示模式、AI 设置等
- **快捷键** — `Ctrl+N` 新建会话，`Ctrl+W` 关闭会话
- **LRU 缓存** — 格式化结果缓存，大数据帧场景性能优化
- **发送历史** — 快捷命令管理

---

## 🛠 技术栈

| 层级 | 技术 |
|---|---|
| 桌面框架 | [Tauri v2](https://v2.tauri.app/) |
| 后端 | [Rust](https://www.rust-lang.org/) (tokio / serde / chrono / crc / zai-rs / thiserror) |
| 前端 | [Vue 3](https://vuejs.org/) Composition API + [TypeScript](https://www.typescriptlang.org/) |
| 构建工具 | [Vite 6](https://vite.dev/) |
| UI 组件库 | [Naive UI](https://www.naiveui.com/) (暗色主题) |
| 状态管理 | [Pinia](https://pinia.vuejs.org/) |
| 虚拟滚动 | [@tanstack/vue-virtual](https://tanstack.com/virtual) |
| ANSI 渲染 | [ansi_up](https://github.com/drudru/ansi_up) |
| 串口通信 | [tauri-plugin-serialplugin](https://github.com/tauri-apps/tauri-plugin-serialplugin) |
| AI 接口 | [zai-rs](https://crates.io/crates/zai-rs) (ZHIPU AI) |
| 代码规范 | ESLint 9 + typescript-eslint + eslint-plugin-vue |
| 包管理 | [pnpm](https://pnpm.io/) |

---

## 📁 项目结构

```
bbcom/
├── src-tauri/                      # Rust 后端
│   ├── src/
│   │   ├── commands/               # Tauri IPC 命令
│   │   │   ├── ai.rs               #   AI 窗口控制 + 命令生成
│   │   │   ├── checksum.rs         #   校验和 / CRC 计算
│   │   │   ├── config.rs           #   配置加载与持久化
│   │   │   └── export.rs           #   数据导出入口
│   │   ├── models/                 # 数据模型
│   │   │   ├── port_config.rs      #   串口配置
│   │   │   ├── data_frame.rs       #   数据帧 (TX/RX + 时间戳 + 字节数据)
│   │   │   ├── errors.rs           #   统一错误类型
│   │   │   └── checksum_type.rs    #   校验类型枚举
│   │   ├── export/                 # 导出格式实现 (TXT / CSV / JSONL / BIN)
│   │   │   ├── mod.rs
│   │   │   └── formatter.rs
│   │   ├── utils/                  # 工具函数
│   │   │   ├── checksum.rs         #   校验算法
│   │   │   ├── hex.rs              #   HEX 格式化
│   │   │   ├── timestamp.rs        #   时间戳处理
│   │   │   └── mod.rs
│   │   ├── lib.rs                  # 应用入口、窗口初始化与插件注册
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                            # Vue 3 前端
│   ├── components/
│   │   ├── port-selector/          # 串口选择器
│   │   ├── session-tabs/           # 会话标签栏
│   │   ├── session/                # 会话视图
│   │   ├── send-panel/             # 发送面板 + AI 助手相关组件
│   │   ├── terminal/               # 数据帧列表 (虚拟滚动)
│   │   └── status-bar/             # 状态栏 (TX/RX 统计 / 连接状态)
│   ├── composables/                # 组合式函数
│   │   ├── useSerialPort.ts        #   串口连接 / 监听 / 写入
│   │   ├── useSerialData.ts        #   数据帧管理 + RAF 批量渲染
│   │   ├── usePortWatcher.ts       #   热插拔监控
│   │   ├── useExport.ts            #   导出逻辑
│   │   ├── useSessionActions.ts    #   会话操作
│   │   └── lib/
│   ├── stores/                     # Pinia 状态管理
│   │   ├── sessions.ts             #   多会话管理
│   │   ├── serial.ts               #   串口设备列表
│   │   └── app.ts                  #   应用级状态
│   ├── types/
│   │   └── index.ts                #   类型定义
│   ├── lib/
│   │   ├── constants.ts            #   常量 (波特率、数据位等枚举)
│   │   ├── format.ts               #   格式化工具
│   │   ├── lru-cache.ts            #   LRU 缓存
│   │   └── time.ts                 #   时间工具
│   ├── styles/
│   │   ├── variables.css           #   全局 CSS 变量 (色彩、间距、字体)
│   │   └── global.css              #   全局样式
│   ├── AiWindow.vue                # AI 助手独立窗口
│   ├── App.vue                     # 应用主组件
│   └── main.ts                     # 应用入口
├── scripts/
│   └── dev.sh                      # 开发构建脚本
├── images/                         # 截图资源
├── tests/                          # 测试 (TODO)
├── .github/workflows/release.yml   # CI/CD: 自动构建发布
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
└── eslint.config.mjs
```

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+N` / `Cmd+N` | 新建会话 |
| `Ctrl+W` / `Cmd+W` | 关闭当前会话 |

---

## 🧪 开发相关

```bash
# 仅启动前端开发服务器
pnpm dev

# 仅启动 Tauri 开发模式
pnpm tauri:dev

# 运行 Rust 测试
cd src-tauri && cargo test

# 代码检查
pnpm lint
```

---

## 🤝 贡献指南

欢迎贡献代码、提交 Issue 或提出功能建议！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

请确保代码通过 ESLint 检查，Rust 测试通过，并遵循现有的代码风格。

---

## 📄 许可证

本项目基于 MIT 许可证开源 — 详见 [LICENSE](LICENSE) 文件。

---

<div align="center">
  Made with ❤️ for embedded developers
</div>