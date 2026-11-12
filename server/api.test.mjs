import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './index.mjs';
import { KNOWLEDGE } from './assistant/knowledge.mjs';
import { FALLBACK_TEXT } from './assistant/retrieval.mjs';
import { MAX_DAILY_QUESTIONS } from './assistant/sessions.mjs';
import { DEGRADED_DATA_TEXT } from './assistant/prompt.mjs';
import { FAULT_KINDS } from './assistant/faults.mjs';
import { createToolbox } from './assistant/tools.mjs';
import { todayISO } from './engine.generated.mjs';

// 测试必须自洽：本机若配了真实的 ASSISTANT_API_KEY，B 类用例会真的去请求上游，
// 结果取决于网络而不是代码。服务启动前清掉，保证「无 Key」是确定的前提。
delete process.env.ASSISTANT_API_KEY;
// 账号相关用例断言「未登录 = 401」，这里显式关掉演示免登录；
// 免登录本身由文件末尾的用例单独验证（临时把开关打回 1）。
process.env.ZHIXUE_DEMO = '0';

const app = startServer({ dbFile: ':memory:' });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

async function call(method, path, body, cookie) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 无响应体 */
  }
  return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

/** 全库首个注册用户即管理员（迁移规则），记录其会话供管理类测试使用 */
const adminSession = { cookie: null };

async function register(email, name = '测试用户') {
  const r = await call('POST', '/api/auth/register', { email, password: 'password123', name });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (!adminSession.cookie) adminSession.cookie = r.cookie;
  return { cookie: r.cookie, user: r.json.user };
}

test('未登录访问受保护接口返回 401', async () => {
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'E2001');
});

test('免注册登录：新建独立游客账号并下发会话', async () => {
  const a = await call('POST', '/api/auth/guest', {});
  assert.equal(a.status, 200);
  assert.equal(a.json.guest, true);
  assert.ok(a.cookie, '应下发会话 cookie');

  const me = await call('GET', '/api/me', null, a.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.name, '测试同学');

  // 每次都是新账号，数据互相隔离
  const b = await call('POST', '/api/auth/guest', {});
  assert.notEqual(b.json.user.id, a.json.user.id);

  // 游客账号没有可用密码，不能从登录接口进来
  const bad = await call('POST', '/api/auth/login', {
    email: a.json.user.email,
    password: 'guest$no-login$0',
  });
  assert.equal(bad.status, 401);
});

test('注册、重复注册与错误密码登录', async () => {
  const a = await register('a@test.dev');
  assert.ok(a.cookie);

  const dup = await call('POST', '/api/auth/register', { email: 'a@test.dev', password: 'password123' });
  assert.equal(dup.status, 409);

  const bad = await call('POST', '/api/auth/login', { email: 'a@test.dev', password: 'wrongpass1' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'E2003');

  const ok = await call('POST', '/api/auth/login', { email: 'a@test.dev', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
});

test('完整链路：目标 → 计划项 → 生成周计划 → 打卡', async () => {
  const { cookie } = await register('flow@test.dev');

  const goal = await call('PUT', '/api/goal', {
    title: '2027 考研', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once',
  }, cookie);
  assert.equal(goal.status, 200);
  assert.equal(goal.json.goal.title, '2027 考研');

  const item = await call('POST', '/api/items', {
    title: '高数 40 题', subject: 'math', estimateMin: 120, weight: 5,
  }, cookie);
  assert.equal(item.status, 200);
  const itemId = item.json.item.id;

  const blocks = await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [
      { id: 'b1', itemId, date: '2026-11-02', startMin: 1140, endMin: 1260, isBuffer: false },
    ],
  }, cookie);
  assert.equal(blocks.status, 200);
  assert.equal(blocks.json.blocks.length, 1);
  assert.equal(blocks.json.blocks[0].status, 'pending');

  const done = await call('PATCH', '/api/blocks/b1', { status: 'done', actualMin: 130, opId: 'op-1' }, cookie);
  assert.equal(done.status, 200);
  assert.equal(done.json.block.status, 'done');
  assert.equal(done.json.block.actualMin, 130);

  // 同一 opId 重复提交：幂等，不重复计数、不报错
  const again = await call('PATCH', '/api/blocks/b1', { status: 'done', actualMin: 999, opId: 'op-1' }, cookie);
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent, true);
  assert.equal(again.json.block.actualMin, 130);

  const state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.blocks[0].status, 'done');
  assert.equal(state.json.goal.weeklyMinutes, 900);
});

test('非法状态迁移与非法参数被拒绝', async () => {
  const { cookie } = await register('rules@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, cookie);
  const item = await call('POST', '/api/items', { title: 'i', subject: 'major', estimateMin: 60, weight: 3 }, cookie);
  const itemId = item.json.item.id;
  await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [{ id: 'x1', itemId, date: '2026-11-02', startMin: 1140, endMin: 1200 }],
  }, cookie);

  const done = await call('PATCH', '/api/blocks/x1', { status: 'done', actualMin: 60 }, cookie);
  assert.equal(done.status, 200);
  const back = await call('PATCH', '/api/blocks/x1', { status: 'running' }, cookie);
  assert.equal(back.status, 400);
  assert.equal(back.json.error.code, 'E1018');

  const badItem = await call('POST', '/api/items', { title: 'bad', subject: 'math', estimateMin: -5, weight: 3 }, cookie);
  assert.equal(badItem.status, 400);
  assert.equal(badItem.json.error.code, 'E1004');

  const badWeek = await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [{ id: 'x2', itemId, date: '2026-12-01', startMin: 1140, endMin: 1200 }],
  }, cookie);
  assert.equal(badWeek.status, 400);
});

test('用户数据隔离：不能读改他人任务块', async () => {
  const a = await register('iso-a@test.dev');
  const b = await register('iso-b@test.dev');

  await call('PUT', '/api/goal', { title: 'A 的目标', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, a.cookie);
  const item = await call('POST', '/api/items', { title: 'A 的任务', subject: 'math', estimateMin: 60, weight: 3 }, a.cookie);
  await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [{ id: 'a-block', itemId: item.json.item.id, date: '2026-11-02', startMin: 1140, endMin: 1200 }],
  }, a.cookie);

  const stateB = await call('GET', '/api/state', null, b.cookie);
  assert.equal(stateB.json.blocks.length, 0);
  assert.equal(stateB.json.items.length, 0);
  assert.equal(stateB.json.goal, null);

  const patchByB = await call('PATCH', '/api/blocks/a-block', { status: 'done', actualMin: 60 }, b.cookie);
  assert.equal(patchByB.status, 404);

  // B 不能把 A 的计划项塞进自己的周计划
  const steal = await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [{ id: 'b-block', itemId: item.json.item.id, date: '2026-11-03', startMin: 1140, endMin: 1200 }],
  }, b.cookie);
  assert.equal(steal.status, 400);
});

