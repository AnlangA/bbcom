# bbcom 三域 Bug 审计（页面跳转 / UI / 插件）

> 日期：2026-08-16。范围：导航与窗口、前端 UI、插件平台（Rust + sidecar + 前端）。
> 方法：全量代码走查 + 契约对照（ADR-0001/0004、AGENTS_PLAN、WIT）+ 关键路径逐条核验。
> 编号规则：`NAV-*` 导航/窗口，`UI-*` 前端界面，`PLG-*` 插件平台。
> 修复排期见文末「修复批次」；UI 现代化改造见 [UI_MODERNIZATION_PLAN.md](UI_MODERNIZATION_PLAN.md)。

## 0. 总览

| 域               | 高  | 中  | 低  | 合计 |
| ---------------- | --- | --- | --- | ---- |
| 导航/窗口（NAV） | 2   | 6   | 7   | 15   |
| 前端 UI（UI）    | 3   | 7   | 6   | 16   |
| 插件平台（PLG）  | 5   | 8   | 7   | 20   |

无 vue-router；导航全部由 store 状态 + `v-if` 切换实现（`src/main.ts:12-17` 按 `?window=ai` 分流根组件，`AppShell.vue` 组合 sidebar / workspaceMode / SessionTabs / SessionRuntimeHost）。该架构本身健康，问题集中在**双窗口状态同步**与**异步切换的原子性**。

## 1. 导航 / 窗口（NAV）

### NAV-01（高）AI 窗口挂载即广播 `visible:true`，与真实可见性脱钩

- 位置：`src/AiWindow.vue:67-73`；创建侧 `src-tauri/src/lib.rs:75`（`.visible(false)`）。
- 触发：AI webview 启动/重载（HMR、崩溃恢复、慢机）时组件 mount 即 `emitNativeEvent('ai-window-state', { visible: true })`，而 OS 窗口实际是隐藏的。主窗 `useAiWindowState.ts:56-58` 盲信该值，且 `refresh()` 只在启动执行一次。
- 影响：主窗 AI 开关显示"已开启"并渲染 `AiSettingsPanel`（`AppShell.vue:68`），实际窗口隐藏；用户需点两次才能唤出。
- 修复：可见性唯一事实源改为 Rust——`show/hide/toggle` 命令成功后由 Rust 侧发 `ai-window-state`；删除 AiWindow 挂载广播；`toggle()` 失败路径重查实际状态（顺带修 `useAiWindowState.ts:45-50` 失败一律置 false 的反相问题）。

### NAV-02（中）AI 窗调用被 capability 拒绝的 `get_ai_key_status`

- 位置：`src/features/settings/tauri-ai-key.ts:15-19` 注释声称命令可安全服务该窗口；但 `src-tauri/src/commands/ai/tests.rs:28-45` 的安全测试**刻意禁止** AI 窗 capability 获得 `allow-get-ai-key-status`（密钥状态只允许经主窗 authority 桥下发）。
- 影响：AI 窗 `appStore.load()` 里 `refreshAiKeyStatus()` 每次被 ACL 拒绝并吞为 `MISSING_AI_KEY_STATUS`（`app.ts`）；authority 快照到达前误报"未配置 Key"。
- 修复（保持安全测试意图，不改 capability）：AI 窗 `load()` 跳过 `refreshAiKeyStatus()`，状态仅由 authority 桥供给；修正 `tauri-ai-key.ts` 注释如实描述该设计。

### NAV-03（高）双窗口写同一份 localStorage 设置，AI 窗以陈旧快照整体回写

- 位置：`src/features/settings/browser-settings-repository.ts:46-54`（全量 JSON 覆盖写）；AI 窗 `app.ts:291` `load()` + `app.ts:195` `watch → save`；authority 到达触发 `setTheme/setLocale`（`AiWindow.vue:21-30`）。
- 触发：AI 窗开着 → 主窗改任意设置（300ms debounce 落盘）→ 主窗再切主题/语言（触发 `sendAuthority`）→ AI 窗把**从未同步的其余 12 项设置**连同新 theme 整体写回。
- 影响：跨窗口 last-writer-wins，用户设置修改在重启后丢失。
- 修复：AI webview 注入 save-noop 的 settings repository（load 为只读快照），AI 窗彻底退出设置持久化；authority 桥继续作为同步通道。

### NAV-04（中）首次激活 session 时视图空白、runtime 创建失败永久空白

