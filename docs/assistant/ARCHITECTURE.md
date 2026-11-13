# ARCHITECTURE · 智学节律 · 助手子系统

| 项 | 值 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-11-09 |
| 输入 | `SPEC.md` v1.1、`DECISIONS.md`（D1–D3）、`../../mockups/assistant-v3-week-strip.html` |
| 范围 | 全系统 L1/L2 上下文 + 助手子系统 L3 深入 |
| 事实基线 | 代码实测：`server/index.mjs`、`server/api.mjs`、`server/db.mjs`、`server/assistant/*`、`src/store.ts` |

> 本文只写「怎么搭」与「为什么这样搭」。做什么、验收怎么判，以 `SPEC.md` 为准。

## 0. 需求

### 0.1 功能边界

| 类 | 内容 | 架构后果 |
|---|---|---|
| A 产品答疑 | 24 条语料的检索直答 + 引用跳转 | 纯函数检索，无外部依赖，可离线跑测试 |
| B 数据问答 | 5 个只读工具读当前用户的计划/排布/报告 | 必须带用户身份，工具只读，禁止写库 |
| 会话 | 多轮、最近 3 轮上下文、列表/详情/软删 | 两张表 + 30 天清理 |
| 降级 | 无 Key / 工具失败 / 上游超时 | 三条独立降级路径，用户可见 `degraded` |

显式不做（架构层护栏，非文案）：写库型工具、跨用户数据、无命中转 B、向量库、微服务拆分。

### 0.2 非功能指标

| 指标 | 目标 | 架构手段 |
|---|---|---|
| 首字延迟 | P50 < 1.5s，P95 < 3s | SSE 逐 token 下发；检索与工具并行前置；首 token > 5s 只切文案 |
| 完整回答 | P95 < 8s | 单次工具调用上限 3s，最多 2 轮工具 |
| 降级触发率 | < 15% | 无 Key 时仍能答 A 类；工具失败降级到固定话术 |
| 单用户配额 | 30 次/日，只计 `done` | 以 `assistant_events` 计数为真源 |
| 演示规模 | 10 人并发、单人 1–2 请求 | 单进程 + SQLite 足够，不做连接池与分片 |

### 0.3 约束

- 技术栈不可换：Node ≥22、原生 `node:http`、`node:sqlite`、React 19 + Vite 6、TypeScript。
- 已有 10 张表与 `route(method, path, ctx)` 单函数分发，迁移只增不改（`CREATE TABLE IF NOT EXISTS`）。
- 部署在 CloudBase 云托管，单容器、单写者 SQLite；`ASSISTANT_API_KEY` 走环境变量，不入库不入仓。
- 团队 1 人，工期 8.5 人日（见 SPEC §12）——这是「不引入新中间件」的硬理由。

## 1. 高层设计

### 1.1 组件图

```
                        ┌──────────────────────────────────────────┐
   浏览器               │  React 19 单页（Vite 构建，hash 路由）    │
                        │  pages: #today #goal #week #report #settings│
                        │  ┌─────────────┐  ┌────────────────────┐  │
                        │  │ store.ts    │  │ AssistantPanel     │  │
                        │  │ 单一状态树  │←→│ 条带/消息/输入框   │  │
                        │  └──────┬──────┘  └─────────┬──────────┘  │
                        │         │ api.ts(fetch)     │ fetch+SSE  │
                        └─────────┼───────────────────┼─────────────┘
                                  │ /api/*            │ /api/assistant/chat
                        ┌─────────▼───────────────────▼─────────────┐
                        │  server/index.mjs  node:http 单进程        │
                        │  ├─ 静态 dist/（SPA 回退）                 │
                        │  ├─ currentUser(db, req)  cookie → 用户    │
                        │  └─ route(method, path, ctx)  api.mjs      │
                        │        ├─ 既有 30+ 端点                    │
                        │        └─ assistant.mjs（新增）            │
                        │              ├─ 路由判定 A/B               │
                        │              ├─ retrieval.mjs（词面检索）  │
                        │              ├─ tools.mjs（5 只读工具）    │
                        │              ├─ prompt.mjs（事实边界）     │
                        │              └─ llm.mjs（OpenAI 兼容流）   │
                        │  engine.generated.mjs ← esbuild 打包 domain│
                        └─────────┬───────────────────┬─────────────┘
                                  │                   │ HTTPS 流
                        ┌─────────▼──────┐   ┌────────▼──────────────┐
                        │ data/zhixue.db │   │ 上游模型（OpenAI 兼容）│
                        │ SQLite WAL     │   │ 可缺席 → 降级          │
                        └────────────────┘   └───────────────────────┘
```

