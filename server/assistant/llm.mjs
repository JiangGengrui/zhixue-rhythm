/**
 * OpenAI 兼容的流式模型调用（只用 `fetch`，零第三方依赖）。
 *
 * 这里只负责「把上游的 token 流拿回来」，不判断该不该调模型、也不决定降级文案：
 * 那些属于 chat.mjs 的路由与降级链。分层的好处是这一层可以用假上游完整单测。
 */

/** 单次回答的总上限（SPEC R5：20s 未完成就中断收尾） */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** 首 token 观察阈值：超过它只把文案切成「正在整理」，不失败（SPEC ARCHITECTURE §2.6） */
export const DEFAULT_FIRST_TOKEN_MS = 5_000;

/**
 * 模型层的可分类错误：调用方按 `kind` 决定降级行为，
 * 绝不把 `message` 直接给用户看（SPEC R5：可见层无原始状态码）。
 */
export class LlmError extends Error {
  constructor(kind, message, { status, partial = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    /** 已经收到的半截文本：超时收尾时要让上层知道「不完整」而不是「空」 */
    this.partial = partial;
  }
}

export function llmConfig(env = process.env) {
  const timeoutMs = Number(env.ASSISTANT_TIMEOUT_MS);
  const temperature = Number(env.ASSISTANT_TEMPERATURE);
  return {
    apiKey: String(env.ASSISTANT_API_KEY ?? '').trim(),
    baseUrl: String(env.ASSISTANT_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: String(env.ASSISTANT_MODEL ?? 'gpt-4o-mini'),
    // temperature 传 NaN 会被序列化成 null，上游直接 400，所以这里做一次兜底
    temperature: Number.isFinite(temperature) ? temperature : 0.3,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** 无 Key 时整个模型链路关闭：A 类照常回语料原文，B 类走降级文案 */
export function isLlmConfigured(env = process.env) {
  return llmConfig(env).apiKey.length > 0;
}

/**
 * 逐行读 SSE：只认 `data:` 行，忽略注释行（部分上游会发 `: keep-alive`）与 event 行。
 * 半包处理：把残行留在 buffer 里，等下一块数据到达再拼。
 */
async function readSse(body, onPayload) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    onPayload(payload);
    return false;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (handleLine(line)) return;
      index = buffer.indexOf('\n');
    }
  }

  // 上游可能不补最后一个换行
  const tail = buffer.trim();
  if (tail) handleLine(tail);
}

/**
 * 发起一次流式补全，边收边回调 `onDelta`，返回完整文本与耗时指标。
 *
 * - 总超时（默认 20s）由这里的定时器负责，不依赖前端 `AbortController`：
 *   否则前端关页面后上游仍挂着，配额已被算掉就白丢一次调用（ARCHITECTURE §2.8）。
 * - `fetchImpl` 可注入，测试用假上游，不联网。
 */
export async function streamChatCompletion({
  messages,
  config = llmConfig(),
  signal,
  onDelta,
  fetchImpl = globalThis.fetch,
  // 阈值（毫秒）与返回值 firstTokenMs（实测耗时）分开命名，避免调用方把两者搞混
  slowThresholdMs = DEFAULT_FIRST_TOKEN_MS,
  onSlowStart,
}) {
  if (!config.apiKey) throw new LlmError('config', '未配置 ASSISTANT_API_KEY');
  if (typeof fetchImpl !== 'function') throw new LlmError('config', '当前运行时没有 fetch');

  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let slowNotified = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  // 首 token 超阈值只切文案，不中断：这条路径不能让用户看到空白
  const slowTimer = setTimeout(() => {
    slowNotified = true;
    onSlowStart?.();
  }, slowThresholdMs);

  const relayAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      throw new LlmError('aborted', '调用方已取消');
    }
    signal.addEventListener('abort', relayAbort, { once: true });
  }

  let text = '';
  let firstTokenAt = null;

  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: config.temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      // 上游正文不进日志也不回显：它可能包含提问原文
      throw new LlmError('upstream', '模型服务返回异常', { status: response.status });
    }

    await readSse(response.body, (payload) => {
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        return;
      }
      // 上游用 data 帧发错误对象的情况也要按失败处理
      if (json.error) throw new LlmError('upstream', '模型服务返回错误帧', { status: json.error.code });
      const piece = json.choices?.[0]?.delta?.content;
      if (typeof piece !== 'string' || piece === '') return;
      if (firstTokenAt === null) {
        firstTokenAt = Date.now() - startedAt;
        clearTimeout(slowTimer);
      }
      text += piece;
      onDelta?.(piece);
    });
  } catch (err) {
    if (err instanceof LlmError) {
      // 上面抛出的错误可能发生在半截文本之后：把已收到的内容带出去
      if (!err.partial) err.partial = text;
      throw err;
    }
    if (timedOut) throw new LlmError('timeout', '模型响应超时', { partial: text });
    if (signal?.aborted) throw new LlmError('aborted', '调用方已取消', { partial: text });
    throw new LlmError('network', '模型服务连接失败', { partial: text });
  } finally {
    clearTimeout(timer);
    clearTimeout(slowTimer);
    signal?.removeEventListener('abort', relayAbort);
  }

  if (!text) throw new LlmError('upstream', '模型返回空响应');
  if (firstTokenAt === null) clearTimeout(slowTimer);

  return {
    text,
    firstTokenMs: firstTokenAt,
    latencyMs: Date.now() - startedAt,
    slowStart: slowNotified && firstTokenAt === null,
  };
}
