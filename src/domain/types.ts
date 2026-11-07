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
  /** 实际用时（分钟），完成时填写 */
  actualMin?: number;
  skipReason?: SkipReason;
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
  overflow: Array<{ item: PlanItem; reason: 'no-capacity' | 'buffer-used' }>;
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
  causes: Array<{ key: 'capacity' | 'interrupt' | 'estimate'; label: string; share: number }>;
  suggestion: string;
  hasData: boolean;
}
