# BBCom - 串口调试助手

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

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发服务
pnpm tauri dev

# 构建生产包
pnpm tauri build
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
└── tests/              # 测试
```

## License

MIT