test('删除计划项同时清理其任务块', async () => {
  const { cookie } = await register('del@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, cookie);
  const item = await call('POST', '/api/items', { title: '待删除', subject: 'major', estimateMin: 60, weight: 3 }, cookie);
  const id = item.json.item.id;
  await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [{ id: 'd1', itemId: id, date: '2026-11-02', startMin: 1140, endMin: 1200 }],
  }, cookie);

  const del = await call('DELETE', `/api/items/${id}`, null, cookie);
  assert.equal(del.status, 200);

  const state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.items.length, 0);
  assert.equal(state.json.blocks.length, 0);
});

test('服务端生成周计划：支持从指定日期起排，并保留完成状态', async () => {
  const { cookie } = await register('gen@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  for (const title of ['A', 'B', 'C']) {
    await call('POST', '/api/items', { title, subject: 'major', estimateMin: 120, weight: 5 }, cookie);
  }

  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02', from: '2026-11-05' }, cookie);
  assert.equal(gen.status, 200, JSON.stringify(gen.json));
  assert.ok(gen.json.blocks.length > 0);
  for (const b of gen.json.blocks) assert.ok(b.date >= '2026-11-05', `排到了过去：${b.date}`);
  // 整周容量：默认七天都可用（120+150×5+120），from 只影响排程范围
  assert.equal(gen.json.capacityMin, 990);

  const first = gen.json.blocks[0];
  // 只完成一半工时：剩余量会再次排入，且完成状态被保留
  await call('PATCH', `/api/blocks/${first.id}`, { status: 'done', actualMin: 60 }, cookie);
  const again = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02', from: '2026-11-05' }, cookie);
  const kept = again.json.blocks.find((b) => b.id === first.id);
  assert.ok(kept, '剩余工时未重新排入');
  assert.equal(kept.status, 'done');
  assert.equal(kept.actualMin, 60);
});

test('服务端周报：指标来自真实记录且归因合计 100', async () => {
  const { cookie } = await register('rep@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'major', estimateMin: 120, weight: 5 }, cookie);
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const block = gen.json.blocks[0];
  await call('PATCH', `/api/blocks/${block.id}`, { status: 'done', actualMin: 150 }, cookie);

  const rep = await call('GET', '/api/report?week=2026-11-02', null, cookie);
  assert.equal(rep.status, 200);
  assert.equal(rep.json.hasData, true);
  assert.equal(rep.json.doneCount, 1);
  assert.ok(Math.abs(rep.json.achievement - 1) < 1e-9);
  assert.ok(rep.json.deviation.median > 0.2);
  const sum = rep.json.causes.reduce((s, c) => s + c.share, 0);
  assert.equal(sum, 100);

  const empty = await call('GET', '/api/report?week=2027-01-04', null, cookie);
  assert.equal(empty.json.hasData, false);
});

test('拒绝同一天时间重叠的任务块', async () => {
  const { cookie } = await register('overlap@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, cookie);
  const item = await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 60, weight: 3 }, cookie);
  const itemId = item.json.item.id;

  const res = await call('PUT', '/api/blocks', {
    weekStart: '2026-11-02',
    blocks: [
      { id: 'o1', itemId, date: '2026-11-02', startMin: 1140, endMin: 1200 },
      { id: 'o2', itemId, date: '2026-11-02', startMin: 1170, endMin: 1230 },
    ],
  }, cookie);
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'E1022');
});

test('设置接口：校验每日时长并影响周容量', async () => {
  const { cookie } = await register('settings@test.dev');

  const bad = await call('PUT', '/api/settings', { weekStart: 1, weekdays: [0, 60, 60] }, cookie);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'E1011');

  const tooBig = await call('PUT', '/api/settings', { weekStart: 1, weekdays: [0, 2000, 60, 60, 60, 0, 0] }, cookie);
  assert.equal(tooBig.status, 400);

  const ok = await call('PUT', '/api/settings', { weekStart: 0, weekdays: [60, 60, 60, 60, 60, 0, 0] }, cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.weekStart, 0);

  const state = await call('GET', '/api/state', null, cookie);
  assert.deepEqual(state.json.settings.weekdays, [60, 60, 60, 60, 60, 0, 0]);

  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 60, weight: 3 }, cookie);
  // 目标页的「每周可用」是容量单一事实源：填 600 会把每日分布按比例缩放（保留原来的 0 天）
  const afterGoal = await call('GET', '/api/state', null, cookie);
  assert.deepEqual(afterGoal.json.settings.weekdays, [120, 120, 120, 120, 120, 0, 0]);
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  assert.equal(gen.status, 200);
  assert.equal(gen.json.capacityMin, 600);
});

test('执行计时：开始、暂停、继续与计时推导用时', async () => {
  const { cookie } = await register('timer@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 60, weight: 5 }, cookie);
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const block = gen.json.blocks[0];

  const started = await call('PATCH', `/api/blocks/${block.id}`, { status: 'running' }, cookie);
  assert.equal(started.json.block.status, 'running');
  assert.ok(started.json.block.startedAt, '开始执行应记录 startedAt');

  const paused = await call('PATCH', `/api/blocks/${block.id}`, { action: 'pause' }, cookie);
  assert.equal(paused.json.block.startedAt, undefined, '暂停后不应在计时');
  assert.ok(paused.json.block.accumulatedSec >= 0);

  const resumed = await call('PATCH', `/api/blocks/${block.id}`, { action: 'resume' }, cookie);
  assert.ok(resumed.json.block.startedAt, '继续后应重新计时');

  // 未填 actualMin：由计时推导（刚继续，约 0-1 分钟，钳制为 ≥1）
  const done = await call('PATCH', `/api/blocks/${block.id}`, { status: 'done' }, cookie);
  assert.equal(done.json.block.status, 'done');
  assert.ok(done.json.block.actualMin >= 1);
  assert.equal(done.json.block.progressPct, 100);

  // 非运行状态不允许暂停
  const bad = await call('PATCH', `/api/blocks/${block.id}`, { action: 'pause' }, cookie);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'E1037');
});

test('补录标识与周报口径：计入达成与时长，不进偏差', async () => {
  const { cookie } = await register('mark@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  for (const t of ['A', 'B']) {
    await call('POST', '/api/items', { title: t, subject: 'math', estimateMin: 60, weight: 4 }, cookie);
  }
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const [first, second] = gen.json.blocks;

  // 计时完成：超时 50%
  await call('PATCH', `/api/blocks/${first.id}`, { status: 'done', actualMin: 90 }, cookie);
  // 补录：自报 600 分钟
  await call('PATCH', `/api/blocks/${second.id}`, { status: 'done', actualMin: 600, source: 'backfill' }, cookie);

  const state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.blocks.find((b) => b.id === second.id).source, 'backfill');
  assert.equal(state.json.blocks.find((b) => b.id === first.id).source, 'plan');

  const rep = await call('GET', '/api/report?week=2026-11-02', null, cookie);
  assert.equal(rep.json.doneCount, 2);
  assert.equal(rep.json.backfillCount, 1);
  assert.equal(rep.json.effectiveMin, 690);
  assert.equal(rep.json.deviation.count, 1, '偏差只统计计时记录');
});

