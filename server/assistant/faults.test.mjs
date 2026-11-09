import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAULT_KINDS, FAULT_TIMEOUT_MS, applyFault, resolveFault,
} from './faults.mjs';

test('开关只认三种已知取值，空值与拼错误一律不注入', () => {
  assert.deepEqual(FAULT_KINDS, ['nokey', 'upstream500', 'timeout']);
  assert.equal(resolveFault({}), null);
  assert.equal(resolveFault({ ASSISTANT_FAULT: '' }), null);
  assert.equal(resolveFault({ ASSISTANT_FAULT: '   ' }), null);
  // 拼错了不能静默当成「无故障」之外的任何一种，否则以为是 500 其实是正常调用
  assert.equal(resolveFault({ ASSISTANT_FAULT: 'upstream' }), null);
  assert.equal(resolveFault({ ASSISTANT_FAULT: 'NOKEY' }), null);
  for (const kind of FAULT_KINDS) {
    assert.equal(resolveFault({ ASSISTANT_FAULT: kind }), kind);
  }
});

test('生产环境强制忽略开关：读到也只警告，不激活', () => {
  const env = { NODE_ENV: 'production', ASSISTANT_FAULT: 'upstream500' };
  assert.equal(resolveFault(env), null);
  // 第二次不再重复刷日志
  assert.equal(resolveFault(env), null);
});

test('nokey 只清空 Key：既不联网，也不碰其他配置', () => {
  const base = { ASSISTANT_API_KEY: 'real-key', ASSISTANT_MODEL: 'custom-model' };
  const override = applyFault('nokey', base);
  assert.equal(override.config.apiKey, '');
  assert.equal(override.config.model, 'custom-model', '模型名不能被故障注入改掉');
  assert.equal(override.fetchImpl, undefined);
});

test('upstream500 用假 Key + 假 fetch，永远返回 5xx', async () => {
  const override = applyFault('upstream500', { ASSISTANT_API_KEY: 'real-key' });
  assert.ok(override.config.apiKey.length > 0, '必须让调用层认为「已配置」，才能真的进到上游分支');
  const response = await override.fetchImpl('https://example.invalid/v1/chat/completions', {});
  assert.equal(response.ok, false);
  assert.equal(response.status, 500);
  assert.equal(response.body, null);
});

test('timeout 用极短超时 + 永不返回的 fetch，取消后按 abort 收尾', async () => {
  const override = applyFault('timeout', { ASSISTANT_API_KEY: 'real-key' });
  assert.equal(override.config.timeoutMs, FAULT_TIMEOUT_MS);
  assert.ok(FAULT_TIMEOUT_MS < 1000, '注入超时必须足够短，测试不该干等 20s');

  const controller = new AbortController();
  const pending = override.fetchImpl('https://example.invalid/v1/chat/completions', { signal: controller.signal });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, '不取消就一直挂起，这才叫超时场景');
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('无故障时返回空覆盖项，调用方原样透传', () => {
  assert.deepEqual(applyFault(null), {});
  assert.deepEqual(applyFault(undefined), {});
});
