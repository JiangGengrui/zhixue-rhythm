# PLAN · 助手子系统实施计划

| 项 | 值 |
|---|---|
| 版本 | v1.0（2026-11-09） |
| 依据 | `SPEC.md`（§6 需求、§12 阶段）、`ARCHITECTURE.md` v1.0、`DECISIONS.md` D1–D8 |
| 语言/栈 | TypeScript + React 19（前端）、Node ≥22 原生 `node:http`/`node:sqlite`（后端） |
| 验收编号 | `AC-<R号>-<序号>`，如 `AC-2-3` = SPEC §6 R2 的第 3 条验收（见 D8.4） |
| 闸门 | 每阶段末对照 `checklists/GATES.md`；Gm = `typecheck` / `test` / `build` 三条退出码 0 |

## 0. 现状与前提

- 阶段 0 已完成：`server/assistant/knowledge.mjs`（24 条）、`retrieval.mjs`（bigram 检索）、`retrieval.test.mjs` 9 条单测。
- 已有骨架：`server/index.mjs`（静态 + API + SPA 回退）、`server/api.mjs`（`route(method,path,ctx)`）、`server/db.mjs`（10 张表，WAL）、`server/auth.mjs`（`zx_sid` Cookie）。
- 已有前端：`src/store.ts`（单一状态树）、`src/data/api.ts`、`src/domain/*`（打包成 `server/engine.generated.mjs`）。
- **无 lint**：仓库没有 eslint 依赖与配置，`npm run lint` 不存在。T0 补上，否则 Gm 第 1 条无法执行。

## 1. 工时对账（先看差异，再看任务）

| SPEC 阶段 | 本计划任务 | SPEC 人日 | 本计划人日 | 差异原因 |
|---|---|---|---|---|
| 1 | T1–T6 | 2.0 | 2.75 | SPEC 未单列「会话端点/软删」「错误码映射」「语料 route 契约」三处，实际各需 0.25–0.5 |
| 2 | T7–T8 | 1.5 | 2.0 | 降级注入矩阵 9 组需要可注入开关与 3 条路径，SPEC 把它算在阶段 5 |
| 3 | T9–T10 | 2.0 | 1.5 | 工具是纯函数、复用 `engine.generated.mjs`，比 SPEC 估的省 |
| 4 | T11–T13 | 2.0 | 2.25 | 条带按小时比例绘制与离线态是 SPEC 未计的细节 |
| 5 | T14 | 1.0 | 1.0 | 一致 |
| — | T0 | — | 0.25 | SPEC 未计 lint 接入 |
| **合计** | | **8.5** | **9.75** | 多 1.25，主因是把 SPEC 里「已隐含但没计」的三块显式化了 |

若必须压回 8.5：先砍 T12 的建议问题（P1 可后补，−0.5），再砍 T9 的工具单测（改由 T14 的端到端覆盖，−0.5），T0 的 lint 不可砍（它决定 Gm 能不能跑）。

## 2. 任务清单

> 「完成判据」一律写成**可观察的结果**（命令输出、DOM 断言、库内数据），不写「实现 X」。
> AC 列中的 `~` 表示连续区间（`AC-1-1~5` = `AC-1-1` 到 `AC-1-5`）；将来若有追溯脚本，需展开区间后再比对。

### 阶段 1 · 骨架与确定性回答（T1–T6，2.75 人日）

| ID | 任务与产出 | 完成判据 | AC | 依赖 | 人日 |
|---|---|---|---|---|---|
| T1 | 数据层：`db.mjs` 增 `chat_sessions`/`chat_messages`/`assistant_events` DDL 与索引；`server/assistant/sessions.mjs`（读写 + 配额计数 + 30 天清理；原计划的 `store.mjs` 改名，因为它只管会话/消息/事件，不承担其他存储） | 空库启动后 `sqlite_master` 里有三张表；`(user_id, updated_at DESC)` 索引存在；构造 `deleted_at` 为 31 天前的会话，跑清理后该行消失且关联消息一并删除（单测） | AC-6-3、AC-6-4 | — | 0.5 |
| T2 | 会话端点：`GET /api/assistant/sessions`、`GET /api/assistant/sessions/:id`、`DELETE …/:id`（软删） | B 账号取 A 的 sessionId → 404 `E4004`；软删后再取 → 404；同一 sessionId 重新拉取的消息条数与内容全等 | AC-6-3、AC-6-4 | T1 | 0.4 |
| T3 | SSE 骨架 + `POST /api/assistant/chat`（**只做 A 类直答**，不接模型）：`server/assistant/chat.mjs`（SSE 帧编码 + 分块 + 落库，不再单开 `sse.mjs`——本阶段没有模型长流，心跳与 20s 收尾随 T7–T8 一起做） | `curl -N` 依次收到 `meta` → `delta` → `done`；A 类任一命中问法返回 `text === KNOWLEDGE[id].answer`；无命中返回 `FALLBACK_TEXT` 且 `citations=[]`；客户端断开后进程日志无 `write after end` | AC-2-1、AC-2-2、AC-2-5、AC-2-6 | T1 | 0.8 |
| T4 | 限流与配额：按 `assistant_events` 当日 `done` 计数，超限 `429` + `resetAt` | 连续 30 次成功后第 31 次 `429` 且带 `resetAt`；第 32 次仍 `429` 且计数不增；成功 29 + `400`×5 + 越权 `404`×2 后第 30 次仍 `200`；重启进程后计数不归零 | AC-6-1、AC-6-2、AC-6-5 | T3 | 0.5 |
| T5 | 错误码与文案：`E1001/E1002/E2001/E2002/E4004` 五条路径 | 五种 code 各触发一次（接口层）；前端渲染中文文案，DOM 文本不含 `E1001` 等原始 code | AC-7-1 | T3 | 0.25 |
| T6 | 语料 `route` 契约：`knowledge.mjs` 补 21 条 `route` + 3 条 `null`（`tech`/`design`/`deploy`）；`citations` 结构定稿 | 21 条引用点开后 `location.hash === route`；3 条渲染为纯文本 chip，点击无跳转、控制台无报错 | AC-2-3、AC-2-4 | T3 | 0.3 |