test('撤销完成：剩余工时按完成度退还', async () => {
  const { cookie } = await register('refund@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  const item = await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 120, weight: 5 }, cookie);
  const itemId = item.json.item.id;
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const block = gen.json.blocks[0];

  await call('PATCH', `/api/blocks/${block.id}`, { status: 'done', actualMin: 60, progressPct: 50 }, cookie);
  let state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.items.find((i) => i.id === itemId).remainingMin, 60);

  await call('PATCH', `/api/blocks/${block.id}`, { status: 'pending' }, cookie);
  state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.items.find((i) => i.id === itemId).remainingMin, 120, '撤销后工作量应退还');
  const reverted = state.json.blocks.find((b) => b.id === block.id);
  assert.equal(reverted.status, 'pending');
  assert.equal(reverted.progressPct, undefined);
});

test('通知中心：预警生成、同日去重、全部已读', async () => {
  const { cookie } = await register('notify@test.dev');
  // deadline 3 天后 + 大量剩余需求 → deadline-risk danger
  // 日期按当前时间推算，避免写死的日期随时间推移失效
  const deadline = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  await call('PUT', '/api/goal', { title: 'g', deadline, weeklyMinutes: 300, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 1200, weight: 5 }, cookie);

  const first = await call('GET', '/api/notifications', null, cookie);
  assert.equal(first.status, 200);
  assert.ok(first.json.unread > 0, '应有未读预警');
  assert.ok(first.json.items.some((n) => n.kind === 'deadline-risk' && n.level === 'danger'));

  // 同一天再拉：不重复落库
  const second = await call('GET', '/api/notifications', null, cookie);
  assert.equal(second.json.items.length, first.json.items.length);

  // 全部已读
  const read = await call('POST', '/api/notifications/read', { ids: 'all' }, cookie);
  assert.equal(read.status, 200);
  const third = await call('GET', '/api/notifications', null, cookie);
  assert.equal(third.json.unread, 0);
  assert.ok(third.json.items.every((n) => n.read));

  // 未登录不可访问
  const anon = await call('GET', '/api/notifications');
  assert.equal(anon.status, 401);
});

test('任务锁定：锁定块在重建与重排中保留，且禁止移动', async () => {
  const { cookie } = await register('lock@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2027-05-01', weeklyMinutes: 900, level: 'once' }, cookie);
  for (const t of ['A', 'B']) {
    await call('POST', '/api/items', { title: t, subject: 'major', estimateMin: 120, weight: 4 }, cookie);
  }
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-09' }, cookie);
  assert.ok(gen.json.blocks.length >= 2);
  const [first] = gen.json.blocks;

  // 锁定第一块
  const locked = await call('PATCH', `/api/blocks/${first.id}`, { locked: true }, cookie);
  assert.equal(locked.json.block.locked, true);

  // 锁定块禁止移动
  const moved = await call('PATCH', `/api/blocks/${first.id}`, { date: '2026-11-12', startMin: 600 }, cookie);
  assert.equal(moved.status, 400);
  assert.equal(moved.json.error.code, 'E1038');

  // 整周重建：锁定块保留，未锁定块被重排
  const rebuilt = await call('POST', '/api/plan/generate', { weekStart: '2026-11-09', mode: 'rebuild' }, cookie);
  const keptLock = rebuilt.json.blocks.find((b) => b.id === first.id);
  assert.ok(keptLock, '重建后锁定块应保留');
  assert.equal(keptLock.date, first.date);
  assert.equal(keptLock.startMin, first.startMin);

  // 重排应用：锁定块时间不变
  const applied = await call('POST', '/api/plan/replan/apply', { week: '2026-11-09', option: 'defer' }, cookie);
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  const keptLock2 = applied.json.blocks.find((b) => b.id === first.id);
  assert.ok(keptLock2, '重排后锁定块应保留');
  assert.equal(keptLock2.startMin, first.startMin);

  // 未锁定的块可以移动（重排会重新分配时间，id 可能已更新，取重排结果里的未锁定块）
  const target = applied.json.blocks.find((b) => !b.locked && b.id !== first.id);
  assert.ok(target, '重排后应仍有未锁定块');
  const unlockedMove = await call('PATCH', `/api/blocks/${target.id}`, { date: '2026-11-12', startMin: 600 }, cookie);
  assert.equal(unlockedMove.status, 200, JSON.stringify(unlockedMove.json));
});

test('拆解草案可编辑：apply 时以提交的 items 为准', async () => {
  const { cookie } = await register('draft@test.dev');
  await call('PUT', '/api/goal', { title: '考研', deadline: '2027-05-01', weeklyMinutes: 900, level: 'once' }, cookie);

  // 非法科目被拒
  const bad = await call('POST', '/api/goal/decompose', {
    template: 'postgrad-cs', apply: true, replace: true,
    items: [{ title: '数学', subject: 'music', estimateMin: 60, weight: 3 }],
  }, cookie);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'E1041');

  // 编辑后的草案：改标题、砍工时、只保留两条
  const ok = await call('POST', '/api/goal/decompose', {
    template: 'postgrad-cs', apply: true, replace: true,
    items: [
      { title: '数学一刷（改过）', subject: 'math', estimateMin: 90, weight: 5 },
      { title: '408 强化', subject: 'major', estimateMin: 60, weight: 4 },
    ],
  }, cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.applied, 2);

  const state = await call('GET', '/api/state', null, cookie);
  const titles = state.json.items.map((i) => i.title);
  assert.deepEqual(titles, ['数学一刷（改过）', '408 强化']);
  assert.equal(state.json.items[0].estimateMin, 90);
  assert.equal(state.json.items[0].remainingMin, 90);
});

