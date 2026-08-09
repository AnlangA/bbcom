# UI 与可读性优化计划

目标：全面优化 UI 一致性、串口数据内容可读性、保存日志可读性。

## 一、串口数据显示可读性（前端）

1. **HEXASCII 模式名实相符**：终端 HEXASCII 目前与 HEX 显示相同
   （`usePacketFormatter.ts` 将其归入 `formatHex`）。改为走
   `formatHexAscii`（`src/lib/format.ts`，16 字节/行 + ASCII 对照列），
   按行拆分多行显示，行高按 `ceil(字节数/16)` 估算。
2. HEXASCII 不走 ANSI HTML 渲染（`packetUsesHtml` 特判），不受
   `preserveLogLineBreaks` 开关影响（恒多行）。
3. 涉及：`src/composables/usePacketFormatter.ts`、`src/lib/packet-list.ts`、
   `src/components/terminal/DataPacketList.vue`、`PacketRow.vue` 及对应测试。

## 二、保存日志可读性（Rust + 导出映射）

统一落盘 hex 格式为与界面 HEXASCII 一致的 dump 版式：
每行 16 字节 hex + `|ascii|` 对照列；每帧可占多行，每行都带完整前缀
（`[YYYY-MM-DD HH:MM:SS.mmm] DIR |` + 空格），保证 grep 友好。

1. `src-tauri/src/commands/log.rs`：hex 分支改用 dump 版式；时间戳加日期，
   统一复用 `utils::timestamp`；`begin_auto_log`/`finish_auto_log` 写入
   `# bbcom auto-log started/finished <ts> format=<hex|text>` 分隔行。
2. `src-tauri/src/export/formatter.rs`：`txt-hex` 同步 dump 版式。
3. `src/lib/constants.ts`：导出 `txt` 在 HEXASCII 模式下映射为 `txt-hex`
   （与自动日志一致，当前误映射为 `txt-ascii`）。
4. CSV/JSONL/BIN 导出格式不变（机器可读场景）。
5. 更新 Rust 内联测试与前端 use-export / export-format 测试。

## 三、UI 一致性

1. 收尾 `ui-07`：DataPacketList 等残留硬编码间距/字号收敛到
   `variables.css` token（补 12px 字号 token）。
2. 消除逐字重复：`.signal-toggle`（PortSelector/CreateSessionDialog）抽为
   `src/components/ui/SignalToggle.vue`；`.col-*` 列样式抽共享样式。
3. StatusBar 减负：`|` 分隔符改为分组间距，弱化视觉噪声。
4. SessionToolbar 内联魔法宽度与嵌套卡片层级收敛。

## 验证

- `pnpm test:frontend`、`cargo test --manifest-path src-tauri/Cargo.toml`
- `pnpm lint`、`pnpm format:check`、`pnpm build`