- 位置：`src/features/sessions/ui/SessionRuntimeHost.vue:3-9,70-88`；runtime 懒创建见 `src/features/application/application-runtime-registry.ts:154-158`。
- 触发：打开含历史 session 的 workspace 后点击某 tab；`ensure` 异步期间 `v-if="activeBinding"` 为 false；`createRuntime` 抛错仅 `logger.warn`。
- 影响：无加载指示；失败时活动 session 永久空白且无用户可见错误。
- 修复：ensure 期间渲染加载占位；失败渲染错误条 + 重试按钮。

### NAV-05（中）removeSession 在异步 cleanup 后重检 mutation gate，产生半完成状态

- 位置：`src/stores/session-core.ts:300-308`；调用方 `useSessionActions.ts:89` 忽略返回值。
- 触发：关闭 session 的瞬间 workspace 进入 quiesce（切换/关闭中）。
- 影响：cleanup（`disposeSession`，断串口）已执行，但 session 未从列表移除——用户看到"关闭没生效、连接却断了"。
- 修复：会话记录移除收敛为单次同步 mutation；异步 cleanup 移出 mutation gate 之后执行。

### NAV-06（中）关闭活动 session 后回退 `sessions[0]` 而非 MRU

- 位置：`src/stores/session-core.ts:326-329`；catalog 本身维护 MRU（`session-catalog.ts:50-55`，undo 路径 `session-core.ts:487-493` 也在用）。
- 影响：多 tab 时回不到上一个使用的 session，且把第一个 tab touch 成 MRU 破坏最近使用序。
- 修复：按 catalog MRU 序选取回退目标。

### NAV-07（低）replaceWorkspaceSessions 不清理 cleanupFns

- 位置：`src/stores/session-core.ts:379-429`；`cleanupFns` 定义 `:121`。
- 影响：被替换 session 的 cleanup 闭包残留（轻微泄漏；同 id 复活时会被下次注册覆盖，风险低）。
- 修复：替换时同步清空对应条目。

### NAV-08（中）外部链接为裸 `target="_blank"`，未装 opener/shell 插件，点击无反应

- 位置：`src/components/app-shell/SettingsModal.vue:84-92`（GitHub 链接）；全仓库无 `tauri-plugin-opener`/`tauri-plugin-shell`（Cargo.toml、package.json、lib.rs 均无）。
- 影响：Tauri 2 wry 默认不处理 `NewWindowRequested`，Linux(WebKitGTK)/Windows(WebView2) 上点击大概率无任何反应。
- 修复：接入 `tauri-plugin-opener`（注意 ADR-0003 bundle 预算），改 `openUrl`。

### NAV-09（低）模态打开时 Ctrl+W / Ctrl+N 仍然生效

- 位置：`src/composables/useAppShortcuts.ts:23-38` 只排除可编辑焦点，不排除打开中的 Settings/CreateSession 对话框。
- 影响：设置打开时按 Ctrl+W 会在模态背后关闭活动 session。
- 修复：AppShell 提供全局 modal-open 状态，快捷键处理器先检查。

### NAV-10（中）AI commandApply revision 失配静默丢弃，无失败回执

- 位置：`src/composables/useAiSessionBridge.ts:532`（严格相等校验）；commandApply 路径无 reject/snapshot 回发。
- 影响：主窗并发 revision bump（如恰逢 session 切换）时 AI 窗命令被丢弃，表现为"点了没反应"、无从重试。另 `SendPanel.vue:198-209,284-287` 会无条件覆盖用户输入草稿。
- 修复：失配时回发失败回执；AI 窗提示可重试。

### NAV-11（低）AI 窗初始尺寸与内容不符、+28px 硬编码标题栏补偿、误导注释

- 位置：`src-tauri/src/lib.rs:68`（初始宽 760 < 内容固定宽 820，`AiWindow.vue:91-93`）；`src/AiWindow.vue:64`（`+28` 对 Windows/Linux 标题栏不成立，首显水平裁切闪烁）；`src-tauri/src/commands/window.rs:71` 注释引用不存在的 resizable 约束。
- 修复：初始宽改 820；补偿逻辑迁移 Rust 侧按 `inner_size`/`outer_size` 差值计算；修正注释。

### NAV-12（低）SessionTabs 点击热区与 disabled 语义错位

- 位置：`src/components/session-tabs/SessionTabs.vue:16,32,155-157`；quiesce 期间 `setActiveSession` 静默 return（`session-core.ts:336-338`）。
- 影响：fail-closed 合理，但键盘/读屏用户会认为 tab 可用且点击无反馈。
- 修复：外层热区补 disabled 语义与点击反馈。

### NAV-13（低）`show_ai_window` 的 `set_focus().ok()` 静默吞错