test('留言管理：首个注册用户为管理员，可隐藏/恢复，公开列表排除隐藏', async () => {
  // 管理员 = 全库首个注册用户（register 已记录）
  const a = await register('mod-a@test.dev');
  const b = await register('mod-b@test.dev');
  const admin = { cookie: adminSession.cookie };
  const guest = a.cookie === adminSession.cookie ? b : a;
  const meAdmin = await call('GET', '/api/me', null, admin.cookie);
  console.error('[debug] meAdmin:', JSON.stringify(meAdmin.json.user), '| adminCookie:', String(admin.cookie).slice(0, 24));
  assert.equal(meAdmin.json.user.isAdmin, true, '首个注册用户应为管理员');

  // 各留一条言
  await call('POST', '/api/feedback', { nickname: '访客A', content: '正常留言' }, a.cookie);
  await call('POST', '/api/feedback', { nickname: '访客B', content: '垃圾留言' }, b.cookie);

  // 非管理员无权管理
  const forbidden = await call('GET', '/api/feedback/admin', null, guest.cookie);
  assert.equal(forbidden.status, 403);

  // 管理员看到全部并隐藏垃圾留言
  const list = await call('GET', '/api/feedback/admin', null, admin.cookie);
  assert.equal(list.status, 200);
  const spam = list.json.items.find((f) => f.content === '垃圾留言');
  assert.ok(spam);
  const hide = await call('DELETE', `/api/feedback/${spam.id}`, { restore: false }, admin.cookie);
  assert.equal(hide.status, 200);

  // 公开列表不再显示隐藏留言
  const pub = await call('GET', '/api/feedback?limit=20');
  assert.ok(!JSON.stringify(pub.json.messages).includes('垃圾留言'), '隐藏后公开列表不应包含');

  // 恢复
  const restore = await call('DELETE', `/api/feedback/${spam.id}?restore=true`, {}, admin.cookie);
  assert.equal(restore.status, 200);
  const pub2 = await call('GET', '/api/feedback?limit=20');
  assert.ok(JSON.stringify(pub2.json.messages).includes('垃圾留言'));
});

test('导出：JSON 完整快照与 CSV 任务记录', async () => {
  const { cookie } = await register('export@test.dev');
  await call('PUT', '/api/goal', { title: '导出目标', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: '导出任务', subject: 'math', estimateMin: 60, weight: 3 }, cookie);
  await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);

  const jsonRes = await fetch(base + '/api/export?format=json', { headers: { Cookie: cookie } });
  assert.equal(jsonRes.status, 200);
  assert.match(jsonRes.headers.get('content-type'), /application\/json/);
  assert.match(jsonRes.headers.get('content-disposition'), /attachment; filename="zhixue-export-/);
  const data = await jsonRes.json();
  assert.equal(data.goal.title, '导出目标');
  assert.equal(data.blocks.length, 1);
  assert.ok(data.exportedAt);

  const csvRes = await fetch(base + '/api/export?format=csv', { headers: { Cookie: cookie } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csv = await csvRes.text();
  assert.ok(csv.includes('日期,开始,结束,任务'));
  assert.ok(csv.includes('导出任务'));
});

test('部分完成：按实际投入扣减剩余工时，下次排程只排剩余量', async () => {
  const { cookie } = await register('partial@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  const item = await call('POST', '/api/items', { title: '长任务', subject: 'major', estimateMin: 120, weight: 5 }, cookie);
  const itemId = item.json.item.id;
  assert.equal(item.json.item.remainingMin, 120);

  const gen1 = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const block = gen1.json.blocks[0];
  assert.equal(block.endMin - block.startMin, 120);

  // 完成度 50%：投入 60 分钟，但工作量只消耗计划量的一半
  await call('PATCH', `/api/blocks/${block.id}`, { status: 'done', actualMin: 60, progressPct: 50 }, cookie);
  let state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.items.find((i) => i.id === itemId).remainingMin, 60);

  const gen2 = await call('POST', '/api/plan/generate', { weekStart: '2026-11-09' }, cookie);
  assert.equal(gen2.json.blocks.length, 1);
  assert.equal(gen2.json.blocks[0].endMin - gen2.json.blocks[0].startMin, 60);
});

test('跨周去重：已在其它周排定未完成的任务不会重复排入', async () => {
  const { cookie } = await register('carry@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'major', estimateMin: 120, weight: 5 }, cookie);

  const week1 = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  assert.ok(week1.json.blocks.length > 0);

  const week2 = await call('POST', '/api/plan/generate', { weekStart: '2026-11-09' }, cookie);
  assert.equal(week2.json.blocks.length, 0, '未完成任务不应在下一周重复出现');

  // 完成后剩余工时为 0，也不再排入
  const block = week1.json.blocks[0];
  await call('PATCH', `/api/blocks/${block.id}`, { status: 'done', actualMin: 120 }, cookie);
  const week3 = await call('POST', '/api/plan/generate', { weekStart: '2026-11-16' }, cookie);
  assert.equal(week3.json.blocks.length, 0);
});

test('注销账号：密码校验、数据级联删除、会话失效', async () => {
  const { cookie } = await register('delete@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 600, level: 'once' }, cookie);

  const wrong = await call('DELETE', '/api/account', { password: 'not-my-password' }, cookie);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, 'E1023');

  const ok = await call('DELETE', '/api/account', { password: 'password123' }, cookie);
  assert.equal(ok.status, 200);

  const after = await call('GET', '/api/state', null, cookie);
  assert.equal(after.status, 401);

  const relogin = await call('POST', '/api/auth/login', { email: 'delete@test.dev', password: 'password123' });
  assert.equal(relogin.status, 401, '注销后不应还能登录');
});

test('移动任务块：同周改时间、拒绝重叠与跨周', async () => {
  const { cookie } = await register('move@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 120, weight: 5 }, cookie);
  await call('POST', '/api/items', { title: 'B', subject: 'major', estimateMin: 120, weight: 4 }, cookie);

  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const first = gen.json.blocks[0];
  const second = gen.json.blocks[1];
  // 120 + 120 分钟在每日 150 分钟容量下会被拆成 3 块
  assert.ok(gen.json.blocks.length >= 2, '应至少生成两块');

  const duration = first.endMin - first.startMin;
  const moved = await call('PATCH', `/api/blocks/${first.id}`, { date: '2026-11-03', startMin: 600 }, cookie);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.block.date, '2026-11-03');
  assert.equal(moved.json.block.startMin, 600);
  assert.equal(moved.json.block.endMin, 600 + duration); // 时长不变

  const overlap = await call('PATCH', `/api/blocks/${first.id}`, { date: second.date, startMin: second.startMin }, cookie);
  assert.equal(overlap.status, 400);
  assert.equal(overlap.json.error.code, 'E1024');

  const crossWeek = await call('PATCH', `/api/blocks/${first.id}`, { date: '2026-11-10', startMin: 600 }, cookie);
  assert.equal(crossWeek.status, 400);
  assert.equal(crossWeek.json.error.code, 'E1028');
});

test('删除任务块后任务回到待排池', async () => {
  const { cookie } = await register('unplan@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 60, weight: 5 }, cookie);
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  const blockId = gen.json.blocks[0].id;

  const del = await call('DELETE', `/api/blocks/${blockId}`, null, cookie);
  assert.equal(del.status, 200);
  let state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.blocks.length, 0);
  assert.equal(state.json.items[0].remainingMin, 60);

  const again = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  assert.equal(again.json.blocks.length, 1);
});

test('修改密码：校验旧密码、旧会话失效、新密码可登录', async () => {
  const { cookie } = await register('pwd@test.dev');

  const wrong = await call('POST', '/api/auth/password', { currentPassword: 'bad-password', newPassword: 'newpassword123' }, cookie);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, 'E1025');

  const same = await call('POST', '/api/auth/password', { currentPassword: 'password123', newPassword: 'password123' }, cookie);
  assert.equal(same.status, 400);
  assert.equal(same.json.error.code, 'E1026');

  const ok = await call('POST', '/api/auth/password', { currentPassword: 'password123', newPassword: 'newpassword123' }, cookie);
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie, '应下发新会话 Cookie');

  const oldSession = await call('GET', '/api/state', null, cookie);
  assert.equal(oldSession.status, 401, '旧会话应失效');

  const fresh = await call('GET', '/api/state', null, ok.cookie);
  assert.equal(fresh.status, 200);

  const relogin = await call('POST', '/api/auth/login', { email: 'pwd@test.dev', password: 'newpassword123' });
  assert.equal(relogin.status, 200);
  const oldLogin = await call('POST', '/api/auth/login', { email: 'pwd@test.dev', password: 'password123' });
  assert.equal(oldLogin.status, 401);
});

test('恢复码：注册下发、错误码拒绝、正确重置并轮换', async () => {
  const reg = await call('POST', '/api/auth/register', { email: 'recover@test.dev', password: 'password123', name: '恢复' });
  assert.equal(reg.status, 200);
  const code = reg.json.recoveryCode;
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/);
  const cookie = reg.cookie;

  const wrong = await call('POST', '/api/auth/recover', {
    email: 'recover@test.dev', recoveryCode: 'AAAA-BBBB-CC', newPassword: 'resetpass123',
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, 'E1029');

  const unknown = await call('POST', '/api/auth/recover', {
    email: 'nobody@test.dev', recoveryCode: code, newPassword: 'resetpass123',
  });
  assert.equal(unknown.status, 400, '不存在的邮箱应返回同样错误');

  const ok = await call('POST', '/api/auth/recover', {
    email: 'recover@test.dev', recoveryCode: code.toLowerCase(), newPassword: 'resetpass123',
  });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.json.recoveryCode, code, '恢复码应轮换');

  const oldSession = await call('GET', '/api/state', null, cookie);
  assert.equal(oldSession.status, 401, '重置后旧会话应失效');

  const newLogin = await call('POST', '/api/auth/login', { email: 'recover@test.dev', password: 'resetpass123' });
  assert.equal(newLogin.status, 200);
  const oldLogin = await call('POST', '/api/auth/login', { email: 'recover@test.dev', password: 'password123' });
  assert.equal(oldLogin.status, 401);

  const reuse = await call('POST', '/api/auth/recover', {
    email: 'recover@test.dev', recoveryCode: code, newPassword: 'anotherpass123',
  });
  assert.equal(reuse.status, 400, '旧恢复码不能再次使用');

  const rotated = await call('POST', '/api/auth/recover', {
    email: 'recover@test.dev', recoveryCode: ok.json.recoveryCode, newPassword: 'thirdpass1234',
  });
  assert.equal(rotated.status, 200);
});

