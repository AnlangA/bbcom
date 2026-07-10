# bbcom 全面优化路线图

> 版本：2026-07-10 审计快照  
> 范围：Vue 3 + TypeScript 前端、Tauri 2 + Rust 后端、串口数据链路、AI、导出、构建与 CI  
> 目标：在不破坏串口通信与本地数据兼容性的前提下，完成可回滚的破坏性重构，并把性能、安全和依赖治理变成持续门禁。

## 1. 结论摘要

项目的功能覆盖和纯函数测试基础较好，但审计前存在四类高风险耦合：会话 UI 生命周期等同于串口连接生命周期、协议解析热路径存在二次复杂度、批量导出跨 IPC 复制完整帧集合、AI 将系统指令和不可信串口内容拼成同一条用户文本。本轮已优先拆除这些 P0 风险，并完成当前工具链能够兼容的直接依赖升级。

后续不应再进行一次性“全目录搬家”。建议采用绞杀式迁移：先建立目标边界和兼容门面，每次迁移一个业务切片，验收后删除旧入口。真正需要继续解决的核心问题是：API Key 仍由普通 JSON store 持久化、前端大部分代码仍位于扁平的 `components/composables/lib/stores`、隐藏会话虽已停止响应帧脉冲但运行时仍与整棵 UI 挂载绑定、前后端 IPC 契约和限制值仍由两套代码手工维护、Rust 覆盖率和真实性能基线尚未成为硬门禁。

文档中的状态含义：

- **已实施**：本轮工作树中已经完成，并至少有定向测试、构建或静态检查证据。
- **待完成**：审计确认需要继续实施，不能因写入路线图而视为已经解决。
- **验收门禁**：合并或发布前必须满足；测量尚未完成时明确标为待采样，不虚构结果。

## 2. 审计基线与量化指标

### 2.1 代码与工具链快照

| 指标            |                          审计/当前快照 | 说明                                                                                          |
| --------------- | -------------------------------------: | --------------------------------------------------------------------------------------------- |
| 前端模块        |                     133 个 TS/Vue 模块 | 新架构检查脚本扫描结果；当前无循环依赖                                                        |
| 前端源码        |   135 个 TS/Vue/CSS 文件，约 22,396 行 | 用于估算迁移规模，不作为质量指标                                                              |
| Rust 源码       |          30 个 `.rs` 文件，约 2,786 行 | 包含命令、模型、导出和工具模块                                                                |
| 前端测试文件    |                    74 个，约 10,350 行 | Node test runner；不包含真实 WebView E2E                                                      |
| 大文件热点      |                 20 个文件约 350 行以上 | 最高包括 `WaveformPanel.vue` 775 行、`waveform-render.ts` 586 行、`stores/sessions.ts` 556 行 |
| Node / 包管理器 |             Node 22（CI），pnpm 11.5.3 | 锁文件必须以 frozen 模式安装                                                                  |
| Rust 工具链     | edition 2024，MSRV 从 1.85 提升到 1.88 | workspace resolver 从 2 提升到 3                                                              |

### 2.2 正确性、覆盖率与安全基线

| 指标                      |                  审计前基线 | 本轮结果/状态                                                                                                        |
| ------------------------- | --------------------------: | -------------------------------------------------------------------------------------------------------------------- |
| 前端测试                  |              576 / 576 通过 | 本轮 598 / 598 通过，新增串口、会话驻留/隔离、解析器和有界导出测试                                                   |
| 前端 statements / lines   |             88.01% / 88.01% | 本轮 88.67% / 88.67%，高于全局 85% 门槛                                                                              |
| 前端 branches / functions |             88.73% / 90.19% | 本轮 89.00% / 90.20%，高于 88% 门槛                                                                                  |
| Rust 测试                 |                68 / 71 通过 | 审计前 3 个失败来自 Windows 路径分隔符测试；本轮 library tests 78 / 78 通过                                          |
| AI 定向测试               |                      未单列 | 21 / 21 通过，覆盖角色隔离、字节边界和并发限制                                                                       |
| 架构循环                  |        未设可靠 Vue/TS 门禁 | 133 个模块扫描通过，无循环依赖和 domain 边界违规                                                                     |
| Rust 依赖安全             | Windows 依赖图发现 3 个漏洞 | 已将 `crossbeam-epoch` 更新到 0.9.20、`quick-xml` 更新到 0.41.0、`plist` 更新到 1.10.0；CI 新增 `cargo audit` 硬门禁 |
| npm 安全                  |                未设持续门禁 | `pnpm audit` 当前 0 漏洞，peer 检查 0 问题；CI 对 moderate 及以上漏洞失败                                            |

### 2.3 性能与包体积基线

所有微基准都应在同一机器、同一电源模式、同一 Node/Rust 版本下至少运行 5 轮并取中位数。跨机器只比较数量级和相对变化，不直接比较绝对毫秒。