- 位置：`src-tauri/src/commands/window.rs:17`。Linux WM 拒绝抢占焦点时无日志无事件。修复：失败记日志（tracing）。

### NAV-14（低）`resize_ai_window` 失败路径与 `Ctrl+L` 复核

- `useAiWindowState.ts:45-50` toggle 失败一律置 false（已并入 NAV-01 修复）。
- `Ctrl+L` 清空经确认走 `requestClearFrames` 确认对话框，**非 bug**，记录在案。

### NAV-15（低）设置即时保存无关闭确认（架构性，非缺陷）

- `SettingsModal.vue:136-159` 即时写 store，300ms debounce 落盘（`settings-service.ts:66-69`）；正常关闭路径有 `flushSettings()`（`application-shutdown-bootstrap.ts:101-102`）。风险仅在 debounce 窗口内被强杀，可接受。真正的丢失向量是 NAV-03。

## 2. 前端 UI（UI）

### UI-01（高）启动防白闪脚本读取已废弃的 localStorage key

- 位置：`index.html:19` 读 `bbcom-app-settings`；现行 key 为 `bbcom-v2:global-settings`（`src/features/settings/global-settings.ts:6`），v1 遗留为 `bbcom-v1:app-settings`（`:8`）。
- 影响：v2 迁移后切过 light 主题的用户每次启动都闪深色，脚本目的失效。
- 修复：改读现行 key，回落 v1 遗留 key。

### UI-02（高）自动滚动开关打开后不恢复跟随

- 位置：`src/composables/usePacketVirtualScroll.ts:104-108`；`shouldAutoScroll` 仅在 `onScroll`（`:80-87`）更新，无对 `autoScroll` 的 watch 复位。
- 触发：上滚查看历史 → 点工具栏 auto-scroll 按钮（`SessionToolbar.vue:171-184`）。
- 影响：按钮显示"开启"但新帧不跟随，需手动滚到底部 2 行内才恢复。
- 修复：`watch(autoScroll)` 开启时置 `shouldAutoScroll=true` 并调度 pin。

### UI-03（高）MacroPanel `runningMacroId='background'` 卡死后编辑/删除永久禁用

- 位置：`src/components/send-panel/MacroPanel.vue:177-192`；`runMacro` 在 `runningMacroId==='background'` 时只 `abort()` 不复位。
- 触发：宏在面板外启动（ToolsTabs KeepAlive + runner 归 session runtime）后打开 macros 页点运行按钮。
- 影响：edit/remove 持续禁用（`:27,:35`），且任何宏无法再启动，直到切换会话。
- 修复：`runningMacroId` 与 `runner.running` watch 同步；abort 'background' 后复位 null。

### UI-04（中）持久化 locale 启动时不回写 `<html lang>`

- 位置：`src/stores/app.ts:148-154` 直接赋值 `locale.value`，绕过 `setLocale`（`src/lib/i18n.ts:74-80` 才更新 `document.documentElement.lang`）；`index.html:2` 固定 `lang="zh-CN"`。
- 影响：英文界面配中文语音引擎朗读（屏幕阅读器）。
- 修复：回放路径改走 `setLocale`。

### UI-05（中）Ctrl+C 复制行的时间戳为原始 epoch 毫秒

- 位置：`src/lib/packet-list.ts:229-234`；对比 `packetContextCopyText`/`packetBatchCopyText`（`:225,:265`）均用 `formatTimestamp`。
- 修复：统一 `formatTimestamp`。

### UI-06（中）i18n 文案语义错用（双语皆错）

- `src/components/terminal/ModbusPanel.vue:327,357,365`：保存寄存器表/启动 replay/导入定义复用 `waveform.exportedStream`（"已导出 {count} 个采样"）。
- `src/components/terminal/ParserPanel.vue:255`：copyAscii 提示用 `parser.copiedHex`。
- `src/components/terminal/waveform/useWaveformExport.ts:55,65`：解析 0 条复用 `waveform.noData`。
- 修复：新增专用 key（zh/en，parity 测试 `tests/frontend/i18n.test.ts:80-86` 强制同步）。

### UI-07（中）主题切换时波形 canvas 不重绘

- 位置：`src/components/terminal/WaveformPanel.vue:304-330`；`render()` 每次读 CSS 变量（`waveform-render.ts:245-273`），但重绘仅由数据帧/指针/ResizeObserver 触发。
- 影响：dark↔light 切换后网格/坐标轴颜色滞留旧主题直到下一帧数据。
- 修复：watch `appStore.theme` → `scheduleRender()`。

### UI-08（中）FileReader 无 onerror/onabort，读取失败静默

