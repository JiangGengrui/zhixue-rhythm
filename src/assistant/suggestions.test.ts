import { describe, expect, it } from 'vitest';
import { FEEDBACK_REASONS, feedbackPayload, suggestionsFor } from './suggestions';

describe('空态建议问题（R8）', () => {
  it('两组都是 4 条，且全是数据类（功能答疑已移除）', () => {
    for (const hasData of [true, false]) {
      const list = suggestionsFor(hasData);
      expect(list).toHaveLength(4);
      expect(list.every((item) => item.mode === 'data')).toBe(true);
    }
  });

  it('按有无数据切换：没数据时不问「还剩多少」', () => {
    const empty = suggestionsFor(false).map((item) => item.text);
    const full = suggestionsFor(true).map((item) => item.text);

    expect(empty).not.toEqual(full);
    expect(empty.some((text) => text.includes('还剩'))).toBe(false);
    expect(full.some((text) => text.includes('还剩'))).toBe(true);
  });

  it('文案非空且不会超过提问上限', () => {
    for (const item of [...suggestionsFor(true), ...suggestionsFor(false)]) {
      expect(item.text.trim().length).toBeGreaterThan(0);
      expect(item.text.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('反馈载荷（R9）', () => {
  it('原因只有三种，顺序稳定', () => {
    expect(FEEDBACK_REASONS.map((reason) => reason.value)).toEqual(['wrong', 'unclear', 'not_wanted']);
  });

  it('取消只发 value: null，赞不带原因，踩带原因', () => {
    expect(feedbackPayload(null)).toEqual({ value: null });
    expect(feedbackPayload('up', 'wrong')).toEqual({ value: 'up' });
    expect(feedbackPayload('down', 'unclear')).toEqual({ value: 'down', reason: 'unclear' });
  });
});
