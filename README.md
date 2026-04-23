# bbcom

基于 **Rust + Tauri v2 + Vue 3** 构建的跨平台桌面端串口调试工具，专为嵌入式软件工程师设计。

## 功能特性

- 实时串口数据收发，支持 HEX / ASCII 双向解析
- 高波特率数据流处理，UI 渲染不卡顿
- 毫秒级精确时间戳记录
- 数据导出（`.txt` / `.csv` / `.bin`）
- 多会话管理，同时连接多个串口
- 热插拔检测，自动刷新设备列表
- CRC / Checksum 校验工具
- 配置持久化，自动恢复上次设置

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Tauri v2 |
| 后端 | Rust |
| 前端 | Vue 3 + TypeScript + Vite |
| 终端 | xterm.js |
| 虚拟滚动 | @tanstack/vue-virtual |
| 状态管理 | Pinia |
| UI 组件库 | Naive UI |

## 快速开始

### 先决条件

- Rust（建议 stable）
- Node.js v16+ 与 pnpm（推荐）/ npm / yarn
- Tauri CLI（项目已作为 devDependency 引入）
- 串口设备访问权限（macOS / Linux / Windows）

### 方式一：使用启动脚本（推荐）

项目提供了 `scripts/dev.sh` 脚本，自动检测包管理器并简化常用操作：

```bash
# 首次使用，赋予执行权限
chmod +x scripts/dev.sh

# 安装依赖
./scripts/dev.sh install

# 一键启动开发环境（前端 + Tauri）
./scripts/dev.sh dev

# 仅启动前端
./scripts/dev.sh frontend

# 仅启动 Tauri
./scripts/dev.sh tauri

# 构建生产包
./scripts/dev.sh build

# 运行 lint
./scripts/dev.sh lint

# 运行测试（前端 + Rust）
./scripts/dev.sh test

# 查看帮助
./scripts/dev.sh help
```

### 方式二：手动命令

```bash
# 安装依赖
pnpm install

# 启动开发服务（前端热重载 + Tauri 窗口）
pnpm tauri:dev

# 仅启动前端 dev server
pnpm dev

# 构建生产包
pnpm build        # 前端构建
pnpm tauri:build  # Tauri 打包

# 代码检查
npx eslint .
```

## 项目结构

```
bbcom/
├── src-tauri/          # Rust 后端
│   ├── commands/       # Tauri IPC 命令
│   ├── models/         # 数据模型
│   ├── utils/          # 工具函数
│   └── export/         # 导出逻辑
├── src/                # Vue 3 前端
│   ├── components/     # UI 组件
│   ├── composables/    # 组合式函数
│   ├── stores/         # Pinia 状态
│   └── lib/            # 纯 TS 工具
├── scripts/            # 开发辅助脚本
│   └── dev.sh          # 一键启动/构建脚本
└── tests/              # 测试
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动 Vite 前端开发服务器 |
| `pnpm build` | 前端类型检查 + 构建 |
| `pnpm preview` | 预览前端构建产物 |
| `pnpm tauri:dev` | 启动 Tauri 开发模式（含前端） |
| `pnpm tauri:build` | 构建生产桌面安装包 |

## 串口通信架构

- 串口由 Rust 后端通过 `serialport` 管理，前端通过 Tauri Command / Event 收发数据
- 支持配置：波特率、数据位、停止位、奇偶校验
- 前端使用 requestAnimationFrame + 数据队列批量渲染，确保高波特率下 UI 流畅
- 支持热插拔检测，自动刷新串口设备列表

## 开发约定

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:`, `fix:`, `chore:` 等）
- 分支策略：`main`（稳定）→ `dev`（开发）→ `feat/xxx`（功能分支）
- PR 需包含变更描述、测试说明与影响范围

## License

MIT