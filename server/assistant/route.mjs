/**
 * 意图路由：只做「数据类 / 知识类」的二分，纯函数，不碰数据库也不碰模型。
 *
 * SPEC §5.1 的顺序是「命中数据指代词 → B」「检索分 ≥5 → A」「其余兜底」。
 * 一、三步分别在 chat 层与 retrieval 层完成，这里只承担第一步。
 *
 * **与 SPEC §5.1.1 的一处偏差（已记入 DECISIONS D9.1）**：
 * 原表把裸词「偏差」「归因」列为数据指代词，但附录 A 第 15、16 条的验收问法
 * 「估时偏差的中位数和P90怎么看」「三类归因分别指什么」本身就含这两个词，
 * 若按裸词匹配会被判成数据类，R2 的 24/24 立刻失败。两者冲突时以验收为准，
 * 故改为带限定的组合（「偏差是多少」「归因是什么」等）：
 * 「我这周偏差多少」仍因「我这周」命中数据类，概念提问则留在知识类。
 */

/** 数据指代词：子串匹配，命中即数据类（SPEC §5.1.1，去掉了两个冲突裸词） */
export const DATA_PRONOUNS = [
  '我这周',
  '我本周',
  '我的目标',
  '我的计划',
  '我的任务',
  '还剩',
  '剩多少',
  '来不来得及',
  '还来得及',
  '达成率',
  '完成率',
  '偏差是多少',
  '偏差多大',
  '我的偏差',
  '归因是什么',
  '我的归因',
  '排满',
  '空着',
  '为什么没排',
  '为什么只排',
  '今天任务',
  '今天的安排',
  '排了多久',
  '这周安排',
  '本周安排',
  '完不成',
];

/**
 * 一次提问要调哪几个只读工具（SPEC R3：单次 ≤3 次）。
 *
 * 走关键词而不是让模型自己选工具：阶段 2 的模型不接 function calling，
 * 少一层不确定性，也便于用固定问法回归。顺序固定（Set 插入序），测试可逐项断言。
 */
export function planTools(question) {
  const text = String(question ?? '');
  const has = (...words) => words.some((word) => text.includes(word));

  // 明确被问到的工具优先占名额；`get_week` 是补位用的上下文，名额不够时先让位，
  // 否则「我的目标这周可用时间」会把 get_settings 挤掉，反而答不出「能学多久」。
  const primary = [];
  const context = new Set();

  if (has('目标', '可行', '来不来得及', '还来得及', 'R值')) primary.push('get_goal');
  if (has('今天', '今日')) primary.push('get_today');
  if (has('这周', '本周', '周报', '达成率', '完成率', '偏差', '归因')) {
    primary.push('get_report');
    context.add('get_week');
  }
  if (has('可用时间', '能学多久', '排满', '空着')) {
    primary.push('get_settings');
    context.add('get_week');
  }

  const picked = [...new Set(primary)];
  for (const name of context) {
    if (picked.length >= 3) break;
    if (!picked.includes(name)) picked.push(name);
  }

  // 什么都没匹配上时至少给周视图：数据类问题总要有事实可依
  if (picked.length === 0) picked.push('get_week');
  return picked.slice(0, 3);
}

/**
 * 判定问题类型。
 *
 * 返回值只有 `data` / `knowledge` 两种：知识类内部是否命中语料由检索器决定，
 * 「兜底」不是一个模式，而是知识类没命中时的表现（citations 为空）。
 */
export function classify(question) {
  const text = String(question ?? '');
  if (!text) return 'knowledge';
  for (const word of DATA_PRONOUNS) {
    if (text.includes(word)) return 'data';
  }
  return 'knowledge';
}