test('主页公开接口：留言免登录读写与校验', async () => {
  const empty = await call('GET', '/api/feedback?limit=5');
  assert.equal(empty.status, 200, '未登录应能读取留言');
  assert.ok(Array.isArray(empty.json.messages));

  const post = await call('POST', '/api/feedback', { nickname: '路人', content: '希望支持考公模板' });
  assert.equal(post.status, 200, JSON.stringify(post.json));
  assert.equal(post.json.message.nickname, '路人');

  const after = await call('GET', '/api/feedback');
  assert.equal(after.json.messages[0].content, '希望支持考公模板');

  const anonymous = await call('POST', '/api/feedback', { content: '匿名也可以留言' });
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.json.message.nickname, null);

  const blank = await call('POST', '/api/feedback', { content: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(blank.json.error.code, 'E1031');

  const tooLong = await call('POST', '/api/feedback', { content: 'x'.repeat(501) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error.code, 'E1031');

  const longNick = await call('POST', '/api/feedback', { nickname: 'x'.repeat(31), content: 'hi' });
  assert.equal(longNick.status, 400);
  assert.equal(longNick.json.error.code, 'E1032');
});

test('访问计数：POST 自增，GET 只读', async () => {
  const before = await call('GET', '/api/visit');
  assert.equal(before.status, 200);
  const start = before.json.count;
  const inc = await call('POST', '/api/visit');
  assert.equal(inc.json.count, start + 1);
  const again = await call('GET', '/api/visit');
  assert.equal(again.json.count, start + 1, 'GET 不应改变计数');
});

test('重排这一周：清掉未完成块重新装，已完成记录与新增任务都正确', async () => {
  const { cookie } = await register('rebuild@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once' }, cookie);
  await call('POST', '/api/items', { title: 'A', subject: 'math', estimateMin: 120, weight: 5 }, cookie);

  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  assert.ok(gen.json.blocks.length > 0);
  const first = gen.json.blocks[0];
  await call('PATCH', `/api/blocks/${first.id}`, { status: 'done', actualMin: 60 }, cookie);

  await call('POST', '/api/items', { title: 'B', subject: 'major', estimateMin: 90, weight: 4 }, cookie);

  const re = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02', mode: 'rebuild' }, cookie);
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(re.json.mode, 'rebuild');

  const done = re.json.blocks.filter((b) => b.status === 'done');
  assert.equal(done.length, 1, '已完成记录应保留');
  assert.equal(done[0].id, first.id);

  const itemIds = new Set(re.json.blocks.map((b) => b.itemId));
  assert.ok(itemIds.size >= 2, '新增任务也应被排进这一周');

  // 未完成的块应被重新写过，不应残留旧 id 的 pending 重复项
  for (const b of re.json.blocks) {
    assert.ok(b.status === 'done' || b.id !== first.id, '旧块不应以未完成状态残留');
  }
});

test('拆解：模板列表 + 预览草案（含阶段与裁断）', async () => {
  const { cookie } = await register('decompose@test.dev');
  await call('PUT', '/api/goal', { title: '考研', deadline: '2027-05-01', weeklyMinutes: 900, level: 'once' }, cookie);

  const tpl = await call('GET', '/api/decompose/templates', null, cookie);
  assert.equal(tpl.status, 200);
  assert.equal(tpl.json.templates.length, 3);

  const preview = await call('POST', '/api/goal/decompose', { template: 'postgrad-cs' }, cookie);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.applied, 0);
  const r = preview.json.result;
  assert.ok(r.items.length > 0, '应产出计划项');
  assert.equal(r.stages.length, 3);
  assert.equal(r.stageRatio.length, 3);
  assert.ok(['comfortable', 'reasonable', 'tight', 'infeasible'].includes(r.verdict));
  assert.ok(r.items.every((i) => i.estimateMin > 0 && i.weight >= 1 && i.weight <= 5));

  // 未确认覆盖时拒绝写库
  await call('POST', '/api/items', { title: '手工任务', subject: 'math', estimateMin: 60, weight: 3 }, cookie);
  const reject = await call('POST', '/api/goal/decompose', { template: 'postgrad-cs', apply: true }, cookie);
  assert.equal(reject.status, 409);
  assert.equal(reject.json.error.code, 'E4009');

  const applied = await call('POST', '/api/goal/decompose', { template: 'postgrad-cs', apply: true, replace: true }, cookie);
  assert.equal(applied.status, 200);
  assert.ok(applied.json.applied > 0);

  const state = await call('GET', '/api/state', null, cookie);
  assert.equal(state.json.items.length, applied.json.applied);
  assert.ok(!state.json.items.some((i) => i.title === '手工任务'), '覆盖后旧计划项应被清掉');
  assert.equal(state.json.blocks.length, 0);
});

