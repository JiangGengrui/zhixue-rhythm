import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport } from '../engine.generated.mjs';
import {
  TOOL_NAMES, buildFacts, createToolbox, runWithTimeout, weekStartFor,
} from './tools.mjs';

/** 2026-11-09 是周一，便于按周对齐 */
const STATE = {
  goal: {
    id: 'g1', title: '考研数学', deadline: '2026-12-20', weeklyMinutes: 600, level: 'once',
  },
  items: [
    { id: 'i1', goalId: 'g1', title: '高数第一章', subject: 'math', estimateMin: 120 },
    { id: 'i2', goalId: 'g1', title: '线代第二章', subject: 'math', estimateMin: 60 },
  ],
  blocks: [
    {
      id: 'b1', itemId: 'i1', date: '2026-11-09', startMin: 540, endMin: 660,
      isBuffer: false, status: 'done', actualMin: 110, accumulatedSec: 6600,
    },
    {
      id: 'b2', itemId: 'i2', date: '2026-11-10', startMin: 540, endMin: 600,
      isBuffer: false, status: 'pending', accumulatedSec: 0,
    },
    {
      id: 'b3', itemId: null, date: '2026-11-10', startMin: 600, endMin: 630,
      isBuffer: true, status: 'pending', accumulatedSec: 0,
    },
  ],
  settings: { weekStart: 1, weekdays: [60, 0, 0, 0, 0, 0, 0] },
};

const toolbox = () => createToolbox({ state: STATE, today: '2026-11-09' });

test('白名单恰好是 SPEC R3 的五个工具', () => {
  assert.deepEqual(toolbox().names, TOOL_NAMES);
  assert.deepEqual(TOOL_NAMES, ['get_goal', 'get_week', 'get_today', 'get_report', 'get_settings']);
});

test('get_goal：给出目标与可行性 R 值', async () => {
  const result = await toolbox().call('get_goal');
  assert.equal(result.status, 'ok');
  assert.equal(result.data.hasData, true);
  assert.equal(result.data.goal.title, '考研数学');
  assert.equal(result.data.feasibility.demandMin, 180);
  assert.equal(typeof result.data.feasibility.ratio, 'number');
  assert.equal(typeof result.data.feasibility.verdict, 'string');
});

test('get_goal：没有目标时 hasData=false，不编造 R 值', async () => {
  const empty = createToolbox({ state: { ...STATE, goal: null }, today: '2026-11-09' });
  const result = await empty.call('get_goal');
  assert.deepEqual(result.data, { hasData: false, goal: null });
});

test('get_goal：截止日已过时 ratio 为 null，不是 Infinity（JSON 里会变 null）', async () => {
  const overdue = createToolbox({
    state: { ...STATE, goal: { ...STATE.goal, deadline: '2026-01-01' } },
    today: '2026-11-09',
  });
  const result = await overdue.call('get_goal');
  assert.equal(result.data.feasibility.ratio, null);
  assert.equal(result.data.feasibility.verdict, 'infeasible');
  // 整个返回必须能安全 JSON 化
  assert.doesNotThrow(() => JSON.stringify(result.data));
});

test('get_week：按天聚合，缓冲块单列、不计入任务时长', async () => {
  const result = await toolbox().call('get_week', { weekStart: '2026-11-09' });
  assert.equal(result.status, 'ok');
  assert.equal(result.data.weekStart, '2026-11-09');
  assert.equal(result.data.weekEnd, '2026-11-15');
  assert.equal(result.data.days.length, 7);
  assert.equal(result.data.plannedMin, 180, '120 + 60，缓冲 30 不算任务');
  assert.equal(result.data.doneCount, 1);

  const tuesday = result.data.days.find((day) => day.date === '2026-11-10');
  assert.equal(tuesday.totalMin, 60);
  assert.equal(tuesday.bufferMin, 30);
  assert.equal(tuesday.blocks.length, 1);
  assert.equal(tuesday.blocks[0].title, '线代第二章');
});

