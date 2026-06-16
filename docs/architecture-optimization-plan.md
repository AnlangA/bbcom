# bbcom 架构与质量优化计划

## 当前架构体检

bbcom 目前是 Tauri v2 + Vue 3 + Pinia + TypeScript 的桌面串口工具，Rust 侧承担导出、校验、AI IPC 等系统能力，前端承担串口会话、终端渲染、协议解析、波形和 Modbus 主站流程。整体已经有较好的方向：高频数据路径用虚拟滚动、RAF 批处理和 `markRaw` 控制响应式成本，Modbus 也拆成了纯协议、传输、批处理、流格式和 Vue composable 多层。

主要风险不在“缺少功能”，而在边界不断变宽后需要更强的契约：

- 运行时边界：Tauri-only 能力要显式隔离，避免 Node 测试、浏览器预览和真实 WebView 三种环境互相污染。
- 数据边界：本地存储、`.bbreg` 文件、串口 RX 字节流都是不可信输入，入口要完成校验，业务层不要再靠默认值“修复”坏数据。
- 会话状态边界：Pinia store 同时保存持久配置和运行时采样值，必须持续保持“哪些字段持久化、哪些字段只在内存”的规则。
- Modbus 主站边界：RTU 半双工、PDU 固定长度、读写轮询、手动读写、回放和周期写共享一条串口链路，单 outstanding request 的不变量必须用测试守住。
- UI 边界：Modbus 面板功能变多后，表格可读性、批量导入/回放意图和错误反馈需要持续压缩复杂度。

## 本轮已落地

- `secure-settings` 增加 Tauri runtime 检测，只在真实 Tauri 环境懒加载 `LazyStore`；Node 测试和浏览器预览走静默回退路径。
- `.bbreg` 解析入口收紧 Modbus 记录校验，拒绝越界从站、未知功能码、非整数/越界地址和负时间戳。
- `.bbreg` 可选波形通道只接受 `0..7` 整数，其他坏通道会被丢弃而不是污染导入结果。
- PDU transport 现在会立即识别 2 字节 Modbus exception response，不再把异常响应误判为正常响应长度不足并拖到超时。
- `modbus-registers` 纯模块承接 Modbus 行、数量、配置和持久化形态规范化，Pinia store 不再内联这套规则。
- `session-persistence` 模块承接 session snapshot hydrate/serialize、默认会话创建、端口/解析器/工具配置 normalizer，Pinia store 保留运行时状态职责。
- `useModbusMaster` 增加 fake transport 测试，覆盖手动读、批量读、写确认、PDU exception、timeout、发送失败、并发读串行化、周期写数据源、stop/disconnect 取消 pending、busy 后周期轮询恢复、replay 超时恢复、停止 replay 和断连中断 replay。
- Modbus master 事务核心现在会在 `sendBytes` throw/reject/false、stop 和连接断开时统一清理 pending 并 resolve 等待方，避免悬挂到 timeout 或产生未处理拒绝。
- Modbus master 后台读写调度增加 timer 去重、busy 释放后的自动恢复和 overdue 补跑，避免一次手动读写、replay 或慢设备响应抢占总线后让另一个周期任务静默停摆。
- Modbus master 改用 `onScopeDispose` 清理资源，组件运行和纯 composable 测试都能安全释放监听器/定时器。
- `modbus-transaction-runner` 纯模块承接单 outstanding request、RX accumulation、timeout、显式 cancel 和发送失败处理；`useModbusMaster` 只保留读写批处理、周期任务和 replay 业务语义。
- `modbus-loop-coordinator` 纯模块承接周期读/写 loop 的 timer、pause/resume、exclusive busy guard 和 overdue 公平调度；`useModbusMaster` 不再直接管理读写 loop 定时器。
- `modbus-backoff` 纯模块承接周期读/写连续失败退避策略；周期 loop 在连续 timeout 或发送失败后指数降频，任意有效响应会恢复正常 cadence，手动读写和 replay 不被动降频。
- `modbus-replay-coordinator` 纯模块承接 `.bbreg` replay 的时间戳排序、相对 cadence、timer 生命周期、stop/finish 和 restart generation guard；`useModbusMaster` 只保留记录到写寄存器的匹配规则和单条写入动作。
- `modbus-write-source` 纯模块承接周期写数据源的 `.bbreg` 分组、FC01→FC05 / FC03→FC06 映射、per-key cursor 推进和循环；`useModbusMaster` 不再直接管理 write source map/cursor。
- Modbus master fake transport 测试扩展到周期读写同时启用、慢读期间写入 overdue 补跑、断开后重连的周期读/周期写恢复，以及断开期间修改寄存器/transport 后按最新配置恢复。
- 新增 loop coordinator 纯单测覆盖慢读后写入补跑、pause/resume、手动 exclusive 操作期间的 deferred loop、stop 清理 timer。
- 新增 backoff 纯单测覆盖 transient failure、指数增长、max cap 和 success reset；Modbus master 集成测试覆盖周期读 timeout backoff 后恢复、周期写发送失败 backoff。
- 新增 replay coordinator 纯单测覆盖时间戳排序、进度回调、stop 清理 timer、空输入 no-op，以及 restart 时旧 in-flight item 不能污染新队列；Modbus master 集成测试覆盖新 replay 替换旧 replay 的 queued record。
- 新增 write source 纯单测覆盖 key 映射、可写 FC 判定、独立 cursor 循环、未匹配/未启用行跳过，以及 clear/reload 后 cursor 重置；Modbus master 周期写回归继续覆盖 cadence、断线恢复 cursor、bus 共享和 backoff。
- Modbus `error` 状态现在会在面板状态条显示中英文错误文案，并复用错误色反馈。
- Modbus `backoff` 状态现在会在面板状态条显示中英文降频原因、scope、失败次数和下次 delay，并使用 warning 色反馈。
- 新增测试覆盖非 Tauri secure settings 回退、`.bbreg` 身份字段校验和通道校验。
- 新增模块级测试覆盖 Modbus register/config 契约、session snapshot 恢复/裁剪/运行时字段剥离。

