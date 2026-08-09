# bbcom 优化审计与实施计划（2026-08）

> 审计日期：2026-08-09
>
> 审计基线：`improve/readability-ui-logs` / `276ae69`
>
> 范围：Vue/TypeScript 前端、Tauri/Rust 后端、串口数据面、持久化、导出、自动日志、AI、安全与工程门禁

## 1. 结论

bbcom 已经不是一个需要“全面重写”的早期项目。串口收发、Modbus、协议解析、导出、AI 和安全存储均有清晰边界，多数高频路径有资源上限、单元测试和基准门禁。当前最值得投入的工作集中在三类：

1. 长期运行路径仍有少数无界状态或输出放大点；
2. 功能增长快于架构边界演进，中央 session store、IPC 双写和大型 Rust adapter 成为维护热点；
3. 本地质量门禁很强，但远程 PR 门禁、真实窗口启动图、硬件/故障注入证据不足。

本轮选择先修复不会改变串口协议、持久化格式或导出 wire schema 的问题：解析结果有界化、持久化尾部选择、日志/HEX 格式化、自动日志竞态、API Key 回退一致性、虚拟列表身份和 bundle 误打包。

## 2. 当前架构

```text
serialplugin binary watch
  ├─ raw observers ── Modbus / trigger / protocol runtime
  └─ SerialRxQueue ── display coalescing ── session frames
                                           ├─ virtual packet list
                                           ├─ parser / waveform panels
                                           ├─ persistence checkpoint worker
                                           └─ export / auto-log sessions

Vue/Pinia webview ── typed Tauri invoke ── Rust commands
                                         ├─ file grants + atomic export
                                         ├─ append-only auto-log
                                         ├─ OS credential store
                                         ├─ bounded AI provider calls
                                         └─ window management
```

关键所有权是合理的：前端拥有会话和协议行为，Rust 拥有文件、凭据、网络和窗口等特权操作。后台 `SessionRuntime` 与活动重 UI 已解耦，切换标签不会断开串口。

## 3. 可复现基线

| 指标               |                                                               结果 |
| ------------------ | -----------------------------------------------------------------: |
| 前端源码模块       |                                            147，架构检查无循环依赖 |
| 前端测试           |                                           103 个文件，775/775 通过 |
| Rust 测试          |                                                       159/159 通过 |
| 前端覆盖率         | statements 85.78%，branches 81.04%，functions 82.60%，lines 87.43% |
| Rust 静态检查      |                 all targets/all features Clippy `-D warnings` 通过 |
| 初始 JS gzip       |                                    292,543 / 292,864 B，仅余 321 B |
| 初始 bootstrap 图  |                                                      36,258 B gzip |
| 实际主窗口必选图   |                                                    约 228 KiB gzip |
| 实际 AI 窗口必选图 |                                                    约 127 KiB gzip |

仓库现通过 pnpm managed runtime 将本地命令、依赖解析、项目脚本统一到 Node 24.13.0，TypeScript Node 类型固定为 24.x；正式前端 benchmark 已在该运行时完成，11/11 通过。

## 4. 风险与优先级

### P0：长期运行、数据一致性和不可信输入

| 问题                                      | 证据与影响                                                                                | 处置                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| resident parser 结果无界                  | `session-protocol-runtime.ts` 持续累积解析对象，每次发布还复制全量数组；面板卸载后仍运行  | 每会话 5,000 帧/8 MiB 双上限，head-index 淘汰，显示丢弃统计   |
| parser 单次 feed 仍会先物化全部结果       | fixed=1 遇到超大 native chunk 时，保留上限生效前仍会瞬时产生与输入字节数等量的帧对象      | 后续增加 visitor/增量 collector；在 raw observer 边界限制切片 |
| API Key session fallback 被旧 OS key 覆盖 | 新 key 持久化失败后虽返回 session 状态，下一次读取却先取仍存在的旧 OS key                 | session override 在本进程内优先；成功持久化后才清除           |
| auto-log abort/expiry 竞态                | append 可先 clone session 再等待锁；abort 返回后仍可能继续写，expiry 也可能删除刚刷新会话 | terminal writer 状态、锁内复核和 `Arc::ptr_eq` 条件移除       |
| ANSI/OSC 清洗可退化到 O(n²)               | 多个未闭合 `ESC ]` 会反复扫描剩余输入；串口数据不可信且单帧可达 MiB                       | 改为线性扫描，并加入 adversarial 测试/基准                    |
| 文本格式病理放大                          | 全换行输入会生成大量临时 `String` 和带重复前缀的输出                                      | visitor/append API 消除逐行集合；后续增加 encoded-output 上限 |

