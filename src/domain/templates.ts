import type { DecomposeTemplate, GoalTemplate } from './types';

/**
 * 知识域树模板（PRD 8.2 第一段：模板骨架）。
 * 每个节点携带标准工时（一刷基准）、考频权重、分值占比与推荐阶段；
 * 模板由运营维护，是冷启动阶段的核心资产——这里以代码常量形式内置。
 */
const postgradCs: DecomposeTemplate = {
  key: 'postgrad-cs',
  label: '考研 · 计算机（数学一 / 408 / 英语一 / 政治）',
  stageRatio: [0.45, 0.35, 0.2],
  nodes: [
    { id: 'm1', title: '高数 · 极限与一元微分', subject: 'math', module: '高等数学', minutes: 1200, frequency: 0.92, share: 0.2, stage: 'foundation' },
    { id: 'm2', title: '高数 · 一元积分与多元微积分', subject: 'math', module: '高等数学', minutes: 1080, frequency: 0.85, share: 0.18, stage: 'strengthen' },
    { id: 'm3', title: '高数 · 级数与综合题', subject: 'math', module: '高等数学', minutes: 480, frequency: 0.7, share: 0.1, stage: 'sprint', mergeable: true },
    { id: 'm4', title: '线代 · 行列式与矩阵', subject: 'math', module: '线性代数', minutes: 480, frequency: 0.8, share: 0.08, stage: 'foundation' },
    { id: 'm5', title: '线代 · 向量、方程组与特征值', subject: 'math', module: '线性代数', minutes: 720, frequency: 0.75, share: 0.1, stage: 'strengthen' },
    { id: 'm6', title: '概率 · 随机变量与数字特征', subject: 'math', module: '概率统计', minutes: 540, frequency: 0.7, share: 0.08, stage: 'strengthen' },
    { id: 'm7', title: '概率 · 大数定律与统计推断', subject: 'math', module: '概率统计', minutes: 300, frequency: 0.55, share: 0.05, stage: 'sprint', mergeable: true },
    { id: 'd1', title: '408 · 线性表、栈与队列', subject: 'major', module: '数据结构', minutes: 420, frequency: 0.85, share: 0.08, stage: 'foundation' },
    { id: 'd2', title: '408 · 树与二叉树', subject: 'major', module: '数据结构', minutes: 540, frequency: 0.9, share: 0.1, stage: 'foundation' },
    { id: 'd3', title: '408 · 图', subject: 'major', module: '数据结构', minutes: 420, frequency: 0.75, share: 0.07, stage: 'strengthen' },
    { id: 'd4', title: '408 · 查找与排序', subject: 'major', module: '数据结构', minutes: 420, frequency: 0.8, share: 0.08, stage: 'strengthen' },
    { id: 'c1', title: '408 · 数据表示与运算', subject: 'major', module: '计算机组成原理', minutes: 360, frequency: 0.7, share: 0.06, stage: 'foundation' },
    { id: 'c2', title: '408 · 存储系统与 Cache', subject: 'major', module: '计算机组成原理', minutes: 480, frequency: 0.8, share: 0.08, stage: 'strengthen' },
    { id: 'c3', title: '408 · 指令系统与 CPU', subject: 'major', module: '计算机组成原理', minutes: 420, frequency: 0.75, share: 0.07, stage: 'strengthen' },
    { id: 'o1', title: '408 · 进程与线程', subject: 'major', module: '操作系统', minutes: 420, frequency: 0.8, share: 0.08, stage: 'foundation' },
    { id: 'o2', title: '408 · 内存管理与文件系统', subject: 'major', module: '操作系统', minutes: 420, frequency: 0.7, share: 0.07, stage: 'strengthen' },
    { id: 'n1', title: '408 · 网络体系结构与 TCP/IP', subject: 'major', module: '计算机网络', minutes: 540, frequency: 0.75, share: 0.09, stage: 'strengthen' },
    { id: 'e1', title: '英语 · 词汇与长难句', subject: 'english', module: '英语', minutes: 720, frequency: 0.9, share: 0.1, stage: 'foundation' },
    { id: 'e2', title: '英语 · 阅读理解', subject: 'english', module: '英语', minutes: 840, frequency: 0.9, share: 0.1, stage: 'strengthen' },
    { id: 'e3', title: '英语 · 翻译与写作', subject: 'english', module: '英语', minutes: 600, frequency: 0.8, share: 0.1, stage: 'sprint' },
    { id: 'p1', title: '政治 · 马原', subject: 'politics', module: '政治', minutes: 420, frequency: 0.75, share: 0.06, stage: 'strengthen' },
    { id: 'p2', title: '政治 · 毛中特与史纲', subject: 'politics', module: '政治', minutes: 420, frequency: 0.7, share: 0.06, stage: 'sprint' },
    { id: 'p3', title: '政治 · 时政与思修法基', subject: 'politics', module: '政治', minutes: 300, frequency: 0.6, share: 0.04, stage: 'sprint', mergeable: true },
  ],
};