关键结构事实：**领域逻辑只有一份**。`src/domain/*.ts` 由 `build:engine` 打成 `server/engine.generated.mjs`，前端页面与服务端工具调用同一套 `packWeek/buildReport/planReplan`。助手回答的周报数字与用户在 `#report` 看到的数字天然同口径，不需要第二套统计逻辑。

### 1.2 两条请求链路

**A 类（知识）**

```
POST /api/assistant/chat
  → 会话校验/新建 → 限流检查 → search(question) 命中 24 条之一
  → 命中：拼 system(事实) + 语料 answer → 模型流式改写（无 Key 时直接回原文）
  → 未命中：FALLBACK_TEXT（不转 B，不做语义猜测）
  → done { citations:[{id, title, route}] }
```

**B 类（数据）**

```
question → 规则表判定为数据类（SPEC §5.1.1 四级有序表，模型不参与路由）
  → 工具选择（≤2 轮）：week_snapshot / day_blocks / report_metrics / goal_summary / capacity_settings
  → 每个工具 = 单条预编译 SQL + WHERE user_id = ?，返回结构化 JSON
  → 数字全部来自工具返回，注入 prompt 的「当前用户数据」区块
  → 流式回答；工具失败 → DEGRADED_DATA_TEXT
```

两类共享：同一个 SSE 通道、同一张 `assistant_events` 埋点、同一套错误码。

### 1.3 部署形态

单容器：`node server/index.mjs` 同时托管 `dist/` 与 `/api/*`，SQLite 落 `data/zhixue.db`（WAL）。CloudBase 云托管只有一个入口，因此**不存在 CORS 与跨域 Cookie 问题**，SSE 也无需额外网关配置——但必须显式 `X-Accel-Buffering: no`，否则部分反代会攒满 buffer 才吐字节，目标里的 1.5s 首字会直接退化到完整回答的 8s 量级。

## 2. 深入

### 2.1 数据模型（只增不改）

新增三张表，均 `CREATE TABLE IF NOT EXISTS`，不改动既有 10 张表：

| 表 | 关键列 | 索引 |
|---|---|---|
| `chat_sessions` | `id`、`user_id`、`title`(首问前 30 字)、`created_at`、`updated_at`、`deleted_at` | `(user_id, updated_at DESC)` |
| `chat_messages` | `id`、`session_id`、`user_id`、`role`、`content`、`mode`、`citations`(JSON)、`tool_calls`(JSON)、`latency_ms`、`feedback`、`created_at` | `(session_id, created_at)` |
| `assistant_events` | `id`、`user_id`、`session_id`、`question`、`mode`、`tool_names`、`degraded`、`first_token_ms`、`latency_ms`、`prompt_version`、`feedback`、`resolved_guess`、`created_at` | `(user_id, created_at)`；`(created_at)` 供指标 |

`user_id` 冗余在 `chat_messages` 上不是规范化失误，是让「所有查询都能带 `WHERE user_id = ?`」成为机械可检的隔离手段：任何一条 SQL 漏了它，就是越权 bug，review 时一眼可查。`assistant_events` 与 `chat_messages` 分开，是因为前者是 30 天也未必清的分析数据，后者是用户可见内容，保留期与删除语义不同。