- 位置：`src/components/terminal/ModbusPanel.vue:340-369`、`src/components/terminal/waveform/useWaveformExport.ts:47-73`。
- 修复：补错误分支 → toast。

### UI-09（中）键盘首选行可能落在虚拟窗口外且不滚动

- 位置：`src/lib/packet-list.ts:192-205`（`virtualItems.find` 未命中返回 null）；`DataPacketList.vue:344-379` 无选中时 ArrowDown 直选 `frames[0]`。
- 影响：选中态在不可见行，Ctrl+C 复制用户看不到的行。
- 修复：未命中时按行高计算 offset 直接滚动。

### UI-10（低-中）AppModal 硬编码 z-index:1000 绕过 z-token 体系；`Math.random()` id

- 位置：`src/components/ui/AppModal.vue:162`（`--z-modal: 2000` 定义于 `variables.css:137`）；`:81` 用 `Math.random()` 而非 `useId()`。
- 修复：z-index 用 token；id 用 `useId()`。治理扩展见现代化计划 M-1。

### UI-11（低-中）Modbus Load/Replay 共用文件选择器按内容猜意图

- 位置：`src/components/terminal/ModbusPanel.vue:309-369`；`onFilePicked` 按 `records.some(fc===05/06/10)` 分派。
- 影响：点 Load 选了含写记录的文件被当 replay 源执行（反之亦然）。
- 修复：拆分两个独立 file input。

### UI-12（中）CreateSessionDialog 深度 watch 外部覆盖表单；preset 空名可入库

- 位置：`src/components/app-shell/CreateSessionDialog.vue:281-294`（`deep:true` 全量同步 8 个 ref）；`:347-351` 不校验空名。
- 修复：仅在对话框打开时同步一次；preset 名非空校验。

### UI-13（低）杂项

- `ToolsTabs.vue:155`、`MacroPanel.vue:88` 索引作 key（后者有 splice 删除）。
- Trigger/Highlight 启用开关 aria-label 仅规则名；三处删除按钮无确认。
- `StatusBar.vue:105-107` `elapsed` 无 >0 守卫（理论 Infinity 显示）。
- `DataPacketList.vue:478-492` header 兄弟节点上的 `position:sticky` 死代码。

### UI-14（低）波形 DPR 变化不触发重绘

- `WaveformPanel.vue:310-317` 的 DPR 对齐实现正确，但 ResizeObserver 只观察尺寸；跨屏拖动（DPR 1→2、CSS 尺寸不变）画布模糊。
- 修复：`matchMedia` resolution 变化监听 → 重绘。

### UI-15（低）Naive 未覆盖组件深色基色风险

- `App.vue:28-30` 不传 `:theme`（bundle 权衡，注释 `:25-27`）；未列入 `naive-theme.ts` overrides 的 NSwitch/NTooltip/NProgress/NTabs 以 light 基色参与 JS 派生。
- 修复：补齐深色 overrides（现代化计划 M-5 全量核对）。

### UI-16（低-中）切换会话丢失全部 per-view 本地 UI 状态

- 位置：`SessionRuntimeHost.vue:3-9` 同屏只渲染当前会话；搜索词/方向筛选（`DataPacketList.vue` 本地 ref）、Modbus 草稿（`ModbusPanel.vue:185`）、tools 活动页、波形视口均随组件销毁丢失（viewMode 归 runtime 所以保留）。
- 修复：该子集状态提升至 session runtime（与 viewMode 同级）。

### UI 域正面结论（无需修复）

- 事件监听/定时器泄漏审计：12 处 `addEventListener` 与全部定时器均有成对清理，**未发现泄漏**。
- 响应式：无解构丢失；in-place 数组变异统一配 `framesVersion` 脉冲，实现严谨。
- i18n：无缺失 key（parity 测试强制）；切换即时生效。
- a11y 基础（roving tabindex、separator 键盘、sr-only 波形数据表、focus-visible、reduced-motion）现状良好。

## 3. 插件平台（PLG）

### PLG-01（高）串口审批：按世代缓存符合锁定决策，但存在次序缺陷与三方文案矛盾

