import { describe, expect, it } from 'vitest';
import {
  buildReport,
  demandMinutes,
  deviationStats,
  feasibility,
  packWeek,
} from './engine';
import type { Block, Goal, PlanItem, Settings } from './types';

const settings: Settings = {
  weekStart: 1,
  // 周日..周六
  weekdays: [0, 120, 120, 120, 120, 120, 0],
};

const goal: Goal = {
  id: 'g1',
  title: '2027 考研 · 计算机',
  deadline: '2027-12-19',
  weeklyMinutes: 300,
  level: 'once',
  createdAt: '2026-11-07',
};

const item = (id: string, estimateMin: number, weight = 3): PlanItem => ({
  id,
  goalId: 'g1',
  title: `任务 ${id}`,
  subject: 'major',
  estimateMin,
  weight,
});

const block = (over: Partial<Block> & Pick<Block, 'id'>): Block => ({
  itemId: 'i1',
  date: '2026-11-02',
  startMin: 1140,
  endMin: 1230,
  isBuffer: false,
  status: 'pending',
  ...over,
});

describe('demandMinutes', () => {
  it('按基础系数放大需求工时', () => {
    const items = [item('a', 100), item('b', 100)];
    expect(demandMinutes(items, 'once')).toBe(200);
    expect(demandMinutes(items, 'zero')).toBe(260);
    expect(demandMinutes(items, 'twice')).toBe(150);
  });

  it('负工时不计入', () => {
    expect(demandMinutes([item('a', -50)], 'once')).toBe(0);
  });
});

describe('feasibility', () => {
  it('没有计划项时返回 no-data', () => {
    const f = feasibility(goal, [], '2026-11-07');
    expect(f.verdict).toBe('no-data');
    expect(f.demandMin).toBe(0);
  });

  it('需求远小于可用时判定为可从容', () => {
    // deadline 距 today 约 407 天 → 59 周；可用 300*59*0.85
    const f = feasibility(goal, [item('a', 600)], '2026-11-07');
    expect(f.weeksLeft).toBeGreaterThan(50);
    expect(f.verdict).toBe('comfortable');
    expect(f.ratio).toBeLessThan(0.85);
  });

  it('截止日已过或可用为零时判定为不可行', () => {
    const overdue = feasibility({ ...goal, deadline: '2026-11-01' }, [item('a', 600)], '2026-11-07');
    expect(overdue.weeksLeft).toBe(0);
    expect(overdue.verdict).toBe('infeasible');
    expect(overdue.ratio).toBe(Infinity);

    const noTime = feasibility({ ...goal, weeklyMinutes: 0 }, [item('a', 600)], '2026-11-07');
    expect(noTime.verdict).toBe('infeasible');
  });

  it('R 值落在偏紧区间', () => {
    const tightGoal: Goal = { ...goal, deadline: '2026-11-28', weeklyMinutes: 600 };
    // 21 天 → 3 周 → 可用 600*3*0.85 = 1530
    const f = feasibility(tightGoal, [item('a', 1600)], '2026-11-07');
    expect(f.availableMin).toBe(1530);
    expect(f.ratio).toBeCloseTo(1600 / 1530, 3);
    expect(f.verdict).toBe('tight');
  });
});