test('重排：四个方案 + 应用顺延 + 未知方案被拒', async () => {
  const { cookie } = await register('replan@test.dev');
  await call('PUT', '/api/goal', { title: 'g', deadline: '2027-05-01', weeklyMinutes: 300, level: 'once' }, cookie);
  for (const title of ['A', 'B', 'C']) {
    await call('POST', '/api/items', { title, subject: 'math', estimateMin: 300, weight: 4 }, cookie);
  }
  const week = '2026-11-09';

  const plan = await call('GET', `/api/plan/replan?week=${week}`, null, cookie);
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  assert.deepEqual(plan.json.options.map((o) => o.key), ['defer', 'compress', 'substitute', 'drop']);
  for (const o of plan.json.options) {
    assert.ok(typeof o.summary.added === 'number');
    assert.ok(typeof o.loadIncreasePct === 'number');
  }
  assert.equal(plan.json.replanCount, 0);

  const bad = await call('POST', '/api/plan/replan/apply', { week, option: 'nope' }, cookie);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'E1033');

  const applied = await call('POST', '/api/plan/replan/apply', { week, option: 'defer' }, cookie);
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(applied.json.applied, 'defer');
  assert.ok(applied.json.blocks.length > 0, '顺延后应写入本周任务块');
  assert.equal(applied.json.replanCount, 1);

  const again = await call('GET', `/api/plan/replan?week=${week}`, null, cookie);
  assert.equal(again.json.replanCount, 1, '重排次数应被记录');
});

test('登出后会话失效', async () => {
  const { cookie } = await register('logout@test.dev');
  const out = await call('POST', '/api/auth/logout', {}, cookie);
  assert.equal(out.status, 200);
  const after = await call('GET', '/api/state', null, cookie);
  assert.equal(after.status, 401);
});

// ---------------------------------------------------------------- 助手（A 类 + 会话）

