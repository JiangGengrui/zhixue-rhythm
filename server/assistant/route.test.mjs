import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_PRONOUNS, classify, planTools } from './route.mjs';
import { KNOWLEDGE } from './knowledge.mjs';

/** SPEC 附录 A 的 24 条触发问法：这些必须留在知识类，否则 R2 的 24/24 直接失败 */
const KNOWLEDGE_PROBES = [
  '怎么设置目标', '可行性R值是什么意思', '智能拆解怎么用', '每周可用时间在哪设置',
  '生成本周计划按什么规则排', '今天没有任务', '怎么调整任务块的时间',
  '重排里的顺延和压缩是什么意思', '为什么提示不能重排', '打卡怎么用',
  '完成的时候要填什么', '不想做可以跳过吗', '昨天忘了打卡怎么办', '周报看哪几个数',
  '估时偏差的中位数和P90怎么看', '三类归因分别指什么', '通知中心会推什么',
  '断网还能打卡吗', '怎么导出数据', '忘记密码怎么办', '我的数据别人能看到吗',
  '这个项目用了什么技术栈', '和别的计划工具有什么区别', '线上部署在哪',
];

test('附录 A 的 24 条问答全部判为知识类（不被数据指代词抢走）', () => {
  const stolen = KNOWLEDGE_PROBES.filter((q) => classify(q) === 'data');
  assert.deepEqual(stolen, [], `被误判为数据类的问法：${stolen.join('、')}`);
});

test('10 条数据问法全部判为数据类（SPEC R3）', () => {
  const probes = [
    '我这周还剩多少任务', '我为什么完不成', '周三为什么空着', '这周达成率多少',
    '我的目标可行吗', '我的计划排满了吗', '今天的安排是什么', '估时偏差是多少',
    '三类归因是什么', '这周安排来得及吗',
  ];
  const missed = probes.filter((q) => classify(q) !== 'data');
  assert.deepEqual(missed, [], `漏判：${missed.join('、')}`);
});

test('裸词「今天」「为什么」「我的」不参与判定（SPEC §5.1.1 注释）', () => {
  assert.equal(classify('今天没有任务'), 'knowledge');
  assert.equal(classify('我的数据别人能看到吗'), 'knowledge');
  assert.equal(classify('为什么会这样'), 'knowledge');
});

test('指代词表里不出现会导致附录 A 误判的裸词', () => {
  assert.equal(DATA_PRONOUNS.includes('偏差'), false);
  assert.equal(DATA_PRONOUNS.includes('归因'), false);
  // 但限定词仍在，数据类问题照样能判对
  assert.equal(classify('我的偏差大吗'), 'data');
  assert.equal(classify('我的归因是什么'), 'data');
});

test('空问题与空白不抛错', () => {
  assert.equal(classify(''), 'knowledge');
  assert.equal(classify(undefined), 'knowledge');
  assert.equal(classify('   '), 'knowledge');
});

test('planTools：按问法挑工具，顺序稳定且 ≤3 个（SPEC R3）', () => {
  assert.deepEqual(planTools('这周达成率多少'), ['get_report', 'get_week']);
  assert.deepEqual(planTools('我的目标可行吗'), ['get_goal']);
  assert.deepEqual(planTools('今天的安排是什么'), ['get_today']);
  assert.deepEqual(planTools('每周可用时间还能排满吗'), ['get_settings', 'get_week']);
  // 一句话同时命中三类也必须收敛到 3 个以内，且被明确问到的工具优先（get_week 让位）
  assert.deepEqual(planTools('我的目标这周可用时间'), ['get_goal', 'get_report', 'get_settings']);
  const crowded = planTools('我的目标这周今天可用时间');
  assert.ok(crowded.length <= 3, `实际 ${crowded.length} 个`);
  assert.deepEqual(crowded, ['get_goal', 'get_today', 'get_report']);
});

test('planTools：一句话都没匹配上时兜底给 get_week', () => {
  assert.deepEqual(planTools('还剩多少'), ['get_week']);
  assert.deepEqual(planTools(''), ['get_week']);
});

test('SPEC §5.1 的对照样例：一字之差分别进 A 与 B', () => {
  // 「今天为什么没排任务」含「为什么没排」→ 数据类
  assert.equal(classify('今天为什么没排任务'), 'data');
  // 「今天没有任务」不含指代词 → 知识类，命中 no-block-today
  assert.equal(classify('今天没有任务'), 'knowledge');
  assert.equal(KNOWLEDGE.some((e) => e.id === 'no-block-today'), true);
});
