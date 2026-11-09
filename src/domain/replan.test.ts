import { describe, expect, it } from 'vitest';
import { detectReplanTrigger, planReplan } from './replan';
import type { Block, PlanItem, Settings } from './types';

const settings: Settings = { weekdays: [0, 150, 150, 150, 150, 150, 120], weekStart: 1 };
const weekStart = '2026-11-09';
const today = '2026-11-10';

function item(id: string, estimateMin: number, weight: number): PlanItem {
  return { id, goalId: 'g', title: id, subject: 'major', estimateMin, weight, remainingMin: estimateMin };
}

function block(id: string, date: string, startMin: number, duration: number, status: Block['status'] = 'pending'): Block {
  return { id, itemId: `i-${id}`, date, startMin, endMin: startMin + duration, isBuffer: false, status };
}

describe('detectReplanTrigger · 触发条件', () => {
  it('连续两天完成率低于 60% 时触发', () => {
    const blocks = [
      block('a', '2026-11-09', 1140, 60, 'done'),
      block('b', '2026-11-09', 1200, 60, 'pending'),
      block('c', '2026-11-10', 1140, 60, 'pending'),
      block('d', '2026-11-10', 1200, 60, 'pending'),
    ];
    const trigger = detectReplanTrigger({ blocks, items: [], settings, weekStart, today });
    expect(trigger.reasons.some((r) => r.code === 'low-achievement')).toBe(true);
  });

  it('未来 7 天欠账超过 150 分钟时触发', () => {
    const tight: Settings = { weekdays: [0, 150, 0, 0, 0, 0, 0], weekStart: 1 };
    const blocks = [
      block('x', '2026-11-11', 1140, 150, 'done'),
      block('y', '2026-11-12', 1140, 150),
      block('z', '2026-11-13', 1140, 150),
      block('w', '2026-11-14', 1140, 150),
    ];
    const trigger = detectReplanTrigger({ blocks, items: [], settings: tight, weekStart, today });
    expect(trigger.backlogMin).toBe(300);
    expect(trigger.reasons.some((r) => r.code === 'backlog')).toBe(true);
  });

  it('曾经执行过但最近三天无记录才进入挽救模式', () => {
    const history = [block('old', '2026-10-30', 1140, 60, 'done')];
    const trigger = detectReplanTrigger({ blocks: history, items: [], settings, weekStart, today });
    expect(trigger.rescue).toBe(true);
    expect(trigger.reasons.some((r) => r.code === 'long-break')).toBe(true);
  });

  it('全新用户不会被判定为中断', () => {
    const trigger = detectReplanTrigger({ blocks: [], items: [], settings, weekStart, today });
    expect(trigger.rescue).toBe(false);
    expect(trigger.reasons.some((r) => r.code === 'long-break')).toBe(false);
  });

  it('主动请求排在原因列表首位', () => {
    const trigger = detectReplanTrigger({ blocks: [], items: [], settings, weekStart, today, manual: true });
    expect(trigger.reasons[0]!.code).toBe('manual');
  });
});

