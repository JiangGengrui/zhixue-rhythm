export type Level = 'zero' | 'once' | 'twice' | 'more';

export const LEVEL_LABEL: Record<Level, string> = {
  zero: '零基础',
  once: '一刷',
  twice: '二刷',
  more: '多战',
};

/** 基础系数：同等工作量，不同基础所需时长不同 */
export const LEVEL_COEF: Record<Level, number> = {
  zero: 1.3,
  once: 1.0,
  twice: 0.75,
  more: 0.6,
};

export type Subject = 'math' | 'major' | 'english' | 'politics' | 'other';

export const SUBJECT_LABEL: Record<Subject, string> = {
  math: '数学',
  major: '专业课',
  english: '英语',
  politics: '政治',
  other: '其他',
};

export interface Goal {
  id: string;
  title: string;
  /** 目标日期 YYYY-MM-DD */
  deadline: string;
  /** 每周可投入分钟数 */
  weeklyMinutes: number;
  level: Level;
  createdAt: string;
}

export interface PlanItem {
  id: string;
  goalId: string;
  title: string;
  subject: Subject;
  /** 预估总工时（分钟） */
  estimateMin: number;
  /** 剩余工时（分钟），完成打卡后按实际投入扣减；旧数据缺省时等于 estimateMin */
  remainingMin?: number;
  /** 权重 1-5，越大越先排 */
  weight: number;
}

export type BlockStatus = 'pending' | 'running' | 'done' | 'skipped';
export type SkipReason = 'interrupt' | 'capacity' | 'other';

export interface Block {
  id: string;
  itemId: string;
  /** YYYY-MM-DD */
  date: string;
  /** 距 00:00 的分钟数 */
  startMin: number;
  endMin: number;
  isBuffer: boolean;
  status: BlockStatus;
  /** 实际用时（分钟），完成时填写；未填写时由计时器推导 */
  actualMin?: number;
  skipReason?: SkipReason;
  /** 执行来源：plan=按计划打卡，backfill=补录（不参与估时偏差统计） */
  source?: 'plan' | 'backfill';
  /** 完成度百分比（1–100）。低于 100 时，剩余工作量自动滚入下次排程 */
  progressPct?: number;
  /** 已累计执行秒数（暂停时间不计） */
  accumulatedSec?: number;
  /** 当前一段执行的开始时间（ISO）。status=running 且该字段为空表示处于暂停 */
  startedAt?: string;
  /** 用户锁定：重排 / 重建 / 移动都不会改动它 */
  locked?: boolean;
}

export interface Settings {
  /** 0=周日 1=周一 ... 6=周六，长度 7，值为当天可用分钟 */
  weekdays: number[];
  /** 周起始日：1=周一，0=周日 */
  weekStart: 0 | 1;
}

export type Verdict = 'no-data' | 'comfortable' | 'reasonable' | 'tight' | 'infeasible';

export interface Feasibility {
  demandMin: number;
  availableMin: number;
  weeksLeft: number;
  /** R = 需求 / 可用 */
  ratio: number;
  verdict: Verdict;
}

export interface PackedWeek {
  blocks: Block[];
  /** 装不下的计划项 */
  overflow: Array<{ item: PlanItem; remainingMin?: number; reason: 'no-capacity' | 'buffer-used' }>;
  capacityMin: number;
  plannedMin: number;
  bufferMin: number;
  suggestions: string[];
}

export interface DeviationStats {
  count: number;
  median: number;
  p90: number;
}

export interface Report {
  plannedCount: number;
  doneCount: number;
  skippedCount: number;
  achievement: number;
  plannedMin: number;
  effectiveMin: number;
  deviation: DeviationStats;
  /** 本周补录完成数：计入达成与时长，但不参与估时偏差 */
  backfillCount: number;
  causes: Array<{ key: 'capacity' | 'interrupt' | 'estimate'; label: string; share: number }>;
  suggestion: string;
  hasData: boolean;
}

