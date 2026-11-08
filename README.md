# 智学节律 · Web MVP（路线 B）

真实账号 + 真实数据 + 真实计算的学习计划产品。目标 → 计划项 → 周排程 → 今日执行 → 周报复盘，全链路无写死数字。

**当前版本：v1.1.0** · 迭代记录见 [CHANGELOG.md](./CHANGELOG.md) · 产品文档见 `../../01_选题与方案/智学节律 产品需求文档.docx`（V2.0，第十八章为实现与迭代记录）

## 版本历史

| 版本 | 主题 | 关键能力 |
|---|---|---|
| v0.1.0 | 前端 MVP 与领域引擎 | 四视图 + 可行性/装箱/偏差/归因引擎，本地持久化 |
| v0.2.0 | 账号与服务端存储 | 注册登录、SQLite、按用户隔离、打卡状态机 |
| v0.3.0 | 排程与周报下沉服务端 | 引擎前后端同源、设置页、重叠校验 |
| v0.4.0 | 工时账本与数据权利 | 剩余工时扣减、跨周去重、导出、注销 |
| v0.5.0 | 排程细化与任务调整 | 跨天拆分、任务块移动/删除、改密 |
| v0.6.0 | 账号自救与首次上线 | 恢复码找回、API 契约、操作手册 |
| v0.7.0 | 离线可用与运维备份 | 本地操作队列（幂等补传）、备份脚本 |
| v1.0.0 | 线上发布与验收 | 全链路线上验收、发布流程固化 |
| v1.0.1 | 主页入口修复 | 主页回到根路径、预览块死按钮、周日空计划提示 |
| v1.0.2 | 交互缺陷修复 | 顶栏「设置目标」、生成/重排反馈、跨周预览、当日合计 |
| v1.1.0 | 拆解与重排引擎 | 知识域树模板、三段式拆解与智能裁断、四级重排方案与三条硬约束 |
| v1.1.0 | 界面改版与双主题 | 左侧导航 + 8/4 栅格、深空/冷光双主题、环形仪表、页面级动效、落地页同步 |

## 页面结构

| 路径 | 页面 | 说明 |
|---|---|---|
| `/` | 产品主页 | 营销主页（Hero 动效、功能、理念、留言反馈），访客第一眼看到的页面 |
| `/app.html` | 学习空间 | React 应用（登录后使用），主页「进入」跳转到这里 |

> 根路径必须是产品主页——这是发布后最容易出问题的地方，路由改名前先确认这一点。

## 线上地址

https://study-rhythm-58065.app.workbuddy.host/?sharecode=D3MS37FLYJ

> 该应用与早期静态 demo 共用同一个平台应用记录，发布新版本会覆盖原 demo 页面（demo 源码仍保留在 `../web-demo`）。

## 部署到线上

已发布为 Node HTTP 服务，平台启动命令必须走 npm 脚本（`vite` 不在 PATH 中，直接写 `vite build` 会启动失败）：

```
语言：node
启动命令：npm start        # = build:engine → tsc --noEmit → vite build → node server/index.mjs
```

发布前注意：本地 `data/` 目录不要一起上传，否则会把本地测试账号带到线上（发布前先移走）。

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
| 前端 | React 19 + TypeScript（strict）+ Vite 6 | 组件化，纯 CSS 令牌（深/浅两套），无 UI 框架 |
| 后端 | Node 22 `node:http` + `node:sqlite` | 零依赖、单文件数据库，一条命令跑起来 |
| 鉴权 | scrypt 口令哈希 + HttpOnly 会话 Cookie（30 天） | 会话存库；登出/改密/重置密码都会失效；注册下发一次性恢复码用于找回 |
| 测试 | Vitest（引擎）+ `node:test`（API）+ CDP E2E | 64 条自动化用例 + 21 步浏览器验收 |
| 离线 | 本地操作队列（localStorage）+ `opId` 幂等补传 | 断网可打卡，恢复后按序上行，无效操作自动丢弃 |
| 同构 | esbuild 把 `src/domain/engine.ts` 打成 `server/engine.generated.mjs` | 排程与周报前后端共用**同一份源码**，不存在两套算法 |

> 说明：架构文档原定 Go + Postgres。当前环境无 Go/Postgres，为满足"一条命令可运行"，后端先用 Node + SQLite 实现，**接口契约与领域规则保持不变**，后续平移 Go 时前端无需改动。

