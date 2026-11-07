import { addDays, daysBetween, weekdayOf, weekDates } from './date';
import { LEVEL_COEF } from './types';
import type {
  Block,
  DeviationStats,
  Feasibility,
  Goal,
  PackedWeek,
  PlanItem,
  Report,
  Settings,
} from './types';

/** 可用时长折扣：吸收疾病、加班、情绪低谷 */
export const CAPACITY_DISCOUNT = 0.85;
/** 弹性位占比：留作缓冲，不参与常规装箱 */
export const BUFFER_RATIO = 0.15;
/** 每日默认开始时间（分钟） */
export const DAY_START_MIN = 19 * 60;

const round = (n: number) => Math.round(n);

export function demandMinutes(items: PlanItem[], level: Goal['level']): number {
  const coef = LEVEL_COEF[level];
  return round(items.reduce((sum, it) => sum + Math.max(0, it.estimateMin) * coef, 0));
}

export function feasibility(
  goal: Goal,
  items: PlanItem[],
  today: string,
): Feasibility {
  const demand = demandMinutes(items, goal.level);
  const daysLeft = Math.max(0, daysBetween(today, goal.deadline));
  const weeksLeft = Math.ceil(daysLeft / 7);
  const available = round(goal.weeklyMinutes * weeksLeft * CAPACITY_DISCOUNT);

  if (items.length === 0 || demand <= 0) {
    return { demandMin: 0, availableMin: available, weeksLeft, ratio: 0, verdict: 'no-data' };
  }
  if (available <= 0) {
    return { demandMin: demand, availableMin: 0, weeksLeft, ratio: Infinity, verdict: 'infeasible' };
  }
  const ratio = demand / available;
  const verdict: Feasibility['verdict'] =
    ratio <= 0.85 ? 'comfortable' : ratio <= 1 ? 'reasonable' : ratio <= 1.15 ? 'tight' : 'infeasible';
  return { demandMin: demand, availableMin: available, weeksLeft, ratio, verdict };
}

