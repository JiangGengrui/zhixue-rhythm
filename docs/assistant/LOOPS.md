# 迭代记录（Loop 1–5）

> 本文件记录 S5 阶段「按 PLAN 持续完善」的五轮迭代。每轮固定四段：
> **目标**（对应 `PLAN.md` 任务与 `SPEC.md` 的 AC）→ **改动**（文件与关键决定）→
> **/code-review 结论**（按安全 / 性能 / 正确性 / 可维护性四维，含处置）→
> **闸门与遗留**（`lint` / `typecheck` / `test` 实跑结果，以及本轮没做的事）。
>
> 与 `CHANGELOG.md` 的分工：CHANGELOG 面向「版本有什么变化」，本文件面向「哪一轮做了什么、review 发现了什么」。

## Loop 1 · T7 模型接入层

**目标**：把「调模型」这件事做成可单测、可降级的一层，A 类行为不变（仍回语料原文）。

| 任务 | 验收点 | 状态 |
|---|---|---|
| T7 `prompt.mjs` | 三块 system 齐全；`PROMPT_VERSION` 随模板改；上下文只带最近 3 轮 | 完成 |
| T7 `llm.mjs` | OpenAI 兼容流式；总超时 / 外部 Abort / 5xx / 空响应 / 错误帧都有分类错误；零第三方依赖 | 完成 |
| T7 `chat.mjs` 的 `streamModelReply` | 模型只服务 B 类；无 Key 或无事实时回 `DEGRADED_DATA_TEXT` | 完成 |
| T7 `route.mjs` | 数据指代词纯函数判定；附录 A 的 24 条问法不得被抢走 | 完成 |

**改动**：新增 `prompt.mjs`（`SYSTEM_BLOCKS` 三块、`trimHistory`、`buildRequestMessages`、`DEGRADED_DATA_TEXT`）、`llm.mjs`（`streamChatCompletion` + `LlmError` 五种 `kind`）、`route.mjs`（`classify`）；`chat.mjs` 抽出 `beginSse` / `completeStream`，新增 `streamModelReply`；`api.mjs` 的 `/chat` 先 `classify`，数据类走 `streamModelReply`（`facts` 待 T10 注入）；`sessions.mjs` 加 `recentMessages`。

**/code-review 结论**

| 维度 | 发现 | 处置 |
|---|---|---|
| 正确性（高） | 帧直接 `res.write`，客户端断开瞬间会抛 `ERR_STREAM_WRITE_AFTER_END`；外层错误处理此时响应头已发，再 `sendJson` 会二次抛 `ERR_HTTP_HEADERS_SENT` | 改为 `beginSse().send()`：写失败即标记断开、静默丢弃后续帧；补回归测试（假 `res.write` 直接抛） |
| 正确性（中） | `done` 与落库之间没有二次确认，close 恰好在写 `done` 前到达仍会落库并占配额 | `completeStream` 在发 `done` 前再确认 `isAborted()` |
| 性能（中） | B 类取上下文用 `messages().slice(-6)`，会把整段历史读进内存（会话可攒上千条） | `sessions.mjs` 加 `recentMessages(userId, id, limit)`，SQL `ORDER BY created_at DESC LIMIT ?` 后反转 |
| 可维护性（低） | `firstTokenMs` 同时表示「阈值」和「实测耗时」，调用方极易搞混 | 阈值参数改名 `slowThresholdMs`，返回值保留 `firstTokenMs` |
| 安全 | 上游响应正文不入日志、不回显（可能回显提问原文）；提问限 500 字；用户输入只进 `user` 消息，system 三块固定 | 无需改动，已由 `llm.mjs` 的注释与 `E1002` 覆盖 |
| 需求冲突 | SPEC §5.1.1 的裸词「偏差」「归因」与附录 A 第 15、16 条互斥 | 记入 `DECISIONS D9.1`，改限定词；`route.test.mjs` 用 24 条问法做回归 |

**闸门**：`lint=0 typecheck=0 test=0`；`node --test` 87 条 + `vitest` 55 条全绿。

**遗留**：`status` 帧（首 token 慢时）前端还没有消费方；故障注入与三条降级路径的端到端断言留给 Loop 2。

## Loop 2 · T9 只读工具

**目标**：B 类回答需要的那 5 个只读工具就位，且每个数字都能回到接口对账。