## 分阶段优化路线

### P0：安全边界和契约

- 为所有 Tauri-only API 建立统一运行时适配层，包括 store、dialog、invoke、文件能力，减少组件直接依赖。
- 为持久化 schema 增加版本迁移函数，避免 `hydrateSession` 随字段增多变成隐式迁移中心。
- 给 `.bbreg` schema 增加显式版本与导出类型标识，区分“寄存器快照”、“周期写源”和“波形样本”。

### P1：逻辑和状态分层

- 继续收窄 `useModbusMaster`：评估将读/写响应应用逻辑拆成纯 mapper，当前 transaction runner、loop coordinator、backoff、replay coordinator、write source 和 fake transport 测试可作为抽象前后的回归基线。
- 继续完善周期 loop 的降级策略：评估按 slave/register key 分桶 backoff，避免单个离线从站拖慢同一会话内其他仍健康的从站。
- 为 `.bbreg` 多值记录增加可逆结构，尤其是 `uint8/int8` 这类两个值共享一个 16-bit register 的情况。

### P2：功能体验和性能

- Modbus 面板增加导入预览，显示将导入多少读行、写行、被跳过的坏行，以及回放/导入模式选择。
- 周期写源显示匹配到的行数和未匹配 key 数，避免用户加载文件后不知道是否真正生效。
- 为测试环境添加 warning 失败门禁，避免“测试通过但输出被预期异常刷屏”的回归。
- 在 `pnpm check` 之外增加轻量 CI 分组：pure frontend tests、Rust unit tests、type/build、optional benches。

## 测试策略

- 纯协议/纯数据模块：继续使用 Node test，覆盖成功路径、坏输入、边界值和回归用例。
- Pinia store：用 mock localStorage 覆盖持久化 round-trip、schema 兼容、运行时字段不持久化。
- Modbus master：继续扩展 fake transport 测试到按从站分桶 backoff、`.bbreg` 多值回放，以及读/写响应 mapper 抽象前后的行为等价。
- Rust IPC：保持 command 层错误转换、路径校验、导出格式和 checksum 上限测试。
- UI：关键交互优先用组件级行为测试或后续 E2E，重点覆盖 Modbus 导入/保存/回放和会话切换。

## 验证命令

- `pnpm run test:frontend`
- `pnpm run test:rust`
- `pnpm run build`
- `pnpm run lint`
- `pnpm run format:check`
