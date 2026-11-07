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

async function register(email, name = '测试用户') {
  const r = await call('POST', '/api/auth/register', { email, password: 'password123', name });
  assert.equal(r.status, 200, JSON.stringify(r.json));
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
  const gen = await call('POST', '/api/plan/generate', { weekStart: '2026-11-02' }, cookie);
  assert.equal(gen.status, 200);
  // 新容量：周一至周五各 60 → 300
  assert.equal(gen.json.capacityMin, 300);
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

  await call('PATCH', `/api/blocks/${block.id}`, { status: 'done', actualMin: 60 }, cookie);
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

  const moved = await call('PATCH', `/api/blocks/${first.id}`, { date: '2026-11-03', startMin: 600 }, cookie);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.block.date, '2026-11-03');
  assert.equal(moved.json.block.startMin, 600);
  assert.equal(moved.json.block.endMin, 720); // 时长不变

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
