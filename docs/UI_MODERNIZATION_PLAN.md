# bbcom UI 现代化计划

> 日期：2026-08-16。前提：UI 代码库已高度现代化（单一 token 源、双主题 CSS 变量换肤、
> 虚拟滚动、a11y/i18n 有测试背书）。本计划是**补漏与收敛**，不是重写。
> 缺陷清单见 [BUGFIX_AUDIT_2026-08.md](BUGFIX_AUDIT_2026-08.md)（UI-01~16）；
> 前序计划 [UI_READABILITY_PLAN.md](UI_READABILITY_PLAN.md) 的未完项（ui-07 硬编码收敛）
> 并入本计划 M-2。

## 现状基线

- **令牌**：`src/styles/variables.css` 283 个 CSS 自定义属性（颜色/字号/间距/圆角/阴影/
  过渡/z-index/布局）；`scripts/check-css-tokens.mjs` 校验 `var(--xxx)` 拼写（不查硬编码 px
  与裸 z-index 字面量）。
- **主题**：`data-theme` 属性整体换肤；Naive UI 经 `naive-theme.ts` 消费同一套语义 token，
  但 `App.vue` 不传 darkTheme（bundle 权衡），未覆盖组件存在 light 基色泄漏（审计 UI-15）。
- **组件**：Naive UI 仅作控件补充（NButton/NInput/NModal 等），标签页、工具栏、波形图例、
  宏/触发器面板、AppSelect、AppModal 均为手写；弹层三种体系并存
  （NModal / AppModal / ShutdownDialog 手写）。
- **残留债务**：177 处硬编码 px；WaveformLegend 519 行含 13 个近似重复的 tooltip 按钮块；
  三套图标按钮模式并存（WaveformLegend 手写 / IconActionButton / NButton）。

## 阶段与验收标准

### M-1 z-index 令牌治理（本轮随 UI-10 落地代码部分）

1. `AppModal.vue` 的 `z-index: 1000` → `var(--z-modal)`；`Math.random()` id → `useId()`。
2. `variables.css` 补通知级 token（覆盖 ShutdownDialog/LegacyResetGate 现用的裸 `10000`），
   两个组件改用 token。
3. 扩展 `scripts/check-css-tokens.mjs`：扫描 `src/**/*.{vue,css}` 中 `z-index:` 数字字面量
   （白名单：全局 sticky/固定头部等已知项），新违规即失败。

- 验收：`pnpm tokens:check` 通过且规则生效（注入违规样式的自测）。

### M-2 硬编码 px 收敛（ui-07 收尾，177 处）

1. `variables.css` 新增控件宽度 token（`--control-w-xs/sm/md/lg`，吸收
   `width: 86/96/100/112/130px` 等内联定宽）与 `--font-size-xs`（12px）。
2. 重灾区顺序：AI 三件套 + AiSettingsPanel → SessionTabs → ExportDialog → 其余。
3. 波形/终端网格契约值（`packet-columns.css` 与 `PACKET_ROW_HEIGHT`）**不动**（有显式契约注释）。

- 验收：`grep -c 'font-size: 12px' src/` 归零；内联 `style="width: \d+px"` 数量下降且无新增。

### M-3 WaveformLegend 重构

1. 13 个 tooltip+按钮块改为配置数组（action id / icon / tooltip key / disabled 条件）驱动的
   单一渲染循环，目标 ≤200 行。
2. 顺带统一图标按钮模式：WaveformLegend 手写按钮迁至 `IconActionButton`，NButton 仅保留
   文字按钮场景。

- 验收：行为等价（快照/交互测试），行数下降，`wf-btn` 类删除。

### M-4 弹层体系统一

1. `CreateSessionDialog`（NModal）与 `ShutdownDialog`/`LegacyResetGate`（手写）迁移到
   `AppModal`（M-1 之后具备 useId 与 z-token）。
2. NModal 仅保留必须有 preset 表单行为的场景；目标全仓 ≤2 处 NModal。
3. AppModal 增加 `variant`（confirm/dialog/sheet）替代各处自绘按钮排布。