### P1：性能与工程门禁

| 问题                                | 影响                                                                               | 计划                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| 持久化先 spread 全量活动/暂停帧     | 最多复制 100k 引用，只为取 2,000 帧/1 MiB 尾部                                     | 双缓冲区反向索引扫描                               |
| HEXASCII 逐字节字符串格式化         | 64 KiB tail 存在大量 `toString/padStart` 和行字符串分配                            | 预分配字节缓冲 + HEX pair table                    |
| HEXASCII 每行创建 Vue 节点          | 64 KiB 可产生约 4,096 行、约 8k DOM/VNode                                          | 单文本节点 + `white-space: pre`                    |
| `package.json` 被打进设置面板       | 只显示版本却携带全部 scripts/dependencies，bundle 门禁只余 321 B                   | Vite/Vitest 构建期注入版本字面量                   |
| 虚拟列表默认 index key              | 滚动淘汰后同长度数组可能复用旧行测量                                               | 使用 frame id；只在源替换时清测量缓存              |
| 启动图门禁漏掉必选动态根            | 报告 35 KiB，但主窗口实际约 228 KiB                                                | 分别度量 bootstrap、App 和 AiWindow 必选图         |
| keyring 操作在 blocking pool 内排队 | 并发 status/run/set 先创建 blocking task，再在 `std::Mutex` 后等待，可能挤占线程池 | async semaphore 准入、超时与 Busy 返回             |
| 导出 finish 的重试语义不一致        | 原子替换失败会移除 session，但 IPC 仍把部分错误标成 retryable；原 ID 实际无法重试  | 保留待替换终态，或明确标记需重跑完整 workflow      |
| AI provider/解析错误冒充 timeout    | UI、监控和重试策略无法区分网络超时、provider 拒绝和响应格式错误                    | 增加稳定的 request-failed/response-invalid 错误码  |
| IPC DTO/limits 双写                 | TS/Rust 字段和批次限制已出现文档漂移                                               | 单一 schema/生成 bindings + contract check         |
| 只有 tag release workflow           | 本地 hook 可绕过，问题可能到发版才暴露                                             | PR/push 远程质量 workflow；性能门禁使用稳定 runner |

### P2：架构与体验

- `stores/sessions.ts` 已约 970 行并承担 63 个函数，应保留 façade 后逐步抽出 frame buffer、persistence repository、catalog/runtime 和 feature config。
- 架构脚本尚未执行“跨 feature 只能从 `index.ts` 导入”；已有 UI 直接引用 feature 私有 runtime。
- IndexedDB Worker 目前只负责 I/O，主线程仍构造完整 snapshot；后续应使用 revision 化 per-session patch/checkpoint。
- `export/session.rs`、`secure_settings.rs`、`commands/log.rs` 和 `file_grants.rs` 生产与测试代码均较大，应抽 file sink、clock、credential store 和 policy port 以支持故障注入。
- 浏览器/native E2E 主要验证应用壳，需补创建会话、mock 收发、筛选、导出、键盘和 capability 拒绝路径。
- AppSelect、tab、packet selection 等仍缺完整可访问名称和键盘/ARIA 语义。

## 5. 分阶段计划

### 阶段 A：本轮安全优化

目标：不改变协议和持久化 schema，关闭无界状态、竞态及明显分配热点。

验收：

- 前端/Rust 全量测试、lint、type-check、fmt、Clippy 通过；
- bundle 总量低于 286 KiB，并至少恢复 1 KiB 主动余量；
- HEXASCII 输出逐字节兼容，64 KiB 基准明显快于旧实现；
- parser 的保留量、丢弃计数、clear/config reset 均有测试；
- abort/expiry 并发测试证明返回后不会继续写；
- 未闭合 OSC 的处理随输入近似线性增长。

回滚：各优化保持原 wire schema 和文本格式，可按文件独立回退；任何格式化优化必须先由 golden tests 证明输出兼容。

#### 阶段 A 实施结果