describe('planReplan · 重排方案', () => {
  const items = [item('数学强化', 600, 5), item('政治背诵', 300, 2), item('英语阅读', 240, 4)];

  it('按「顺延 → 压缩 → 替代 → 放弃」顺序给出四个方案', () => {
    const result = planReplan({ blocks: [], items, settings, weekStart, today });
    expect(result.options.map((o) => o.key)).toEqual(['defer', 'compress', 'substitute', 'drop']);
  });

  it('压缩只作用于权重 ≤ 3 的任务，并给出工时变更', () => {
    const result = planReplan({ blocks: [], items, settings, weekStart, today });
    const compress = result.options.find((o) => o.key === 'compress')!;
    expect(compress.itemChanges.length).toBeGreaterThan(0);
    for (const change of compress.itemChanges) {
      const target = items.find((i) => i.id === change.id)!;
      expect(target.weight).toBeLessThanOrEqual(3);
      expect(change.remainingMin!).toBeLessThan(target.estimateMin);
    }
  });

  it('放弃方案会明确标出被移除的计划项', () => {
    const result = planReplan({ blocks: [], items, settings, weekStart, today });
    const drop = result.options.find((o) => o.key === 'drop')!;
    expect(drop.itemChanges).toHaveLength(1);
    expect(drop.itemChanges[0]!.remove).toBe(true);
    expect(drop.summary.dropped).toBe(1);
  });

  it('容量充足时顺延方案可行且没有延期项', () => {
    const result = planReplan({ blocks: [], items: [item('小任务', 60, 5)], settings, weekStart, today });
    const defer = result.options.find((o) => o.key === 'defer')!;
    expect(defer.summary.deferred).toBe(0);
    expect(defer.summary.deferredMin).toBe(0);
    expect(defer.feasible).toBe(true);
  });

  it('负载增幅超过 20% 时只有顺延仍可行（顺延本就允许装不下）', () => {
    const heavy = [item('a', 900, 5), item('b', 900, 5)];
    const current: Block[] = [
      { id: 'p1', itemId: 'a', date: '2026-11-10', startMin: 1140, endMin: 1200, isBuffer: false, status: 'pending' },
    ];
    const result = planReplan({ blocks: current, items: heavy, settings, weekStart, today });
    const defer = result.options.find((o) => o.key === 'defer')!;
    expect(defer.loadIncreasePct).toBeGreaterThan(20);
    // 顺延的语义就是"装不下的留到下周"，不应被负载增幅挡掉
    expect(defer.feasible).toBe(true);
    expect(defer.summary.deferredMin).toBeGreaterThan(0);
  });

  it('没有可压缩/可替换的对象时标记为不适用', () => {
    const core = [item('核心A', 300, 5), item('核心B', 300, 4)];
    const result = planReplan({ blocks: [], items: core, settings, weekStart, today });
    const get = (k: string) => result.options.find((o) => o.key === k)!;
    expect(get('defer').applicable).toBe(true);
    expect(get('compress').applicable).toBe(false);
    expect(get('substitute').applicable).toBe(false);
    expect(get('drop').applicable).toBe(true);
    expect(get('compress').feasible).toBe(false);
    expect(get('compress').reason).toContain('没有可压缩');
    expect(get('substitute').reason).toContain('没有权重 ≤ 2');
  });

  it('本周只有一个任务时「放弃」不适用（等于清空整周）', () => {
    const result = planReplan({ blocks: [], items: [item('唯一任务', 120, 5)], settings, weekStart, today });
    const drop = result.options.find((o) => o.key === 'drop')!;
    expect(drop.applicable).toBe(false);
    expect(drop.reason).toContain('清空整周');
    expect(drop.itemChanges).toHaveLength(0);
  });

  it('只重排本周已排块的任务，不把整个计划塞进一周', () => {
    const all = [item('i-p1', 300, 4), item('未排的A', 6000, 5), item('未排的B', 6000, 5)];
    const current: Block[] = [
      { id: 'p1', itemId: 'i-p1', date: '2026-11-10', startMin: 1140, endMin: 1260, isBuffer: false, status: 'pending' },
    ];
    const result = planReplan({ blocks: current, items: all, settings, weekStart, today });
    for (const o of result.options) {
      const ids = new Set(o.blocks.map((b) => b.itemId));
      expect([...ids].every((id) => id === 'i-p1')).toBe(true);
    }
  });

  it('连续三次重排仍不可行时停止重排，转为目标校准建议', () => {
    const heavy = [item('a', 1200, 5), item('b', 1200, 5), item('c', 1200, 5)];
    const result = planReplan({
      blocks: [],
      items: heavy,
      settings,
      weekStart,
      today,
      replanCount: 3,
    });
    expect(result.blocked).toBe(true);
    expect(result.calibration).toContain('顺延');
  });

  it('方案里的块都在本周范围内且不重叠', () => {
    const result = planReplan({ blocks: [], items, settings, weekStart, today });
    for (const option of result.options) {
      const byDate = new Map<string, Array<[number, number]>>();
      for (const b of option.blocks) {
        expect(b.date >= weekStart && b.date <= '2026-11-15').toBe(true);
        const list = byDate.get(b.date) ?? [];
        list.push([b.startMin, b.endMin]);
        byDate.set(b.date, list);
      }
      for (const [, list] of byDate) {
        list.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < list.length; i++) {
          expect(list[i]![0]).toBeGreaterThanOrEqual(list[i - 1]![1]);
        }
      }
    }
  });
});