清理由惰性任务做（`deleted_at < now-30d` 物理删），触发点是「进程启动」+「每日首个助手请求」，不引定时器框架——单容器长跑数月的情况下，只靠启动清理会让过期数据一直躺着。

### 2.2 SSE 契约

`POST /api/assistant/chat`，`Content-Type: text/event-stream`，事件序列固定：

```
event: meta   data: {"sessionId","mode":"knowledge|data","degraded":false}
event: tool   data: {"name","status":"start|ok|fail"}        ← 仅 B 类，可多次
event: delta  data: {"text":"..."}                            ← 可多次
event: done   data: {"citations":[...],"usage":{...},"latencyMs":1234}
event: error  data: {"code":"E3xxx","message":"..."}           ← 终止事件
```

**为什么不用 EventSource**：EventSource 只支持 GET 且不能带自定义头，提问正文会进 URL 与访问日志。前端用 `fetch` + `ReadableStream` 手动切 `\n\n` 帧，代价是要自己处理半包与 `AbortController`，收益是正文在 body 里、与既有 `api.ts` 的 `ApiError` 体系一致。

**为什么不用 WebSocket**：单向、一问一答、无需服务端主动推送，WS 带来的心跳与重连状态机会让「20s 超时收尾」这条规则多出一套实现。

`error` 事件不计入限流；客户端收到 `done` 或 `error` 都要复位发送态。

### 2.3 工具层

5 个只读工具，全部是 `(db, userId, args) => JSON` 的纯函数，**不经过 HTTP**，也不给模型 SQL 能力：

| 工具 | 读什么 | 复用 |
|---|---|---|
| `goal_summary` | `goals` | — |
| `week_snapshot` | `blocks`、`items` | `packWeek` |
| `day_blocks` | `blocks` 按日 | — |
| `report_metrics` | 本周 `blocks/items/ops` | `buildReport`（与 `#report` 同源） |
| `capacity_settings` | `users.weekdays`、`week_start` | — |

工具返回**结构化的、已算好的数字**（如 `achievement: 0.62`），而不是原始行让模型自己算。理由：模型算术不可验收，而 SPEC 要求「每个数字必须来自工具返回」；把计算放在 `buildReport` 里，数字就能与页面逐位对齐。

工具的挑选由规则表决定（问题里的关键词映射到工具集合），**不让模型自己决定调哪个**：路由可测、可回归，模型只负责把工具返回的数字讲顺。

工具与检索**并行发起**：A 类的检索是同步纯函数（<5ms），B 类的工具是同步 SQL（<20ms），两者都不占 I/O 等待，因此「先判定再取数」不构成延迟瓶颈——真正的延迟全部来自上游模型。

### 2.4 检索

`search(question)` 用 bigram 重叠打分（`retrieval.mjs`），命中即返回语料 `answer` 与 `route`。选词面而非向量，三条理由：24 条语料用不上嵌入；无 Key 时必须能跑（演示断网场景）；验收要「机械可判」——附录 A 的 24 条问法就是回归用例。

代价明确：同义改写（「我为啥没排任务」）可能不命中，落到兜底。兜底是设计内的，不是故障；SPEC 已把「不猜」写成行为而非遗憾。

### 2.5 会话与上下文

- 新建：无 `sessionId` 或 `sessionId` 已软删 → 建新会话，`meta` 返回新 id（前端静默替换）。
- 上下文：只带最近 3 轮，`messages.length ≤ 8` 硬断言。不传全会话，控制 token 与「越聊越偏」。
- 并发：同会话两标签页各自持 id，按到达顺序写，last-write-wins，不加锁不报错。
- 端点与 UI 的落差：`GET/DELETE /api/assistant/sessions` 按 SPEC 实现，但面板不接（`DECISIONS.md` D8.1）；接口存在是为了排障与以后补 UI，不为了本期有调用方。
- 版本：system 模板带 `PROMPT_VERSION`，随事件入库（D8.2）；改模板不改版本号等于把两版行为混进同一组指标。

### 2.6 错误、降级、限流

