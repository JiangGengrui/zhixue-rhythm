# 智学节律 · Web MVP（路线 B）

真实业务逻辑驱动的学习计划应用。**目标 → 计划项 → 周排程 → 今日执行 → 周报复盘** 一条链路全部由代码计算，不再有写死的 68% / +18%。

## 快速开始

```bash
npm install
npm run dev        # 开发：http://localhost:5173
npm run test       # 引擎单测
npm run build      # 类型检查 + 生产构建（输出 dist/）
npm run preview    # 预览构建结果
```

打开 `http://localhost:5173/?demo=1` 可自动载入示例数据。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | Vite 6 | 静态产物，可部署到任意静态托管 |
| 框架 | React 19 + TypeScript（strict） | 组件化，类型安全 |
| 样式 | 原生 CSS + 设计 token | 沿用 demo 的纸感配色，无 UI 框架 |
| 测试 | Vitest | 引擎纯函数单测 |

## 目录结构

```
src/
├── domain/            纯函数领域层（不依赖 React / 浏览器）
│   ├── types.ts       实体与枚举
│   ├── date.ts        日期工具（本地时区，禁止 toISOString）
│   ├── engine.ts      可行性 / 装箱 / 偏差 / 归因
│   └── engine.test.ts 17 条单测（含边界）
├── store.ts           状态 + 本地持久化（localStorage，接口可替换为后端）
├── components.tsx     Card / Stat / Button / Field / Empty / Meter
├── pages/             Today / Goal / Week / Report
├── styles/app.css     token + 布局
├── App.tsx            路由（hash）、错误边界、演示入口
└── main.tsx           挂载
```

## 引擎约定（可被离线重放）

- **纯函数**：输入结构体快照，输出结果，不读时钟、不读 localStorage、无随机数
- **确定性**：同输入必同输出（排序含 id 兜底，避免并列时顺序漂移）
- **可单测**：`npm test` 覆盖空数据、容量为 0、跨日、超额、弹性位、除零

| 函数 | 输入 | 输出 |
|---|---|---|
| `feasibility` | 目标、计划项、今天 | 需求工时、可用工时（×0.85）、`R = 需求/可用`、可行档位 |
| `packWeek` | 计划项、可用时段、周起始日 | Block 列表、溢出项、容量/弹性位占用、建议 |
| `deviationStats` | Block 列表 | 偏差中位数、P90、样本数 |
| `buildReport` | 本周 Block、可用时段、周起始日 | 达成率、有效时长、归因占比（合计 100%）、一条建议 |

## 数据存储

MVP 阶段数据存本机 `localStorage`（key: `zhixue.app.v2`），写入失败与数据损坏都会降级为可控状态（不白屏）。
`store.ts` 是唯一持久化出口，接入后端时只需替换该文件实现，页面与引擎不用改。

## 已验证

- `npm run test`：17 条用例通过
- `npx tsc --noEmit`：0 错误
- `npm run build`：构建成功（JS 254 KB / gzip 80 KB，CSS 8.9 KB / gzip 2.7 KB）
- 桌面 1280px 与手机 390px 实测：无横向溢出、统计卡自动换行

## 下一步（按规划文档 M1 起）

1. 账号与数据隔离（登录、`user_id`、RLS）
2. Go API + Postgres 替换 localStorage（`store.ts` 实现替换即可）
3. 打卡操作幂等（`op_id`）与离线队列
4. 周报归因加入"中断时段"证据句
5. E2E 覆盖主链路 + CI 卡口