test('get_today：累计时长由秒换算为分钟，非法日期回落到 today', async () => {
  const result = await toolbox().call('get_today', { date: '2026-11-09' });
  assert.equal(result.data.date, '2026-11-09');
  assert.equal(result.data.totalMin, 120);
  assert.equal(result.data.doneCount, 1);
  assert.equal(result.data.accumulatedMin, 110);

  const fallback = await toolbox().call('get_today', { date: '周二' });
  assert.equal(fallback.data.date, '2026-11-09', '服务端只校验格式，不做时区换算');
});

test('get_today：当天没有任务时 hasData=false', async () => {
  const result = await toolbox().call('get_today', { date: '2026-11-14' });
  assert.equal(result.data.hasData, false);
  assert.equal(result.data.totalMin, 0);
});

test('get_report：与 GET /api/report 同源（直接复用 buildReport）', async () => {
  const result = await toolbox().call('get_report', { weekStart: '2026-11-09' });
  const expected = buildReport(STATE.blocks, STATE.settings, '2026-11-09');
  assert.deepEqual(result.data, expected);
  // 周报要进 JSON 给模型读，不能有 Infinity / undefined
  const roundTrip = JSON.parse(JSON.stringify(result.data));
  assert.deepEqual(roundTrip, expected);
});

test('TOOL_NAMES 里每个名字都真的能调通（防止白名单与实现脱节）', async () => {
  const box = toolbox();
  for (const name of TOOL_NAMES) {
    const result = await box.call(name, { weekStart: '2026-11-09', date: '2026-11-09' });
    assert.equal(result.status, 'ok', `${name} 调用失败：${result.error ?? ''}`);
    assert.notEqual(result.error, '未知工具', `${name} 只在白名单里，没有实现`);
  }
});

test('get_settings：7 天可用分钟与合计', async () => {
  const result = await toolbox().call('get_settings');
  assert.deepEqual(result.data.weekdays, STATE.settings.weekdays);
  assert.equal(result.data.weeklyTotal, 60);
});

test('未知工具返回 fail 而不是抛错（模型可能瞎编工具名）', async () => {
  const result = await toolbox().call('drop_table');
  assert.equal(result.status, 'fail');
  assert.equal(result.error, '未知工具');
});

test('weekStartFor：按周起始日归周（周一 / 周日两种设置）', () => {
  assert.equal(weekStartFor('2026-11-09', 1), '2026-11-09');
  assert.equal(weekStartFor('2026-11-11', 1), '2026-11-09');
  assert.equal(weekStartFor('2026-11-11', 0), '2026-11-08');
  assert.equal(weekStartFor('2026-11-15', 0), '2026-11-15', '周日当天归到周日起始');
});

test('get_week 默认取「今天所在的周」，不是从今天起算 7 天', async () => {
  // 周三提问，也必须拿到周一那一整周的数据
  const box = createToolbox({ state: STATE, today: '2026-11-11' });
  const result = await box.call('get_week');
  assert.equal(result.data.weekStart, '2026-11-09');
  assert.equal(result.data.weekEnd, '2026-11-15');
  assert.equal(result.data.plannedMin, 180);
});

test('buildFacts：全失败返回 null（不许调模型），部分失败标出 failedTools', () => {
  assert.equal(buildFacts([]), null);
  assert.equal(buildFacts([{ name: 'get_week', status: 'fail' }]), null);

  const facts = buildFacts([
    { name: 'get_week', status: 'ok', data: { hasData: true, plannedMin: 180 } },
    { name: 'get_report', status: 'fail' },
  ]);
  assert.equal(facts.hasData, true);
  assert.deepEqual(facts.failedTools, ['get_report']);
  assert.equal(facts.tools.get_week.plannedMin, 180);

  const empty = buildFacts([{ name: 'get_goal', status: 'ok', data: { hasData: false } }]);
  assert.equal(empty.hasData, false, '取到工具但确实没数据，要如实说「还没有记录」');
});

test('工具超时：超时返回 fail，不把异常抛给调用方', async () => {
  await assert.rejects(
    runWithTimeout(() => new Promise((resolve) => setTimeout(resolve, 50)), 5),
    /工具执行超时/,
  );

  // 正常路径不受影响
  assert.equal(await runWithTimeout(() => 42, 50), 42);
});