| 触发 | 判定点 | 用户可见 |
|---|---|---|
| 无 `ASSISTANT_API_KEY` | `llm.mjs` 启动探测 | A 回原文；B 回 `DEGRADED_DATA_TEXT` |
| 上游 401/429/5xx | 首个 chunk 前 | 同无 Key 路径，`degraded=true` |
| 首 token > 5s | 计时器 | 文案切「正在整理」，不伪造流式 |
| 20s 未完成 | 计时器 | 中断 + 「回答不完整」收尾 |
| 工具异常 | `try/catch` 包单个工具 | 该工具缺席，其余照常 |

限流真源是 `assistant_events` 的当日 `done` 计数，内存 Map 只是快速路径。这样进程重启不会把配额清零——单容器环境下这是唯一可靠做法。

### 2.7 前端接入

`AssistantPanel` 挂在 `App` 根节点、脱离路由，切 tab 不丢会话；条带数据来自 `week_snapshot` 的同一份响应，不额外请求。引用 chip 的跳转用 `location.hash = route`，与现有 `#week/#today/...` 路由对齐，命中后面板收起。

### 2.8 与既有骨架的接缝（评审补充）

`index.mjs` 的 API 分支是「`route()` 返回对象 → 统一 `sendJson`」，流式端点必须走它已有的逃生口：`res` 已经在 `ctx` 里，助手路由自己写完 SSE 后返回 `{ __sent: true }`，外层才会跳过二次写。三条硬约束随之而来：

1. **进入流式后不得抛错**。此时响应头已发出，外层 `catch` 再 `sendJson` 会撞 `ERR_HTTP_HEADERS_SENT`，用户看到的是连接截断而不是错误码。因此流式段内所有异常必须在内部捕获并转成 `error` 事件。
2. **中途失败也要发终止帧**。若 `res.write` 抛错（客户端已断开），只清理计时器与上游 `AbortController`，不再尝试写任何东西。
3. **20s 上限要在服务端计时**，不能只靠前端 `AbortController`——前端关页面后服务端仍会挂住上游流，配额已被 `done` 计入就白白泄漏一次调用。

**离线**：助手不走 `offlineQueue`。断网时前端先探测 `navigator.onLine === false` 即本地回「当前离线，联网后再问」，不发请求也不入队——排队的提问在恢复后集中触发，会让限流与配额出现难以解释的尖峰。

**安全**：复用现有 `zx_sid`（`HttpOnly; SameSite=Lax`），跨站 POST 会被浏览器丢弃，故本期不引 CSRF token。两点需在阶段 1 顺手确认：Cookie 缺 `Secure` 属性（既有问题，HTTPS 下应补，改动只在一行且向后兼容）；`question` 长度上限 500 字既防滥用也防提示词注入的体积攻击，服务端截断而非报错。

**配额日期口径**：按客户端上报的本地日期归档（与「多时区非目标」一致），服务端只校验格式不换算。代价是改系统时间可绕过配额——演示场景可接受，写在此处以免被当成漏洞。

## 3. 规模与可靠性

### 3.1 负载估算

| 项 | 演示期 | 假设 100 用户 |
|---|---|---|
| 日提问 | ~150 次（10 人 × 15） | ~1,500 次 |
| 峰值并发 SSE | 1–2 | ~5（按 5% 同时） |
| DB 写 | < 10 行/秒 | < 60 行/秒 |
| 流水量 | 每答 300–800 token | 同量级 |
| 模型 token 消耗 | 150 次 × ~2k ≈ 0.3M/日 | ≈3M/日 |

结论：三个数量级都在单进程与 SQLite 的安全区内。真正的上限不是请求数，而是**上游模型并发与单次 8s 时长的乘积**——100 并发流会让 Node 事件循环里挂 100 个上游流，内存与配额同时吃紧。所以水平扩展的第一刀不是拆 SQLite，而是把上游并发做成信号量（当前不足则 429 + `E3010`），这一条留给「100 用户」阶段，不在本期实现。

### 3.2 故障模式