/** 考公：需更早进入刷题，阶段比例调整为 35 / 40 / 25 */
const civilService: DecomposeTemplate = {
  key: 'civil-service',
  label: '考公 · 行测 + 申论',
  stageRatio: [0.35, 0.4, 0.25],
  nodes: [
    { id: 'x1', title: '行测 · 言语理解', subject: 'other', module: '行测', minutes: 540, frequency: 0.9, share: 0.15, stage: 'foundation' },
    { id: 'x2', title: '行测 · 判断推理', subject: 'other', module: '行测', minutes: 600, frequency: 0.9, share: 0.15, stage: 'foundation' },
    { id: 'x3', title: '行测 · 资料分析', subject: 'other', module: '行测', minutes: 480, frequency: 0.85, share: 0.15, stage: 'strengthen' },
    { id: 'x4', title: '行测 · 数量关系', subject: 'other', module: '行测', minutes: 420, frequency: 0.65, share: 0.1, stage: 'strengthen', mergeable: true },
    { id: 'x5', title: '行测 · 常识判断', subject: 'other', module: '行测', minutes: 240, frequency: 0.5, share: 0.05, stage: 'sprint', mergeable: true },
    { id: 's1', title: '申论 · 归纳概括', subject: 'other', module: '申论', minutes: 360, frequency: 0.8, share: 0.15, stage: 'strengthen' },
    { id: 's2', title: '申论 · 综合分析', subject: 'other', module: '申论', minutes: 300, frequency: 0.7, share: 0.1, stage: 'strengthen' },
    { id: 's3', title: '申论 · 大作文', subject: 'other', module: '申论', minutes: 480, frequency: 0.85, share: 0.2, stage: 'sprint' },
  ],
};

/** 项目导学 / 自学项目 */
const projectSelf: DecomposeTemplate = {
  key: 'project-self',
  label: '项目导学 · 从需求到交付',
  stageRatio: [0.45, 0.35, 0.2],
  nodes: [
    { id: 'j1', title: '需求与范围界定', subject: 'other', module: '项目启动', minutes: 240, frequency: 0.8, share: 0.15, stage: 'foundation' },
    { id: 'j2', title: '技术方案与选型', subject: 'other', module: '项目启动', minutes: 300, frequency: 0.75, share: 0.15, stage: 'foundation' },
    { id: 'j3', title: '核心功能开发', subject: 'other', module: '开发实现', minutes: 1200, frequency: 0.95, share: 0.4, stage: 'strengthen' },
    { id: 'j4', title: '测试与缺陷修复', subject: 'other', module: '质量保障', minutes: 480, frequency: 0.8, share: 0.2, stage: 'strengthen' },
    { id: 'j5', title: '交付与复盘总结', subject: 'other', module: '交付收尾', minutes: 240, frequency: 0.6, share: 0.1, stage: 'sprint' },
  ],
};

export const TEMPLATES: Record<GoalTemplate, DecomposeTemplate> = {
  'postgrad-cs': postgradCs,
  'civil-service': civilService,
  'project-self': projectSelf,
};

export const TEMPLATE_LIST = Object.values(TEMPLATES).map((t) => ({
  key: t.key,
  label: t.label,
  nodeCount: t.nodes.length,
  totalMinutes: t.nodes.reduce((s, n) => s + n.minutes, 0),
}));
