# 智学节律 · Web MVP（路线 B）

真实账号 + 真实数据 + 真实计算的学习计划产品。目标 → 计划项 → 周排程 → 今日执行 → 周报复盘，全链路无写死数字。

## 快速开始

```bash
npm install
npm start          # 构建 + 启动 API 与页面：http://localhost:8787
```

开发模式（前端热更新 + 后端分离）：

```bash
npm run server     # 终端 1：API + SQLite，:8787
npm run dev        # 终端 2：Vite :5173，/api 代理到 8787
```

首次打开是登录页，注册一个账号即可使用（密码 ≥ 8 位，数据按账号隔离）。

## 技术栈与结构

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | React 19 + TypeScript（strict）+ Vite 6 | 组件化，纯 CSS token，无 UI 框架 |
| 后端 | Node 22 `node:http` + `node:sqlite` | 零依赖、单文件数据库，一条命令跑起来 |
| 鉴权 | scrypt 口令哈希 + HttpOnly 会话 Cookie（30 天） | 会话存库；登出/改密/重置密码都会失效；注册下发一次性恢复码用于找回 |
| 测试 | Vitest（引擎）+ `node:test`（API）+ CDP E2E | 39 条自动化用例 + 15 步浏览器验收 |
| 同构 | esbuild 把 `src/domain/engine.ts` 打成 `server/engine.generated.mjs` | 排程与周报前后端共用**同一份源码**，不存在两套算法 |

> 说明：架构文档原定 Go + Postgres。当前环境无 Go/Postgres，为满足"一条命令可运行"，后端先用 Node + SQLite 实现，**接口契约与领域规则保持不变**，后续平移 Go 时前端无需改动。

```
server/
├── index.mjs      HTTP 入口：路由分发、静态资源、统一错误
├── api.mjs        业务接口 + 校验 + 状态机
├── auth.mjs       scrypt 哈希、会话、Cookie、登录限流
├── db.mjs         SQLite 打开与建表（幂等迁移）
├── engine.generated.mjs  由 src/domain/engine.ts 打包而来（构建产物，勿手改）
└── api.test.mjs   7 条接口测试（越权/幂等/非法迁移）
src/
├── domain/        纯函数引擎（可行性 / 装箱 / 偏差 / 归因）+ 17 条单测
├── data/api.ts    唯一 HTTP 客户端
├── store.ts       会话 + 服务端状态（前端唯一数据出口）
├── pages/         Auth / Today / Goal / Week / Report
└── components.tsx Card / Stat / Button / Field / Empty / Meter
scripts/e2e.mjs    真实 Chrome 走完整链路并截图
docs/openapi.yaml  API 契约
docs/操作手册.md    启动、备份、回滚、排障
```

## 接口约定

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册并建立会话 |
| POST | `/api/auth/login` | 登录（同 IP 每分钟限 10 次） |
| POST | `/api/auth/logout` | 登出，销毁会话 |
| GET | `/api/state` | 当前用户的目标、计划项、任务块、设置 |
| PUT | `/api/goal` | 新建或更新目标（单用户唯一） |
| POST | `/api/items` | 添加计划项 |
| DELETE | `/api/items/:id` | 删除计划项并级联清理其任务块 |
| PUT | `/api/settings` | 每周可用时段、周起始日 |
| POST | `/api/plan/generate` | 服务端生成某周计划：`from` 从今天起排；只补排没有块的任务，已完成记录不被覆盖；跨周已排任务不重复排 |
| GET | `/api/report?week=` | 服务端计算周报（达成率/时长/偏差/归因） |
| PUT | `/api/blocks` | 覆盖某周任务块（校验同日不重叠） |
| PATCH | `/api/blocks/:id` | 打卡状态迁移（带 `opId` 幂等）或**同周移动时间**（改 `date`/`startMin`，时长不变，拒绝重叠与跨周）；完成时按实际投入扣减剩余工时 |
| DELETE | `/api/blocks/:id` | 删除单个任务块，任务回到待排池 |
| POST | `/api/auth/password` | 修改密码：校验旧密码，旧会话全部失效并下发新会话 |
| GET | `/api/export?format=json\|csv` | 导出全部数据（JSON）或任务记录（CSV，带 BOM） |
| DELETE | `/api/account` | 注销账号：校验密码、级联删除数据、会话失效 |

错误统一返回 `{ error: { code, message } }`，业务码 `E1xxx` 参数、`E2xxx` 认证、`E4xxx` 冲突、`E5xxx` 服务端。

## 已验证

| 检查 | 结果 |
|---|---|
| `npm test` | 39 条通过（引擎 20 + 接口 19） |
| `npx tsc --noEmit` | 0 错误 |
| `npm run build` | 成功（JS 259KB / gzip 81.6KB，CSS 10.4KB / gzip 2.9KB） |
| `node scripts/e2e.mjs` | 15 步全通过：未登录深链拦截 → 注册 → 载入示例 → 生成周计划 → 同周移动任务 → 打卡 → 服务端周报 → 刷新保持 → 改设置 → 修改密码 → 按新容量补排 → 登出 → 控制台零报错 |

安全边界：所有查询按 `user_id` 过滤；越权改他人任务块返回 404；计划项不能跨用户塞入；口令与 Cookie 不落日志；请求体上限 1MB；密码错 10 次/分钟限流。

## 已知限制（下一轮处理）

1. 忘记密码依赖注册时下发的恢复码（无邮件通道）；恢复码丢失则无法自助找回。
2. 无离线队列与多端冲突合并（当前以服务端为准，后写覆盖）。
3. 「补排新任务」只处理本周还没有块的任务；调整时间请用任务块上的「调整」。
4. 弹性位只在剩余量能整块放下时使用，极端情况下会留出未利用的弹性时间（保证不把任务切碎）。
5. 后端为 Node + SQLite（环境无 Go/Postgres），契约已固化以便后续平移。
