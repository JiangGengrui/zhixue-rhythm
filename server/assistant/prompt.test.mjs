import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEGRADED_DATA_TEXT, HISTORY_ROUNDS, PROMPT_VERSION, SYSTEM_BLOCKS,
  buildRequestMessages, buildSystemPrompt, trimHistory,
} from './prompt.mjs';

/** 造 n 轮对话（一提问一回答算一轮） */
function makeHistory(rounds) {
  const list = [];
  for (let i = 1; i <= rounds; i += 1) {
    list.push({ role: 'user', content: `第${i}轮提问` });
    list.push({ role: 'assistant', content: `第${i}轮回答` });
  }
  return list;
}

test('上下文只带最近 3 轮（SPEC §5.2）', () => {
  const history = makeHistory(5);
  const kept = trimHistory(history);
  // 10 条里留最后 6 条 = 第 3 轮提问起
  assert.equal(kept.length, HISTORY_ROUNDS * 2);
  assert.equal(kept[0].content, '第3轮提问');
  assert.equal(kept.at(-1).content, '第5轮回答');
});

test('5 轮对话时请求 messages ≤ 8 条，且第 1 轮不出现', () => {
  const messages = buildRequestMessages({ question: '这周还剩多少任务', history: makeHistory(5) });
  assert.ok(messages.length <= 8, `实际 ${messages.length} 条`);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1).content, '这周还剩多少任务');
  assert.equal(messages.some((m) => String(m.content).includes('第1轮')), false);
});

test('历史末条与本轮问题相同则不重复追加', () => {
  // 真实场景：上一次请求写了 user 消息但回答中断，history 末条就是同一句提问
  const history = [
    { role: 'assistant', content: '上一次的回答。' },
    { role: 'user', content: '打卡怎么用' },
  ];
  const messages = buildRequestMessages({ question: '打卡怎么用', history });
  assert.equal(messages.length, 3, 'system + history 两条，不再追加重复提问');
  assert.equal(messages.at(-1).content, '打卡怎么用');
  assert.equal(messages.filter((m) => m.role === 'user').length, 1);
});

test('system 三块齐全：边界、规范、事实规则', () => {
  assert.ok(SYSTEM_BLOCKS.boundary.length > 0);
  assert.ok(SYSTEM_BLOCKS.style.length > 0);
  assert.ok(SYSTEM_BLOCKS.facts.length > 0);

  const knowledge = buildSystemPrompt({ mode: 'knowledge' });
  assert.ok(knowledge.includes('不回答与产品无关'));
  assert.ok(knowledge.includes('2–4 条要点'));
  assert.equal(knowledge.includes('当前用户数据'), false, 'A 类不带数据区块');

  const data = buildSystemPrompt({ mode: 'data', facts: { remaining: 3 } });
  assert.ok(data.includes('当前用户数据'));
  assert.ok(data.includes('"remaining": 3'));
  assert.ok(data.includes('hasData=false'));
});

test('PROMPT_VERSION 非空且在模板变更时需要跟着改', () => {
  assert.match(PROMPT_VERSION, /^v\d+$/);
});

test('降级文案与 SPEC 附录 B 一致，且不含任何数字', () => {
  assert.equal(DEGRADED_DATA_TEXT, '暂时取不到你的数据，请稍后再问；功能用法我可以直接回答。');
  assert.equal(/\d/.test(DEGRADED_DATA_TEXT), false, '降级文案不能出现数字，否则会被当成数据结论');
});