| 指标                                 |                    审计前 |                                                                     本轮结果 |                                       变化 |
| ------------------------------------ | ------------------------: | ---------------------------------------------------------------------------: | -----------------------------------------: |
| ProtocolParser：32 KiB 输入、fixed=1 |               约 1,129 ms |                                                                    约 6.7 ms |                              约 168 倍加速 |
| 初始 `dist` raw                      |               1,028,502 B |                                                             最终发布前重采样 |                               作为总量基线 |
| 初始 eager raw / JS gzip             |     1,012,985 / 271,988 B |                                            后续改用 Vite manifest 可达图口径 | 保留原始审计记录，不与新口径强行计算百分比 |
| bootstrap eager JS raw               |                 927,993 B |                                                                     87,114 B |                                     -90.6% |
| bootstrap eager JS gzip              |                 265,135 B |                                                                     34,789 B |                                     -86.9% |
| 主窗口实际启动路径 JS raw            |                 927,993 B |                                                                    789,163 B |                                     -15.0% |
| 主窗口实际启动路径 JS gzip           |                 265,135 B |                                                                    243,665 B |                                      -8.1% |
| async JS raw / gzip 占比             |             1.45% / 1.91% |                                                              90.94% / 88.29% |                             首屏边界已建立 |
| 三个按需面板 JS raw / gzip           |            首屏内同步加载 | Waveform 32,337 / 10,478 B；Parser 18,004 / 5,810 B；Modbus 18,857 / 5,489 B |                首次进入对应模式才下载/执行 |
| AI 日志 100,000 帧、10k 字符预算     | 会先格式化/遍历完整选择集 |                                                           只访问最新约 45 帧 |           工作量从总帧数改为与字符预算相关 |
| Rust CRC16，256 B                    |                    未记录 |                                                      约 592 ns / 412.7 MiB/s |              Criterion release，10 samples |
| Rust 导出格式化，10,000 帧           |                    未记录 |                                          JSONL 约 8.4 ms；HEX 文本约 14.6 ms |                               不含磁盘 I/O |

## 3. 问题清单与优先级

优先级定义：P0 是数据丢失、秘密泄露、资源失控或主要热路径不可接受；P1 是阻碍演进、可观测性不足或中期性能风险；P2 是维护效率和体验优化。

### 3.1 P0

| 维度        | 问题                                                                                        | 影响                                      | 状态       | 处理                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 架构        | 切换标签会卸载 `SessionView`，串口连接、监听器和定时任务与可见 UI 同生共死                  | 后台会话断线、状态丢失                    | **已实施** | 引入 session residency；访问过且仍存在的会话运行时保持挂载，只有活动会话响应全局快捷键                                                                                      |
| 性能        | 协议解析器每取一帧都切剩余数组，fixed=1 时退化为 O(n²)；delimiter 无上限积累                | 高波特率卡死、内存增长                    | **已实施** | cursor + 摊还压缩；delimiter 搜索游标；pending 1,000,000 B 上限；丢弃/重同步统计                                                                                            |
| 性能/安全   | 导出最多 100,000 帧以完整 JSON 数组跨 IPC，`Uint8Array` 扩成 number[]，内存和延迟被多次放大 | 大导出卡死或 OOM；临时文件归属不清        | **已实施** | 彻底删除整批 IPC；后端 export session；512 帧/4 MiB 批次；单帧 2 MiB、总计 100,000 帧/128 MiB、最多 8 个会话；30 分钟遗弃回收；临时文件、flush+sync、原子替换和显式回滚错误 |
| 安全        | AI 系统规则、串口日志和用户问题原先拼进同一文本，串口内容可伪造指令                         | prompt injection、危险命令建议            | **已实施** | 使用真正的 system/user `TextMessages`；串口/元数据单独作为不可信 user message；最终 user message 才是实际问题                                                               |
| 安全/资源   | AI prompt、key、model、响应和并发缺少完整上限；含 key 的请求类型可被 Debug                  | 内存/费用放大、秘密进入日志               | **已实施** | prompt 16 KiB、key 4 KiB、model 64 B、shell 256 B、session meta 4 KiB、context mode 64 B、context 512,000 B、response 256 KiB；最多 2 个无等待请求；请求类型移除 Debug      |
| 性能/正确性 | 周期发送使用 `setInterval`，慢写入可能叠加未完成 Promise                                    | 无界发送队列、乱序/断开时残留             | **已实施** | 改为一次只执行一个任务，上一轮 settle 后再调度，stop 以 generation 使后续 tick 失效                                                                                         |
| 依赖/兼容   | serial plugin 前后端停留 v2，事件监听模型与 v3 API 分叉                                     | 无法安全升级、断连监听脆弱                | **已实施** | Rust/JS 同步升级 v3；改用 channel-backed `watch`/`WatchHandle.unwatch`，二进制模式避免文本往返                                                                              |
| 安全        | `secure-settings.json` 实际由普通 Tauri store 保存，名称虽为 secure 但没有 OS 凭据保护      | 本地 API Key 可被同用户进程或备份直接读取 | **待完成** | 迁移到 OS Credential Manager/Keychain/Secret Service 或经审计的 Stronghold；双读迁移后清除明文                                                                              |
| 依赖/供应链 | CI 没有把 npm audit 和 Rust advisory 扫描设为硬门禁                                         | 已知漏洞可能重新进入锁文件                | **已实施** | CI 增加 `pnpm audit --audit-level moderate` 与 `cargo audit`；后续再补 SBOM、许可证和 SARIF 归档                                                                            |

### 3.2 P1