| 任务 | 验收点 | 状态 |
|---|---|---|
| T9 `tools.mjs` | `get_goal / get_week / get_today / get_report / get_settings` 五个白名单工具 | 完成 |
| T9 | 单次 3s 超时、异常一律返回 `status:'fail'` 而不抛 | 完成 |
| T9 | 数值与 `GET /api/state`、`GET /api/report` 同源 | 完成（`get_report` 直接复用 `buildReport`） |
| T9 | 只读、禁自由 SQL | 完成（全部从内存 `state` 派生，无写路径） |

**改动**：新增 `server/assistant/tools.mjs`（`createToolbox({ state, today })` + `runWithTimeout`）；`api.test.mjs` 增一条「同一份 `/api/state` 下 `get_today` 逐项一致」的集成用例。

**/code-review 结论**

| 维度 | 发现 | 处置 |
|---|---|---|
| 正确性（中） | `get_today` 的累计时长混用 `actualMin` 与 `accumulatedSec`，会出现「已完成 120 分钟、累计 0 分钟」的自相矛盾 | 已完成块优先 `actualMin`，进行中块才用 `accumulatedSec`；补断言 |
| 正确性（低） | `get_goal` 的 `ratio` 在截止日已过时是 `Infinity`，经 JSON 会变 `null` | 显式转 `null` 并断言 `JSON.stringify` 不抛 |
| 可维护性（中） | `TOOL_NAMES` 与实现对象是两处定义，新增工具忘同步会出现「白名单里有、实现里没有」 | 加测试逐个 `call`，出现 `未知工具` 即失败 |
| 安全 | 工具名白名单、`weekStart`/`date` 用正则校验、无写库路径 | 无需改动 |
| 性能 | 每次请求都新建 toolbox，但只是遍历已查好的 `state`，无额外 SQL | 无需改动 |

**闸门**：`lint=0 typecheck=0 test=0`；`node --test` 101 条 + `vitest` 55 条全绿。

**遗留**：工具结果还没注入 prompt（Loop 3）；`status:'fail'` 走到用户面前的表现留给 Loop 4。

## Loop 3 · T10 工具事实注入与数据类回答

**目标**：把工具结果真正接到 B 类回答上——模型只拿事实说话，取不到事实就降级。

| 任务 | 验收点 | 状态 |
|---|---|---|
| T10 | 按问法选 1–3 个工具，被明确问到的工具优先占名额 | 完成（`planTools`） |
| T10 | 工具结果合成 `facts` 注入 system 的「当前用户数据」区块 | 完成（`buildFacts` + `buildRequestMessages`） |
| T10 | 一个工具都没成功 → 不调模型，回 `DEGRADED_DATA_TEXT` | 完成（`buildFacts` 返回 `null`） |
| T10 | 工具调用记入 `assistant_events.tool_names`，可事后归因 | 完成（集成测试断言） |

**改动**：`tools.mjs` 增 `buildFacts`、`weekStartFor`，`createToolbox` 支持 `weekStart` 并按「今天所在的周」取数；`route.mjs` 增 `planTools`；`api.mjs` 的 B 类分支改为「state → toolbox → planTools → Promise.all(call) → buildFacts → streamModelReply」。

**/code-review 结论**

| 维度 | 发现 | 处置 |
|---|---|---|
| 正确性（高） | `get_week` 默认从「今天」起算 7 天，跨周时会把两周的尾巴拼成一周，周报口径与 `/api/report` 对不上 | 改为 `weekStartFor(today, settings.weekStart)`，补「周三提问也拿到周一起始」的测试 |
| 正确性（中） | `planTools` 用 `slice(0,3)` 截断会挤掉被明确问到的工具（「我的目标这周可用时间」丢 `get_settings`） | 拆成 primary / context 两档：primary 先占名额，`get_week` 作补位；补精确断言 |
| 可维护性（低） | `buildFacts` 的 `hasData` 若工具不返回该字段会算成「有数据」 | 语义改为「只有显式 `false` 才算没数据」，并在 `get_goal`/`get_today` 显式给 `hasData` |
| 安全 | facts 含用户自己的任务标题，只进 prompt 不落日志；工具仍全只读 | 无需改动 |

**闸门**：`lint=0 typecheck=0 test=0`；`node --test` 106 条 + `vitest` 55 条全绿。

**遗留**：故障注入与三条降级路径的端到端断言（Loop 4）；`status` 帧仍无前端消费方（Loop 5）。

## Loop 4 · T8 降级链与故障注入

**目标**：把「无 Key / 上游 5xx / 20s 超时」三条路径做成可重复执行的端到端断言，并确认降级期间用户看到的仍是完整一句话（SPEC AC-5-1、AC-5-2、AC-5-4）。