- 事实：`AGENTS_PLAN.md:31` 锁定「每个 `workspace+plugin+instance+generation` 只询问一次，批准/拒绝缓存至实例结束」；代码按此实现（`src-tauri/src/plugins/command_service/mod.rs:939-973` 缓存命中即自动 resolve，`:1281-1282` 写入，`:1448-1451` 世代切换清除；测试 `:273-301` 断言该行为）。
- **矛盾**：`wit/bbcom-plugin-v1/plugin.wit:85-86`「always requires a new user confirmation」、`docs/ADR-0001...md:66-68`「every send requires confirmation / No persistent grant」、`PluginSerialProposalDialog.vue:28,34`（`one_time_warning` + `approve_once`）三方均与锁定决策不符，UI 对用户存在误导。
- **次序缺陷**：`:1281-1293` 先写缓存 `true` 再执行 `execute_serial_action`；执行失败缓存仍在，后续发送继续被自动批准。
- 决策（2026-08-16，用户确认）：**以锁定决策为准**——保留按世代缓存；修 WIT 注释、ADR-0001 措辞、弹窗文案为「本实例内记住批准」；执行成功后才写缓存。

### PLG-02（高）`propose-serial-send` 端到端是死桩

- 位置：sidecar 侧 `crates/bbcom-plugin-host/src/host_state.rs:274-294` 仅返回 `PendingUserConfirmation` 无上报；invoke 面只支持 `"panel-event"`（`sidecar.rs:404-423`）；主进程 `register_proposal`/相关入口无生产调用点（仅测试，已 grep 验证）；`runtime_wiring.rs:572-639` 的 scheduler/registry 与前端 `PluginSerialActionBridge` 全部不可达。
- 影响：插件调用永远 pending 且无结果；确认弹窗永不因插件出现。对插件作者是"静默成功的 stub"。
- 修复：列入后续阶段（需打通 sidecar→broker→前端→结果回传全链路，配套 PLG-12 幂等）。本轮不动代码。

### PLG-03（高）`session-list` 恒空、`capture-read` 恒空页

- 位置：`crates/bbcom-plugin-host/src/host_state.rs:28,41,220-250`；`HostLaunchRequest` 无会话数据字段；注释自认"supplied by the broker in G43"。
- 影响：counter-plugin 的 "Open sessions" 恒 0；未授权 `session.metadata.read` 时 initialize 失败但重渲染路径 `unwrap_or(0)` 静默吞错，行为不一致。
- 修复：后续阶段（G43 数据供给）。

### PLG-04（高）本地/dev 目录重装永远失败（热重载不可用）

- 位置：`crates/bbcom-plugin-manager/src/manager.rs:106-136`（`install_local` 恒 `current=None`）；`src-tauri/src/plugins/installation.rs:497-508`（`current=None` 要求 kind 必须为 `InitialInstall`）；`crates/bbcom-plugin-repository/src/install.rs:278-293`（已存在则 staging 为 `ManualUpgrade`，同版本不同 digest `VersionDigestConflict`）；`command_service/mod.rs:1236-1240`（InstallLocal 无升级分支，对比 `:1228-1232`）；`manager.rs:159-161` `local_probe_plugin_id` 恒 None 死代码。
- 触发：首次本地安装成功后，升版本→`UpdateTargetInvalid`；同版本重编译→`VersionDigestConflict`；dev watcher（`runtime_wiring.rs:799-885`）自动重装必然失败。
- 修复：InstallLocal 检测既有安装路由升级分支；实现本地探针；同源同版本允许 digest 刷新。

### PLG-05（高）workspace 创建/打开失败仍先关闭插件项目且无回滚

- 位置：`src-tauri/src/commands/workspace/mod.rs:356`（create）/`:413`（open）在任何校验前 `close_plugin_project`；激活仅在成功分支（`:333-345`）；`require_main_window_label`（`:370`）在 close 之后才检查；`close_project` 停全部 host 且 `expected_enabled=false`（`manager.rs:429-439`），事后 `enable` 因 `require_workspace`（`manager.rs:838-842`）无法恢复。
- 修复：校验前置；close 移到校验后；失败尝试回滚重开原 workspace 插件。

### PLG-06（中）uninstall 先删内存再删盘，失败即状态分裂、重启复活

- 位置：`crates/bbcom-plugin-manager/src/manager.rs:148-153`；盘上 active 安装在重启后被 `runtime_wiring.rs:287-313` restart discovery 复活。
- 修复：stop → 删盘 → 删内存；盘删失败保留记录。

### PLG-07（中）enable 在 pending 检查前写 `expected_enabled=true`

- 位置：`crates/bbcom-plugin-manager/src/manager.rs:205-213`；失败后与快照层（`command_service/mod.rs:1250-1253` 不 upsert）状态分歧，下次 open_workspace 自动启动。
- 修复：先查 pending 再写期望值。

### PLG-08（中）source registry 先改内存后校验落盘 + refresh 竞态可毒化注册表