| 维度      | 问题                                                                                                                        | 影响                                                                     | 后续动作                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 目录/架构 | 绝大多数业务仍散落在 `components/`、`composables/`、`lib/`、`stores/`，只有 serial/sessions 开始进入 `features/`            | 私有实现可被任意跨层导入，改动波及面大                                   | 按第 4 节目标树逐切片迁移；每个 feature 只从 `index.ts` 暴露公共 API                                                    |
| 架构      | session residency 当前通过常驻整个 `SessionView` 保存连接；本轮已按会话隔离帧版本并冻结隐藏 UI 帧脉冲，但隐藏组件树仍占内存 | 会话越多，常驻组件内存仍线性增长                                         | 将 headless `SessionRuntime` 与 active-only `SessionView` 分离；连接/自动日志常驻，重 UI 只保留一份                     |
| 状态管理  | `sessions.ts` 同时负责目录、连接标志、帧缓冲、宏、触发器、Modbus、AI 消息和持久化                                           | 556 行 store 成为变更热点                                                | 分成 catalog/runtime/frame/config/history stores；跨 store 用 application service 编排                                  |
| 状态性能  | 审计前 `schedulePersist()` 顺带触发帧消费者，任何配置更新都会让高频列表失效                                                 | 无关设置导致大列表重算                                                   | 本轮已把 frame 通知收窄到 append/clear/flush；后续增加 selector 级 render-count 测试和帧版本号契约                      |
| IPC       | TS/Rust 手写重复 DTO、枚举和限制常量                                                                                        | camelCase、格式 tag、大小上限容易漂移                                    | 从 Rust schema 生成 TS bindings，或维护单一 JSON Schema；契约测试覆盖所有 command/event                                 |
| IPC 性能  | 导出虽已分批，但每批二进制仍序列化为 JSON number[]                                                                          | 4 MiB 原始字节可能在 IPC/JS 堆中放大数倍                                 | 调研 Tauri Channel/resource/binary transfer；保留 session 协议作为流控层                                                |
| Rust 并发 | `ExportSessionManager` 在 `write_all().await` 时持有全局 map mutex                                                          | 一个慢磁盘会阻塞其他导出会话                                             | map 只存 `Arc<Mutex<Session>>`，全局锁只用于查找/增删；每个导出独立串行                                                 |
| Rust 资源 | 本轮已用 30 分钟 inactivity TTL 惰性回收进程内遗弃会话；进程崩溃仍可能留下 `.tmp`/`.backup`                                 | 重启后存在孤立磁盘文件                                                   | 启动时按严格命名和目录范围清理/恢复孤立文件；输出编码字节也设预算并检查磁盘空间                                         |
| 持久化    | session 快照在主线程 JSON.stringify/localStorage，虽限制为 8 会话、每会话 2,000 帧/1 MiB，仍可能形成长任务                  | 串口高负载下 UI 抖动                                                     | 把序列化移到 worker 或 Rust；使用增量日志/版本化快照，保留向后迁移器                                                    |
| 性能      | MERGED 包视图仍可能在响应式失效后重建全部帧；波形解析/渲染仍在主线程                                                        | 50k–100k 帧时出现长任务                                                  | 增量维护 merge index；波形解码和协议解析评估 worker/Rust；用真实 WebView profile 决策                                   |
| 包体积    | Vite 8 默认分块保住了异步边界，但主窗口启动路径仍包含多个静态 chunk                                                         | 请求瀑布和解析开销未测                                                   | 先采集 Windows WebView2/macOS WKWebView waterfall，再决定 `advancedChunks`；禁止恢复整包 naive-ui 的粗粒度 manualChunks |
| 安全      | 生产 CSP 的 `connect-src` 仍包含 localhost/ws 开发地址，style 仍允许 unsafe-inline                                          | XSS 后可利用的连接面较宽                                                 | 开发/生产 CSP 分离；生产移除 localhost/ws；评估 Naive UI nonce/hash 方案后收紧 style                                    |
| 安全      | `append_log`、export begin 接受前端传入的绝对路径                                                                           | WebView 被攻陷时可尝试写入用户可写位置                                   | 保存对话框返回后端签发的一次性文件 token；命令只接受 token/受控目录，不再信任任意路径字符串                             |
| 测试      | 当前以纯 TS/Rust 单测为主，缺少真实 Tauri IPC、WebView 和硬件断连测试                                                       | 平台 API、权限和生命周期回归只能人工发现                                 | 增加 Windows 主线 E2E、PTY/虚拟串口集成、断连/磁盘满/取消导出故障注入                                                   |
| 测试/性能 | `.perf-baseline.json` 被 gitignore，CI 的 15% 回归逻辑没有可比较基线                                                        | benchmark 只证明“能跑”，不能阻止退化                                     | 提交经校准的相对基线或改用历史 CI artifact；按平台分基线，连续两次超 15% 才失败                                         |
| 测试      | Rust tarpaulin `continue-on-error` 且无阈值                                                                                 | 覆盖率漂移不会阻止合并                                                   | 先稳定报告，再设 workspace lines ≥80%、关键 parser/export/AI ≥90% 的硬门禁                                              |
| 发布兼容  | 现有 bundle identifier `com.bbcom.app` 以 `.app` 结尾，Tauri 在 macOS 发布构建中明确警告                                    | 与 macOS `.app` bundle 扩展名冲突；直接改名又会迁移应用数据目录/签名身份 | 设计 `com.bbcom.desktop` 身份迁移，先迁移旧数据目录和签名配置，再在独立版本切换；不得只为消除警告直接改字符串           |

### 3.3 P2

| 维度     | 问题                                                                      | 后续动作                                                                        |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 可维护性 | `WaveformPanel.vue`、`PortSelector.vue`、`MacroPanel.vue` 等仍超过 500 行 | 拆出无状态 view、controller composable 和 domain model；单文件建议软上限 350 行 |
| 可观测性 | parser 有 stats，但串口队列、丢帧、导出速率、隐藏会话 CPU 没有统一指标    | 建立开发诊断页和结构化 tracing 字段；默认不记录串口正文和秘密                   |
| 国际化   | 中英文 catalog 大文件手工同步                                             | 以 typed key/schema 生成 catalog，CI 检查 key 集合一致                          |
| 更新机制 | 无 endpoint/pubkey 的 updater 已移除                                      | 只有在签名、回滚和 endpoint 运维就绪后才重新引入，不保留“看似可用”的空插件      |
| 架构门禁 | 当前自研脚本以静态 import 正则为主                                        | 待 TS7/tooling 成熟后评估 compiler API 图；继续保留无外部 peer 冲突的轻量门禁   |
| 发布     | release build 与性能/安全证据没有统一清单                                 | 自动生成 SBOM、依赖审计、包体积、签名验证和回滚演练报告                         |

