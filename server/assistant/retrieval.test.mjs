import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, answerFromKnowledge, normalize, bigrams } from './retrieval.mjs';

test('归一化去掉标点空白并统一小写', () => {
  assert.equal(normalize('  重排，顺延？ '), '重排顺延');
  assert.equal(normalize('CSV 导出'), 'csv导出');
});

test('二元组切分对中文短句成立', () => {
  assert.deepEqual([...bigrams('打卡')].sort(), ['打卡']);
  assert.deepEqual([...bigrams('a')], ['a']);
});

test('术语类提问命中重排方案', () => {
  const hits = search('重排里的顺延是什么意思');
  assert.equal(hits[0]?.id, 'replan-options');
});

test('功能类提问命中导出', () => {
  const hits = search('怎么导出数据');
  assert.equal(hits[0]?.id, 'export');
});

test('离线场景命中离线说明', () => {
  const hits = search('断网还能打卡吗');
  assert.equal(hits[0]?.id, 'offline');
});

test('空档期提问命中今日为空的原因', () => {
  const hits = search('今天怎么没有安排任务');
  assert.equal(hits[0]?.id, 'no-block-today');
});

test('无关问题不硬凑答案', () => {
  assert.deepEqual(search('今天天气怎么样'), []);
  assert.deepEqual(search(''), []);
});

test('降级回答带引用，且引用不超过 3 条', () => {
  const reply = answerFromKnowledge('怎么设置目标');
  assert.equal(reply.mode, 'knowledge');
  assert.ok(reply.text.length > 0);
  assert.ok(reply.citations.length > 0 && reply.citations.length <= 3);
  assert.ok(reply.citations.every((c) => c.title && c.doc));
});

test('检索不到时不编造，给可问范围', () => {
  const reply = answerFromKnowledge('帮我写一首诗');
  assert.equal(reply.mode, 'fallback');
  assert.deepEqual(reply.citations, []);
  assert.match(reply.text, /不猜|可以问/);
});
