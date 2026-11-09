import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb, nowISO } from '../db.mjs';
import {
  createSessionStore, MAX_DAILY_QUESTIONS, purgeAssistantData, RETENTION_DAYS, shanghaiDay,
} from './sessions.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 每个用例一个内存库：会话表依赖 users 外键，所以要先造用户 */
function freshDb() {
  const db = openDb(':memory:');
  const insert = db.prepare(
    "INSERT INTO users (id, email, name, pass_hash, week_start, weekdays, created_at) VALUES (?, ?, ?, 'x', 1, '[0,0,0,0,0,0,0]', ?)",
  );
  insert.run('u_a', 'a@example.com', '甲', nowISO());
  insert.run('u_b', 'b@example.com', '乙', nowISO());
  return { db, store: createSessionStore(db) };
}

test('会话标题取首问前 30 字，空白折叠', () => {
  const { store } = freshDb();
  const long = `  这周   还剩多少任务${'啊'.repeat(40)}  `;
  const session = store.create('u_a', long);

  assert.equal(session.title.length, 30);
  assert.ok(!session.title.includes('\n'));
  assert.ok(!session.title.startsWith(' '));
  assert.equal(store.get('u_a', session.id).id, session.id);
});

test('软删后查不到、列表不含、重复删除返回 false', () => {
  const { store } = freshDb();
  const s1 = store.create('u_a', '第一个会话');
  const s2 = store.create('u_a', '第二个会话');

  assert.equal(store.softDelete('u_a', s1.id), true);
  assert.equal(store.get('u_a', s1.id), undefined);
  assert.deepEqual(store.list('u_a').map((s) => s.id), [s2.id]);
  assert.equal(store.softDelete('u_a', s1.id), false, '已删过的会话不应再次 delete 成功');
});

test('会话按用户隔离：B 账号拿 A 的 id 查不到，也删不掉', () => {
  const { store } = freshDb();
  const session = store.create('u_a', '甲的会话');

  assert.equal(store.get('u_b', session.id), undefined);
  assert.equal(store.softDelete('u_b', session.id), false);
  assert.ok(store.get('u_a', session.id), '越权失败不应影响真正的属主');
  assert.deepEqual(store.list('u_b'), []);
});

test('列表按 updated_at 倒序，touch 能把旧会话顶到最前', () => {
  const { store } = freshDb();
  const first = store.create('u_a', '先建的');
  const second = store.create('u_a', '后建的');

  store.touch('u_a', first.id, new Date(Date.now() + 1000).toISOString());
  assert.deepEqual(store.list('u_a').map((s) => s.id), [first.id, second.id]);
});

test('消息按写入顺序返回，citations 与 toolCalls 反序列化', () => {
  const { store } = freshDb();
  const session = store.create('u_a', '引用怎么跳');

  store.appendMessage('u_a', session.id, { role: 'user', content: '引用怎么跳' });
  store.appendMessage('u_a', session.id, {
    role: 'assistant',
    content: '点引用会跳到对应页面。',
    mode: 'knowledge',
    citations: [{ title: '引用与跳转', doc: '今日页 → 引用' }],
    toolCalls: [{ name: 'get_week', status: 'ok' }],
    latencyMs: 812,
  });

  const messages = store.messages('u_a', session.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages[1].mode, 'knowledge');
  assert.equal(messages[1].citations.length, 1);
  assert.equal(messages[1].citations[0].title, '引用与跳转');
  assert.equal(messages[1].toolCalls[0].name, 'get_week');
  assert.equal(messages[1].latencyMs, 812);
  assert.deepEqual(store.messages('u_b', session.id), [], '别人的会话读不到消息');
});

test('反馈：本人可改可取消，别人的消息改不动', () => {
  const { store } = freshDb();
  const session = store.create('u_a', '这周还剩多少任务');
  const replyId = store.appendMessage('u_a', session.id, { role: 'assistant', content: '还剩 3 项。' });

  assert.equal(store.setMessageFeedback('u_a', replyId, 'up'), true);
  assert.equal(store.messages('u_a', session.id)[0].feedback, 'up');

  // 踩带原因会存成 `down:<reason>`，前端按这个值还原选中态
  assert.equal(store.setMessageFeedback('u_a', replyId, 'down:wrong'), true);
  assert.equal(store.messages('u_a', session.id)[0].feedback, 'down:wrong');

  // 取消写 NULL：读出来是 undefined（「没有评价」），不会变成空串这种伪评价
  assert.equal(store.setMessageFeedback('u_a', replyId, null), true);
  assert.equal(store.messages('u_a', session.id)[0].feedback, undefined);

  // 越权与「不存在」返回同一个 false，调用方统一转 404
  assert.equal(store.setMessageFeedback('u_b', replyId, 'down'), false);
  assert.equal(store.messages('u_a', session.id)[0].feedback, undefined, '越权失败不能影响属主');
  assert.equal(store.setMessageFeedback('u_a', 'msg_missing', 'up'), false);
});

test('配额按自然日计数：只算当天，昨天的记录不占今天的额度', () => {
  const { store } = freshDb();
  const today = shanghaiDay();

  const base = {
    userId: 'u_a',
    sessionId: null,
    question: '还剩多少任务',
    mode: 'knowledge',
    latencyMs: 100,
    promptVersion: 'v1',
  };
  store.recordEvent({ ...base, day: today });
  store.recordEvent({ ...base, day: today });
  store.recordEvent({ ...base, day: '2000-01-01' });

  assert.equal(store.usedToday('u_a'), 2);
  assert.equal(store.usedToday('u_a', '2000-01-01'), 1);
  assert.equal(store.usedToday('u_b'), 0, '别的账号不共享额度');
  assert.equal(MAX_DAILY_QUESTIONS, 30);
  assert.equal(RETENTION_DAYS, 30);
});

test('清理：软删未满 30 天保留，超期才物理删除消息与事件', () => {
  const { db, store } = freshDb();
  const keep = store.create('u_a', '刚删的');
  const gone = store.create('u_a', '早就删了');

  for (const s of [keep, gone]) {
    store.appendMessage('u_a', s.id, { role: 'user', content: '问题' });
    store.recordEvent({ userId: 'u_a', sessionId: s.id, question: '问题', mode: 'knowledge' });
  }

  const old = new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS).toISOString();
  store.softDelete('u_a', keep.id);
  store.softDelete('u_a', gone.id);
  db.prepare('UPDATE chat_sessions SET deleted_at = ? WHERE id = ?').run(old, gone.id);

  const purged = purgeAssistantData(db);
  assert.equal(purged.sessions, 1);
  assert.equal(purged.messages, 1);
  assert.equal(purged.events, 1);
  // 软删的会话本来就查不到，这里要断言的是「物理行还在」
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chat_sessions WHERE id = ?').get(keep.id).c, 1, '未到期的软删会话应还在');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chat_sessions WHERE id = ?').get(gone.id).c, 0);
});

test('清理：未软删但 30 天没动过的会话也算过期', () => {
  const { db, store } = freshDb();
  const session = store.create('u_a', '很久没动');
  const old = new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS).toISOString();
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(old, session.id);

  assert.equal(purgeAssistantData(db).sessions, 1);
  assert.deepEqual(store.list('u_a'), []);
});