### 阶段 2 · 模型与降级（T7–T8，2.0 人日）

| ID | 任务与产出 | 完成判据 | AC | 依赖 | 人日 |
|---|---|---|---|---|---|
| T7 | 模型接入：`server/assistant/llm.mjs`（OpenAI 兼容流式、超时、Abort）、`prompt.mjs`（system 三块 + `PROMPT_VERSION` 常量） | 无 Key 时 B 类返回 `DEGRADED_DATA_TEXT` 且数字个数 = 0；有 Key 时 B 类首 token ≤3s（本地实测一次，结果记入验收报告）；`assistant_events.prompt_version` 每次请求有值 | AC-4-1~6、AC-5-1 | T3 | 1.5 |
| T8 | 降级链与注入：无 Key / 上游 5xx / 20s 超时三条路径，外加**仅测试可用**的故障注入（环境变量，生产禁用） | R5.3 的 9 组（3 注入 × 3 问题类型）全过；9 组 DOM 与气泡文本不含 `5\d\d`、`E\d{4}`、`fetch`、`stack`、`timeout`；降级期间无空气泡（节点数 ≥1 且 `content.length>0`） | AC-5-1、AC-5-2、AC-5-4 | T7 | 0.5 |

### 阶段 3 · 工具与数据类（T9–T10，1.5 人日）

| ID | 任务与产出 | 完成判据 | AC | 依赖 | 人日 |
|---|---|---|---|---|---|
| T9 | 5 个只读工具：`server/assistant/tools.mjs`（`get_goal`/`get_week`/`get_today`/`get_report`/`get_settings`），复用 `engine.generated.mjs` | 每个工具有单测：构造库 → 返回值与 `/api/state` 同项数值相等；无目标返回 `null`；无数据返回 `hasData:false`；单次耗时 <3s（本地） | AC-3-1~6 | T7 | 1.0 |
| T10 | 规则路由 + 数据类回答：SPEC §5.1.1 四级有序判定表落地为纯函数 + 工具结果注入 prompt | 10 条数据问法全部走 B 且数字来自工具返回；「这周还剩多少任务」与 `/api/state` 未完成块数相等；「周三为什么空着」出现三者之一且与构造数据一致；误路由 10 条走 A 时回答数字集合 ⊆ 语料数字集合 | AC-3-1~6、AC-3.5-1、AC-3.5-2 | T9 | 0.5 |

### 阶段 4 · 前端面板（T11–T13，2.25 人日）

| ID | 任务与产出 | 完成判据 | AC | 依赖 | 人日 |
|---|---|---|---|---|---|
| T11 | 面板 UI：`AssistantPanel`/`WeekStrip`（七列条带）/`MessageList`/`Composer`/`CitationChip` + `useAssistant`（fetch 流解析、AbortController） | 五页均可唤起，`Esc` 关闭后 `scrollY` 与打开前一致；空输入 `disabled`；501 字被阻止并提示上限；1440×900 与 1280×800 下与「完成打卡」按钮相交面积 = 0；390×844 下面板 `width===innerWidth && height===innerHeight`；条带为真实 7 列，点选某天后提问自动带上该天 | AC-1-1~5、AC-2-4、AC-10-1 | T3（可用 mock 流提前起步） | 1.5 |
| T12 | 建议问题、反馈、复制、清空会话、模式标识 | 空态 4 个（2A + 2B）按有无数据切换；点击后填入并触发一次提问；赞/踩落库 `feedback`，踩展开 3 原因；复制内容与气泡全等；清空需二次确认 | AC-8-1、AC-9-1、AC-11-1 | T11 | 0.5 |
| T13 | 离线态与移动全屏 | 离线注入后输入框 `disabled` 且提示文案存在；恢复网络 5s 内可输入；离线期间不发出任何请求（network 记录 0 条） | AC-5-3、AC-1-4 | T11 | 0.25 |

