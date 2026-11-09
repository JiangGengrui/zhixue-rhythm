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

/** 单任务单日上限：避免一个大任务吃满整天 */
export const MAX_ITEM_MIN_PER_DAY = 120;
/** 每天推进的任务数上限：太多会切碎，太少又会让部分任务饿死 */
export const MAX_ITEMS_PER_DAY = 3;
/** 单块最短时长：避免把任务切得过碎 */
export const MIN_CHUNK_MIN = 30;
/** 一天的最晚结束时间，排程不会越过 24:00 */
export const DAY_END_MIN = 24 * 60;

export interface PackOptions {
  /** 每天已被占用的时段；传入后新块会精确避开，而不是只扣容量 */
  busy?: Array<{ date: string; startMin: number; endMin: number }>;
  /** 生成块 id；默认确定性 id，服务端应传入随机 id 避免与保留块主键冲突 */
  makeId?: (date: string, itemId: string, seq: number) => string;
  maxItemMinPerDay?: number;
  minChunkMin?: number;
  /** 每天最多推进几个任务 */
  maxItemsPerDay?: number;
}

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
  /** 只从这一天（含）之后排程；用于周中生成时避免排到已过去的日期 */
  fromISO: string = weekStartISO,
  options: PackOptions = {},
): PackedWeek {
  const dates = weekDates(weekStartISO);
  const makeId =
    options.makeId ??
    ((date: string, itemId: string, seq: number) => `blk_${date}_${itemId}_${seq}`);
  const minChunk = Math.max(15, options.minChunkMin ?? MIN_CHUNK_MIN);
  const maxItemMin = Math.max(minChunk, options.maxItemMinPerDay ?? MAX_ITEM_MIN_PER_DAY);
  const maxItemsPerDay = Math.max(1, options.maxItemsPerDay ?? MAX_ITEMS_PER_DAY);

  // 早于 fromISO 的日期不参与排程（容量记为 0）
  const dayCap = dates.map((d) =>
    d < fromISO ? 0 : Math.max(0, Math.min(DAY_END_MIN, settings.weekdays[weekdayOf(d)] ?? 0)),
  );
  // 每天的开始时间：默认 19:00，当天时长较大时自动提前，保证不越过 24:00
  const dayStart = dates.map((_, i) => Math.max(0, Math.min(DAY_START_MIN, DAY_END_MIN - dayCap[i]!)));

  // 既有占用：按时间段避开，而不是仅扣容量（否则新块会和已有块重叠）
  const busy = dates.map(() => [] as Array<[number, number]>);
  for (const b of options.busy ?? []) {
    const idx = dates.indexOf(b.date);
    if (idx === -1) continue;
    const start = Math.max(DAY_START_MIN, Math.min(DAY_END_MIN, b.startMin));
    const end = Math.max(start, Math.min(DAY_END_MIN, b.endMin));
    if (end > start) busy[idx]!.push([start, end]);
  }
  busy.forEach((list) => list.sort((a, b) => a[0] - b[0]));

  const freeByDay = dates.map((_, i) => {
    const occupied = busy[i]!.reduce((sum, [s, e]) => sum + (e - s), 0);
    return Math.max(0, dayCap[i]! - occupied);
  });
  const totalCap = dayCap.reduce((a, b) => a + b, 0);
  const freeTotal = freeByDay.reduce((a, b) => a + b, 0);
  const bufferTotal = round(freeTotal * BUFFER_RATIO);
  const normalCap = freeTotal - bufferTotal;

  const normalLeft = freeByDay.slice();
  const dayUsed = dates.map(() => 0);
  const cursor = busy.map((list, i) => nextFreeStart(list, dayStart[i]!));
  const perDay = dates.map(() => new Map<string, { min: number; seq: number }>());
  const blocks: Block[] = [];
  const overflow: PackedWeek['overflow'] = [];

  let usedNormal = 0;
  let usedBuffer = 0;

  const ordered = orderItems(items).filter((it) => Math.max(0, it.estimateMin) > 0);
  const remaining = new Map(ordered.map((it) => [it.id, Math.max(0, it.estimateMin)]));

  for (let day = 0; day < dates.length; day++) {
    let active = ordered.filter((it) => (remaining.get(it.id) ?? 0) > 0);
    if (active.length === 0) break;
    // 轮转起点：每天由不同任务先取时间，避免固定顺序的任务吃满整周
    const rot = day % active.length;
    active = [...active.slice(rot), ...active.slice(0, rot)];

    for (let guard = 0; guard < 64; guard++) {
      const pending = active.filter((it) => (remaining.get(it.id) ?? 0) > 0);
      const freeNow = freeByDay[day]! - dayUsed[day]!;
      if (pending.length === 0 || freeNow <= 0) break;
      // 当天只推进排在最前的若干任务，份额均分：既不把任务切碎，也不让单个任务独占
      const groupSize = Math.min(pending.length, maxItemsPerDay);
      const share = Math.min(maxItemMin, Math.max(minChunk, Math.floor(freeNow / groupSize)));
      let placed = false;

      for (const item of pending) {
        const free = freeByDay[day]! - dayUsed[day]!;
        if (free <= 0) break;
        const left = remaining.get(item.id) ?? 0;
        if (left <= 0) continue;
        const rec = perDay[day]!.get(item.id);
        const itemRoom = Math.max(0, maxItemMin - (rec?.min ?? 0));
        const start = cursor[day]!;
        const limit = segmentEnd(busy[day]!, start);
        if (limit - start < minChunk) {
          cursor[day] = nextFreeStart(busy[day]!, limit);
          continue;
        }
        let take = Math.min(left, share, itemRoom, free, limit - start);
        // 剩余量本就小于一个最小块时允许放完，否则不切碎
        if (take < minChunk && take < left) continue;

        const regRoom = Math.max(0, Math.min(normalLeft[day]!, normalCap - usedNormal));
        let reg = Math.min(take, regRoom);
        let buf = Math.min(take - reg, Math.max(0, bufferTotal - usedBuffer));
        // 常规位只剩零头时并到弹性位，避免同一任务被切成两小段
        if (reg > 0 && reg < minChunk && reg + buf <= Math.max(0, bufferTotal - usedBuffer)) {
          buf += reg;
          reg = 0;
        }
        take = reg + buf;
        if (take <= 0 || (take < minChunk && take < left)) continue;

        // 常规位与弹性位首尾相接，合并成一个块，避免同一任务被切成碎片
        const duration = reg + buf;
        const seq = rec?.seq ?? 0;
        blocks.push(makeBlock(item, dates[day]!, start, duration, reg === 0, seq, makeId));
        cursor[day] = start + duration;
        normalLeft[day] = normalLeft[day]! - reg;
        usedNormal += reg;
        usedBuffer += buf;
        dayUsed[day] = dayUsed[day]! + take;
        remaining.set(item.id, left - take);
        perDay[day]!.set(item.id, { min: (rec?.min ?? 0) + take, seq });
        placed = true;
      }

      if (!placed) break;
    }
  }

  for (const item of ordered) {
    const left = remaining.get(item.id) ?? 0;
    if (left <= 0) continue;
    overflow.push({
      item,
      remainingMin: left,
      reason: usedNormal + usedBuffer >= freeTotal ? 'no-capacity' : 'buffer-used',
    });
  }

  blocks.sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));

  const plannedMin = blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const suggestions: string[] = [];

  if (overflow.length > 0) {
    const missing = overflow.reduce((s, o) => s + Math.max(0, o.remainingMin ?? o.item.estimateMin), 0);
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

function makeBlock(
  item: PlanItem,
  date: string,
  startMin: number,
  duration: number,
  isBuffer: boolean,
  seq = 0,
  makeId: (date: string, itemId: string, seq: number) => string = (d, id, s) => `blk_${d}_${id}_${s}`,
): Block {
  return {
    // 序号用于区分同一任务在同一天的多个分片（常规位 + 弹性位）
    id: makeId(date, item.id, seq),
    itemId: item.id,
    date,
    startMin,
    endMin: startMin + duration,
    isBuffer,
    status: 'pending',
  };
}

/** 从 start 开始的下一个空闲起点（跳过既有占用） */
function nextFreeStart(list: Array<[number, number]>, start: number): number {
  let pos = Math.max(0, start);
  for (const [s, e] of list) {
    if (pos >= e) continue;
    if (pos < s) break;
    pos = e;
  }
  return pos;
}

/** 从 start 开始这一段连续空闲的结束点（不超过 24:00） */
function segmentEnd(list: Array<[number, number]>, start: number): number {
  for (const [s] of list) {
    if (s > start) return Math.min(DAY_END_MIN, s);
  }
  return DAY_END_MIN;
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
    // 补录没有真实计时，自报用时无法反映估时准确性，不参与偏差统计
    if (b.source === 'backfill') continue;
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
  const backfillCount = done.filter((b) => b.source === 'backfill').length;
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
          .filter((b) => b.status === 'done' && b.actualMin != null && b.source !== 'backfill')
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
    backfillCount,
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