describe('packWeek', () => {
  const weekStart = '2026-11-02';

  it('按权重优先装入常规容量，时间连续且不重叠', () => {
    const packed = packWeek([item('low', 60, 1), item('high', 120, 5)], settings, weekStart);
    expect(packed.blocks).toHaveLength(2);
    expect(packed.blocks[0]!.itemId).toBe('high');
    expect(packed.blocks[0]!.date).toBe('2026-11-02');
    expect(packed.blocks[0]!.startMin).toBe(19 * 60);
    expect(packed.blocks[0]!.endMin).toBe(21 * 60);
    // 当天常规容量已用满，第二项顺延到次日同一起始时间
    expect(packed.blocks[1]!.date).toBe('2026-11-03');
    expect(packed.blocks[1]!.startMin).toBe(19 * 60);
    expect(packed.capacityMin).toBe(600);
    expect(packed.plannedMin).toBe(180);
    expect(packed.overflow).toHaveLength(0);
  });

  it('同输入两次结果完全一致（确定性）', () => {
    const items = [item('a', 90, 3), item('b', 60, 3), item('c', 120, 4)];
    const one = packWeek(items, settings, weekStart);
    const two = packWeek(items, settings, weekStart);
    expect(one).toEqual(two);
  });

  it('长任务自动拆分到多天', () => {
    const packed = packWeek([item('long', 500)], settings, weekStart);
    expect(packed.blocks.length).toBeGreaterThan(1);
    expect(packed.plannedMin).toBe(500);
    expect(packed.overflow).toHaveLength(0);
    // 每天不超过当日容量，且不重叠
    for (const b of packed.blocks) {
      expect(b.endMin - b.startMin).toBeLessThanOrEqual(120);
    }
  });

  it('总容量不足时溢出剩余量并给出建议', () => {
    const packed = packWeek([item('huge', 700)], settings, weekStart);
    // 常规容量 510 用满；剩余 190 超过单日弹性位，不切片 → 整体溢出
    expect(packed.plannedMin).toBe(510);
    expect(packed.overflow).toHaveLength(1);
    expect(packed.overflow[0]!.remainingMin).toBe(190);
    expect(packed.suggestions.join('')).toContain('差');
  });

  it('常规容量不足时占用弹性位', () => {
    // 常规容量 510，四项 120 占满后，60 分钟的项只能进弹性位
    const items = [
      item('a', 120, 5),
      item('b', 120, 5),
      item('c', 120, 5),
      item('d', 120, 5),
      item('e', 60, 5),
    ];
    const packed = packWeek(items, settings, weekStart);
    // 常规 510 用满后，最后 60 分钟里 30 分钟进常规、30 分钟进弹性位
    expect(packed.bufferMin).toBe(30);
    expect(packed.blocks.filter((b) => b.isBuffer)).toHaveLength(1);
    expect(packed.suggestions.join('')).toContain('弹性位');
  });

  it('周中生成：不把任务排到 fromISO 之前', () => {
    const packed = packWeek([item('a', 120, 5), item('b', 60, 5)], settings, weekStart, '2026-11-05');
    expect(packed.blocks.length).toBeGreaterThan(0);
    for (const b of packed.blocks) {
      expect(b.date >= '2026-11-05').toBe(true);
    }
    // 容量只统计 fromISO 之后的工作日（周四、周五）
    expect(packed.capacityMin).toBe(240);
  });

  it('fromISO 超出本周时无容量可用', () => {
    const packed = packWeek([item('a', 60)], settings, weekStart, '2026-11-20');
    expect(packed.blocks).toHaveLength(0);
    expect(packed.capacityMin).toBe(0);
    expect(packed.overflow).toHaveLength(1);
  });

  it('本周无可排时段时全部进入 overflow', () => {
    const zero: Settings = { weekStart: 1, weekdays: [0, 0, 0, 0, 0, 0, 0] };
    const packed = packWeek([item('a', 60)], zero, weekStart);
    expect(packed.capacityMin).toBe(0);
    expect(packed.overflow).toHaveLength(1);
    expect(packed.suggestions.join('')).toContain('没有可用时段');
  });
});

