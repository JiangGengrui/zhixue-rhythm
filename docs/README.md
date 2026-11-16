# 文档地图

`docs/` 按主题分目录，仓库根目录只留三份入口文件（`README.md` / `CHANGELOG.md` / `CODEBUDDY.md`），其余文档全部在此。

## 一、按需求找文档

| 我想…… | 去这里 |
|---|---|
| 了解产品是什么、为什么这么设计 | [`../README.md`](../README.md) · [`product/`](product/) |
| 知道某个功能是哪一版加的 | [`../CHANGELOG.md`](../CHANGELOG.md) |
| 动代码前看规范与边界 | [`../CODEBUDDY.md`](../CODEBUDDY.md) |
| 联调接口 | [`api/openapi.yaml`](api/openapi.yaml) |
| 部署、备份、回滚、排障 | [`ops/操作手册.md`](ops/操作手册.md) |
| 改拆解 / 重排的交互 | [`design/拆解与重排接入说明.md`](design/拆解与重排接入说明.md) |
| 改助手子系统 | [`assistant/`](assistant/) |
| 30 秒看懂模块关系 | [`architecture/ARCHITECTURE.diagram.html`](architecture/ARCHITECTURE.diagram.html) |
| 写汇报材料要配图 | [`screenshots/`](screenshots/) |
| 准备第二阶段 | [`phase2/`](phase2/) |

## 二、目录说明

| 目录 | 内容 | 维护方式 |
|---|---|---|
| `product/` | PRD V2.0（`.docx`）、技术架构设计（`.docx`）、实施规划（`.md`） | 手动；PRD 第十八章记实现与迭代 |
| `api/` | `openapi.yaml`：全部端点、请求/响应、错误码 | 改接口必同步 |
| `ops/` | `操作手册.md`：运行、环境变量、备份恢复、发布回滚、冒烟、排障、验收命令 | 发布流程变了就改 |
| `design/` | `拆解与重排接入说明.md`（接口形状、两个状态位、联调自查）、`mockups/`（线框原型 HTML + 截图） | 改交互时同步 |
| `assistant/` | 助手子系统六篇文档链 | 改动前先读 SPEC 与 DECISIONS |
| `architecture/` | `ARCHITECTURE.diagram.html`：手绘 SVG 架构图（archify CLI 出图失败后的替代物） | 模块关系变了再改 |
| `screenshots/` | README 用的六张产品图 | `npm run shots` 生成，**不要手改** |
| `phase2/` | 第二阶段规划：范围、里程碑、风险、开工前检查清单 | 每阶段开始时更新 |

## 三、助手子系统（assistant/）

一期「Agent 助手对话」的完整文档链，按依赖顺序读：

| 顺序 | 文件 | 讲什么 |
|---|---|---|
| 1 | [`assistant/SPEC.md`](assistant/SPEC.md) | 问题、目标与非目标、用户故事、需求 R1–R14、接口契约、提示词与事实边界、UI 规范 |
| 2 | [`assistant/DECISIONS.md`](assistant/DECISIONS.md) | D1–D11 裁决记录：面板形态、条带选日、提示词版本化、验收编号方案 |
| 3 | [`assistant/ARCHITECTURE.md`](assistant/ARCHITECTURE.md) | 需求 → 高层设计 → 深入 → 规模与可靠性 → 取舍 → 风险 |
| 4 | [`assistant/ARCHITECTURE.review.md`](assistant/ARCHITECTURE.review.md) | 架构评审记录：已修 8 处、留待决策 3 处、核验无需动作 2 处 |
| 5 | [`assistant/PLAN.md`](assistant/PLAN.md) | 15 个任务 T0–T14，含完成判据、AC 编号、依赖与人日对账 |
| 6 | [`assistant/LOOPS.md`](assistant/LOOPS.md) | 迭代记录 Loop 1–6，逐轮交付内容与与计划的两处偏差 |

线框原型在 [`design/mockups/assistant-v3-week-strip.html`](design/mockups/assistant-v3-week-strip.html)，是 `DECISIONS.md` D4 选定方向的实物依据。

## 四、产品与规划（product/）

| 文件 | 讲什么 |
|---|---|
| `product/智学节律 产品需求文档.docx` | PRD V2.0，17 章功能定义 + 第十八章「实现与迭代记录」 |
| `product/智学节律 技术架构设计.docx` | 技术选型、模块划分、数据模型 |
| [`product/从Demo到正式开发 实施规划 v1.0.md`](product/从Demo到正式开发%20实施规划%20v1.0.md) | 三条路线对比、模块优先级、六阶段推进与验收标准 |

> 这三份是本项目的唯一副本，工作区里不再保留同名拷贝（课程交付目录已随实训结束清理）。