- 位置：`src-tauri/src/plugins/source_registry.rs:361-408`（锁外抓取、写 record 后才 `persist`→`validate_registry` 失败但内存已污染）；`:104-117` 继续供出脏索引；后续所有 persist 因同一不一致失败直到重启。所有 mutator 均为 mutate-then-validate。
- 修复：validate-then-mutate；锁内复核 record 身份。

### PLG-09（中）过期提案永不驱逐 + 弹窗「批准成功」假象

- 位置：`crates/bbcom-plugin-broker/src/proposal.rs:7,176-177`（60s TTL 仅 resolve 时惰性检查）；`command_service/mod.rs:923-927` 上限 1024 可被塞满；`PluginPromptHost.vue:28-30` 无过期计时，过期后批准 → `NoAction(Expired)` → Completed，UI 显示成功但什么都没发。
- 修复：broker `retain_active(now)` 清扫 + 前端按剩余 TTL 过期并提示。

### PLG-10（中）workspace 激活静默跳过与锁竞态

- 位置：`src-tauri/src/plugins/runtime_wiring.rs:181-239`（`ensure_plugin_runtime` 持 `COMPOSE_LOCK` 而 `activate_plugin_workspace` 不持）；`src-tauri/src/commands/workspace/mod.rs:106-134`（单 binding 构造失败 → snapshot 整体 None → activate 无警告 return，actor 仍绑旧 workspace）。
- 修复：snapshot 容忍单 binding 失败（记日志跳过）；锁顺序统一。

### PLG-11（中）`Box::leak` 审计 sink 在每次失败的重组循环中泄漏

- 位置：`src-tauri/src/plugins/runtime_wiring.rs:335`（`build()` 之前 leak，打开的 append 文件永不关闭）。
- 修复：进程级 OnceLock 单例。

### PLG-12（中）串口动作 2s 超时与前端实际发送的双写竞态（当前因 PLG-02 不可达）

- 位置：`src-tauri/src/plugins/runtime_wiring.rs:67,622-637`（超时 discard）vs `src/features/plugins/plugin-serial-action-bridge.ts:46-70`（仍会执行真实写）；迟到结果在 `commands/plugin.rs:530-535` 被忽略；插件误判失败重试 → 设备收到重复帧。
- 修复：后续阶段与 PLG-02 一并设计（在途取消/幂等）。

### PLG-13（中）单一进程表互斥锁上的长阻塞 IO（队头阻塞）

- 位置：`src-tauri/src/plugins/host_launcher.rs:815-844`（分块状态传输，16MiB=32 块×2s）、`:846-891`（shutdown）均持 `processes` 全局锁；`HostExitMonitor::poll`（`:378-410`）与其他插件 launch 排同一锁后，500ms 崩溃收割被拖住。
- 修复：IO 移出锁（取 Arc 句柄 → IO → 回锁插入）。

### PLG-14（低）adapter 已成功操作被后续 `set_expected_enabled` 失败改写为错误响应

- 位置：`src-tauri/src/plugins/runtime_actor.rs:149-156`。修复：失败仅记日志 + 标记快照刷新，不改写成功响应。

### PLG-15（低）`failure_code` 子串匹配语义漂移

- 位置：`src-tauri/src/plugins/command_adapter/mod.rs:1348-1365`（`contains("INSTALL")` 等）。修复：精确码表。

### PLG-16（低）dev watcher 失败指纹不重试 + Snapshot→InstallLocal 非原子

- 位置：`src-tauri/src/plugins/runtime_wiring.rs:845-881`（`attempted` 指纹使同内容失败永不重试；revision 读取后排队，中间变化 `RevisionConflict` → `set_dev_health(false)` 卡死）。修复：内容变化重置 attempted；revision 原子传递。

### PLG-17（低）前端 `run()` 完全吞异常无日志

- 位置：`src/features/plugins/plugin-center-service.ts:224-227`（`catch {}`，同文件其他处均用 logger）。修复：补 `logger.warn`。

### PLG-18（低）`expect("operation existence checked above")` panic 路径与取消语义混淆

- 位置：`src-tauri/src/plugins/command_service/mod.rs:1093-1097,1146`。修复：显式错误返回。

### PLG-19（低）后台每小时自动索引检查与「Updates are manual」边界

- 位置：`src-tauri/src/plugins/source_registry.rs:414-432`（每源 24h 一次自动抓 index）。ADR-0004 只约束安装/下载，抓 index 处于边界；记录在案，暂不改（如需收紧再立决策）。

### PLG-20（低）counter-plugin `panic_handler` 内 `unreachable!()`

- 位置：`plugins/counter-plugin/src/lib.rs:82-87`，依赖 panic=abort，注释已自述；列为已知设计。

### 插件域正面结论