## 4. 目标架构与目录层次

### 4.1 前端目标树

```text
src/
├─ main.ts                         # 只判断窗口类型并加载 app bootstrap
├─ app/
│  ├─ bootstrap/                   # Vue、Pinia、全局样式、错误边界
│  ├─ shell/                       # 主窗口/AI 窗口组合，不承载业务规则
│  └─ orchestration/               # 跨 feature 用例编排
├─ features/
│  ├─ serial/
│  │  ├─ domain/                   # PortConfig、字节/连接状态规则；无 Vue/Tauri
│  │  ├─ application/              # connect/send/reconnect/async loop 用例
│  │  ├─ infrastructure/           # serialplugin v3 adapter
│  │  ├─ store/                    # 运行时状态
│  │  ├─ ui/
│  │  └─ index.ts                  # 唯一公共入口
│  ├─ sessions/
│  │  ├─ domain/
│  │  ├─ application/
│  │  ├─ infrastructure/           # snapshot repository
│  │  ├─ store/                    # catalog/runtime/frame/config 分离
│  │  ├─ ui/
│  │  └─ index.ts
│  ├─ terminal/                    # packet list、filter、format、virtual scroll
│  ├─ parser/                      # protocol parser、panel、presets
│  ├─ waveform/
│  ├─ modbus/
│  ├─ macros/
│  ├─ export/
│  └─ ai/
├─ shared/
│  ├─ domain/                      # Result、时间/字节等无框架值对象
│  ├─ contracts/                   # 生成的 IPC/event schema，不含实现
│  ├─ infrastructure/
│  │  ├─ tauri/                    # invoke/event/file token adapters
│  │  └─ storage/
│  ├─ ui/                          # 真正跨 feature 的小组件
│  └─ testkit/
├─ styles/
└─ env.d.ts
```

前端依赖方向必须是单向的：

```text
main/app shell
    ↓
feature public API (index.ts)
    ↓
ui → application/store → domain
          ↓ ports        ↑
      infrastructure ────┘
    ↓
shared contracts/domain
```

规则：

1. `domain/` 不得导入 Vue、Pinia、Naive UI、Tauri 或 serial plugin。
2. feature 之间不得导入对方私有路径；跨域操作由 `app/orchestration` 或对方 `index.ts` 完成。
3. UI 不直接调用 `invoke()`；只能调用 application port。
4. infrastructure 可以依赖外部 SDK，但不得反向被 domain 导入。
5. `shared/` 只接收至少两个 feature 的稳定能力；不能成为新的杂物 `lib/`。
6. 迁移期间旧路径只做 re-export 兼容门面，并带删除 issue/截止版本。

### 4.2 Rust 目标树

```text
src-tauri/src/
├─ main.rs
├─ lib.rs                          # Tauri composition root，仅注册插件/state/commands
├─ app/
│  ├─ state.rs
│  └─ lifecycle.rs
├─ domains/
│  ├─ ai/
│  │  ├─ model.rs
│  │  ├─ policy.rs                 # 限制、角色边界
│  │  ├─ service.rs
│  │  └─ response_parser.rs
│  ├─ export/
│  │  ├─ model.rs
│  │  ├─ service.rs
│  │  ├─ formatter.rs
│  │  └─ session.rs
│  ├─ logging/
│  └─ checksum/
├─ ports/
│  ├─ ai_client.rs
│  ├─ file_sink.rs
│  └─ clock.rs
├─ adapters/
│  ├─ ipc/                         # Tauri command DTO + command handler
│  ├─ zai/
│  └─ filesystem/
├─ shared/
│  ├─ error.rs
│  ├─ limits.rs
│  └─ validation.rs
└─ testkit/
```

Rust 依赖方向：

```text
lib/composition root → adapters/ipc → domain services → domain model
                              ↓              ↑
                    infrastructure → ports ──┘
shared 可被下游使用，但不得依赖 Tauri adapter
```

`#[tauri::command]` handler 只负责 DTO 反序列化、授权上下文、调用 service 和映射错误；文件写入、AI 供应商、时钟等通过 port 注入。domain 不得导入 `tauri::State`、窗口对象或插件类型。

### 4.3 旧目录到目标目录的迁移映射

| 当前路径                                 | 目标路径                                               | 迁移顺序                                                   |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `src/stores/sessions.ts`                 | `features/sessions/{store,application,infrastructure}` | 先抽 repository，再拆 frame/runtime，最后 catalog/config   |
| `src/composables/useSerialConnection.ts` | `features/serial/application` + `infrastructure`       | 先定义 `SerialPortAdapter`，再移动 composable/controller   |
| `src/lib/protocol-parser.ts`             | `features/parser/domain`                               | 纯移动并保留旧 re-export；基准和测试先行                   |
| `src/lib/modbus/*`、`useModbusMaster.ts` | `features/modbus/{domain,application}`                 | core/batches 先移，UI/controller 后移                      |
| `src/components/terminal/*`              | parser/waveform/terminal/modbus 各自 `ui/`             | 按模式逐个迁移，避免一次改动全部面板                       |
| `src/lib/ipc.ts`                         | `shared/contracts` + 各 feature `infrastructure`       | 先生成 DTO，再按 command 拆 adapter                        |
| `src-tauri/src/commands/*`               | `adapters/ipc/*`                                       | 保持 command 名和 wire schema，业务实现移入 domain service |
| `src-tauri/src/export/*`                 | `domains/export/*`                                     | 已完成初步边界；下一步抽 file sink 和每会话锁              |

## 5. 本轮已经实施的优化

