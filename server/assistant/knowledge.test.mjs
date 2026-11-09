import assert from 'node:assert/strict';
import test from 'node:test';
import { KNOWLEDGE, ROUTES } from './knowledge.mjs';
import { answerFromKnowledge, FALLBACK_TEXT, search } from './retrieval.mjs';

/** 与 src/App.tsx 的 TABS 保持一致：hash 只能落在这五个页面上 */
const TABS = ['today', 'goal', 'week', 'report', 'settings'];
/** SPEC R2：24 条语料里 21 条可跳转，3 条无对应页面 */
const NO_ROUTE_IDS = ['tech', 'design', 'deploy'];

test('语料共 24 条，id 不重复', () => {
  assert.equal(KNOWLEDGE.length, 24);
  assert.equal(new Set(KNOWLEDGE.map((e) => e.id)).size, 24);
});

test('route 契约：21 条指向 Tab、3 条为 null', () => {
  const withRoute = KNOWLEDGE.filter((e) => typeof e.route === 'string');
  const withoutRoute = KNOWLEDGE.filter((e) => e.route === null);

  assert.equal(withRoute.length, 21);
  assert.deepEqual(withoutRoute.map((e) => e.id).sort(), [...NO_ROUTE_IDS].sort());
  for (const entry of withRoute) {
    assert.ok(TABS.includes(entry.route), `${entry.id} 的 route=${entry.route} 不是有效 Tab`);
  }
});

test('ROUTES 覆盖全部 id，不靠 ?? null 兜错', () => {
  assert.deepEqual(Object.keys(ROUTES).sort(), KNOWLEDGE.map((e) => e.id).sort());
});

test('每条语料都有非空 answer 与可核对的 doc', () => {
  for (const entry of KNOWLEDGE) {
    assert.ok(entry.answer.length > 0, `${entry.id} 缺 answer`);
    assert.ok(entry.doc.length > 0, `${entry.id} 缺 doc`);
    assert.ok(entry.keys.length > 0, `${entry.id} 缺 keys`);
  }
});

/** SPEC 附录 A 的触发问法，验收要求 hits[0].id 全部相等（24/24） */
const PROBES = [
  ['怎么设置目标', 'goal-set'],
  ['可行性R值是什么意思', 'feasibility'],
  ['智能拆解怎么用', 'decompose'],
  ['每周可用时间在哪设置', 'capacity'],
  ['生成本周计划按什么规则排', 'generate'],
  ['今天没有任务', 'no-block-today'],
  ['怎么调整任务块的时间', 'block-edit'],
  ['重排里的顺延和压缩是什么意思', 'replan-options'],
  ['为什么提示不能重排', 'replan-limit'],
  ['打卡怎么用', 'checkin'],
  ['完成的时候要填什么', 'done-form'],
  ['不想做可以跳过吗', 'skip'],
  ['昨天忘了打卡怎么办', 'backfill'],
  ['周报看哪几个数', 'report-metrics'],
  ['估时偏差的中位数和P90怎么看', 'deviation'],
  ['三类归因分别指什么', 'causes'],
  ['通知中心会推什么', 'notifications'],
  ['断网还能打卡吗', 'offline'],
  ['怎么导出数据', 'export'],
  ['忘记密码怎么办', 'account'],
  ['我的数据别人能看到吗', 'isolation'],
  ['这个项目用了什么技术栈', 'tech'],
  ['和别的计划工具有什么区别', 'design'],
  ['线上部署在哪', 'deploy'],
];

test('附录 A：24 条触发问法全部命中预期 id', () => {
  const missed = [];
  for (const [question, id] of PROBES) {
    const top = search(question)[0];
    if (top?.id !== id) missed.push(`${question} → ${top?.id ?? '(未命中)'}，预期 ${id}`);
  }
  assert.deepEqual(missed, [], missed.join('\n'));
});

test('附录 A：命中条目的 route 与附录一致', () => {
  const expected = {
    'goal-set': 'goal',
    feasibility: 'goal',
    decompose: 'goal',
    capacity: 'settings',
    generate: 'week',
    'no-block-today': 'today',
    'block-edit': 'week',
    'replan-options': 'week',
    'replan-limit': 'week',
    checkin: 'today',
    'done-form': 'today',
    skip: 'today',
    backfill: 'today',
    'report-metrics': 'report',
    deviation: 'report',
    causes: 'report',
    notifications: 'today',
    offline: 'today',
    export: 'settings',
    account: 'settings',
    isolation: 'settings',
    tech: null,
    design: null,
    deploy: null,
  };
  assert.deepEqual(ROUTES, expected);
});

test('附录 B：8 条探针全部落入兜底文案', () => {
  for (const probe of [
    '帮我写首诗', '今天天气怎么样', '帮我写一段 Python 代码', '你是 GPT 吗',
    '给我推荐一部电影', '帮我翻译这句话', '我该不该退学', '1+1 等于几',
  ]) {
    const reply = answerFromKnowledge(probe);
    assert.equal(reply.mode, 'fallback', probe);
    assert.deepEqual(reply.citations, [], probe);
    assert.equal(reply.text, FALLBACK_TEXT, probe);
  }
});

test('引用把 route 透给前端，可点与不可点都能区分', () => {
  const hit = answerFromKnowledge('怎么导出数据');
  assert.equal(hit.citations[0].route, 'settings');

  const plain = answerFromKnowledge('这个项目用了什么技术');
  assert.equal(plain.citations[0].route, null);
});
