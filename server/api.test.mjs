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