本节仅记录已经落到工作树的内容；第 6 节才是后续计划。

| 项目              | 已实施内容                                                                                                                  | 证据/约束                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| npm 工具链升级    | Vue 3.5、Pinia 3、Vite 8、ESLint 10、Vue plugin/parser、vue-tsc 3、TypeScript 6、Tauri JS API 等升级；Lucide 包替换         | lockfile 更新；lint/build/type-check 作为验收门禁                                       |
| Cargo 升级        | MSRV 1.88、resolver 3、Tauri 2.11、Tokio 1.52、zai-rs 0.2、Criterion 0.8 等                                                 | Rust 当前快照 79/79 tests；严格 clippy/fmt 纳入 CI                                      |
| serial v3         | Rust `tauri-plugin-serialplugin` 与 JS API 同步到 3.0.0；使用 `watch`、二进制数据和显式 unwatch                             | 避免 v2 全局事件名、listen/startListening 时序和文本转码                                |
| session residency | 新增 `SessionRuntimeHost` 和纯函数 reconciliation；标签切换不再销毁已访问会话；帧版本改为 per-session，隐藏视图冻结 UI 脉冲 | 关闭/删除会话才卸载；隐藏会话继续收包/触发后台任务，但不消费快捷键、AI 草稿或帧列表重算 |
| parser O(n)       | cursor 消费、摊还 compaction、delimiter 增量搜索；长度异常逐字节重同步                                                      | 32 KiB fixed=1 从约 1,129 ms 降至 6.7 ms；pending 上限与 stats 测试                     |
| AI 日志上下文     | 从尾部按字符预算反向选帧；UTF-8 可读时不再提前生成 HEX                                                                      | 100k 帧、10k 字符约只读取 45 帧，仍保持原时间顺序和 truncation 契约                     |
| AI 安全           | system/user 角色分离；串口内容显式不可信；输入/响应字节限制；2 请求并发；API Key 请求无 Debug                               | 21/21 定向测试通过；IPC 字段名保持兼容                                                  |
| 导出会话          | begin/append/finish/abort；删除 legacy 整批命令；有界批次；30 分钟遗弃回收；后端临时文件；原子替换和可诊断恢复              | 前端不再构造全量 IPC payload；header/append/finish/abort/过期/双重回滚失败均有测试      |
| store 通知收窄    | `schedulePersist` 不再无条件触发帧更新；配置集合采用顶层不可变替换；仅 append/clear/flush 通知帧消费者                      | 避免设置、宏、触发器、Modbus 状态使大帧列表无效化                                       |
| 首屏拆包          | main 按窗口动态导入；Waveform/Parser/Modbus 和设置对话框按需加载；Vite 8 使用默认 Oxc minifier                              | 主窗口启动路径 gzip 下降 8.1%，异步代码占比显著提高                                     |
| 异步周期发送      | 以 settle 后调度代替 `setInterval`                                                                                          | 同一会话最多一个 in-flight send，stop 后不再续调度                                      |
| 架构门禁          | 用仓库内脚本替代与 TS6 peer 冲突的 Madge 8                                                                                  | 当前 132 模块、0 cycle，并检查 domain 禁止依赖 UI/infrastructure/store/框架             |
| 最小权限          | main 与 AI window capability 分离；AI window 不再拥有 dialog/serial；窗口尺寸拒绝 NaN/Infinity，拖拽校验 label              | 降低独立 AI WebView 被利用后的权限范围                                                  |
| 无效 updater 清理 | 删除未启用、无 endpoint、无 pubkey 的 updater 插件、命令、配置和 capability                                                 | 将来只有完成签名/回滚运维后才重新引入                                                   |

## 6. 分阶段迁移计划、验收与回滚

### 阶段 0：冻结基线与可复现测量（1–2 天）

**工作内容**

1. 固定 Node 22、pnpm 11.5.3、Rust 1.88.x、Windows runner 和 release profile。
2. 保存本节列出的测试、覆盖率、bundle manifest、WebView waterfall、内存和微基准结果。
3. 将架构、fmt、lint、type-check、test、clippy 的命令统一到 `pnpm check`/CI。
4. 为破坏性重构建立 feature flag 和版本化持久化 fixture。

**验收**：同一 commit 连续三次构建，bundle gzip 浮动 <1%；微基准中位数浮动 <10%；所有基线 artifact 可从 CI 下载。  
**回滚**：本阶段只增加测量，不改业务；若 runner 噪声过大，先把性能 job 降级为报告，不得保存错误基线。

### 阶段 1：关闭剩余 P0 安全与资源风险（2–4 天）

**工作内容**

1. 把 API Key 从普通 store 迁移到 OS keychain/Stronghold；实现 `new → legacy → empty` 双读，写入新存储成功后删除明文。
2. 在 CI 加 npm production audit、Rust advisory/deny、SBOM；升级后的锁文件重新确认 0 critical/high。
3. export session 增加启动时孤立 temp/backup 清理、编码后输出预算和每会话锁；生产 CSP 去掉开发连接源。inactivity TTL 与惰性清扫本轮已完成。
4. 保存对话框路径改成后端一次性 token，至少先覆盖 export 与 append_log。

**验收**：磁盘中不再出现新明文 key；旧 key 可一次性迁移；日志不含 key；漏洞门禁为 0 critical/high；8 个并行导出互不阻塞；取消/崩溃/磁盘满测试不破坏原目标文件。  
**回滚**：保留一个版本的 legacy 只读迁移，不恢复 legacy 写入；file token 可在紧急版本中回退为“仅保存对话框返回路径 + 受控目录”，不能回退为任意路径；导出新协议故障时只允许临时启用有严格小数据上限的 legacy export。

### 阶段 2：建立前端 feature 边界（1–2 周）