- fail-closed 落实良好：`UnavailablePluginCommandService` 先装（`lib.rs:44-51`）、沙箱自测六项全过才允许 launcher（`host_launcher.rs:463-475`）、`Drop` 兜底 kill、launch 失败全路径 terminate。
- 生产代码无 TODO/FIXME/`todo!`；`.unwrap()/.expect()` 均在 `#[cfg(test)]`。
- 声明式面板双重校验（Rust `commands/plugin.rs:1012-1117` + 前端 `panel-validation.ts`），无 HTML 注入面。

## 4. 修复批次

| 批次        | 内容                                                                                                         | 状态      |
| ----------- | ------------------------------------------------------------------------------------------------------------ | --------- |
| P0          | UI-01~~06、NAV-01、NAV-02、PLG-01（次序+文案）、PLG-05~~07（原 H5/M1/M2：workspace 顺序、uninstall、enable） | ✅ 已完成 |
| P1-导航     | NAV-03~13                                                                                                    | ✅ 已完成 |
| P1-UI       | UI-07~16                                                                                                     | ✅ 已完成 |
| P1-插件     | PLG-04（原 H4 本地重装/热重载）、PLG-08~~11、PLG-13~~18                                                      | ✅ 已完成 |
| 后续-阶段 2 | PLG-02 提案端到端管线 + PLG-12 幂等超时                                                                      | 待立项    |
| 后续-阶段 3 | PLG-03 G43 数据供给（session-list/capture-read）                                                             | 待立项    |
| 持续        | UI 现代化 M-2~M-8（见现代化计划；M-1 代码部分与 M-5 首批、M-6 子集已随本轮落地）                             | 滚动      |

> PLG-01 的文档同步范围：`wit/bbcom-plugin-v1/plugin.wit:85` 注释（无 ABI 变更）、`docs/ADR-0001` 措辞、`AGENTS_PLAN.md` 保持不动（即决策源）。

## 5. 实施记录（2026-08-16 收口）

全部门禁通过：前端 1073 测试 / Rust 342 测试 / lint / format / tokens / architecture / build / bundle。实施相对初稿的修正与残留：

- **NAV-02**：存在显式安全测试（`commands/ai/tests.rs:28-45`）禁止 AI 窗获得该命令权限——最终方案是 AI 窗 `load()` 跳过 `refreshAiKeyStatus()`（状态仅由 authority 桥下发），capability 保持不变。
- **UI-12**：preset「空名可入库」经核为非问题——`device-profile-library.ts` 的 `normalizeName` 已有空名回退；仅落地了「打开时同步一次」的 watch 守卫。
- **PLG-04（本地重装）**：采用「停 host（带关停证据）→ 清除包树 → 全新 InitialInstall → 恢复 expected_enabled → 按需重启」的替换路径（`manager.rs::replace_local_install`），插件存储/项目态在包树外得以保留；`local_probe_plugin_id` 已实现（读 plugin.toml）。同版本重编译与升版本均可用，dev watcher 热重载随之打通。
- **PLG-13（锁范围）**：`initialize`/`shutdown` 改为「取出-执行-按结果回插」，失败路径保持旧语义（记录留在表内供 terminate/exit-monitor 兜底）。
- **NAV-11**：初始宽 760→820 已落地；`+28px` 标题栏补偿迁移 Rust 侧测量留待 M-8。
- **UI-13**：MacroPanel 步骤行改稳定 key、三处删除按钮加两步确认（新 `useConfirmRemove`）、StatusBar 除零守卫、死 sticky 移除、启用开关 aria-label 补全已落地；ToolsTabs 历史列表索引 key 维持现状（静态内容，低风险）。
- **UI-16**：搜索词、方向筛选、tools 活动页、Modbus 值草稿四项已提升至 runtime（`SessionRuntimeUiState`，provide/inject 接线）；波形视口等留待 M-6 后续。
- **NAV-08**：bundle 总量 +2.7 KiB gzip（opener 依赖、约 30 个 locale key、深色覆盖、保留特性），按 ADR-0003 既有修订先例将总量上限 376→380 KiB 并记录 addendum；其余天花板全部未动。
- **测试更新**：4 个既有测试断言被更新为修复后的契约（AiWindow 不再广播可见性、复制时间戳格式、监听器计数、删除两步确认）；`session-runtime-host` 测试改用 `vi.waitFor` 消除对固定微任务拍数的敏感。

## 6. 第二轮实施记录（2026-08-17 收口）