```
server/
├── index.mjs      HTTP 入口：路由分发、静态资源、统一错误
├── api.mjs        业务接口 + 校验 + 状态机
├── auth.mjs       scrypt 哈希、会话、Cookie、登录限流
├── db.mjs         SQLite 打开与建表（幂等迁移）
├── engine.generated.mjs  由 src/domain/engine.ts 打包而来（构建产物，勿手改）
└── api.test.mjs   19 条接口测试（越权/幂等/非法迁移/导出/注销/恢复码）
src/
├── domain/        纯函数引擎（可行性 / 装箱 / 偏差 / 归因 / 拆解 / 重排）+ 40 条单测
│   ├── templates.ts   知识域树模板（3 类目标）
│   ├── decompose.ts   三段式拆解：模板骨架 → 参数填充 → 智能裁断
│   └── replan.ts      重排：触发检测 + 四级方案 + 三条硬约束
├── data/api.ts    唯一 HTTP 客户端
├── data/offlineQueue.ts  离线操作队列（断网暂存 + opId 幂等补传）
├── store.ts       会话 + 服务端状态（前端唯一数据出口，含乐观更新）
├── pages/         Auth / Today / Goal / Week / Report / Settings
└── components.tsx Card / Stat / Button / Field / Empty / Meter
scripts/e2e.mjs    真实 Chrome 走完整链路并截图
scripts/backup.mjs 数据库冷备（checkpoint + 保留最近 14 份）
public/three-effects.js  主页 3D 吊牌（three.js 动态加载）
index.html        产品主页（营销页，多页构建入口之一）
app.html          学习空间（React 应用）
docs/openapi.yaml  API 契约
docs/操作手册.md    启动、备份、回滚、排障
docs/拆解与重排接入说明.md  给前端/UI 的接口与呈现约定
CHANGELOG.md       版本变更记录（v0.1.0 → v1.0.0）
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
| GET | `/api/decompose/templates` | 拆解模板清单（考研 / 考公 / 项目导学） |
| POST | `/api/goal/decompose` | 拆解目标为计划项草案；`apply=true` 才写库（需 `replace=true` 确认覆盖） |
| GET | `/api/plan/replan?week=` | 重排方案预览（顺延/压缩/替代/放弃），不写库 |
| POST | `/api/plan/replan/apply` | 应用选定方案，重写本周未完成块并记录重排次数 |
| DELETE | `/api/account` | 注销账号：校验密码、级联删除数据、会话失效 |

错误统一返回 `{ error: { code, message } }`，业务码 `E1xxx` 参数、`E2xxx` 认证、`E4xxx` 冲突、`E5xxx` 服务端。

## 已验证

| 检查 | 结果 |
|---|---|
| `npm test` | 64 条通过（引擎 40 + 接口 24） |
| `npx tsc --noEmit` | 0 错误 |
| `npm run build` | 成功（JS 259KB / gzip 81.6KB，CSS 10.4KB / gzip 2.9KB） |
| `node scripts/e2e.mjs` | 17 步全通过：未登录深链拦截 → 注册 → 载入示例 → 生成周计划 → 同周移动任务 → 打卡 → 服务端周报 → **断网打卡 → 恢复补传** → 刷新保持 → 改设置 → 修改密码 → 按新容量补排 → 登出 → 忘记密码入口 → 控制台零报错 |

安全边界：所有查询按 `user_id` 过滤；越权改他人任务块返回 404；计划项不能跨用户塞入；口令与 Cookie 不落日志；请求体上限 1MB；密码错 10 次/分钟限流。

## 已知限制（下一轮处理）

1. 忘记密码依赖注册时下发的恢复码（无邮件通道）；恢复码丢失则无法自助找回。
2. 多端并发仍以服务端为准（后写覆盖），未做字段级冲突合并；离线队列只保证单设备按序补传。
3. 「补排新任务」只处理本周还没有块的任务；调整时间请用任务块上的「调整」。
4. 弹性位只在剩余量能整块放下时使用，极端情况下会留出未利用的弹性时间（保证不把任务切碎）。
5. 后端为 Node + SQLite（环境无 Go/Postgres），契约已固化以便后续平移。