**工作内容**

1. 先创建 `shared/contracts` 和每个 feature 的 `index.ts`，架构脚本新增禁止私有跨 feature import。
2. 按纯度迁移：parser → terminal formatting/filter → waveform → modbus → macros/trigger → AI/export。
3. 每移动一个模块，在旧路径保留 re-export；调用方分批改为公共入口。
4. 最后拆 `sessions.ts`：repository、frame buffer、runtime、catalog/config；禁止一次提交同时移动全部 UI。

**验收**：每个 PR 0 cycle、0 boundary violation；domain 0 Vue/Pinia/Tauri imports；现有 wire schema、持久化 fixture 和测试全部通过；任一迁移 PR 不得造成 >5% bundle 或 >15% hot-path 回归。  
**回滚**：re-export 门面在一个 minor 版本内保留；出错只回退当前 feature 调用方，不恢复已验证的纯 domain 移动；删除旧文件前用 `rg` 确认无生产 import，并单独提交删除。

### 阶段 3：会话运行时与 UI 解耦（4–7 天）

**工作内容**

1. 抽 `SessionRuntimeController`：串口 watch、重连、自动日志、发送队列、协议 parser 生命周期。
2. 每个已连接/需后台工作的会话保留 headless runtime；界面只挂载一个 active `SessionView`。
3. runtime 以 event/selector 向 store 发布有界快照，UI 不持有插件对象。
4. 将波形/协议的 CPU 密集解析放入 worker 或 Rust 原型，对比复制成本后决定。

**验收**：切换 20 个标签不发生断连；只有一个重 UI 树；隐藏会话仍收包/自动日志但无快捷键、动画帧或面板重算；20 个驻留会话空闲 CPU 和内存符合第 8 节预算。  
**回滚**：以 feature flag 切回当前 `SessionRuntimeHost`；runtime state schema 保持兼容；不得回退到切换标签即关闭串口的旧行为。

### 阶段 4：Rust 领域层、IPC 契约与二进制通道（1 周）

**工作内容**

1. 先把 command DTO 与 domain model 分开，保持 Tauri command 名、camelCase 和 enum tag 不变。
2. 抽 AI client、file sink、clock ports；单测使用 fake adapter，不访问网络/真实用户文件。
3. 生成 TS IPC bindings 和限制常量；为 command/event 建立 schema snapshot。
4. 对大二进制试验 Channel/resource 传输；session id、顺序号和 backpressure 语义保持不变。

**验收**：domain crate/module 不导入 Tauri；所有 IPC schema snapshot 无非预期变化；100k 帧导出峰值内存满足预算；Windows/Linux/macOS 契约测试通过。  
**回滚**：adapter 层保留旧 JSON transport；二进制 transport 通过 capability/feature flag 切换；schema 变化必须提供双版本 decoder，不能直接让旧前端失效。

### 阶段 5：性能、测试和可观测性硬门禁（3–5 天）

**工作内容**

1. 提交或从 CI artifact 加载分平台 benchmark 基线，启用 15% 回归门禁。
2. 增加真实 Tauri smoke E2E：启动、列端口、打开/关闭虚拟串口、导出、AI 拒绝路径、capability 拒绝。
3. Rust coverage 从报告提升为 ≥80% lines；关键安全/解析/导出模块 ≥90%。
4. 统一 tracing：session/export id、字节数、耗时、丢弃数；正文和秘密字段永不记录。

**验收**：所有预算自动产出并能阻止故意注入的回归；故障注入覆盖拔线、慢写、磁盘满、无权限、AI 超时和取消。  
**回滚**：只允许因 runner 噪声临时提高统计样本或标记 flaky；不得静默删除门禁。任何阈值变更需附连续历史数据。

### 阶段 6：TS7 与持续依赖维护（生态兼容后，独立 PR）

**工作内容**

1. 等待 `typescript-eslint` 正式声明支持 TypeScript 7；在隔离分支升级到 TS 7.0.x。
2. 同时验证 vue-tsc/Volar、ESLint typed lint、Node strip-only test loader、Vite plugin 和 IDE LSP。
3. 处理 TS7 移除的 TS6 deprecated option；比较 `tsc`/`tsgo` 诊断差异和构建性能。
4. 以后每月升级 patch/minor，每季度评估 major；自动 PR 只合并通过完整矩阵的版本。

**验收**：TS7 type-check 与 TS6 对同一代码无未解释诊断差异；Vue SFC 类型检查、ESLint、测试 loader、生产 build 全通过；保留性能提升报告。  
**回滚**：TS7 必须是独立 commit/PR；直接恢复 `typescript@6.0.3` 与 lockfile，不与 feature 搬迁或运行时改造混合。

## 7. 依赖升级矩阵

### 7.1 npm/pnpm