| 任务 | 验收点 | 状态 |
|---|---|---|
| T8 `faults.mjs` | `ASSISTANT_FAULT` 三值开关；`NODE_ENV=production` 强制忽略；假 Key + 假 fetch，不联网不读真实凭据 | 完成 |
| T8 `api.mjs` /chat | B 类分支接 `resolveFault()` → `applyFault()`，覆盖项透传 `streamModelReply` | 完成 |
| T8 端到端 | 三条路径 `text === DEGRADED_DATA_TEXT`、`done.degraded === true`、`citations === []`、正文无数字、事件 `degraded=1` | 完成 |
| T8 半截失败 | 已发出正文后上游断开：保留前文、补「不完整」、`done.incomplete=true`、不换降级文案 | 完成 |

**改动**：新增 `server/assistant/faults.mjs`（`FAULT_KINDS`、`resolveFault`、`applyFault`、50ms 注入超时）与 `faults.test.mjs`（6 条）；`api.mjs` 的 B 类分支加 `applyFault(resolveFault())` 覆盖项；`chat.mjs` 的 `done` 帧补 `degraded`（DECISIONS D9.5）；`chat.test.mjs` 增「半截失败」用例（假上游先吐一段再抛）；`api.test.mjs` 增三条注入路径的端到端用例，并在进程启动前清空 `ASSISTANT_API_KEY`（D9.6）。

**/code-review 结论**

| 维度 | 发现 | 处置 |
|---|---|---|
| 正确性（高） | `meta.degraded` 是**开口前**的判断；上游中途 5xx / 超时时它已经是 `false`，前端会拿着降级文案渲染「未降级」状态 | `done` 帧补 `degraded`，以最终结果为准；端到端用例三条路径都断言 `done.degraded === true` |
| 正确性（中） | 若把故障注入做成「连工具一起短路」，B 类会落进 `facts === null` 的分支（D9.2 已覆盖），「有事实但模型坏了」这条真正的降级链反而没测到 | 注入只覆盖模型这一段的 `config` / `fetchImpl`，工具照常执行；用例断言 `assistant_events.tool_names` 非空，证明前置条件与生产一致 |
| 测试卫生（中） | 本机若配了真实 `ASSISTANT_API_KEY`，「无 Key」用例会真的请求上游，结果取决于网络与额度 | 测试进程启动前 `delete process.env.ASSISTANT_API_KEY`（D9.6），降级前提变成确定的 |
| 安全（中） | 注入开关若在部署环境里残留（`NODE_ENV` 未设），线上会一直走假上游 | 保持 `NODE_ENV === 'production'` 强制忽略并只警告一次；`applyFault` 只塞假 Key，不读真实凭据、不发真实请求。剩余风险记入遗留：部署必须显式设 `NODE_ENV=production`（Dockerfile 已设） |
| 可维护性（低） | 超时注入若用真实的 20s，测试要干等 | 独立常量 `FAULT_TIMEOUT_MS=50`，并在用例里断言它 <1s |
| 性能 | `hangingFetch` 挂起的 Promise 只挂一个 `once` 监听，abort 后立即释放 | 无需改动 |

**闸门**：`lint=0 typecheck=0 test=0`；`node --test` 114 条（新增 6 + 1 + 1）+ `vitest` 55 条全绿。

**遗留**：`status` 帧（首 token 慢）与 `incomplete` 提示仍无前端消费方，留给 Loop 5；`FAULT_KINDS` 未覆盖「网络直接不通」（`network` 分支已由 `llm.test.mjs` 覆盖，端到端不重复造）。

## Loop 5 · T11 前端面板骨架

**目标**：把服务端的四条帧（`meta` / `status` / `delta` / `done`）接到界面上，让用户能问、能停、能点引用；配额、上限、离线这三种「不让问」的状态在点击之前就说清楚（AC-1-1~5、AC-2-4、AC-5-3、AC-7-1）。

| 任务 | 验收点 | 状态 |
|---|---|---|
| T11 `sse.ts` | 自研增量解析：跨块拆包、粘包、CRLF、心跳注释、非法 JSON 不抛 | 完成 |
| T11 `useAssistant` | fetch + `ReadableStream` + `AbortController`；`meta` 定模式、`status` 显示等待、`delta` 追加、`done` 收尾；断流/停止标 `incomplete` | 完成 |
| T11 `AssistantPanel` | 右下角浮层（手机整屏）；`Esc` 关闭；空输入禁用；>500 字拦截并提示；引用 chip 可点跳页 | 完成 |
| T11 离线 | `phase === 'offline'` 时入口禁用并给出原因，不发请求 | 完成 |
| T11 `WeekStrip` | 七列条带 + 点选某天自动带日期 | Loop 6 补完 |

