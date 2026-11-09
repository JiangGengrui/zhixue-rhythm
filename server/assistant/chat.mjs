import { newId } from '../auth.mjs';
import { nowISO } from '../db.mjs';
import { DEGRADED_DATA_TEXT, PROMPT_VERSION, buildRequestMessages } from './prompt.mjs';
import {
  DEFAULT_FIRST_TOKEN_MS, LlmError, llmConfig, streamChatCompletion,
} from './llm.mjs';

/** 提示词版本：改 system 模板必须改它（SPEC §8、DECISIONS D8.2） */
export { PROMPT_VERSION };
/** 单次提问长度上限（SPEC R7：超 500 字报 E1002） */
export const MAX_QUESTION_CHARS = 500;

/** 分块长度：只为让前端有增量感，不改变最终正文（等于语料 answer 原文） */
const CHUNK_SIZE = 18;

/**
 * 打开 SSE 响应。
 * `X-Accel-Buffering: no` 是给反向代理看的：不加的话 nginx 会攒满缓冲才下发，
 * 前端看到的就是「一次性蹦出整段」，首字延迟指标也会失真。
 */
export function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

/** 单帧编码，独立导出便于测试与排障时手工拼帧 */
export function encodeFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 按固定长度切块；只在字符边界切，避免把 emoji 拆成半个 */
export function splitChunks(text, size = CHUNK_SIZE) {
  const chars = Array.from(text);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/**
 * 打开流并返回一个「安全写」通道。
 *
 * 为什么不让调用方直接 `res.write`：客户端断开的瞬间写一个已关闭的 socket 会抛
 * `ERR_STREAM_WRITE_AFTER_END`，而外层错误处理此时已经发过响应头，再 sendJson 就会
 * 撞上 `ERR_HTTP_HEADERS_SENT`，把一次正常的用户断网变成进程级噪音日志。
 * 所以所有帧都走 `send()`：写失败即标记断开并静默丢弃后续帧。
 */
function beginSse(res) {
  let aborted = false;
  const onClose = () => {
    if (!res.writableEnded) aborted = true;
  };
  res.on('close', onClose);
  sseStart(res);
  return {
    isAborted: () => aborted,
    markAborted: () => {
      aborted = true;
    },
    send(event, data) {
      if (aborted) return false;
      try {
        res.write(encodeFrame(event, data));
        return true;
      } catch {
        aborted = true;
        return false;
      }
    },
    release() {
      if (typeof res.removeListener === 'function') res.removeListener('close', onClose);
    },
  };
}

/**
 * 收尾：发 `done`、落库、更新会话时间、记一条事件、关流。
 *
 * 落库规则与 SPEC R6 一致：只有把 `done` 发出去的请求才算一次成功提问；
 * 客户端中途断流（`close` 早于 `end`）不写消息、不写事件、不占配额。
 */
function completeStream({
  res, stream, store, userId, sessionId, question, startedISO,
  text, mode, citations, toolCalls, degraded, promptVersion, firstTokenAt, startedAt, extra,
}) {
  // done 之前再确认一次：断开早于 done 就当作未完成，不写库也不占配额
  if (stream.isAborted()) {
    stream.release();
    return { aborted: true, persisted: false };
  }

  // 消息 id 必须在发 done 之前就定下来：前端拿到它才能对这条回答点赞/踩。
  // 顺序仍是「先发 done、再落库」，所以没发出去的请求不会留下脏数据。
  const messageId = newId('msg');

  const sent = stream.send('done', {
    // 反馈接口用它定位消息；前端不该自己编 id
    messageId,
    citations,
    usage: { chars: text.length },
    latencyMs: Date.now() - startedAt,
    firstTokenMs: firstTokenAt,
    // 语料未命中时为 true：前端据此显示「没把握」而不假装答出来了
    fallback: mode === 'knowledge' && citations.length === 0,
    mode,
    // meta 里的 degraded 是「开口前」的判断；上游中途失败只能事后知道，
    // 所以 done 里再带一次，前端以它为准刷新提示
    degraded,
    ...extra,
  });
  if (!sent) {
    stream.release();
    return { aborted: true, persisted: false };
  }

  const latencyMs = Date.now() - startedAt;
  store.appendMessage(userId, sessionId, { role: 'user', content: question, createdAt: startedISO });
  store.appendMessage(userId, sessionId, {
    // 与 done 帧里同一个 id：否则前端反馈时找不到这条消息
    id: messageId,
    role: 'assistant',
    content: text,
    mode,
    citations,
    toolCalls,
    latencyMs,
  });
  store.touch(userId, sessionId);
  store.recordEvent({
    userId,
    sessionId,
    question,
    mode,
    toolNames: (toolCalls ?? []).map((call) => call.name),
    degraded,
    firstTokenMs: firstTokenAt,
    latencyMs,
    promptVersion,
  });

  res.end();
  stream.release();
  return { aborted: false, persisted: true };
}

/**
 * 下发一次 A 类回答：meta → delta* → done，然后落库。
 * 正文就是语料 `answer` 原文（SPEC R2 要求可逐字比对），因此这里只做分块，不做改写。
 */
export async function streamReply({
  res,
  store,
  userId,
  question,
  sessionId,
  answer,
  degraded,
  promptVersion = PROMPT_VERSION,
}) {
  const startedAt = Date.now();
  const startedISO = nowISO();
  const stream = beginSse(res);
  const mode = answer.mode === 'data' ? 'data' : 'knowledge';
  const citations = answer.citations ?? [];
  let firstTokenAt = null;

  if (!stream.send('meta', { sessionId, mode, degraded })) {
    stream.release();
    return { aborted: true, persisted: false };
  }

  for (const piece of splitChunks(answer.text)) {
    if (firstTokenAt === null) firstTokenAt = Date.now() - startedAt;
    if (!stream.send('delta', { text: piece })) {
      stream.release();
      return { aborted: true, persisted: false };
    }
  }

  return completeStream({
    res, stream, store, userId, sessionId, question, startedISO,
    text: answer.text,
    mode,
    citations,
    toolCalls: answer.toolCalls ?? [],
    degraded,
    promptVersion,
    firstTokenAt,
    startedAt,
  });
}

/**
 * 下发一次 B 类数据回答：工具结果作为事实注入 prompt，模型只负责把数字讲顺。
 *
 * 降级分三种，用户可见文案一律固定，绝不透出状态码：
 * - 未配置 Key，或没有工具事实：整段 `DEGRADED_DATA_TEXT`（不发起上游请求）；
 * - 上游失败/超时且一个字符都没发出去：整段 `DEGRADED_DATA_TEXT`；
 * - 已经发出半截才失败：补一句「回答不完整」并在 `done` 里带 `incomplete`，
 *   此时不强行换文案——前端已经把前文拼上去了，换文案会拼出病句。
 */
export async function streamModelReply({
  res,
  store,
  userId,
  question,
  sessionId,
  mode = 'data',
  facts,
  history = [],
  toolCalls = [],
  signal,
  config = llmConfig(),
  fetchImpl,
  slowThresholdMs = DEFAULT_FIRST_TOKEN_MS,
  promptVersion = PROMPT_VERSION,
}) {
  const startedAt = Date.now();
  const startedISO = nowISO();
  const stream = beginSse(res);
  // 没有工具事实就不让模型开口：「数字只能来自工具返回」是硬护栏，
  // 拿 null 当数据让模型自由发挥，等于把不可验收的编造放进回答。
  const hasFacts = facts !== undefined && facts !== null;
  const canUseModel = config.apiKey.length > 0 && hasFacts;
  let degraded = !canUseModel;
  let incomplete = false;
  let text = '';
  let firstTokenAt = null;

  if (!stream.send('meta', { sessionId, mode, degraded })) {
    stream.release();
    return { aborted: true, persisted: false };
  }

  const emit = (chunk) => {
    if (!chunk) return true;
    if (firstTokenAt === null) firstTokenAt = Date.now() - startedAt;
    text += chunk;
    return stream.send('delta', { text: chunk });
  };

  const emitAll = (chunk) => {
    for (const piece of splitChunks(chunk)) {
      if (!emit(piece)) return false;
    }
    return true;
  };

  if (canUseModel) {
    try {
      const messages = buildRequestMessages({ mode, question, history, facts });
      const result = await streamChatCompletion({
        messages,
        config,
        signal,
        fetchImpl,
        slowThresholdMs,
        onDelta: (piece) => emit(piece),
        // 首 token 慢只切文案：中断会让用户白白等到 20s 才看到一句话
        onSlowStart: () => {
          stream.send('status', { text: '正在整理你的数据…' });
        },
      });
      // 以最终文本为准：onDelta 与返回值应当一致，这里兜住上游补发的收尾片段
      text = result.text;
      firstTokenAt = result.firstTokenMs ?? firstTokenAt;
    } catch (err) {
      if (err instanceof LlmError && err.kind === 'aborted') {
        stream.release();
        return { aborted: true, persisted: false };
      }
      degraded = true;
      if (text) {
        incomplete = true;
        emitAll('\n\n（这次回答不完整，可以再问一次。）');
      } else {
        emitAll(DEGRADED_DATA_TEXT);
      }
    }
  } else {
    emitAll(DEGRADED_DATA_TEXT);
  }

  if (stream.isAborted()) {
    stream.release();
    return { aborted: true, persisted: false };
  }

  return completeStream({
    res, stream, store, userId, sessionId, question, startedISO,
    text,
    mode,
    citations: [],
    toolCalls,
    degraded,
    promptVersion,
    firstTokenAt,
    startedAt,
    extra: incomplete ? { incomplete: true } : {},
  });
}