| 项目            | 本轮结果                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------- |
| parser 常驻内存 | 已限制为每会话最新 5,000 帧/8 MiB；快照最多复制 5,000 个引用，UI 显示累计淘汰帧数/字节数  |
| 持久化尾部      | 已从全量 spread 改为两个 frame buffer 的反向索引扫描；Proxy 回归测试禁止 bulk iterator    |
| HEXASCII        | 64 KiB 格式化由约 3.14 ms 降至约 0.51 ms（约 6.1 倍）；多行结果改为一个文本节点           |
| Rust HEX/日志   | 256 B `format_hex` 约 2.06 µs 降至 269 ns（约 7.7 倍）；dump/文本导出改为 visitor/append  |
| 不可信 OSC      | 输入扩大 4 倍时耗时约 3.94 倍；16,384 个未闭合前缀的 adversarial 测试通过                 |
| 自动日志        | abort/expiry/finish 使用 terminal 状态和实例身份移除；增加确定性并发回归                  |
| 凭据与日志      | session key 覆盖旧 OS key；未知 AI risk 不再原样进入进程日志                              |
| bundle          | Node 24.13.0 下总 JS gzip 292,367/292,864 B，余量 497 B；新增 App/AiWindow 真实启动图门禁 |

Node 24.13.0 的 zlib 口径揭示总量门禁仅余 497 B，仍然偏紧；下一轮应优先消除 `createDiscreteApi` 带入的多余 provider，而不是继续压低门限。

最终自动验收：前端 103 个文件、781/781 测试和 11/11 正式 benchmark 通过；Rust 167/167 通过；ESLint、Markdown lint、Prettier/rustfmt、Vue type-check、架构检查、全目标/全特性 Clippy、生产构建、bundle/version gate、`cargo bench --no-run` 和 `git diff --check` 均通过。当前镜像未安装 `shellcheck`，因此 shell 门禁只能留给项目工具链/CI。

### 阶段 B：峰值、远程门禁与契约（1–3 天）

1. 给 `ProtocolParser` 增加 visitor/collector API，并限制 raw observer 单次处理切片，避免先物化超大结果数组。
2. 给文本导出/自动日志增加 encoded-output 预算或分块 sink，限制全换行等病理输入的输出放大。
3. 增加 Linux PR workflow：audit、lint、architecture、format、build、bundle、frontend/Rust tests、coverage。
4. Windows job 编译/测试 cfg 与 Tauri 权限契约；macOS 保留 release smoke。
5. 从 Rust schema 或受版本控制的 contracts artifact 生成 TS DTO、enum、limits 和 error code。
6. Criterion 至少进入 `cargo bench --no-run`；噪声敏感的性能比较放固定 runner/nightly。

回滚：远程 benchmark 可暂时报告但不得 fail-open；安全、类型和单测门禁不得因噪声移除。

### 阶段 C：持久化与 feature 边界（1–2 周）

1. 先增强架构脚本，禁止跨 feature 私有导入。
2. 保留现有 `useSessionStore` façade，按 frame/persistence/catalog/runtime 顺序迁移。
3. 设计带 revision 的 worker patch/checkpoint，避免 clear+重写全部 IndexedDB records。
4. Worker 失败暴露 `healthy/degraded/readOnly/error` 状态并提供有限重试。

回滚：旧完整快照仍作为恢复路径；增量消息必须幂等且拒绝乱序 revision。

### 阶段 D：真实平台与故障基线（持续）

- PTY/虚拟串口覆盖断连、重连、慢写、DTR/RTS 和 Modbus；
- 文件 sink 注入磁盘满、权限、慢盘、原子替换失败；
- 测量 20 resident sessions、128 MiB 导出、长时间 parser/terminal 的 CPU 和峰值内存；
- 三平台验证 OS keyring、grant、路径别名和安装包升级。

## 6. 文档漂移修正清单

旧 `OPTIMIZATION_PLAN.md` 的审计快照不再代表当前实现，后续维护应以本文件和实际门禁为准。需逐步修正：

- 工具链已为 Node 24.13.0、pnpm 11.11、Rust 1.97、zai-rs 0.5；
- 当前规模已为 147 个前端模块、103 个前端测试文件和 159 项 Rust 测试；
- MERGED rope、IndexedDB Worker、Rust coverage、SBOM/provenance 已实现；
- 导出实际批次为 256 帧/512 KiB，不是旧文档中的 512 帧/4 MiB；
- 当前保存全部 session metadata，只对 8 个 MRU session 保留 frame tail；
- bundle identifier 若将来迁移，必须同时迁移 `com.bbcom.app` keyring service，否则现有 API Key 会表现为丢失。

## 7. 发布前人工验证

- 真实串口持续高波特率收包、暂停/恢复、切换 20 个标签；
- Parser 丢弃提示、搜索与统计是否准确；
- HEXASCII 大帧滚动、选择、复制和 light/dark 主题；
- 自动日志开始、append、abort、expiry、应用退出和同路径并发；
- OS keyring 写失败后 session key 立即用于 AI 请求；
- TXT/CSV/JSONL/BIN 导出、取消、磁盘满和原目标保护。
