import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { LlmError, isLlmConfigured, llmConfig, streamChatCompletion } from './llm.mjs';

/** 起一个假上游：`/v1/chat/completions` 由 handler 决定怎么回 */
async function withUpstream(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    return await run(baseUrl);
  } finally {
    // 超时用例里连接是挂着的，先强断再 close，否则测试自己会挂住
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function configWith(baseUrl, overrides = {}) {
  return { ...llmConfig({}), apiKey: 'test-key', baseUrl, timeoutMs: 2000, ...overrides };
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test('正常流：两段 delta 拼成全文，首 token 时间有值', async () => {
  const deltas = [];
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame({ choices: [{ delta: { content: '本周' } }] }));
      res.write(sseFrame({ choices: [{ delta: { content: '还剩 3 个任务' } }] }));
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (baseUrl) => {
      const result = await streamChatCompletion({
        messages: [{ role: 'user', content: '这周还剩多少任务' }],
        config: configWith(baseUrl),
        onDelta: (piece) => deltas.push(piece),
      });
      assert.equal(result.text, '本周还剩 3 个任务');
      assert.deepEqual(deltas, ['本周', '还剩 3 个任务']);
      assert.ok(result.firstTokenMs >= 0);
      assert.ok(result.latencyMs >= 0);
    },
  );
});

test('模型名与请求体按配置下发，且只发服务端构造的 messages', async () => {
  let received = null;
  await withUpstream(
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseFrame({ choices: [{ delta: { content: '好' } }] }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    },
    async (baseUrl) => {
      await streamChatCompletion({
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }],
        config: configWith(baseUrl, { model: 'custom-model', temperature: 0.2 }),
      });
      assert.equal(received.model, 'custom-model');
      assert.equal(received.stream, true);
      assert.equal(received.temperature, 0.2);
      assert.equal(received.messages.length, 2);
    },
  );
});

test('上游 5xx 归为 upstream，且带状态码供调用方判断（不拼进文案）', async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    },
    async (baseUrl) => {
      await assert.rejects(
        streamChatCompletion({ messages: [], config: configWith(baseUrl) }),
        (err) => {
          assert.ok(err instanceof LlmError);
          assert.equal(err.kind, 'upstream');
          assert.equal(err.status, 503);
          return true;
        },
      );
    },
  );
});

test('上游挂起超过总超时：kind=timeout，并保留已收到的半截文本', async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame({ choices: [{ delta: { content: '半截' } }] }));
      // 之后不再写、也不 end，模拟卡住的上游
    },
    async (baseUrl) => {
      await assert.rejects(
        streamChatCompletion({
          messages: [],
          config: configWith(baseUrl, { timeoutMs: 80 }),
        }),
        (err) => {
          assert.equal(err.kind, 'timeout');
          assert.equal(err.partial, '半截');
          return true;
        },
      );
    },
  );
});

test('上游只发 [DONE] 不发内容：按空响应失败，避免前端出现空气泡', async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: [DONE]\n\n');
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        streamChatCompletion({ messages: [], config: configWith(baseUrl) }),
        (err) => err.kind === 'upstream' && /空响应/.test(err.message),
      );
    },
  );
});

test('上游用 data 帧回错误对象：当作失败而不是正文', async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame({ choices: [{ delta: { content: '先给一点' } }] }));
      res.write(sseFrame({ error: { code: 429, message: 'rate limit' } }));
      res.end();
    },
    async (baseUrl) => {
      await assert.rejects(
        streamChatCompletion({ messages: [], config: configWith(baseUrl) }),
        (err) => err.kind === 'upstream' && err.partial === '先给一点',
      );
    },
  );
});

test('未配置 Key 时直接报 config，绝不发起网络请求', async () => {
  await assert.rejects(
    streamChatCompletion({
      messages: [],
      config: { ...llmConfig({}), apiKey: '' },
      fetchImpl: () => {
        throw new Error('不应该联网');
      },
    }),
    (err) => err.kind === 'config',
  );
});

test('调用方取消（AbortSignal）：kind=aborted，不重试也不报网络错', async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame({ choices: [{ delta: { content: '开头' } }] }));
    },
    async (baseUrl) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(
        streamChatCompletion({
          messages: [],
          config: configWith(baseUrl, { timeoutMs: 5000 }),
          signal: controller.signal,
        }),
        (err) => err.kind === 'aborted',
      );
    },
  );
});

test('配置默认值：没给环境变量时指向默认供应商，NaN 温度被兜住', () => {
  const config = llmConfig({});
  assert.equal(config.model, 'gpt-4o-mini');
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.temperature, 0.3);
  assert.equal(config.timeoutMs, 20_000);
  assert.equal(isLlmConfigured({}), false);
  assert.equal(isLlmConfigured({ ASSISTANT_API_KEY: 'k' }), true);

  const bad = llmConfig({ ASSISTANT_TEMPERATURE: 'abc', ASSISTANT_TIMEOUT_MS: 'xyz' });
  assert.equal(bad.temperature, 0.3);
  assert.equal(bad.timeoutMs, 20_000);
});
