import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './index.mjs';

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
  assert.equal(gen.json.capacityMin, 870); // 整周容量（capacityMin 表示本周可用，from 只影响排程范围）

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
  await call('PUT', '/api/goal', { title: 'g', deadline: '2026-11-11', weeklyMinutes: 300, level: 'once' }, cookie);
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
  const [first, second] = gen.json.blocks;

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

test.after(async () => {
  await app.close();
});