**改动**：新增 `src/assistant/sse.ts`（帧解析，纯函数）、`useAssistant.ts`（流式状态机）、`AssistantPanel.tsx`（含导出的 `CitationChip`）、`sse.test.ts`（8 条）；`App.tsx` 在登录后挂载面板（`phase` 是 `ready` / `offline` 时）；`app.css` 追加 `assistant-*` 一节（含 720px 以下整屏规则）；`api.mjs` 的 A 类 `degraded` 改用 `isLlmConfigured()`，与 B 类同一套判定。

**/code-review 结论**

| 维度 | 发现 | 处置 |
|---|---|---|
| 正确性（高） | A 类的 `degraded` 只表示「没接模型」，与 B 类「取不到数据」不是一件事；面板若不加区分地显示「暂时取不到你的数据」，知识类回答会被误标成降级 | 标记只在 `mode === 'data'` 时出现，文案改为「这条回答没有用到你的实时数据」，与兜底句不重复 |
| 正确性（中） | `status` 帧是全局状态，多条待答消息会共享同一句等待提示 | 用 `busyRef` 串行化，同一时刻只有一条 pending；`done` 到达即清空 `status` |
| 正确性（中） | 没收到 `done` 就断流时，气泡会一直转圈（`pending` 停在 true） | `finally` 兜底把残留 pending 收成 `incomplete` 并补一句「（没有收到回答）」，保证不出现空气泡 |
| 正确性（中） | 停止/卸载时 `AbortController` 只能中止请求，已收到的正文若被清空，用户会以为答案丢了 | 保留已收到的正文，只追加「不完整」提示；卸载时 abort 但不 setState |
| 安全 | 引用 chip 是 `href={'#' + route}`，即便上游返回 `javascript:` 也只会变成页内锚点；正文一律走文本节点，无 `dangerouslySetInnerHTML` | 无需改动 |
| 可维护性（低） | 500 字上限在前后端各写一份，存在漂移风险 | 前端常量注释里标明「与服务端同一条上限」，`sse.test.ts` 之外的边界用例由 `api.test.mjs` 的 `E1002` 守住 |
| 可访问性（低） | 未做焦点陷阱；手机整屏时等同模态 | 记入遗留，与 `WeekStrip` 一起在 T12 处理（需要先定「关闭后焦点回到哪」） |
| 性能 | 每帧一次 `setMessages` 全量 map，500 字最多 28 帧，实测无卡顿 | 无需改动；若将来单条到数千字再考虑 buffer |

**闸门**：`lint=0 typecheck=0 test=0`；`node --test` 114 条 + `vitest` 63 条（新增 8）全绿；`npm run build` 通过（`dist/app.js` 316.95 kB / gzip 97.97 kB）。

**遗留**：① ~~`WeekStrip` 七列条带与「点选某天带日期」未做~~ → Loop 6 已补；② 几何类判据（与「完成打卡」按钮相交面积 = 0、关闭后 `scrollY` 一致、390×844 整屏）只写了 CSS 规则，未实测（项目自带 `scripts/e2e.mjs` 的 CDP 驱动可测，留给 T14）；③ 焦点陷阱与「关闭后焦点归位」随 T14 一并做（需要先定「关闭后焦点回到哪」）；④ 面板历史会话列表仍按 D8.1 不做。

## Loop 6 · T11 补完 + T12 交互闭环

**目标**：把面板从「能问能停」补成 R1 要求的完整交互——条带选日、空态建议、赞/踩、复制、清空（AC-1-5、AC-8-1、AC-9-1、AC-11-1）。

| 任务 | 验收点 | 状态 |
|---|---|---|
| T11 `WeekStrip` | 真实 7 列（`grid` 七等分），列内显示星期、日号、当天「已完成/总数」；点一列选中、再点取消 | 完成 |
| T11 日期上下文 | 选中后输入区上方出现「已选 X 月 X 日（周 X），提问按这天算」，请求体带 `date`，服务端 `today` 换成该日 | 完成 |
| T12 建议问题 | 空态 4 条、2 功能类 + 2 数据类；`hasData` 为假时换成引导问法（不问「还剩多少」）；点击即发一次 | 完成 |
| T12 反馈 | 每条回答「有用 / 没用」；没用再展开三种原因；再点同一按钮取消；落库 `chat_messages.feedback` | 完成 |
| T12 复制 | 一键复制正文，按钮短暂变「已复制」；`clipboard` 不可用时退回 `execCommand` | 完成 |
| T12 清空 | 头部「清空」，`window.confirm` 二次确认，清完回到空态并取消选中日期 | 完成 |
| T12 模式标识 | 每条回答顶部标签「功能答疑 / 你的数据」，数据类高亮 | 完成 |

