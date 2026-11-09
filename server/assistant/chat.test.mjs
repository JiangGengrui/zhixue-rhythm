import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb, nowISO } from '../db.mjs';
import { createSessionStore } from './sessions.mjs';
import { splitChunks, streamModelReply, streamReply } from './chat.mjs';
import { DEGRADED_DATA_TEXT } from './prompt.mjs';

function freshStore() {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO users (id, email, name, pass_hash, week_start, weekdays, created_at) VALUES ('u_a', 'a@example.com', '甲', 'x', 1, '[0,0,0,0,0,0,0]', ?)",
  ).run(nowISO());
  return { db, store: createSessionStore(db) };
}

/** 够用的假 res：记录写出的帧，可在第 N 次 write 后模拟客户端断开 */
function fakeRes({ closeAfterWrites = Infinity } = {}) {
  const frames = [];
  const handlers = {};
  let writes = 0;
  const res = {
    writableEnded: false,
    headers: null,
    writeHead(status, headers) {
      this.headers = headers;
      return this;
    },
    flushHeaders() {},
    write(chunk) {
      frames.push(chunk);
      writes += 1;
      if (writes >= closeAfterWrites) handlers.close?.();
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    on(event, fn) {
      handlers[event] = fn;
    },
  };
  return { res, frames };
}

const ANSWER = {
  mode: 'knowledge',
  text: '周视图里点任务块可以调整开始 / 结束时间、移到别的天或删除。'.repeat(3),
  citations: [{ title: '调时间', doc: '周视图 → 任务块', route: 'week' }],
};

test('分块后拼回去等于原文', () => {
  assert.equal(splitChunks(ANSWER.text).join(''), ANSWER.text);
  assert.equal(splitChunks('').length, 0);
  // 代理对不能被切成半个字符
  assert.equal(splitChunks('😀😀😀', 1).join(''), '😀😀😀');
});

test('正常流：meta → delta → done，并落库两条消息 + 一条事件', async () => {
  const { store } = freshStore();
  const session = store.create('u_a', '怎么调整任务块');
  const { res, frames } = fakeRes();

  const result = await streamReply({
    res,
    store,
    userId: 'u_a',
    question: '怎么调整任务块',
    sessionId: session.id,
    answer: ANSWER,
    degraded: true,
  });

  assert.deepEqual(result, { aborted: false, persisted: true });
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.ok(frames[0].includes('event: meta'));
  assert.ok(frames.at(-1).startsWith('event: done'));
  assert.equal(res.writableEnded, true);
  assert.equal(frames.join('').includes('event: done'), true);

  const messages = store.messages('u_a', session.id);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages[1].content, ANSWER.text);
  assert.equal(messages[1].citations[0].route, 'week');
  assert.equal(store.usedToday('u_a'), 1, '成功的 done 要占一次配额');
});

test('写已关闭的 socket 不抛错：静默丢弃后续帧，也不落库', async () => {
  const { store } = freshStore();
  const session = store.create('u_a', '怎么调整任务块');
  const res = {
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write() {
      // Node 在客户端断开后写会抛这个，若冒泡出去会撞上「响应头已发送」
      throw new Error('ERR_STREAM_WRITE_AFTER_END');
    },
    end() {
      this.writableEnded = true;
    },
    on() {},
    removeListener() {},
  };

  const result = await streamReply({
    res,
    store,
    userId: 'u_a',
    question: '怎么调整任务块',
    sessionId: session.id,
    answer: ANSWER,
    degraded: false,
  });

  assert.deepEqual(result, { aborted: true, persisted: false });
  assert.deepEqual(store.messages('u_a', session.id), []);
  assert.equal(store.usedToday('u_a'), 0);
  assert.equal(res.writableEnded, false, '写失败后不应再调 end');
});

/** 假上游：先吐一段正文，随后连接中断——用来验证「半截失败」不换文案 */
function partialThenBrokenFetch() {
  const encoder = new TextEncoder();
  return async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        let step = 0;
        return {
          async read() {
            step += 1;
            if (step === 1) {
              return {
                done: false,
                value: encoder.encode('data: {"choices":[{"delta":{"content":"这周还剩"}}]}\n\n'),
              };
            }
            // 第二块直接炸：模拟上游在传输中途断开
            throw new Error('socket hang up');
          },
        };
      },
    },
  });
}

const FACTS = { hasData: true, tools: { get_week: { hasData: true, plannedMin: 120 } } };
const LIVE_CONFIG = { apiKey: 'test-key', baseUrl: 'https://example.invalid/v1', model: 'm', temperature: 0.3, timeoutMs: 5000 };

test('半截失败：保留已发出的正文，只补一句不完整，不换降级文案', async () => {
  const { store } = freshStore();
  const session = store.create('u_a', '这周还剩多少任务');
  const { res, frames } = fakeRes();

  const result = await streamModelReply({
    res,
    store,
    userId: 'u_a',
    question: '这周还剩多少任务',
    sessionId: session.id,
    mode: 'data',
    facts: FACTS,
    toolCalls: [{ name: 'get_week', status: 'ok' }],
    config: LIVE_CONFIG,
    fetchImpl: partialThenBrokenFetch(),
  });

  assert.deepEqual(result, { aborted: false, persisted: true });
  const text = frames
    .filter((frame) => frame.startsWith('event: delta'))
    .map((frame) => JSON.parse(frame.split('\ndata: ')[1]).text)
    .join('');

  assert.ok(text.startsWith('这周还剩'), '已发出的正文不能丢');
  assert.ok(text.includes('不完整'), '半截时要说明不完整，不能让用户以为是完整回答');
  assert.equal(text.includes(DEGRADED_DATA_TEXT), false, '已有前文时换文案会拼出病句');
  // 可见层不许透出原始错误与状态码
  assert.equal(/socket|hang up|5\d\d|E\d{4}/.test(text), false);

  const done = JSON.parse(frames.at(-1).split('\ndata: ')[1]);
  assert.equal(done.incomplete, true);
  assert.equal(done.degraded, true);
  assert.deepEqual(done.citations, []);

  // 半截也是一次真实回答：正文落库、计一次配额，便于事后复盘
  assert.equal(store.messages('u_a', session.id)[1].content, text);
  assert.equal(store.usedToday('u_a'), 1);
});

test('客户端断流：不写消息、不占配额，也不抛 write after end', async () => {
  const { store } = freshStore();
  const session = store.create('u_a', '怎么调整任务块');
  const { res } = fakeRes({ closeAfterWrites: 3 });

  const result = await streamReply({
    res,
    store,
    userId: 'u_a',
    question: '怎么调整任务块',
    sessionId: session.id,
    answer: ANSWER,
    degraded: true,
  });

  assert.deepEqual(result, { aborted: true, persisted: false });
  assert.deepEqual(store.messages('u_a', session.id), []);
  assert.equal(store.usedToday('u_a'), 0, '断流中止不计入配额（SPEC R6）');
});