/** 解析 SSE 文本为 [{event, data}]；只认本项目下发的 event/data 两行格式 */
function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function chat(question, cookie, sessionId, date) {
  const res = await fetch(`${base}/api/assistant/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({
      question,
      ...(sessionId ? { sessionId } : {}),
      ...(date ? { date } : {}),
    }),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return { status: res.status, json: await res.json(), events: null };
  }
  const events = parseSSE(await res.text());
  const meta = events.find((e) => e.event === 'meta')?.data;
  const done = events.find((e) => e.event === 'done')?.data;
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  return { status: res.status, meta, done, text, events };
}

test('助手：功能答疑已移除，问法一律走数据通道，不再返回语料原文', async () => {
  const { cookie } = await register('assist-a@test.dev');
  const corpus = KNOWLEDGE.find((entry) => entry.id === 'goal-set');

  const r = await chat('怎么设置目标', cookie);
  assert.equal(r.status, 200);
  // 提交版只保留数据通道：语料直答的 mode=knowledge 不应再出现
  assert.equal(r.meta.mode, 'data');
  assert.ok(r.meta.sessionId.startsWith('sess_'));
  assert.equal(r.done.citations.length, 0, '不再有知识库引用');
  assert.equal(r.done.fallback, false);
  assert.notEqual(r.text, corpus.answer, '不该再逐字复述语料');

  const detail = await call('GET', `/api/assistant/sessions/${r.meta.sessionId}`, null, cookie);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(detail.json.messages[0].content, '怎么设置目标');
  assert.equal(detail.json.messages[1].content, r.text);

  const list = await call('GET', '/api/assistant/sessions', null, cookie);
  assert.deepEqual(list.json.sessions.map((s) => s.id), [r.meta.sessionId]);
});

test('助手：无 Key 时数据类问题用工具事实本地汇总，不再回「取不到数据」', async () => {
  const { cookie } = await register('assist-data@test.dev');
  await call('PUT', '/api/goal', {
    title: '考研', deadline: '2026-12-19', weeklyMinutes: 900, level: 'once',
  }, cookie);
  for (const title of ['高数 40 题', '408 二叉树']) {
    await call('POST', '/api/items', { title, subject: 'major', estimateMin: 120, weight: 5 }, cookie);
  }
  const today = todayISO();
  const base = new Date(`${today}T00:00:00Z`);
  const monday = new Date(base.getTime() - ((base.getUTCDay() + 6) % 7) * 86400000);
  const weekStart = monday.toISOString().slice(0, 10);
  const gen = await call('POST', '/api/plan/generate', { weekStart, from: today }, cookie);
  assert.equal(gen.status, 200, JSON.stringify(gen.json));
  assert.ok(gen.json.blocks.length > 0, '先要有计划，摘要才有数字可讲');

  const question = '我这周还剩多少任务';
  const r = await chat(question, cookie);

  assert.equal(r.status, 200);
  assert.equal(r.meta.mode, 'data');
  // 摘要是拿实时数据算出来的，不该标成降级；但要让前端知道这不是模型写的
  assert.equal(r.done.degraded, false, '本地摘要用了真实数据，不是降级');
  assert.equal(r.done.localSummary, true);
  assert.notEqual(r.text, DEGRADED_DATA_TEXT);
  assert.match(r.text, /本周/, `摘要要说明是哪一周：${r.text}`);
  assert.match(r.text, /\d/, '摘要必须带真实数字，否则等于没说');

  // 摘要也是一次完整回答：照样落库、照样计配额
  const detail = await call('GET', `/api/assistant/sessions/${r.meta.sessionId}`, null, cookie);
  assert.equal(detail.json.messages[1].mode, 'data');
  assert.equal(detail.json.messages[1].content, r.text);

  // 工具确实跑过并记进事件：没有这段记录，出问题时无法判断是「没取到数据」还是「模型没用好」
  const event = app.db.prepare(
    'SELECT tool_names, mode, degraded FROM assistant_events WHERE question = ? ORDER BY id DESC LIMIT 1',
  ).get(question);
  assert.equal(event.mode, 'data');
  assert.equal(event.degraded, 0);
  const toolNames = JSON.parse(event.tool_names ?? '[]');
  assert.ok(toolNames.includes('get_week'), `实际工具：${event.tool_names}`);
});

test('助手：没有任何数据时，本地摘要引导建目标而不是说取不到', async () => {
  const { cookie } = await register('assist-empty@test.dev');
  const r = await chat('我今天要做什么', cookie);

  assert.equal(r.meta.mode, 'data');
  assert.equal(r.done.localSummary, true);
  assert.match(r.text, /还没有设置目标|没有排任务/, `空数据也要说清楚缺什么：${r.text}`);
  assert.notEqual(r.text, DEGRADED_DATA_TEXT);
});

test('助手：故障注入三条路径（无 Key / 上游 500 / 超时）都落到同一降级文案', async () => {
  const { cookie } = await register('assist-fault@test.dev');
  await call('PUT', '/api/goal', {
    title: '考研', deadline: '2026-12-20', weeklyMinutes: 600, level: 'once',
  }, cookie);

  const kindOf = (question) => app.db.prepare(
    'SELECT tool_names, degraded FROM assistant_events WHERE question = ? ORDER BY id DESC LIMIT 1',
  ).get(question);

  try {
    for (const [i, kind] of FAULT_KINDS.entries()) {
      process.env.ASSISTANT_FAULT = kind;
      // 每次换一句问法：事件表按 question 回查，同句会互相串行
      const question = `这周还剩多少任务（故障 ${i}）`;
      const r = await chat(question, cookie);

      assert.equal(r.status, 200, `${kind} 不应把故障变成 HTTP 错误`);
      assert.equal(r.meta.mode, 'data');
      // meta 是开口前的判断，done 才是最终结果；上游中途失败只有 done 里才准
      assert.deepEqual(r.done.citations, []);
      assert.equal(r.events.some((e) => e.event === 'error'), false, '不能把上游细节写进流里');

      const event = kindOf(question);
      // 降级发生在「模型这一段」：工具事实照常取到，否则测的就不是降级链
      assert.ok(JSON.parse(event.tool_names ?? '[]').length > 0, `${kind} 应已取到工具事实`);

      if (kind === 'nokey') {
        // 没配 Key 时工具事实是完整的：直接本地汇总，答出真实数字，不算降级
        assert.equal(r.done.degraded, false, 'nokey 有事实可讲，不该标降级');
        assert.equal(r.done.localSummary, true);
        assert.notEqual(r.text, DEGRADED_DATA_TEXT);
        assert.match(r.text, /目标|周/, `摘要要讲事实：${r.text}`);
        assert.equal(event.degraded, 0);
      } else {
        // 上游 500 / 超时：一句带数字的正文都会变成编造的结论，只能回固定降级文案
        assert.equal(r.text, DEGRADED_DATA_TEXT, `${kind} 应回固定降级文案`);
        assert.equal(/\d/.test(r.text), false, `${kind} 的文案里不能出现数字`);
        assert.equal(r.done.degraded, true, `${kind} 的 done 必须标记降级`);
        assert.equal(event.degraded, 1);
      }
    }
  } finally {
    delete process.env.ASSISTANT_FAULT;
  }

  // 开关关掉后恢复正常：同一账号再问不会继承上一次的降级
  const normal = await chat('这周还剩多少任务（恢复）', cookie);
  assert.equal(normal.meta.mode, 'data');
  assert.equal(normal.done.localSummary, true, '本机无真实 Key，开关关掉后回到本地摘要');
  assert.equal(normal.done.degraded, false);
});

test('助手：没有可引用的数据时给引导，不再回知识库兜底文案', async () => {
  const { cookie } = await register('assist-fb@test.dev');
  const r = await chat('帮我写首诗', cookie);

  assert.equal(r.status, 200);
  assert.equal(r.meta.mode, 'data');
  assert.deepEqual(r.done.citations, [], '引用通道已随知识库一起移除');
  assert.notEqual(r.text, FALLBACK_TEXT, '知识库兜底文案不该再出现');
  assert.match(r.text, /周|计划|目标/, `无数据也要说清楚缺什么：${r.text}`);
});

test('助手反馈：赞、踩带原因、取消都落库，别人的消息改不动', async () => {
  const owner = await register('assist-fb-owner@test.dev');
  const other = await register('assist-fb-other@test.dev');

  const r = await chat('怎么设置目标', owner.cookie);
  const messageId = r.done.messageId;
  assert.ok(messageId, 'done 必须带 messageId，前端才能对这条回答反馈');

  const url = `/api/assistant/messages/${messageId}/feedback`;
  // 从会话详情读，验证的是真的落库，而不是响应体自己说自己成功
  const stored = async () => {
    const list = await call('GET', '/api/assistant/sessions', null, owner.cookie);
    const detail = await call('GET', `/api/assistant/sessions/${list.json.sessions[0].id}`, null, owner.cookie);
    return detail.json.messages.at(-1).feedback;
  };

  const up = await call('PATCH', url, { value: 'up' }, owner.cookie);
  assert.equal(up.status, 200);
  assert.equal(up.json.feedback, 'up');
  assert.equal(await stored(), 'up');

  const down = await call('PATCH', url, { value: 'down', reason: 'wrong' }, owner.cookie);
  assert.equal(down.status, 200);
  assert.equal(down.json.feedback, 'down:wrong', '踩要带原因存成 down:<reason>');
  assert.equal(await stored(), 'down:wrong');

  const cancel = await call('PATCH', url, { value: null }, owner.cookie);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.feedback, null);
  assert.equal(await stored(), undefined, '取消后要变回「没有评价」');

  // 越权与不存在同一个 404，不告诉对方这条消息存不存在
  const cross = await call('PATCH', url, { value: 'up' }, other.cookie);
  assert.equal(cross.status, 404);
  assert.equal(cross.json.error.code, 'E4004');
  assert.equal(await stored(), undefined, '越权失败不能改到属主的数据');

  const badReason = await call('PATCH', url, { value: 'down', reason: 'whatever' }, owner.cookie);
  assert.equal(badReason.status, 400);
  assert.equal(badReason.json.error.code, 'E1016');

  const badValue = await call('PATCH', url, { value: 'meh' }, owner.cookie);
  assert.equal(badValue.status, 400);

  const wrongMethod = await call('POST', url, { value: 'up' }, owner.cookie);
  assert.equal(wrongMethod.status, 405);
});

test('助手：条带点选的日期参与取数，非法日期静默忽略', async () => {
  const { cookie } = await register('assist-date@test.dev');
  await call('PUT', '/api/goal', {
    title: '考研', deadline: '2026-12-20', weeklyMinutes: 600, level: 'once',
  }, cookie);

  // 2026-02-30 格式对但不存在：不能把用户的提问变成 400
  const invalid = await chat('这周还剩多少任务', cookie, null, '2026-02-30');
  assert.equal(invalid.status, 200);

  const picked = await chat('今天的安排还剩多少', cookie, null, '2026-11-11');
  assert.equal(picked.status, 200);
  assert.equal(picked.meta.mode, 'data');

  // 日期只进 facts，不改写提问原文；工具调用按所选日期走 get_today
  const event = app.db.prepare(
    'SELECT tool_names FROM assistant_events WHERE question = ? ORDER BY id DESC LIMIT 1',
  ).get('今天的安排还剩多少');
  assert.ok(JSON.parse(event.tool_names).includes('get_today'));
});

test('助手：空问题与超长问题被拒，未登录 401', async () => {
  const { cookie } = await register('assist-bad@test.dev');

  const empty = await chat('   ', cookie);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, 'E1001');

  const tooLong = await chat('问'.repeat(501), cookie);
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error.code, 'E1002');

  const anon = await chat('怎么设置目标', null);
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error.code, 'E2001');

  // 500 字是上限本身（『怎么设置目标』6 字 + 494），不能被误拒
  const boundary = await chat('怎么设置目标' + '啊'.repeat(494), cookie);
  assert.equal(boundary.status, 200);
});

test('助手：拿别人的 sessionId 发问返回 404', async () => {
  const a = await register('assist-own-a@test.dev');
  const b = await register('assist-own-b@test.dev');
  const first = await chat('怎么设置目标', a.cookie);

  const stolen = await chat('怎么设置目标', b.cookie, first.meta.sessionId);
  assert.equal(stolen.status, 404);
  assert.equal(stolen.json.error.code, 'E4004');

  const missing = await call('GET', `/api/assistant/sessions/${first.meta.sessionId}`, null, b.cookie);
  assert.equal(missing.status, 404);
});

test('助手：已删除的会话继续发问会新建会话并回新 id', async () => {
  const { cookie } = await register('assist-del@test.dev');
  const first = await chat('怎么设置目标', cookie);

  const del = await call('DELETE', `/api/assistant/sessions/${first.meta.sessionId}`, null, cookie);
  assert.equal(del.status, 200);

  const again = await chat('怎么设置目标', cookie, first.meta.sessionId);
  assert.equal(again.status, 200);
  assert.notEqual(again.meta.sessionId, first.meta.sessionId);
  assert.ok(again.text.length > 0);

  const gone = await call('GET', `/api/assistant/sessions/${first.meta.sessionId}`, null, cookie);
  assert.equal(gone.status, 404);
});

test('助手：同一自然日第 31 次提问返回 429 且给 resetAt，不再新建会话', async () => {
  const { cookie } = await register('assist-quota@test.dev');
  let sessionId = null;
  for (let i = 0; i < MAX_DAILY_QUESTIONS; i += 1) {
    const r = await chat('怎么设置目标', cookie, sessionId);
    assert.equal(r.status, 200, `第 ${i + 1} 次提问应成功`);
    sessionId = sessionId ?? r.meta.sessionId;
  }

  const blocked = await chat('怎么设置目标', cookie, sessionId);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'E2002');
  assert.ok(blocked.json.resetAt, '429 必须带 resetAt');
  assert.ok(new Date(blocked.json.resetAt).getTime() > Date.now(), 'resetAt 应在未来');
  // 429 在开流之前就拒绝：不能留下半个会话，也不能留下半截消息
  const detail = await call('GET', `/api/assistant/sessions/${sessionId}`, null, cookie);
  assert.equal(detail.json.messages.length, MAX_DAILY_QUESTIONS * 2);
  const list = await call('GET', '/api/assistant/sessions', null, cookie);
  assert.equal(list.json.sessions.length, 1, '被限流的请求不应新建会话');
});

test('助手工具：同一份 /api/state 下，get_today 的数字与接口逐项一致', async () => {
  const { cookie } = await register('assist-tools@test.dev');
  await call('PUT', '/api/goal', {
    title: '考研数学', deadline: '2026-12-20', weeklyMinutes: 600, level: 'once',
  }, cookie);
  const { item } = (await call('POST', '/api/items', {
    title: '高数第一章', subject: 'math', estimateMin: 120,
  }, cookie)).json;

  // 用「今天」写块，保证落在本周区间内（PUT /api/blocks 会校验 E1015）
  const today = todayISO();
  const cursor = new Date(`${today}T00:00:00Z`);
  const weekStartDate = new Date(cursor);
  weekStartDate.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() - 1 + 7) % 7));
  const weekStart = weekStartDate.toISOString().slice(0, 10);

  await call('PUT', '/api/blocks', {
    weekStart,
    blocks: [{
      itemId: item.id, date: today, startMin: 540, endMin: 660, isBuffer: false,
    }],
  }, cookie);

  const state = (await call('GET', '/api/state', null, cookie)).json;
  const toolbox = createToolbox({ state, today });
  const result = await toolbox.call('get_today', { date: today });

  const expected = state.blocks.filter((block) => block.date === today && !block.isBuffer);
  assert.equal(result.status, 'ok');
  assert.equal(result.data.blocks.length, expected.length);
  assert.equal(
    result.data.totalMin,
    expected.reduce((acc, block) => acc + (block.endMin - block.startMin), 0),
  );
  assert.equal(result.data.blocks[0].title, '高数第一章');
  assert.equal(result.data.blocks[0].estimateMin, 120, '估时要能从 items 关联出来');
});

test('演示模式：不登录也拿到同一个演示账号，匿名可读写', async () => {
  process.env.ZHIXUE_DEMO = '1';
  try {
    const first = await call('GET', '/api/me', null, null);
    assert.equal(first.status, 200);
    assert.equal(first.json.user.demo, true);
    assert.equal(first.json.user.email, 'demo@zhixue.local');

    // 第二次仍落到同一账号：不能每次请求都新建一个 demo 用户
    const second = await call('GET', '/api/me', null, null);
    assert.equal(second.json.user.id, first.json.user.id);

    // 匿名的业务请求同样可用，评审打开页面就能直接操作
    const state = await call('GET', '/api/state', null, null);
    assert.equal(state.status, 200);
    assert.ok(Array.isArray(state.json.blocks));
  } finally {
    process.env.ZHIXUE_DEMO = '0';
  }
});

test.after(async () => {
  await app.close();
});