| 故障 | 表现 | 处置 |
|---|---|---|
| SQLite 写锁竞争 | `SQLITE_BUSY` | WAL + 单写者；写失败重试 1 次，仍失败返回 `E3005` 并保留用户提问在内存完成当前流 |
| 容器重启 | 进行中的流断开 | 客户端 `done` 缺失即在本地标记「回答不完整」，不做自动重放（重放会重复计数） |
| 反代缓冲 SSE | 首字延迟异常 | `X-Accel-Buffering: no` + `Cache-Control: no-transform` |
| 上游限频 | 429 | 降级链接管，`degraded=true` 计入指标 |
| 磁盘满 | 写入失败 | 启动时检查可用空间；失败只影响助手，不阻塞既有单机功能 |

### 3.3 可观测

`assistant_events` 一行即一次提问的全貌（模式、工具、降级、延迟、反馈），指标 §11 全部由它聚合，不引 APM。日志只打 `sessionId` 与错误码，不打提问原文——原文已在库里，日志不必二次泄漏。

## 4. 取舍（ADR 摘要）

| # | 决策 | 放弃的方案 | 代价 |
|---|---|---|---|
| ADR-1 | SSE over POST | WebSocket；轮询 | 自写流解析与半包处理 |
| ADR-2 | bigram 词面检索 | 向量/嵌入检索 | 同义改写命中率低，靠兜底兜住 |
| ADR-3 | 工具按需调用、结果已算好 | 把用户全量数据塞进 prompt | 多一轮选择逻辑；换来 token 与隐私可控 |
| ADR-4 | SQLite 单文件 | Postgres / 云数据库 | 无法水平扩展，单写者；本期规模够用 |
| ADR-5 | 领域逻辑前后端共用一份 | 服务端重写统计 | 需 esbuild 打包步骤（已有） |
| ADR-6 | 提问原文入库 | 只存哈希/不存 | 隐私面变大；换来可排障、可算指标，配 30 天清理 |
| ADR-7 | 检索未命中直接兜底，不转 B | 未命中转数据问答 | 少答一些模糊问题；换来行为可预测、可验收 |
| ADR-8 | 限流真源落库 | 内存计数器 | 每次提问多一次聚合查询；换来重启不清零 |

## 5. 风险与待定

| # | 风险/待定 | 影响 | 处置 |
|---|---|---|---|
| A1 | 模型与 Key 未定（SPEC Q1） | 阻塞阶段 2 | `llm.mjs` 只依赖 OpenAI 兼容协议，Key 走环境变量，可随时替换 |
| A2 | CloudBase 反代是否缓冲 SSE | 首字指标失效 | 上线前用 curl 实测首字节时间，不过就开 `no-transform` 并关压缩 |
| A3 | 模型算术漂移 | 数字与页面不一致 | 工具返回已算好的字段，prompt 明确「不得自行计算」 |
| A4 | 兜底率偏高 | 体验与「90% 首次可用」冲突 | 上线 1 周看 `resolved_guess` 与 `degraded` 分布，必要时扩语料而非改路由 |
| A5 | 30 天清理与 `assistant_events` 保留期冲突 | 指标断档 | 事件表独立保留，清理只动两张会话表 |

## 6. 架构对验收的支撑

| 验收要求 | 由哪层保证 |
|---|---|
| 数字与页面一致 | ADR-5 共用引擎 + 工具返回已算好字段 |
| 引用可跳转 | 语料 `route` 字段 + `location.hash` |
| 降级可注入、可复现 | 三条独立路径，均以 `degraded` 标志暴露 |
| 用户数据隔离 | 三张新表都带 `user_id`，工具 SQL 禁裸查询 |
| 无 5xx 露出 | 所有异常收敛为 `error` 事件 + 固定文案 |
| 不遮挡主页面 | 面板为 fixed 浮层，`getBoundingClientRect` 相交面积 0 |

架构层面的未决项只剩 A1（Key 由谁给）与 A2（反代行为），两者都不阻塞阶段 1。

