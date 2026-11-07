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
| 鉴权 | scrypt 口令哈希 + HttpOnly 会话 Cookie（30 天） | 会话存库，登出即失效 |
| 测试 | Vitest（引擎）+ `node:test`（API）+ CDP E2E | 24 条自动化用例 + 10 步浏览器验收 |

> 说明：架构文档原定 Go + Postgres。当前环境无 Go/Postgres，为满足"一条命令可运行"，后端先用 Node + SQLite 实现，**接口契约与领域规则保持不变**，后续平移 Go 时前端无需改动。

```
server/
├── index.mjs      HTTP 入口：路由分发、静态资源、统一错误
├── api.mjs        业务接口 + 校验 + 状态机
├── auth.mjs       scrypt 哈希、会话、Cookie、登录限流
├── db.mjs         SQLite 打开与建表（幂等迁移）
└── api.test.mjs   7 条接口测试（越权/幂等/非法迁移）
src/
├── domain/        纯函数引擎（可行性 / 装箱 / 偏差 / 归因）+ 17 条单测
├── data/api.ts    唯一 HTTP 客户端
├── store.ts       会话 + 服务端状态（前端唯一数据出口）
├── pages/         Auth / Today / Goal / Week / Report
└── components.tsx Card / Stat / Button / Field / Empty / Meter
scripts/e2e.mjs    真实 Chrome 走完整链路并截图
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
| PUT | `/api/blocks` | 覆盖某周任务块（客户端排程结果） |
| PATCH | `/api/blocks/:id` | 打卡状态迁移，带 `opId` 幂等 |

错误统一返回 `{ error: { code, message } }`，业务码 `E1xxx` 参数、`E2xxx` 认证、`E4xxx` 冲突、`E5xxx` 服务端。

## 已验证

| 检查 | 结果 |
|---|---|
| `npm test` | 24 条通过（引擎 17 + 接口 7） |
| `npx tsc --noEmit` | 0 错误 |
| `npm run build` | 成功（JS 259KB / gzip 81.6KB，CSS 10.4KB / gzip 2.9KB） |
| `node scripts/e2e.mjs` | 10 步全通过：登录页 → 注册 → 载入示例 → 生成周计划 → 打卡 → 周报 → 刷新保持 → 登出 → 控制台零报错 |

安全边界：所有查询按 `user_id` 过滤；越权改他人任务块返回 404；计划项不能跨用户塞入；口令与 Cookie 不落日志；请求体上限 1MB；密码错 10 次/分钟限流。

## 已知限制（下一轮处理）

1. 周中生成计划从周一排起，可能把任务排到已过去的日期——需支持"从今天起排"。
2. 周报在前端计算（数据源是服务端任务块），后续下沉到服务端以便跨端一致。
3. 无设置界面（每周可用时段、周起始日接口已就绪，UI 未接）。
4. 无找回密码 / 邮箱验证；注册未做邮箱唯一性以外的校验。
5. 无离线队列与多端冲突合并（当前以服务端为准）。