| 依赖                                                | 审计前                   | 本轮选择              | 状态与原因                                                          |
| --------------------------------------------------- | ------------------------ | --------------------- | ------------------------------------------------------------------- |
| Vue                                                 | `^3.5.0`                 | `^3.5.39`             | 已升级                                                              |
| Pinia                                               | `^2.2.0`                 | `^3.0.4`              | 已升级并修复 shallow store 更新语义                                 |
| Vite                                                | `^6.4.3`                 | `^8.1.4`              | 已升级；使用 Vite 8/Oxc 默认 minifier                               |
| `@vitejs/plugin-vue`                                | `^5.0.0`                 | `^6.0.7`              | 已升级                                                              |
| TypeScript                                          | `^5.6.0`                 | `^6.0.3`              | 已升级到当前 lint 生态允许的最高主版本                              |
| `typescript-eslint`                                 | `^8.0.0`                 | `^8.63.0`             | 已升级；peer 为 `>=4.8.4 <6.1.0`，它是暂缓 TS7 的硬约束             |
| ESLint / `@eslint/js`                               | `^9` / `^9.39.4`         | `^10.6.0` / `^10.0.1` | 已升级；补 `globals.browser`                                        |
| `eslint-plugin-vue`                                 | `^9.0.0`                 | `^10.9.2`             | 已升级                                                              |
| `vue-eslint-parser`                                 | `^9.0.0`                 | `^10.4.1`             | 已升级                                                              |
| vue-tsc                                             | `^2.2.0`                 | `^3.3.7`              | 已升级                                                              |
| Prettier                                            | `^3.8.4`                 | `^3.9.5`              | 已升级                                                              |
| `@tauri-apps/api`                                   | `^2.11.0`                | `^2.11.1`             | 已升级                                                              |
| `@tauri-apps/cli`                                   | `^2.11.2`                | `^2.11.4`             | 已升级                                                              |
| serial plugin JS                                    | `^2.0.0`                 | `^3.0.0`              | 已升级并完成 API 迁移                                               |
| TanStack Vue Virtual                                | `^3.0.0`                 | `^3.13.31`            | 已升级                                                              |
| 图标库                                              | `lucide-vue-next ^1.0.0` | `@lucide/vue ^1.24.0` | 包替换并更新全部 import                                             |
| Madge                                               | `^8.0.0`                 | 删除                  | Madge 8 peer 仅支持 TypeScript `^5.4.4`；改用无 peer 冲突的仓库脚本 |
| c8 / visualizer / Naive UI / ansi_up / dialog/store | 已在兼容版本             | 保持或锁到审计版本    | 发布前仍需 production audit 与 license/SBOM 检查                    |

#### 为什么暂缓 TypeScript 7

TypeScript 7.0.2 已在 2026-07-08 发布，但“最新”不等于“当前项目可安全采用”。本轮 `typescript-eslint@8.63.0` 明确声明 peer range 为 `>=4.8.4 <6.1.0`；直接安装 TS7 会进入 unsupported 组合，使 lint 的 AST/parser 正确性没有上游保证。TS7 还是原生 Go 工具链迁移，必须额外验证 Vue SFC、Volar/vue-tsc、ESLint typed lint、Node 的 strip-only 测试路径及编辑器 LSP。故本轮选择最高兼容的 `typescript@6.0.3`，TS7 按阶段 6 独立升级；这不是遗漏依赖，而是明确的兼容性隔离。

### 7.2 Cargo

| 依赖/工具链          | 审计前        | 本轮选择              | 状态与说明                                          |
| -------------------- | ------------- | --------------------- | --------------------------------------------------- |
| Rust MSRV / resolver | 1.85 / 2      | 1.88 / 3              | 已升级                                              |
| Tauri                | broad `2`     | `2.11.5`              | 已更新锁图                                          |
| tauri-build          | broad `2`     | `2.6.3`               | 已升级                                              |
| serial plugin Rust   | `2`           | `3.0.0`               | 已与 JS v3 同步迁移                                 |
| dialog / store       | `2` / `2`     | `2.7.1` / `2.4.3`     | 已升级                                              |
| serde / serde_json   | `1` / `1`     | `1.0.228` / `1.0.150` | 已升级                                              |
| thiserror            | `2`           | `2.0.18`              | 已升级                                              |
| crc / chrono         | `3` / `0.4`   | `3.4.0` / `0.4.45`    | 已升级                                              |
| tracing / subscriber | `0.1` / `0.3` | `0.1.44` / `0.3.23`   | 已升级                                              |
| Tokio                | broad `1`     | `1.52.3`              | 已升级并增加 `sync` feature 供并发门禁/会话使用     |
| zai-rs               | `0.1.14`      | `0.2.0`               | 已升级并迁移角色化消息 API                          |
| Criterion            | `0.5`         | `0.8.2`               | 已升级；改用 `std::hint::black_box`                 |
| updater plugin       | `2.10.1`      | 删除                  | 配置 inactive、无 endpoint/pubkey；减少依赖和权限面 |

升级纪律：manifest、lockfile 和 API 迁移必须同一 PR；Rust 运行 `fmt + clippy -D warnings + test --locked + cargo audit`，前端运行 `install --frozen-lockfile + audit + lint + type-check + test + build`。当前 npm 审计为 0；任何未来扫描未出最终报告时只能写“待验证”，不能宣称安全。

## 8. 性能、包体积与安全预算

### 8.1 运行时预算

| 对象                           | 预算/硬限制                                                               | 门禁方式                    |
| ------------------------------ | ------------------------------------------------------------------------- | --------------------------- |
| ProtocolParser fixed=1, 32 KiB | 同机中位数 ≤10 ms，且不得比已提交基线退化 >15%                            | frontend benchmark          |
| delimiter pending              | ≤1,000,000 B；超限必须计入 discarded/overflow/resync                      | 单测 + telemetry            |
| 串口帧内存                     | 每会话配置范围 1,000–100,000 帧；达到上限按既定策略丢弃，不得无界增长     | store/queue 边界测试        |
| 持久化快照                     | ≤8 会话；每会话 ≤2,000 帧、≤1,000,000 B                                   | fixture + 序列化测试        |
| AI 日志上下文                  | 10k 字符预算、100k 帧场景访问帧数 ≤100；当前约 45                         | lazy Proxy 测试             |
| AI 请求                        | 最多 2 个并发且不排队；超时 60 s                                          | semaphore/timeout 测试      |
| 导出                           | 单帧 ≤2 MiB；批次 ≤512 帧/4 MiB；总计 ≤100k 帧/128 MiB；活跃会话 ≤8       | TS/Rust 双端边界测试        |
| 大导出内存                     | 128 MiB 原始数据导出时，进程峰值增量目标 ≤32 MiB；不得随总数据线性复制    | Tauri integration benchmark |
| UI 响应                        | 串口稳定流下 p95 long task <50 ms；活动视图 dropped frame <1%             | WebView Performance trace   |
| 隐藏会话                       | 空闲时不运行 requestAnimationFrame/面板重算；20 会话驻留增量 CPU <5% 单核 | runtime instrumentation     |

