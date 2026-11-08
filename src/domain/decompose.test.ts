import { describe, expect, it } from 'vitest';
import { decomposeGoal } from './decompose';
import { TEMPLATES, TEMPLATE_LIST } from './templates';
import type { GoalTemplate } from './types';

const base = {
  template: 'postgrad-cs' as GoalTemplate,
  today: '2026-11-09',
  deadline: '2027-05-09',
  weeklyMinutes: 900,
  level: 'once' as const,
};

describe('decomposeGoal · 拆解引擎', () => {
  it('宽松条件下不裁剪，计划项覆盖全部节点', () => {
    const result = decomposeGoal({ ...base, weeklyMinutes: 2400, deadline: '2027-12-01' });
    expect(result.trimmed).toHaveLength(0);
    expect(result.items.length).toBe(TEMPLATES['postgrad-cs'].nodes.length);
    const sum = result.items.reduce((s, i) => s + i.estimateMin, 0);
    expect(sum).toBe(result.demandMin);
    expect(result.verdict).toBe('comfortable');
  });

  it('时间不够时按「低频低分」优先裁断，并记录被放弃项', () => {
    const result = decomposeGoal({ ...base, weeklyMinutes: 300, deadline: '2026-12-21' });
    expect(result.trimmed.length).toBeGreaterThan(0);
    expect(result.trimmed[0]!.reason).toBe('low-priority');
    expect(result.demandMin).toBeLessThan(TEMPLATES['postgrad-cs'].nodes.reduce((s, n) => s + n.minutes, 0));
    expect(result.warnings.join('')).toContain('裁掉');
  });

  it('极紧条件下会动用第二顺位「已有基础」裁断', () => {
    const tight = decomposeGoal({ ...base, weeklyMinutes: 120, deadline: '2026-12-07', level: 'more' });
    expect(tight.trimmed.some((t) => t.reason === 'mastered')).toBe(true);
    expect(tight.demandMin).toBeLessThanOrEqual(tight.availableMin);
  });

  it('基础越好，裁断前的原始需求越小', () => {
    const once = decomposeGoal({ ...base, weeklyMinutes: 100000, deadline: '2027-12-31', level: 'once' });
    const twice = decomposeGoal({ ...base, weeklyMinutes: 100000, deadline: '2027-12-31', level: 'twice' });
    expect(twice.demandMin).toBeLessThan(once.demandMin);
  });

  it('考公模板使用 35/40/25 的阶段比例', () => {
    const result = decomposeGoal({ ...base, template: 'civil-service', weeklyMinutes: 900, deadline: '2027-02-01' });
    expect(result.stageRatio).toEqual([0.35, 0.4, 0.25]);
    expect(result.stages.map((s) => s.key)).toEqual(['foundation', 'strengthen', 'sprint']);
    expect(result.stages[0]!.milestone).toContain('正确率');
  });

  it('阶段合计等于需求工时，且阶段日期连续', () => {
    const result = decomposeGoal({ ...base, weeklyMinutes: 1200, deadline: '2027-03-01' });
    const stageSum = result.stages.reduce((s, st) => s + st.minutes, 0);
    expect(stageSum).toBe(result.demandMin);
    expect(result.stages[0]!.endDate < result.stages[1]!.startDate).toBe(true);
    expect(result.stages[1]!.endDate < result.stages[2]!.startDate).toBe(true);
  });

  it('同一输入两次结果完全一致（确定性）', () => {
    const a = decomposeGoal({ ...base, weeklyMinutes: 600, deadline: '2027-02-01' });
    const b = decomposeGoal({ ...base, weeklyMinutes: 600, deadline: '2027-02-01' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('目标日期已过时给出明确告警而不是 NaN', () => {
    const result = decomposeGoal({ ...base, deadline: '2026-11-01' });
    expect(Number.isFinite(result.demandMin)).toBe(true);
    expect(result.warnings.join('')).toContain('无法拆解');
  });

  it('模板清单可直接给前端做选择器', () => {
    expect(TEMPLATE_LIST.length).toBe(3);
    for (const t of TEMPLATE_LIST) {
      expect(t.nodeCount).toBeGreaterThan(0);
      expect(t.totalMinutes).toBeGreaterThan(0);
    }
  });
});