**改动**：`sessions.mjs` 加 `setMessageFeedback`（`UPDATE ... WHERE id = ? AND user_id = ?`）；`chat.mjs` 的 `completeStream` 在发 `done` 前预生成 `messageId`，帧里带回、落库复用；`api.mjs` 新增 `PATCH /api/assistant/messages/:id/feedback`（`up` / `down` / `null`，`down` 可带 `wrong|unclear|not_wanted`），`/chat` 接受可选 `date`（`isISODate` 校验，非法静默忽略）并写进 `facts.focusDate`；`useAssistant` 加 `send(question, { date })`、`messageId`、`submitFeedback`（乐观更新 + 失败回滚）；`AssistantPanel` 重写为条带 + 建议问题 + 标签 + 动作行 + 日期 chip；新增 `suggestions.ts` / `suggestions.test.ts`；`App.tsx` 算七列 `assistantDays` 并传 `hasData`；`app.css` 追加条带、标签、动作行、建议问题样式。

**/code-review 结论**

| 维度 | 发现 | 处置 |
|---|---|---|
| 正确性（高） | 选「原因」时 `value` 仍是 `down`，若沿用「同值即取消」的判定，点原因会把手里的「没用」取消掉 | `cancelling = 同一按钮 && 没有新原因`；点原因走「补原因」，不再触发取消 |
| 正确性（高） | `done` 帧原本没有消息 id，前端拿不到可以反馈的对象；而 `done` 必须在落库之前发（R6：没发出去就不算成功） | 预生成 `messageId`：`done` 里带回、落库复用同一 id，发送顺序不变；用例从会话详情反查，验证的是真落库 |
| 安全（中） | 用 `messageId` 直接反馈，必须防越权；用 403 会泄露「这条消息存在」 | SQL 的 `WHERE` 带 `user_id`，不存在与别人的消息统一 404；用例覆盖越权后属主数据未被改动 |
| 安全（中） | 反馈原因若放开成任意字符串，会出现脏数据与前端还原不了的值 | 服务端白名单三个值，非法 400 `E1016`；前端按钮只可能是这三个 |
| 正确性（中） | 条带选中日期若只存在前端，回答仍是「今天」的数据，判据就落空 | 日期进请求体，服务端把 `today` 换成该日（`get_today` 取那天），并写进 `facts.focusDate`；非法日期当没传，不把 UI 小错变成 400 |
| 正确性（低） | 选中的日期会一直粘着，连续追问容易忘了还在按那天算 | 输入区常驻 chip 明示「提问按这天算」+ 一键取消；不自动清空，避免用户以为选了却没用上 |
| 可维护性（低） | 反馈原因在前后端各写一份 | 服务端白名单有单测、前端数组有条数断言，漂移会在「非法原因 400」用例上暴露；不为此建跨端共享模块 |
| 正确性（低） | 用 `message.feedbackSending` 拦连点不可靠：快速双击时两次回调拿到同一份渲染快照，会发出两个请求 | 改用 `feedbackInFlight`（`Set` ref）拦截，`finally` 里清；`disabled` 只负责视觉 |
| 可访问性（低） | 赞/踩是开关语义 | `aria-pressed` + 请求在途 `disabled`；面板仍非模态，不锁页面滚动 |
| 性能 | 七列条带每次渲染对周块做 7 次 `filter`，量级是 7×N（N 为一周块数，通常 < 30） | 无需 memo |

**闸门**：`lint=0 typecheck=0 test=0`；`node --test` 117 条（新增 3：会话层反馈、接口层反馈、date 传参）+ `vitest` 6 文件（新增 `suggestions.test.ts` 5 条）全绿；`npm run build` 通过（`app` 321.98 kB / gzip 99.52 kB）。

**遗留**：① `assistant_events` 没记 `focusDate`，事后复盘看不出用户问的是哪天（加字段要迁移，暂不做）；② 条带、建议问题、赞/踩、复制、清空的浏览器级断言仍未做，随 T14 的 `e2e.mjs` 补；③ `window.confirm` 在 e2e 里需要对话框处理（脚本已有 `Page.javascriptDialogOpening` 分支，T14 时复用）；④ 移动端整屏与几何判据仍未实测。