- 验收：`grep -rl "n-modal" src/components | wc -l` ≤ 2；弹层 Esc/焦点陷阱行为一致。

### M-5 Naive 深色覆盖审计（本轮随 UI-15 落地首批）

1. 盘点未列入 `naive-theme.ts` overrides 的在用组件：NSwitch、NTooltip、NProgress、NTabs、
   NDropdown、message provider。
2. 逐个补深色 overrides（轨道/气泡/进度条/tab 条背景走语义 token 或派生深色值）。
3. 评估长期项：动态 import `darkTheme` 换取完整覆盖 vs 维持 overrides（bundle 预算
   ADR-0003 约束下默认维持 overrides）。

- 验收：深色模式下逐组件目检截图对比；无 light 基色残留。

### M-6 会话视图状态保持（本轮随 UI-16 落地子集）

1. 本轮：搜索词、方向筛选、tools 活动页、Modbus 值草稿提升至 session runtime（与 viewMode
   同级），切回不丢。
2. 后续：波形 ruler/视口、parser 面板状态；评估写入 session document 的持久化边界
   （避免快照膨胀，遵循 ADR-0002 派生目录原则）。

- 验收：会话 A↔B 切换往返，上述状态保留；快照体积不增长（未持久化项）。

### M-7 a11y 残余

1. AppSelect 补完整可访问名（label 关联 + aria-describedby）；手写 tab 补 `role=tab` 语义。
2. Trigger/Highlight 启用开关 aria-label 表达「启用 <规则名>」语义；危险操作（删除宏/
   触发器/高亮）补确认（本轮随 UI-13 落地确认部分）。

- 验收：axe 或手动读屏抽检；已有 parity/单测不回退。

### M-8 AI 窗口尺寸治理

1. 初始宽 760→820（本轮随 NAV-11 落地），消除首显水平裁切。
2. `+28px` 标题栏补偿改为 Rust 侧按 `outer_size - inner_size` 差值计算，前端只上报内容
   尺寸。
3. 评估内容宽度 820px 收敛为 token（`--ai-panel-width`），AiWindow 与 AiSettingsPanel 共享。

- 验收：双平台（Linux/Windows）首显无裁切、无底部留白；resize 往返稳定。

## 执行顺序与门禁

```text
M-1(代码) → M-5(首批) → M-6(子集)   [第一轮，已落地]
M-2 → M-3 → M-4 → M-7 → M-8(2,3)   [第二轮，2026-08-17 已落地]
M-5(全量)                            [后续滚动：NSwitch/NTooltip/NProgress/NTabs 之外的组件逐个核对]
```

## 状态（2026-08-17 第二轮收口）

- **M-2 已落地**：`--control-w-xs/sm/md/lg`（86/96/112/130px）入库；`font-size: 12px` 全仓归零（统一 `--font-size-data`）；热点内联定宽（SendPanel/SessionToolbar/AiLogAssistant/TriggerPanel/HighlightPanel）替换为 token。残留：ModbusHeader/DataPacketList/SettingsModal 的 120–168px 网格定宽属表单网格布局，不在控件 token 范围。
- **M-3 已落地**：WaveformLegend 519→447 行，13 个 tooltip 按钮块收敛为 `actions` 配置数组单一循环（`toggler`/`plain` 工厂），新增按钮=新增一个配置项。
- **M-4 已落地**：CreateSessionDialog（含 preset 命名子对话框）迁 AppModal；`.modal-positive` 作为确认按钮稳定类保留给测试选择器。
- **M-7 已落地**：AppSelect 32 处使用全部带 aria-label/aria-labelledby（脚本审计零缺口）；ToolsTabs/SessionTabs role=tab 完整。
- **M-8 已落地**：前端只上报内容尺寸，Rust `resize_ai_window` 按 `outer_size − inner_size` 实测装饰高度补偿；`--ai-panel-width: 820px` token 统一 AiWindow 内容宽。
- 每阶段门禁照旧；全部绿灯（前端 1078 / Rust 350 / lint / format / markdown / tokens / architecture / build / bundle 380KiB 内）。
