/**
 * 进度预警引擎（PRD F-5.4）—— 纯函数：不读时钟、不碰存储，today 由调用方传入。
 *
 * 三条规则：
 *  1. deadline-risk  剩余需求工时相对「剩余周数 × 周容量 × 0.85」的比率 R'：
 *                    > 1.15 → danger（按当前节奏无法按期完成）；> 1 → warn（进度偏紧）。
 *  2. week-behind    本周已过 ≥2 天且完成率 < 60% → warn。
 *  3. streak-broken  曾有执行记录但最近 3 天（含今天）都没有完成 → danger（挽救信号）。
 */
import type { Block, Goal, PlanItem, Settings } from './types';
import { daysBetween, startOfWeek, weekDates, weekdayOf } from './date';

export type AlertLevel = 'info' | 'warn' | 'danger';

export interface AlertItem {
  /** 通知类别：同时用于同日去重 */
  kind: 'deadline-risk' | 'week-behind' | 'streak-broken';
  level: AlertLevel;
  title: string;
  body: string;
}

export interface AlertInput {
  goal: Goal;
  items: PlanItem[];
  blocks: Block[];
  settings: Settings;
  today: string;
}

const FEASIBLE_BUFFER = 0.85;

/** 剩余需求工时（分钟）：所有计划项的剩余量之和 */
function remainingDemandMin(items: PlanItem[]): number {
  return items.reduce((sum, i) => sum + Math.max(0, i.remainingMin ?? i.estimateMin), 0);
}

/** 未来 n 天的可用容量（分钟） */
function capacityForDays(settings: Settings, startDate: string, days: number): number {
  let total = 0;
  for (let i = 0; i < days; i++) {
    const date = addDaysISO(startDate, i);
    total += Math.max(0, settings.weekdays[weekdayOf(date)] ?? 0);
  }
  return total;
}

function addDaysISO(iso: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function evaluateAlerts(input: AlertInput): AlertItem[] {
  const { goal, items, blocks, settings, today } = input;
  const alerts: AlertItem[] = [];

  const daysLeft = daysBetween(today, goal.deadline);
  const demand = remainingDemandMin(items);

  // 规则 1：截止日负载（至少还剩 1 天才有意义）
  if (daysLeft > 0 && demand > 0) {
    const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
    const available = capacityForDays(settings, today, daysLeft) * FEASIBLE_BUFFER;
    // 可用为 0 时视为无穷大比率（每天都在休息日还背着需求）
    const ratio = available > 0 ? demand / available : Number.POSITIVE_INFINITY;
    if (ratio > 1.15) {
      alerts.push({
        kind: 'deadline-risk',
        level: 'danger',
        title: '按当前节奏难以按期完成',
        body: `距离目标还有 ${daysLeft} 天，剩余任务约 ${(demand / 60).toFixed(1)} 小时，但可用时间只有 ${(
          available / 60
        ).toFixed(1)} 小时。建议延长目标日期、放弃低权重任务，或增加每周可用时间。`,
      });
    } else if (ratio > 1) {
      alerts.push({
        kind: 'deadline-risk',
        level: 'warn',
        title: '进度偏紧',
        body: `剩余任务约 ${(demand / 60).toFixed(1)} 小时，可用 ${(
          available / 60
        ).toFixed(1)} 小时（${weeksLeft} 周）。留出弹性，优先做高权重任务。`,
      });
    }
  }

  // 规则 2：本周进度落后（本周已过 ≥2 天才有统计意义）
  const weekStart = startOfWeek(today, settings.weekStart);
  const dates = weekDates(weekStart);
  const dayIndex = dates.indexOf(today);
  if (dayIndex >= 1) {
    const weekBlocks = blocks.filter((b) => dates.includes(b.date) && b.status !== 'skipped');
    const doneCount = weekBlocks.filter((b) => b.status === 'done').length;
    if (weekBlocks.length > 0 && doneCount / weekBlocks.length < 0.6) {
      alerts.push({
        kind: 'week-behind',
        level: 'warn',
        title: '本周进度落后',
        body: `本周已排 ${weekBlocks.length} 项，目前完成 ${doneCount} 项。用「周视图 → 重排建议」把没时间的日子顺延，比硬扛更有效。`,
      });
    }
  }

  // 规则 3：连续 3 天无执行（挽救信号，只对曾经执行过的用户触发）
  const everDone = blocks.some((b) => b.status === 'done');
  const recent = [0, 1, 2].map((i) => addDaysISO(today, -i));
  const doneRecently = blocks.some((b) => b.status === 'done' && recent.includes(b.date));
  if (everDone && !doneRecently) {
    alerts.push({
      kind: 'streak-broken',
      level: 'danger',
      title: '已经 3 天没有执行记录',
      body: '中断很正常，别从零开始。到「今日」页挑一个最小的任务补打卡，或用「周视图 → 重排建议」把本周计划调轻。',
    });
  }

  return alerts;
}
