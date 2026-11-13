# 文档地图

代码库里的文档都在 `docs/` 下。根目录只留三份入口文件，其余按主题分目录。

## 入口（根目录）

| 文件 | 讲什么 | 什么时候看 |
|---|---|---|
| [`../README.md`](../README.md) | 产品是什么、怎么跑、怎么部署、接口一览 | 第一次接触本项目 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 逐版本变更（v1.0.0 → v1.5.0），含每轮偏差说明 | 想知道某个功能是哪一版加的 |
| [`../CODEBUDDY.md`](../CODEBUDDY.md) | 目录约定、前后端代码规范、明确不做的边界 | 动代码之前 |

## 运维与对接

| 文件 | 讲什么 |
|---|---|
| [`操作手册.md`](操作手册.md) | 运行、环境变量、备份恢复、发布回滚、健康检查、验收命令、安全说明 |
| [`拆解与重排接入说明.md`](拆解与重排接入说明.md) | 拆解（PRD 8.2）与重排（PRD 8.4）的接口形状、两个状态位、联调自查 |
| [`openapi.yaml`](openapi.yaml) | 全部端点的请求、响应、错误码 |

## 助手子系统（assistant/）

一期「Agent 助手对话」的完整文档链，按依赖顺序读：

| 顺序 | 文件 | 讲什么 |
|---|---|---|
| 1 | [`assistant/SPEC.md`](assistant/SPEC.md) | 问题、目标与非目标、用户故事、需求 R1–R14、接口契约、提示词与事实边界、UI 规范 |
| 2 | [`assistant/DECISIONS.md`](assistant/DECISIONS.md) | D1–D11 裁决记录：面板形态、条带选日、提示词版本化、验收编号方案 |
| 3 | [`assistant/ARCHITECTURE.md`](assistant/ARCHITECTURE.md) | 需求 → 高层设计 → 深入 → 规模与可靠性 → 取舍 → 风险 |
| 4 | [`assistant/ARCHITECTURE.review.md`](assistant/ARCHITECTURE.review.md) | 架构评审记录：已修 8 处、留待决策 3 处、核验无需动作 2 处 |
| 5 | [`assistant/PLAN.md`](assistant/PLAN.md) | 15 个任务 T0–T14，含完成判据、AC 编号、依赖与人日对账 |
| 6 | [`assistant/LOOPS.md`](assistant/LOOPS.md) | 迭代记录 Loop 1–6，逐轮交付内容与与计划的两处偏差 |

线框原型在 [`../mockups/assistant-v3-week-strip.html`](../mockups/assistant-v3-week-strip.html)，是 `DECISIONS.md` D4 选定方向的实物依据。

## 产品与规划（product/）

| 文件 | 讲什么 |
|---|---|
| `product/智学节律 产品需求文档.docx` | PRD V2.0，17 章功能定义 + 第十八章「实现与迭代记录」 |
| `product/智学节律 技术架构设计.docx` | 技术选型、模块划分、数据模型 |
| [`product/从Demo到正式开发 实施规划 v1.0.md`](product/从Demo到正式开发%20实施规划%20v1.0.md) | 三条路线对比、模块优先级、六阶段推进与验收标准 |

> 工作区 `01_选题与方案/` 下也有这三份的同名副本，内容与本目录一份一致、一份仅有 23 字节差异，以本目录为准。

## 截图（screenshots/）

README 里用的六张产品图，由 `npm run shots` 用真实数据生成，不要手改。