### 阶段 5 · 验收（T14，1.0 人日）

| ID | 任务与产出 | 完成判据 | AC | 依赖 | 人日 |
|---|---|---|---|---|---|
| T14 | 端到端与验收：扩充 `scripts/e2e.mjs`；填 `ACCEPTANCE.md`（期望/实际/证据/结论） | P0 全部 AC 有端到端用例；24 条 A + 20 条 B + 9 组降级全绿；`ACCEPTANCE.md` 每条都能指到命令或文件；报告中的数字全部来自实跑 | 全部 | T1–T13 | 1.0 |

### S5 前置 · T0（0.25 人日，先于编码）

| ID | 任务与产出 | 完成判据 | AC | 依赖 | 人日 |
|---|---|---|---|---|---|
| T0 | 写 `CODEBUDDY.md`（四段：项目结构 / 命令 / 代码规范 / 边界），接入 eslint | `npm run lint` 存在且退出码 0；`CODEBUDDY.md` 四段齐全且命令与实际脚本一致；Gm 三条命令连续跑通 | N/A（工具性任务：lint 与文档，判据由 Gm 自身承担） | — | 0.25 |

## 3. 执行顺序与并行

```
T1 → T3 → T4/T5/T6（并行）→ T7 → T8 → T9 → T10 → T14
              └→ T11 → T12 → T13 ─┘
T0（S5 第一天）
```

- **关键路径**：T1 → T3 → T7 → T9 → T10 → T14。任何一环延期，T14 直接后移，没有可压缩的缓冲。
- **可并行**：T4/T5/T6 互不依赖；T11 可在 T3 之后用假流先做，不必等 T7。
- **必须串行**：T7 之后才 T9（工具结果要进 prompt）；T9 之后才 T10（路由器要能调到工具）。
- **不可提前**：T6 的 `route` 必须先于 T11，否则引用 chip 返工两处。

## 4. 风险与依赖

| 风险 | 触发点 | 处置 |
|---|---|---|
| Q1（模型与 Key 未定） | T7 开工前 | T1–T6、T9–T13 全部不受阻，只有 T7 等；先把 T7 的 LLM 接口写成可替换的单一模块 |
| 反代缓冲 SSE | T7 上线前 | `curl -N` 测首字节时间；不过则加 `X-Accel-Buffering: no` 并关压缩，实测值进验收报告 |
| 24 条语料缺 `route` | T6 | 排在阶段 1 末尾，避免 T11 之后返工 |
| 面板与主页面争层级/滚动 | T11 | 判据里已写「相交面积 = 0」「关闭后 `scrollY` 一致」，不靠肉眼 |
| 工时超 8.5 人日 | 全程 | 见 §1，超 1.25；压缩顺序：T12 → T9 单测 → 不接受砍 T0 |

## 5. 明确不做（防蔓延）

| 不做 | 依据 |
|---|---|
| 面板的历史会话列表 UI | `DECISIONS.md` D8.1（端点保留，界面不接） |
| Cookie 加 `Secure` | D8.3（单独立项） |
| 向量检索 | SPEC R14（语料 >80 条再议） |
| 执行型 Agent（改计划/重排） | SPEC R12（P2 只留接口位） |
| 离线 FAQ 语料入前端包 | SPEC R13（取决于 Q3 是否真断网） |
| 性能压测、压测脚本 | `GATES.md` 未覆盖项，本期规模下无可判阈值 |

## 6. 执行状态（滚动更新）

| 任务 | 状态 | 完成到哪一步 / 余量 |
|---|---|---|
| T1–T6 | ✅ 完成 | 数据层、会话端点、SSE 骨架、配额、错误码、语料 `route` 全绿（Loop 1） |
| T7 | ✅ 完成 | 模型接入 + prompt + 首 token 慢的 `status` 帧（Loop 2） |
| T8 | ✅ 完成 | 三条降级路径端到端 + 半截失败 + 仅测试可用的注入口（Loop 4） |
| T9 | ✅ 完成 | 5 个只读工具 + 超时 + 数字与 `/api/state` 对账（Loop 2） |
| T10 | ✅ 完成 | 规则路由（A/B 判定）+ 工具事实入 prompt（Loop 3） |
| T11 | ✅ 完成 | 面板、`useAssistant`、`CitationChip`、500 字拦截、`Esc`、离线禁用（Loop 5）；`WeekStrip` 七列条带 + 点选某天带日期（Loop 6）。几何类 AC（相交面积 = 0、关闭后 `scrollY`）仍需浏览器实测 |
| T12 | ✅ 完成 | 建议问题按有无数据切换、赞/踩含 3 原因（落库）、复制、清空二次确认、模式标识（Loop 6） |
| T13 | ⬜ 未开始 | 离线注入回归、恢复网络 5s 内可输入、移动全屏实测 |
| T14 | ⬜ 未开始 | 验收报告与 AC 逐条对照 |