/** 按权重降序、工时降序、id 升序排列，保证确定性 */
function orderItems(items: PlanItem[]): PlanItem[] {
  return [...items].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.estimateMin !== a.estimateMin) return b.estimateMin - a.estimateMin;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function packWeek(
  items: PlanItem[],
  settings: Settings,
  weekStartISO: string,
): PackedWeek {
  const dates = weekDates(weekStartISO);
  const dayCap = dates.map((d) => Math.max(0, settings.weekdays[weekdayOf(d)] ?? 0));
  const totalCap = dayCap.reduce((a, b) => a + b, 0);
  const bufferTotal = round(totalCap * BUFFER_RATIO);
  const normalCap = totalCap - bufferTotal;

  const normalLeft = dayCap.slice();
  const bufferLeft = dayCap.slice();
  const cursor = dates.map(() => DAY_START_MIN);
  const blocks: Block[] = [];
  const overflow: PackedWeek['overflow'] = [];

  let usedNormal = 0;
  let usedBuffer = 0;

  for (const item of orderItems(items)) {
    const est = Math.max(0, item.estimateMin);
    if (est === 0) continue;

    // 1) 优先放入常规容量（同时受全局常规容量约束）
    let placed = false;
    for (let i = 0; i < dates.length; i++) {
      if (normalLeft[i]! >= est && usedNormal + est <= normalCap) {
        const date = dates[i]!;
        blocks.push(makeBlock(item, date, cursor[i]!, est, false));
        cursor[i] = cursor[i]! + est;
        normalLeft[i] = normalLeft[i]! - est;
        usedNormal += est;
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // 2) 常规容量不够时使用弹性位（同样受弹性位总量约束）
    for (let i = 0; i < dates.length; i++) {
      if (bufferLeft[i]! >= est && usedBuffer + est <= bufferTotal) {
        const date = dates[i]!;
        blocks.push(makeBlock(item, date, cursor[i]!, est, true));
        cursor[i] = cursor[i]! + est;
        bufferLeft[i] = bufferLeft[i]! - est;
        usedBuffer += est;
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // 3) 装不下
    overflow.push({
      item,
      reason: usedNormal + usedBuffer >= totalCap ? 'no-capacity' : 'buffer-used',
    });
  }

  blocks.sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));

  const plannedMin = blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const suggestions: string[] = [];

  if (overflow.length > 0) {
    const missing = overflow.reduce((s, o) => s + Math.max(0, o.item.estimateMin), 0);
    suggestions.push(
      `本周还差 ${Math.round(missing / 60)} 小时容量：可把低权重项顺延到下周，或把每日可用时长上调。`,
    );
  }
  if (usedBuffer > 0) {
    suggestions.push(
      `已占用弹性位 ${Math.round(usedBuffer)} 分钟，本周应对突发情况的空间变小。`,
    );
  }
  if (overflow.length === 0 && usedBuffer === 0 && plannedMin > 0) {
    suggestions.push('本周计划已全部装入常规容量，弹性位保持空闲。');
  }
  if (totalCap === 0) {
    suggestions.push('本周没有可用时段，请先在设置里配置每天可用时长。');
  }

  return {
    blocks,
    overflow,
    capacityMin: totalCap,
    plannedMin,
    bufferMin: usedBuffer,
    suggestions,
  };
}

function makeBlock(item: PlanItem, date: string, startMin: number, duration: number, isBuffer: boolean): Block {
  return {
    id: `blk_${date}_${item.id}`,
    itemId: item.id,
    date,
    startMin,
    endMin: startMin + duration,
    isBuffer,
    status: 'pending',
  };
}

function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(sorted.length * 0.9) - 1);
  return sorted[idx]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function deviationStats(blocks: Block[]): DeviationStats {
  const ratios: number[] = [];
  for (const b of blocks) {
    if (b.status !== 'done' || b.actualMin == null) continue;
    const planned = b.endMin - b.startMin;
    if (planned <= 0) continue;
    ratios.push((b.actualMin - planned) / planned);
  }
  return {
    count: ratios.length,
    median: median(ratios),
    p90: p90(ratios.map(Math.abs)),
  };
}

function normalizeShares(raw: Array<{ key: Report['causes'][number]['key']; label: string; value: number }>) {
  const total = raw.reduce((s, r) => s + Math.max(0, r.value), 0);
  if (total <= 0) return raw.map((r) => ({ key: r.key, label: r.label, share: 0 }));
  const shares = raw.map((r) => ({ key: r.key, label: r.label, share: (Math.max(0, r.value) / total) * 100 }));
  const rounded = shares.map((s) => ({ ...s, share: Math.floor(s.share) }));
  let rest = 100 - rounded.reduce((s, r) => s + r.share, 0);
  const byFraction = shares
    .map((s, i) => ({ i, frac: s.share - Math.floor(s.share) }))
    .sort((a, b) => b.frac - a.frac);
  for (const f of byFraction) {
    if (rest <= 0) break;
    rounded[f.i]!.share += 1;
    rest -= 1;
  }
  return rounded;
}

export function buildReport(blocks: Block[], settings: Settings, weekStartISO: string): Report {
  const dates = weekDates(weekStartISO);
  const capacity = dates.reduce((s, d) => s + Math.max(0, settings.weekdays[weekdayOf(d)] ?? 0), 0);

  const planned = blocks.filter((b) => b.status !== 'skipped' || b.skipReason !== 'capacity');
  const done = blocks.filter((b) => b.status === 'done');
  const skipped = blocks.filter((b) => b.status === 'skipped');
  const plannedMin = blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const effectiveMin = done.reduce(
    (s, b) => s + (b.actualMin ?? b.endMin - b.startMin),
    0,
  );

  const hasData = blocks.length > 0;
  const achievement = planned.length > 0 ? done.length / planned.length : 0;
  const dev = deviationStats(blocks);

  const overloadMin = Math.max(0, plannedMin - capacity);
  const capacityRaw = plannedMin > 0 ? overloadMin / plannedMin : 0;
  const interruptRaw =
    plannedMin > 0
      ? skipped
          .filter((b) => b.skipReason === 'interrupt')
          .reduce((s, b) => s + (b.endMin - b.startMin), 0) / plannedMin
      : 0;
  const estimateRaw =
    plannedMin > 0 && dev.count > 0
      ? blocks
          .filter((b) => b.status === 'done' && b.actualMin != null)
          .reduce((s, b) => {
            const plannedOne = b.endMin - b.startMin;
            return s + Math.abs(b.actualMin! - plannedOne);
          }, 0) / plannedMin
      : 0;

  const causes = normalizeShares([
    { key: 'capacity', label: '计划容量', value: capacityRaw },
    { key: 'interrupt', label: '执行中断', value: interruptRaw },
    { key: 'estimate', label: '任务估时', value: estimateRaw },
  ]);

  const dominant = [...causes].sort((a, b) => b.share - a.share)[0];
  let suggestion = '本周数据还不足，完成几天任务后再来看归因。';
  if (hasData && dominant && dominant.share > 0) {
    if (dominant.key === 'capacity') {
      suggestion = `本周计划量超出可用时长 ${Math.round(overloadMin / 60)} 小时，下周减少一天的任务密度。`;
    } else if (dominant.key === 'interrupt') {
      suggestion = '中断集中在固定时段的话，可把该时段的任务改为弹性位，减少被打断的损失。';
    } else {
      const pct = Math.round(dev.median * 100);
      if (pct >= 0) {
        const factor = (1 + dev.median).toFixed(2);
        suggestion = `任务平均多用 ${pct}%，下次估时按 ${factor} 倍上调更接近现实。`;
      } else {
        suggestion = '估时偏保守，可以适当压缩同类任务的预估时长。';
      }
    }
  }
  if (hasData && achievement >= 0.9) {
    suggestion = '本周达成率很高，可以尝试把弹性位再留大一点，避免下周过载。';
  }

  return {
    plannedCount: planned.length,
    doneCount: done.length,
    skippedCount: skipped.length,
    achievement,
    plannedMin,
    effectiveMin,
    deviation: dev,
    causes,
    suggestion,
    hasData,
  };
}

/** 供 UI 用：取某周的所有 block */
export function blocksOfWeek(all: Block[], weekStartISO: string): Block[] {
  const set = new Set(weekDates(weekStartISO));
  return all.filter((b) => set.has(b.date)).sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));
}

export function nextWeekStart(weekStartISO: string): string {
  return addDays(weekStartISO, 7);
}
