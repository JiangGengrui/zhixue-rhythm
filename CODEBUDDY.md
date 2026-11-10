# CODEBUDDY.md

本文件是「智学节律」的代码规范与协作约定。四段：项目结构 / 命令 / 代码规范 / 边界。
`ARCHITECTURE.md` 讲「为什么这么设计」，本文件只讲「改代码时按什么规矩来」。

## 1. 项目结构

单进程 Node 服务 + 一个 React 前端，二者同域部署（`server/index.mjs` 同时托管 `/api` 与 `dist/`）。

```
zhixue-app/
├─ src/                     前端（React 19 + Vite，hash 路由）
│  ├─ domain/               纯业务逻辑：拆解、排程、重排、预警、周报
│  │  └─ *.test.ts          vitest 单测，与实现同目录同名
│  ├─ data/api.ts           API 封装：统一 ApiError(code, status)、同源 Cookie
│  ├─ data/offlineQueue.ts  离线队列与重放
│  ├─ pages/                AuthPage / TodayPage / WeekPage / GoalPage / ReportPage / SettingsPage
│  ├─ landing/              产品主页（纯静态 + 一个 canvas 动效脚本）
│  ├─ components.tsx        共享组件（无 UI 组件库，手写）
│  ├─ App.tsx, store.ts, main.tsx
│  └─ styles/app.css        全站样式（CSS 变量 + 类名，无预处理器）
├─ server/                  后端（原生 node:http + node:sqlite，无框架）
│  ├─ index.mjs             入口：路由分发、静态托管、统一错误出口
│  ├─ api.mjs               全部 /api 路由与入参校验（本项目最大的文件）
│  ├─ db.mjs                建表 + 增量迁移 + 时间工具
│  ├─ auth.mjs              会话 Cookie、密码哈希
│  ├─ engine.generated.mjs  build:engine 产物，勿手改（见下）
│  ├─ api.test.mjs          node --test 集成测试（临时库跑真实 HTTP）
│  ├─ assistant/            助手子系统：retrieval / knowledge / prompt / tools / llm
│  └─ *.test.mjs
├─ scripts/                 运维与验证脚本：backup / e2e / shot / demo-shots
├─ docs/                    openapi.yaml、产品文档、截图
├─ data/                    运行期 SQLite 文件（不进版本库）
├─ dist/                    vite 构建产物（不进版本库）
├─ index.html / privacy.html              两个入口：应用（今日页）/ 隐私说明（多页构建，见 vite.config.ts；落地页与登录页已移除）
├─ SPEC.md / PLAN.md / ARCHITECTURE.md / DECISIONS.md / ACCEPTANCE.md
└─ CHANGELOG.md
```

**前后端共享代码只有一条路径**：`src/domain/*` 是纯函数，`npm run build:engine` 用 esbuild 打成 `server/engine.generated.mjs`，后端 `import` 该产物。所以：

- 改 `src/domain/` 后必须跑 `npm run build:engine`（`test` / `server` / `start` 脚本已自带）。
- **不要手改 `server/engine.generated.mjs`**，它是生成物，已被 `.gitignore`/lint 忽略。
- `src/domain/` 里不许 `import` React、不许读写 `localStorage`、不许 `Date.now()` 之外的副作用——它要在 Node 里跑。

## 2. 命令

| 目的 | 命令 |
|---|---|
| 开发（前端热更新，代理到 8787） | `npm run dev` |
| 起完整服务（构建 engine + 类型检查 + 构建 + 起服） | `npm start` |
| 只起后端（读 `data/zhixue.db`） | `npm run server` |
| 类型检查 | `npm run typecheck` |
| Lint | `npm run lint`（自动修：`npm run lint:fix`） |
| 全量测试 | `npm test` |
| 只跑前端单测 / 只跑后端集成 / 只跑端到端 | `npm run test:unit` / `npm run test:api` / `npm run test:e2e` |
| 产物构建 | `npm run build` |
| 备份数据库 | `npm run backup` |

**过 Gm 的三条命令（退出码必须全为 0）**：

```
npm run lint
npm run typecheck
npm test
```

三条命令必须与本表完全一致：改了脚本就同步改这里和 `checklists/GATES.md`，不允许「文档写一套、本地跑另一套」。

## 3. 代码规范

### 通用

