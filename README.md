# bbcom

跨平台桌面串口调试工具，基于 **Tauri v2 + Rust + Vue 3 + TypeScript** 构建，面向嵌入式开发者的日常调试场景。

## 功能

### 串口通信

![串口调试助手主界面](screenshots/main-interface.png)

- 实时串口数据收发，支持 HEX / ASCII / UTF-8 / ANSI 四种显示模式
- 完整的串口参数配置：波特率（9600 ~ 921600）、数据位、停止位、奇偶校验、流控
- 多会话管理 — 同时连接并监控多个串口，独立收发互不干扰
- 热插拔检测，串口设备列表自动刷新
- 毫秒级精确时间戳，按帧/合并两种查看模式
- 循环发送，可自定义间隔（50ms ~ 1h）

### 数据处理
- 虚拟滚动（@tanstack/vue-virtual）+ requestAnimationFrame 批量渲染，高波特率下 UI 流畅不卡顿
- 数据帧按方向着色（TX 绿 / RX 蓝），支持方向过滤（全部 / TX / RX）
- 文本搜索 & HEX 搜索，带防抖
- ANSI 转义序列着色渲染
- 数据导出：TXT（HEX / ASCII）、CSV、JSONL、BIN 四种格式
- 右键菜单快速复制 HEX / ASCII / UTF-8 / 完整行

### 校验工具
- Checksum / CRC-8 / CRC-16 / CRC-32 校验计算

### AI 终端助手

![AI 终端助手](screenshots/ai-assistant.png)

- 独立悬浮窗口，始终置顶，可拖拽、可调整大小
- 自然语言描述意图，AI 自动生成 Linux/BusyBox 终端命令
- 基于 ZHIPU AI（zai-rs），支持 GLM-5.1 / GLM-5 Turbo / GLM-4.7 / GLM-4.5 Air 模型
- 命令风险分级（安全 / 谨慎 / 危险），危险命令自动拦截
- 可选启用 Coding Plan 模式，提升复杂命令的生成质量
- 生成结果一键复制或填入发送输入框

### 用户体验
- 深色主题，绿色主色调
- 配置持久化 — 自动恢复上次串口参数、显示模式、AI 设置等
- 快捷键：`Ctrl+N` 新建会话、`Ctrl+W` 关闭会话
- LRU 缓存格式化结果，保证大量数据帧下的渲染性能
- 发送历史记录 + 快捷指令管理

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 后端 | Rust（serialport / tokio / serde / chrono / crc / zai-rs） |
| 前端 | Vue 3 Composition API + TypeScript |
| 构建 | Vite 6 |
| UI 组件库 | Naive UI（Dark Theme） |
| 状态管理 | Pinia |
| 虚拟滚动 | @tanstack/vue-virtual |
| ANSI 渲染 | ansi_up |
| 代码规范 | ESLint 9 + typescript-eslint |
| 包管理 | pnpm |

## 项目结构

```
bbcom/
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── commands/           # Tauri IPC 命令
│   │   │   ├── ai.rs           #   AI 窗口控制 + 命令生成
│   │   │   ├── checksum.rs     #   校验和 / CRC 计算
│   │   │   ├── config.rs       #   配置加载与持久化
│   │   │   └── export.rs       #   数据导出入口
│   │   ├── models/             # 数据模型
│   │   │   ├── port_config.rs  #   串口配置（数据位 / 停止位 / 校验 / 流控）
│   │   │   ├── data_frame.rs   #   数据帧（TX/RX + 时间戳 + 字节数据）
│   │   │   ├── errors.rs       #   统一错误类型
│   │   │   └── checksum_type.rs
│   │   ├── export/             # 导出格式实现（TXT / CSV / JSONL / BIN）
│   │   ├── utils/              # 工具函数（HEX 格式化 / 校验算法 / 时间戳）
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
│   │   └── status-bar/         # 状态栏（收发统计 / 连接状态）
│   ├── composables/            # 组合式函数
│   │   ├── useSerialPort.ts    # 串口连接 / 监听 / 写入
│   │   ├── useSerialData.ts    # 数据帧管理 + RAF 批量渲染
│   │   ├── usePortWatcher.ts   # 热插拔监听
│   │   ├── useExport.ts        # 导出逻辑
│   │   └── useSessionActions.ts
│   ├── stores/                 # Pinia 状态
│   │   ├── sessions.ts         # 多会话管理
│   │   ├── serial.ts           # 串口设备列表
│   │   └── app.ts              # 全局设置（显示模式 / AI 配置 / 快捷键）
│   ├── lib/                    # 纯 TS 工具
│   │   ├── format.ts           # HEX / ASCII / UTF-8 格式化
│   │   ├── constants.ts        # 波特率 / 数据位等常量
│   │   ├── lru-cache.ts        # LRU 缓存
│   │   └── time.ts
│   ├── types/index.ts          # TypeScript 类型定义
│   ├── styles/                 # CSS 变量 + 全局样式
│   ├── App.vue                 # 主窗口
│   ├── AiWindow.vue            # AI 悬浮窗口
│   └── main.ts                 # 入口（路由分发主窗口 / AI 窗口）
├── scripts/
│   └── dev.sh                  # 开发辅助脚本
├── package.json
├── vite.config.ts
├── eslint.config.mjs
└── tsconfig.json
```

## 快速开始

### 环境要求

- **Rust** stable（edition 2024，最低 1.85）
- **Node.js** 18+
- **pnpm**（推荐）/ npm / yarn
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

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动 Vite 前端开发服务器 |
| `pnpm build` | Vue 类型检查 + Vite 构建 |
| `pnpm preview` | 预览前端构建产物 |
| `pnpm tauri:dev` | 启动 Tauri 开发模式（含前端热重载） |
| `pnpm tauri:build` | 构建生产桌面安装包 |

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  Vue 3 前端 (Naive UI + Pinia + Virtual Scroll)    │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │PortSelector│  │SessionView│  │ AiTerminalAssistant│ │
│  └─────┬─────┘  └─────┬────┘  └────────┬──────────┘ │
│        │              │                │             │
│  ┌─────┴──────────────┴────────────────┴──────────┐ │
│  │        Tauri IPC (invoke / listen / emit)        │ │
│  └─────────────────────┬───────────────────────────┘ │
├────────────────────────┼────────────────────────────┤
│  Rust 后端             │                             │
│  ┌─────────────────────┴───────────────────────────┐ │
│  │  commands: ai / checksum / config / export       │ │
│  ├─────────────────────────────────────────────────┤ │
│  │  tauri-plugin-serialplugin (串口收发)            │ │
│  │  tauri-plugin-dialog (文件保存对话框)             │ │
│  │  tauri-plugin-store / plugin-fs (持久化)         │ │
│  │  zai-rs (ZHIPU AI Chat API)                     │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

- 串口通过 `tauri-plugin-serialplugin` 管理，前端通过 Tauri Command / Event 与 Rust 后端通信
- 前端使用 requestAnimationFrame + 数据队列批量渲染，确保高波特率下 UI 流畅
- AI 助手为独立 WebviewWindow，关闭时隐藏而非销毁，通过 Tauri Event 同步窗口状态
- 所有配置通过 localStorage + Tauri Store 双重持久化

## 开发约定

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)
- ESLint 9 + typescript-eslint，`no-console: warn`
- Rust edition 2024，tracing 日志，thiserror 错误处理
- 前端严格 TypeScript（`strict: true`，`noUnusedLocals`，`noUnusedParameters`）

## License

MIT
