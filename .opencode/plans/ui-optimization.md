# bbcom UI 全面优化计划

## 项目概述

**bbcom** 是一个基于 Tauri + Vue 3 + Naive UI 的串口调试工具。当前 UI 已有良好的设计基础（CSS 变量系统、Naive UI 主题覆盖），但在交互体验、动画过渡和响应式布局方面有较大优化空间。

---

## Phase 1: 侧边栏改进

### 1.1 侧边栏拖拽调整宽度

**文件**: `src/stores/app.ts`, `src/components/app-shell/AppShell.vue`

**改动**:
- 在 `app.ts` 中添加 `sidebarWidth` (默认 292) 和 `sidebarCollapsed` (默认 false) 状态，持久化到本地存储
- 在 `AppShell.vue` 的 `.sidebar` 和 `.main` 之间添加一个 `.resize-handle` 元素（4px 宽，hover 时高亮）
- 使用 `mousedown/mousemove/mouseup` 事件实现拖拽调整宽度
- 宽度范围限制在 `--sidebar-width-min` (252px) 到 `--sidebar-width-max` (340px)
- 侧边栏的 `width` 绑定到 store 中的 `sidebarWidth`

### 1.2 侧边栏折叠/展开

**文件**: `src/components/app-shell/AppShell.vue`

**改动**:
- 在 sidebar-header 的 brand-mark 旁边添加一个折叠按钮（使用 `PanelLeftClose` / `PanelLeftOpen` 图标）
- 折叠时侧边栏宽度缩至 48px，只显示图标
- 折叠状态保存到 store
- 添加 CSS transition 实现平滑折叠动画

### 1.3 PortSelector section 平滑折叠动画

**文件**: `src/components/port-selector/PortSelector.vue`

**改动**:
- 将 `v-show` 替换为带有 CSS transition 的动画方案
- 使用 `max-height` + `opacity` + `overflow: hidden` 过渡实现平滑折叠
- 折叠时 `max-height: 0; opacity: 0`，展开时 `max-height: 500px; opacity: 1`
- 过渡时间使用 `var(--transition-slow)` (260ms)
- 添加 chevron 旋转动画（折叠时 0deg，展开时 90deg）

---

## Phase 2: 会话标签改进

### 2.1 拖拽排序标签

**文件**: `src/components/session-tabs/SessionTabs.vue`, `src/stores/sessions.ts`

**改动**:
- 使用原生 HTML5 Drag & Drop API（`draggable`, `dragstart`, `dragover`, `drop` 事件）
- 拖拽时显示插入指示器（2px 宽的竖线）
- 在 sessions store 中添加 `reorderSessions(fromIndex, toIndex)` 方法
- 拖拽中的标签添加半透明效果 (`opacity: 0.5`)

### 2.2 关闭按钮始终可见

**文件**: `src/components/session-tabs/SessionTabs.vue`

**改动**:
- 移除 `.tab-close` 的 `color: transparent` 默认样式
- 改为始终显示但颜色为 `var(--text-dim)`
- hover 时颜色变为 `var(--text-primary)` + 背景高亮
- 非活动标签的关闭按钮颜色更淡 (`opacity: 0.5`)

### 2.3 连接状态增强

**文件**: `src/components/session-tabs/SessionTabs.vue`

**改动**:
- 已连接的标签添加左侧 2px 绿色边框 (`border-left: 2px solid var(--accent-green)`)
- 已连接标签的背景添加微妙的绿色渐变
- 断开连接的标签保持默认样式

---

## Phase 3: 数据列表优化

### 3.1 交替行色

**文件**: `src/components/terminal/DataPacketList.vue`

**改动**:
- 为 `.packet-item` 添加 `:nth-child(even)` 样式
- 偶数行背景添加 `rgba(255, 255, 255, 0.015)`
- 确保与 TX/RX 渐变背景兼容（使用 `background-image` 叠加）

### 3.2 行选中高亮

**文件**: `src/components/terminal/DataPacketList.vue`

**改动**:
- 添加 `selectedFrameId` ref 状态
- 点击行时设置选中状态
- 选中行添加 `border-left: 2px solid var(--color-primary)` + 背景高亮 `var(--bg-selected)`
- 右键菜单时自动选中该行

### 3.3 表头改进

**文件**: `src/components/terminal/DataPacketList.vue`

**改动**:
- 表头添加底部阴影 `box-shadow: 0 1px 3px rgba(0,0,0,0.2)` 增强分离感
- 表头背景使用稍暗的 `var(--bg-secondary)` 确保与数据行区分

### 3.4 键盘导航

**文件**: `src/components/terminal/DataPacketList.vue`

**改动**:
- 添加 `tabindex="0"` 到 `.packet-items` 容器
- 监听 `keydown` 事件：ArrowUp/ArrowDown 切换选中行，Ctrl+C 复制选中行
- 选中行自动滚动到可视区域 (`scrollIntoView`)

---

## Phase 4: 发送面板优化

### 4.1 可折叠历史/快捷命令区域

**文件**: `src/components/send-panel/SendPanel.vue`

**改动**:
- 为 `.send-history` 和 `.quick-row` 添加折叠/展开切换
- 默认展开快捷命令区域，折叠历史记录
- 使用与 PortSelector 相同的 `max-height` 过渡动画
- 折叠按钮使用 `ChevronDown`/`ChevronRight` 图标