- ESM only（`package.json` 的 `"type": "module"`）；后端 `.mjs`，前端 `.ts/.tsx`，脚本 `.mjs`。
- 2 空格缩进、单引号、语句结尾带分号、行宽约 120。与既有代码保持一致比「更漂亮」重要。
- 注释与用户可见文案一律**中文**；注释只写「为什么」，不复述代码在做什么。
- 不引入新依赖解决已有依赖能解决的事。当前依赖只有 `react`、`react-dom` 与构建/测试工具链。

### 前端

- `tsconfig` 已开 `strict`、`noUnusedLocals`、`noUnusedParameters`、`noUncheckedIndexedAccess`：
  索引访问一律按 `T | undefined` 处理，不要用 `!` 绕过。
- 所有网络请求走 `src/data/api.ts`，抛 `ApiError`（带 `code` 与 `status`）；页面不直接调 `fetch`。
- 业务计算只写在 `src/domain/`，页面只做「取值 + 渲染 + 派发」。
- 组件不引第三方 UI 库，样式统一写 `src/styles/app.css`，沿用现有 CSS 变量与命名。
- dev 下 `/api` 由 vite 代理到 `127.0.0.1:8787`（`vite.config.ts`），所以前端一律用相对路径 `/api/...`，不要写死域名。
- 面板/弹层类 UI：关闭后必须还原滚动位置；不得让浮层遮挡主操作按钮（见 `PLAN.md` T11 判据）。

### 后端

- 路由集中在 `server/api.mjs`，签名 `route(method, pathname, { body, res, user, query, ip })`；
  返回对象即 200 JSON；返回 `undefined` → 404 `E4004`；需要自己写响应时返回 `{ __sent: true }`（SSE 用）。
- 错误一律 `throw new HttpError(status, code, 中文文案)`，由 `server/index.mjs` 统一成
  `{ error: { code, message } }`。码段约定：`E1xxx` 入参/协议、`E4xxx` 资源与鉴权、`E5xxx` 服务端异常。
  用户可见文案里**不许**出现堆栈、`fetch`、`timeout`、`5xx` 原样数字。
- 数据库：`node:sqlite` 的 `DatabaseSync`，语句 `prepare` 后复用。建表与迁移都写在 `server/db.mjs` 的
  `migrate()` 里；加列用 `PRAGMA table_info(x)` 判断后再 `ALTER TABLE`，保持老库能平滑升级（现有库不允许重建）。
- 时间：入库用 `nowISO()`（UTC），涉及「今天/本周」的判定用 `nowLocalISO()` 或 `todayISO()`，别混。
- 表名/字段名走 snake_case；对外 JSON 走 camelCase，转换在 `api.mjs` 里显式写，不做隐式映射。
- 用户数据一律按 `user_id` 隔离；SQL 必须参数化，禁止字符串拼 SQL。
- 长耗时/流式端点（助手的 SSE）要设 `X-Accel-Buffering: no` 并逐块 `res.write`，结束必须 `res.end()`。

### 测试

- 纯逻辑：`src/domain/*.test.ts`（vitest）。
- 接口：`server/api.test.mjs`（`node --test`，`startServer({ dbFile: ':memory:' | 临时目录 })` 起真实 HTTP，
  用 `fetch` + 手工 Cookie），一个用例一个临时库，不共享状态。
- 每条断言尽量对「可观察结果」：HTTP 状态、`error.code`、库内行、DOM 文本；不测私有函数。
- 修 bug 先补一条会失败的用例，再改实现。

## 4. 边界（明确不做）

| 不做 | 依据 |
|---|---|
| 引入 Express/Koa/Prisma 等框架或 ORM | 现有 `node:http` + `node:sqlite` 足够，换栈带不出收益 |
| 引入 UI 组件库 / CSS-in-JS | 现有手写组件与 `styles.css` 已成型 |
| 改动登录 Cookie 的 `Secure` 属性 | `DECISIONS.md` D8.3，单独立项 |
| 助手面板做历史会话列表 UI | D8.1（端点保留，界面不接） |
| 向量检索 / 执行型 Agent（自动改计划） | SPEC R12、R14，本期不做 |
| 手改 `server/engine.generated.mjs`、`dist/` | 生成物 |
| 在 `src/domain/` 里写副作用或依赖浏览器 API | 它要在 Node 里被调用 |
| 为「顺便优化」重构无关文件 | 一次改动只服务一个任务，见 `PLAN.md` §5 |

改动涉及上表任一条时，先在 `DECISIONS.md` 记一条 ADR 并取得确认，再动代码。
