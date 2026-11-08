import { describe, expect, it } from 'vitest';
import { evaluateAlerts } from './alerts';
import type { Block, Goal, PlanItem, Settings } from './types';

const settings: Settings = { weekdays: [0, 150, 150, 150, 150, 150, 120], weekStart: 1 };

function goal(overrides: Partial<Goal> = {}): Goal {
  return { id: 'g1', title: '考研', deadline: '2027-05-01', weeklyMinutes: 900, level: 'once', createdAt: '2026-11-01T00:00:00Z', ...overrides };
}

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'i1', goalId: 'g1', title: '任务', subject: 'math',
    estimateMin: 120, remainingMin: 120, weight: 3, ...overrides,
  } as PlanItem;
}

function block(overrides: Partial<Block> = {}): Block {
  return {
    id: 'b1', itemId: 'i1', date: '2026-11-03', startMin: 1140, endMin: 1200,
    isBuffer: false, status: 'pending', ...overrides,
  };
}

describe('evaluateAlerts', () => {
  it('健康状态：负载充足、进度正常、执行连续 → 无预警', () => {
    const blocks = [block({ date: '2026-11-07', status: 'done', actualMin: 120 })];
    const alerts = evaluateAlerts({ goal: goal(), items: [item()], blocks, settings, today: '2026-11-08' });
    expect(alerts).toHaveLength(0);
  });

  it('剩余需求远超可用时间 → danger', () => {
    // deadline 3 天后，需求 20 小时，可用只有 2.5+2+0 小时×0.85
    const alerts = evaluateAlerts({
      goal: goal({ deadline: '2026-11-11' }),
      items: [item({ remainingMin: 1200 })],
      blocks: [],
      settings,
      today: '2026-11-08',
    });
    expect(alerts.some((a) => a.kind === 'deadline-risk' && a.level === 'danger')).toBe(true);
  });

  it('需求略超可用 → warn', () => {
    // deadline 7 天后（11-15），需求 900 分钟；可用 = 周一至周五 150×5 + 周六 120 + 周日 0 = 870×0.85 = 739.5 → ratio 1.22
    // 要构造 ratio 在 1~1.15：需求 850 → 850/739.5 ≈ 1.15 边界；取 800 → 1.082
    const alerts = evaluateAlerts({
      goal: goal({ deadline: '2026-11-15' }),
      items: [item({ remainingMin: 800 })],
      blocks: [],
      settings,
      today: '2026-11-08',
    });
    expect(alerts.some((a) => a.kind === 'deadline-risk' && a.level === 'warn')).toBe(true);
  });

  it('本周进度落后（完成率 < 60%）→ warn', () => {
    // 2026-11-08 是周日，本周 11-02 起已过 6 天
    const blocks = [
      block({ id: 'b1', date: '2026-11-02' }),
      block({ id: 'b2', date: '2026-11-03' }),
      block({ id: 'b3', date: '2026-11-04' }),
    ];
    const alerts = evaluateAlerts({
      goal: goal({ deadline: '2027-05-01' }),
      items: [item()],
      blocks,
      settings,
      today: '2026-11-08',
    });
    expect(alerts.some((a) => a.kind === 'week-behind')).toBe(true);
  });

  it('连续 3 天无执行且曾执行过 → danger；全新用户不触发', () => {
    const history = [block({ id: 'old', date: '2026-11-02', status: 'done', actualMin: 60 })];
    const withBreak = evaluateAlerts({
      goal: goal({ deadline: '2027-05-01' }),
      items: [item()],
      blocks: history,
      settings,
      today: '2026-11-08',
    });
    expect(withBreak.some((a) => a.kind === 'streak-broken' && a.level === 'danger')).toBe(true);

    const fresh = evaluateAlerts({
      goal: goal({ deadline: '2027-05-01' }),
      items: [item()],
      blocks: [],
      settings,
      today: '2026-11-08',
    });
    expect(fresh.some((a) => a.kind === 'streak-broken')).toBe(false);
  });
});