### 4.2 发送视觉反馈

**文件**: `src/components/send-panel/SendPanel.vue`

**改动**:
- 发送按钮点击时添加短暂的 `scale(0.95)` 动画
- 发送成功时在输入框区域添加一个从左到右的绿色闪光条 (`@keyframes send-flash`)
- 闪光持续 300ms，使用 `var(--color-primary)` 颜色

---

## Phase 5: 动画与过渡

### 5.1 全局动画定义

**文件**: `src/styles/global.css`

**改动**:
- 添加 `@keyframes fade-in` 动画（opacity 0→1, 200ms）
- 添加 `@keyframes slide-up` 动画（translateY(8px)→0, 200ms）
- 添加 `@keyframes send-flash` 动画（绿色光条从左到右扫过）
- 添加 `@keyframes pulse-green` 动画（状态栏连接脉冲）
- 添加 `.animate-fade-in` 和 `.animate-slide-up` 工具类

### 5.2 标签切换过渡

**文件**: `src/components/app-shell/AppShell.vue`

**改动**:
- 在 `<SessionView>` 外层包裹 `<Transition name="fade-slide" mode="out-in">`
- 添加 `.fade-slide-enter-active`, `.fade-slide-leave-active` 等 CSS 类
- 过渡时间 150ms

### 5.3 平滑自动滚动

**文件**: `src/composables/usePacketVirtualScroll.ts`

**改动**:
- 在自动滚动到底部时使用 `scrollTo({ behavior: 'smooth' })` 替代直接设置 `scrollTop`
- 仅在新增数据时触发平滑滚动，避免频繁跳动

### 5.4 状态栏连接脉冲动画

**文件**: `src/components/status-bar/StatusBar.vue`

**改动**:
- 为 `.status-dot.connected` 添加 `animation: pulse-green 2s ease-in-out infinite`
- 脉冲效果：`box-shadow` 从 `0 0 0 3px` 扩大到 `0 0 0 6px` 再缩回

---

## Phase 6: 视觉打磨

### 6.1 空状态入场动画

**文件**: `src/components/app-shell/AppShell.vue`

**改动**:
- 为 `.empty-state` 添加 `animation: fade-in 300ms ease, slide-up 300ms ease`
- `.empty-mark` 图标添加轻微的缩放动画 `scale(0.9) → scale(1)`

### 6.2 AI 面板改进

**文件**: `src/components/ai/AiPanel.vue`, `src/components/ai/AiLogAssistant.vue`

**改动**:
- `AiPanel.vue`: 移除 `:global(.ai-model-menu)` 的 `max-height: 72px` 限制，改为 `max-height: 200px`
- `AiLogAssistant.vue`: `.message-list` 的 `max-height` 从 128px 增加到 200px
- `.result-card` 的 `max-height` 从 220px 增加到 320px

### 6.3 微交互改进

**文件**: 多个组件

**改动**:
- `PortSelector.vue`: `.section-title:hover` 时 chevron 图标微移 `translateX(2px)`
- `SendPanel.vue`: `.quick-item:hover` 添加 `transform: translateY(-1px)` 微浮动
- `SendPanel.vue`: `.history-item:hover` 添加 `transform: translateY(-1px)` 微浮动
- `SessionTabs.vue`: `.tab-add:hover` 添加 `transform: scale(1.05)` 微放大
- `AppShell.vue`: `.brand-mark` 添加 `transition: transform 200ms` + hover 时 `rotate(12deg)` 微旋转

---

## 文件变更清单

| 文件 | 变更类型 |
|------|---------|
| `src/stores/app.ts` | 添加 sidebarWidth, sidebarCollapsed 状态 |
| `src/stores/sessions.ts` | 添加 reorderSessions 方法 |
| `src/styles/global.css` | 添加全局动画 keyframes |
| `src/components/app-shell/AppShell.vue` | 侧边栏拖拽/折叠、过渡动画、空状态动画 |
| `src/components/port-selector/PortSelector.vue` | section 平滑折叠动画 |
| `src/components/session-tabs/SessionTabs.vue` | 拖拽排序、关闭按钮、连接状态 |
| `src/components/terminal/DataPacketList.vue` | 交替行色、选中高亮、键盘导航 |
| `src/components/send-panel/SendPanel.vue` | 可折叠区域、发送反馈 |
| `src/components/status-bar/StatusBar.vue` | 脉冲动画 |
| `src/components/ai/AiPanel.vue` | 模型菜单高度 |
| `src/components/ai/AiLogAssistant.vue` | 消息列表高度 |
| `src/composables/usePacketVirtualScroll.ts` | 平滑滚动 |

---

## 验证步骤

1. `pnpm run lint` - 确保无 ESLint 错误
2. `pnpm run build` - 确保 TypeScript 编译通过
3. `pnpm run test:frontend` - 确保前端测试通过
4. 手动验证：
   - 拖拽侧边栏调整宽度
   - 折叠/展开侧边栏
   - 拖拽排序会话标签
   - 数据列表交替行色和选中高亮
   - 键盘上下箭头导航数据列表
   - 发送面板历史/快捷命令折叠
   - 状态栏连接脉冲动画
   - 空状态入场动画