### 8.2 包体积预算

| 指标                          |                            当前已测 |                                          预算 |
| ----------------------------- | ----------------------------------: | --------------------------------------------: |
| bootstrap eager JS raw / gzip |                   87,114 / 34,789 B |                           ≤100,000 / 40,000 B |
| 主窗口启动路径 JS raw / gzip  |                 789,163 / 243,665 B | ≤800,000 / 250,000 B；超出需附 waterfall 说明 |
| async JS 占比 raw / gzip      |                     90.94% / 88.29% |                                       均 ≥85% |
| 单个延迟面板 chunk            | 最大当前 Waveform 32,337 / 10,478 B |           单 chunk ≤200 KiB raw、≤60 KiB gzip |
| 总 `dist` raw                 |                  审计前 1,028,502 B |            ≤1.10 MiB；单 PR 增长 >5% 必须审批 |

包体积门禁必须从 Vite manifest 计算“入口可达图”，不能简单相加 dist 中所有文件；动态 chunk 既计入总量，也不应误算为首屏。

### 8.3 安全预算

| 项目         | 预算/策略                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 依赖漏洞     | production graph critical/high = 0；medium 需有 issue、负责人和 ≤30 天处置日期                                                |
| 修复 SLA     | critical 24 小时；high 7 天；medium 30 天；无法升级时记录隔离/缓解措施                                                        |
| 秘密         | API Key 不得进入 localStorage、普通 JSON store、Debug/trace、崩溃报告或测试 fixture                                           |
| AI 输入      | prompt 16 KiB；key 4 KiB；model 64 B；shell 256 B；session meta 4 KiB；context mode 64 B；context 512,000 B；response 256 KiB |
| WebView 权限 | 每窗口 capability 最小化；AI window 禁止 serial/dialog；新增权限必须有拒绝路径测试                                            |
| CSP          | `script-src` 不允许 unsafe-eval；生产 `connect-src` 不含 localhost/ws；逐步移除 style unsafe-inline                           |
| 文件写入     | 只接受后端签发 token 或受控目录；使用 create-new temp、sync、atomic replace；失败保留原文件                                   |
| 日志         | 默认只记录长度、耗时、id、错误类别；不记录串口正文、AI 完整响应、路径中的敏感部分或 key                                       |
| 供应链       | frozen lockfile、SBOM、许可证检查、GitHub Action 固定 major/可信发布者；release artifact 必须签名                             |

### 8.4 测试与架构预算

| 指标                | 预算                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| 前端全局覆盖率      | statements/lines ≥85%，branches/functions ≥88%                               |
| `src/lib`/纯 domain | 每文件 lines ≥90%；新 domain 建议 branches ≥90%                              |
| Rust coverage       | workspace lines ≥80%；AI/export/parser/security policy ≥90%                  |
| 测试通过率          | 100%；不得用 skip/continue-on-error 隐藏可复现失败                           |
| 性能回归            | 同平台连续基准退化 >15% 阻止合并                                             |
| 架构                | 0 cycle、0 domain boundary violation、0 feature 私有跨域 import              |
| IPC                 | 每个 command/event 至少 1 个成功契约、1 个缺字段/非法枚举、1 个边界/超限测试 |
| 平台                | PR 至少 Linux + Windows；release 前 Windows/macOS/Linux smoke                |

## 9. 风险控制与破坏性重构协议

1. **一类风险一组提交**：依赖 major、目录移动、wire schema、持久化 schema 不得混在同一不可分提交中。
2. **兼容门面先行**：新实现先上线，旧 import/command 做薄转发；调用方全部迁移后再删除。
3. **数据格式双读单写**：新版本能读旧 session/macro/preset；只写新格式；至少保留一个 minor 版本迁移器。
4. **资源上限不能为兼容而取消**：legacy 路径也必须有比新路径更小的安全上限。
5. **删除清单**：每次 destructive cleanup 必须附 `rg` 无引用证据、schema fixture、回滚 commit 和用户数据影响说明。
6. **真实设备灰度**：串口 v3、runtime 解耦和二进制 IPC 先在虚拟串口与至少两类 USB 串口芯片上验证，再扩大发布比例。
7. **回滚不回退安全边界**：可以恢复旧 UI 或 transport，但不能恢复明文秘密写入、无限 payload、同角色 AI prompt 或无界 parser。

## 10. 完成定义

只有同时满足以下条件，全面优化计划才可标记完成：

- P0 全部完成，特别是 OS 凭据存储和供应链 0 critical/high 门禁。
- 前端业务均进入 feature 边界；旧 `lib/composables/stores` 不再承载跨域业务杂糅。
- session runtime 与重 UI 解耦，后台连接语义有跨标签和断连 E2E 证明。
- Rust command 足够薄，domain 无 Tauri 依赖；TS/Rust IPC 契约由单一来源生成或验证。
- 性能、bundle、coverage、安全预算由 CI 自动计算并阻止回归，而不是只存在于文档。
- Windows、macOS、Linux 发布 smoke、签名、SBOM、更新/回滚演练全部留存证据。
- TS7 只有在生态 peer 支持、完整矩阵通过后升级；若仍暂缓，必须保留有日期和负责人的跟踪 issue。