/* ───────── 拆解引擎（PRD 8.2） ───────── */

export type GoalTemplate = 'postgrad-cs' | 'civil-service' | 'project-self';
export type StageKey = 'foundation' | 'strengthen' | 'sprint';

export const STAGE_LABEL: Record<StageKey, string> = {
  foundation: '基础',
  strengthen: '强化',
  sprint: '冲刺',
};

/** 知识域树的章节节点：标准工时 + 考频权重 + 分值占比 + 推荐阶段 */
export interface KnowledgeNode {
  id: string;
  title: string;
  subject: Subject;
  module: string;
  /** 标准工时（分钟），已按“一刷”基准标定 */
  minutes: number;
  /** 考频权重 0–1 */
  frequency: number;
  /** 分值占比 0–1 */
  share: number;
  stage: StageKey;
  /** 可与其他节点合并（裁断第三顺位） */
  mergeable?: boolean;
}

export interface DecomposeTemplate {
  key: GoalTemplate;
  label: string;
  /** 基础 / 强化 / 冲刺 的时间占比 */
  stageRatio: [number, number, number];
  nodes: KnowledgeNode[];
}

/** 拆解产出的计划项草案 */
export interface DraftItem {
  key: string;
  title: string;
  subject: Subject;
  module: string;
  estimateMin: number;
  weight: number;
  stage: StageKey;
  nodeIds: string[];
}

export interface DecomposeStage {
  key: StageKey;
  label: string;
  startDate: string;
  endDate: string;
  minutes: number;
  milestone: string;
}

export interface TrimmedNode {
  id: string;
  title: string;
  minutes: number;
  reason: 'low-priority' | 'mastered' | 'merged';
  note: string;
}

export interface DecomposeResult {
  template: GoalTemplate;
  stages: DecomposeStage[];
  items: DraftItem[];
  /** 裁剪后的需求工时 */
  demandMin: number;
  availableMin: number;
  ratio: number;
  verdict: Verdict;
  weeksLeft: number;
  stageRatio: [number, number, number];
  trimmed: TrimmedNode[];
  warnings: string[];
}

/* ───────── 重排引擎（PRD 8.4） ───────── */

export type ReplanReasonCode = 'low-achievement' | 'backlog' | 'manual' | 'goal-changed' | 'long-break';

export interface ReplanTrigger {
  triggered: boolean;
  rescue: boolean;
  backlogMin: number;
  reasons: Array<{ code: ReplanReasonCode; label: string; detail: string }>;
}

export type ReplanOptionKey = 'defer' | 'compress' | 'substitute' | 'drop';

export interface ReplanSummary {
  /** 新增（重新排入）的块数 */
  added: number;
  /** 延期到下周的项数 */
  deferred: number;
  /** 显式放弃的项数 */
  dropped: number;
  /** 延期工作量（分钟） */
  deferredMin: number;
}

export interface ReplanItemChange {
  id: string;
  /** 覆盖工时（压缩时用） */
  remainingMin?: number;
  /** 放弃该计划项 */
  remove?: boolean;
}

export interface ReplanOption {
  key: ReplanOptionKey;
  label: string;
  /** 一句话理由 */
  reason: string;
  /** 代价说明 */
  cost: string;
  summary: ReplanSummary;
  plannedMin: number;
  bufferMin: number;
  /** 未来 7 天负载相对当前增幅（%），硬约束 ≤ 20 */
  loadIncreasePct: number;
  /** 该方案在当前排布下是否用得上（如没有可压缩项时为 false） */
  applicable: boolean;
  feasible: boolean;
  /** 该方案下本周的块（可直接落库） */
  blocks: Block[];
  itemChanges: ReplanItemChange[];
}

export interface ReplanResult {
  trigger: ReplanTrigger;
  options: ReplanOption[];
  /** 连续重排仍不达标时置真，停止继续重排 */
  blocked: boolean;
  /** 目标校准建议（blocked 时给出） */
  calibration?: string;
}