目标：UI 布局优化、弹窗闪退、插件加载失败、全部遗留问题。全部门禁通过：前端 1078 测试 / Rust 350 测试 / lint / format / markdown / tokens / architecture / build / bundle（维持 380 KiB，按预定削减序移除横幅专属文案键）。

### 插件加载失败的真正根因（G3）：自伤型权限，非环境问题

`compose_from_parts` 中 `open_installer` 先以 `create_dir_all`（umask 权限，本机实测 0775）创建了 `plugin-state-v2/`，随后 state 端口的严格校验拒绝了"已存在且带 group/other 位"的目录 → umask≠077 的机器首启必现 `PLUGIN_BOOTSTRAP_STATE_STORE_MISSING`。叠加组合失败后进程内无重试路径（`activate_plugin_workspace` 在未组合时直接 return），重启也无效（目录仍在）。

修复：installer 快照目录迁出 state 根（`plugin-installer-v2/snapshots`）；`ensure_private_directory` 对真实目录的自伤权限先 chmod 0700 自愈再复验（符号链接/非目录仍硬失败，chmod 失败仍是硬失败）；`activate_plugin_runtime_after_attempt` 先 `ensure_plugin_runtime` 再 `activate_plugin_workspace` 使失败组合随 workspace 切换自愈；组合成败均发 `plugin-runtime-status` 事件，插件中心顶部横幅显示稳定失败码。

### 弹窗闪退根因（G2）：迁移完成装机每次启动仍渲染迁移门

修复：`LegacyResetGate` 初始相位由 localStorage 完成标记决定——有标记时完全不渲染（journal 确认后直接放行 slot）；无标记的 checking 相渲染中性加载骨架（不再闪现「旧数据库」文案）；完整门仅交互态渲染。附带修复：IDB 枚举不再是缺席证明（`databases()` 谎报时按名直开）、workspaceReady 漂移降级为 completed-restore 而非 target_failed 死循环、`restoreLastActiveWorkspace`/`activateCompletedV1` 补 workspaceId 校验。

### 遗留功能补全（PLG-02/03/12 关闭）

- **PLG-02 串口提案端到端**：协议 v3 新增 `SerialProposalEvent`（sidecar→main）与 `ProposalResult`（main→sidecar）；sidecar 的 `propose-serial-send` 上报事件后挂起 guest 调用（oneshot + 60s TTL+5s 余量，超时 resolve cancelled）；reader 线程经 `HostPushSink` 转发，专用 worker 经 actor `RegisterProposal` 进入既有 `register_proposal`（带 sidecar 关联 id），决策/执行结果按关联 id 推回 sidecar；`plugin-snapshot-changed` 事件让前端免手动刷新即可见提示。
- **PLG-12**：调度器等待 2s→10s，迟到完成记 warn；WIT 注释载明超时重试的重复写风险。
- **PLG-03 G43**：sidecar `session-list`/`capture-read` 经同一 uplink 上报；`WebviewSessionQueryScheduler`（镜像串口桥，10s 界限）发 `plugin-session-query` 到主窗口，前端 `PluginSessionQueryBridge` 从 session catalog/capture 取数（分页 ≤256 帧/512KiB），`plugin_session_query_result` 命令回填，回应经 `deliver_envelope` 推回 sidecar。

### 其余工作包

WP4 本地替换先验后删（manifest+组件 sha256 预检，坏包保留旧安装）；WP5 deb 依赖补 python3、bwrap PATH 回退、musl triple；WP6 `PluginFailureCode::WorkspaceMissing`（契约+生成+文案）；WP7 观测性杂项；WP10 令牌收敛（`--control-w-*` 4 档 + 全部 `font-size: 12px` 归零）；WP11 WaveformLegend 配置驱动重构（519→447 行，13 块 tooltip 收敛为单一循环）；WP12 CreateSessionDialog 迁 AppModal（全仓 n-modal 仅剩内置对话框）；WP13 a11y 审计确认全部 AppSelect 已带可访问名；WP14 AI 窗标题栏补偿改 Rust 侧按 outer−inner 实测，`--ai-panel-width` token 化。

### 第二轮偏差与记录

- **CreateSessionDialog 测试**：VTU 的 Teleport stub 下 AppModal 内容按父渲染重挂载（生产 Teleport 原地 patch，无此问题）；测试改为每次交互前重新查询元素并注明原因。
- **协议 minor 2→3**：契约 golden fixture 与 `PROTOCOL_MINOR` 断言同步更新。
- **测试总量**：前端 1073→1078（新增 plugin-session-query-bridge 3 例、correlated proposal 1 例等），Rust 342→350（state store 自愈/符号链接 2 例、本地替换 2 例、uplink 3 例、契约 golden 更新）。