describe('deviationStats', () => {
  it('计算中位数与 P90，跳过未完成项', () => {
    const blocks = [
      // 计划 90 分钟：实际 100（+11.1%）、120（+33.3%）
      block({ id: '1', status: 'done', actualMin: 100, startMin: 1110, endMin: 1200 }),
      block({ id: '2', status: 'done', actualMin: 120, startMin: 1110, endMin: 1200 }),
      block({ id: '3', status: 'pending', actualMin: 999 }),
    ];
    const d = deviationStats(blocks);
    expect(d.count).toBe(2);
    expect(d.median).toBeCloseTo((1 / 9 + 1 / 3) / 2, 4);
    expect(d.p90).toBeCloseTo(1 / 3, 4);
  });

  it('补录记录不参与偏差统计', () => {
    const blocks = [
      block({ id: '1', status: 'done', actualMin: 100, startMin: 1110, endMin: 1200 }),
      block({ id: '2', status: 'done', actualMin: 500, startMin: 1110, endMin: 1200, source: 'backfill' }),
    ];
    const d = deviationStats(blocks);
    expect(d.count).toBe(1);
    expect(d.median).toBeCloseTo(1 / 9, 4);
  });

  it('没有完成项时返回 0 而不是 NaN', () => {
    const d = deviationStats([]);
    expect(d).toEqual({ count: 0, median: 0, p90: 0 });
  });
});

describe('buildReport', () => {
  const weekStart = '2026-11-02';

  it('按真实记录计算达成率、有效时长与归因', () => {
    const blocks = [
      block({ id: '1', status: 'done', actualMin: 100, startMin: 1140, endMin: 1230 }),
      block({ id: '2', status: 'done', actualMin: 120, startMin: 1140, endMin: 1230 }),
      block({ id: '3', status: 'skipped', skipReason: 'interrupt', startMin: 1140, endMin: 1230 }),
    ];
    const r = buildReport(blocks, settings, weekStart);
    expect(r.hasData).toBe(true);
    expect(r.doneCount).toBe(2);
    expect(r.skippedCount).toBe(1);
    expect(r.achievement).toBeCloseTo(2 / 3, 4);
    expect(r.effectiveMin).toBe(220);
    const interrupt = r.causes.find((c) => c.key === 'interrupt')!;
    expect(interrupt.share).toBeGreaterThan(50);
    expect(r.causes.reduce((s, c) => s + c.share, 0)).toBe(100);
  });

  it('计划量超出容量时归因指向容量', () => {
    const blocks = Array.from({ length: 6 }, (_, i) =>
      block({ id: `${i}`, startMin: 1140, endMin: 1260 }),
    ); // 6 * 120 = 720 > capacity 600
    const r = buildReport(blocks, settings, weekStart);
    expect(r.causes[0]!.key).toBe('capacity');
    expect(r.suggestion).toContain('超出');
  });

  it('补录计入达成与时长，但不进偏差与估时归因', () => {
    const blocks = [
      block({ id: '1', status: 'done', actualMin: 60, startMin: 1140, endMin: 1200 }),
      block({ id: '2', status: 'done', actualMin: 600, startMin: 1140, endMin: 1200, source: 'backfill' }),
    ];
    const r = buildReport(blocks, settings, weekStart);
    expect(r.doneCount).toBe(2);
    expect(r.effectiveMin).toBe(660); // 补录时长照常计入
    expect(r.backfillCount).toBe(1);
    expect(r.deviation.count).toBe(1); // 偏差只看计时记录
    const estimate = r.causes.find((c) => c.key === 'estimate');
    expect(estimate?.share).toBe(0); // 估时归因排除补录
  });

  it('空数据不产生 NaN', () => {
    const r = buildReport([], settings, weekStart);
    expect(r.hasData).toBe(false);
    expect(r.achievement).toBe(0);
    expect(Number.isFinite(r.deviation.median)).toBe(true);
    // 无记录时归因不编造份额
    expect(r.causes.every((c) => c.share === 0)).toBe(true);
  });

  it('达成率高时给出正向建议', () => {
    const blocks = [block({ id: '1', status: 'done', actualMin: 90 })];
    const r = buildReport(blocks, settings, weekStart);
    expect(r.achievement).toBe(1);
    expect(r.suggestion).toContain('达成率');
  });
});
