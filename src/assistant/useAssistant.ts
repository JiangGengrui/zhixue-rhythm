import { useCallback, useEffect, useRef, useState } from 'react';
import { createSseParser } from './sse';
import { feedbackPayload, type FeedbackReason } from './suggestions';

/** 与服务端同一条上限（SPEC R7）：超了在前端就拦住，别让用户白等一次网络往返 */
export const MAX_QUESTION_CHARS = 500;

/** 提交版只保留数据通道；功能答疑（知识库）已移除 */
export type AssistantMode = 'data';

export interface Citation {
  doc: string;
  title: string;
  route: string | null;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  mode?: AssistantMode;
  /** 服务端的消息 id（`done` 帧带回），反馈接口靠它定位；本地 id 不能拿来用 */
  messageId?: string;
  /** 当前用户的评价；undefined = 还没评 */
  feedback?: 'up' | 'down' | null;
  feedbackReason?: FeedbackReason;
  /** 请求在途：按钮禁用，避免连点产生两个请求 */
  feedbackSending?: boolean;
  /** 服务端明确说了「数据取不到 / 上游失败」，前端据此标注，避免把兜底当结论 */
  degraded?: boolean;
  /** 正文被中途掐断（上游断开或用户点了停止） */
  incomplete?: boolean;
  /** 知识类问题没命中语料 */
  fallback?: boolean;
  /** 还在收字，气泡里显示占位文案而不是空白 */
  pending?: boolean;
  failed?: boolean;
  /**
   * 流式回答按收到的顺序切开的分段。渲染时每段包一层 span 各自淡入，
   * 后到的字就不会「整块跳出来」；历史消息没有这个字段，退回渲染 content。
   */
  chunks?: string[];
}

interface ChatState {
  messages: AssistantMessage[];
  /** 首 token 慢时的等待提示，来自 `status` 帧 */
  status: string;
  busy: boolean;
  error: string;
}

const EMPTY: ChatState = { messages: [], status: '', busy: false, error: '' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.text === 'string' ? record.text : '';
}

function citationsOf(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  const parsed: Citation[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.doc !== 'string' || typeof record.title !== 'string') continue;
    parsed.push({
      doc: record.doc,
      title: record.title,
      route: typeof record.route === 'string' && record.route ? record.route : null,
    });
  }
  return parsed;
}

/** 服务端的错误体是中文人话，优先照抄；拿不到再按状态码兜底 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const payload: unknown = await res.json();
    const message = asRecord(asRecord(payload)?.error)?.message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // 网关返回了 HTML/空体，走下面的兜底
  }
  if (res.status === 401) return '登录状态已失效，请刷新页面后重试。';
  if (res.status === 429) return '今天的提问次数用完了，明天再来。';
  return '助手暂时不可用，请稍后再试。';
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export function useAssistant() {
  const [state, setState] = useState<ChatState>(EMPTY);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  // 正在提交反馈的消息 id：防连点，状态里的 feedbackSending 要等一帧才生效
  const feedbackInFlight = useRef<Set<string>>(new Set());

  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = useCallback((id: string, updater: (message: AssistantMessage) => AssistantMessage) => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.map((message) => (message.id === id ? updater(message) : message)),
    }));
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    sessionIdRef.current = null;
    setState(EMPTY);
  }, []);

  const send = useCallback(
    async (raw: string, options: { date?: string } = {}) => {
      const question = raw.trim();
      if (!question) return;
      if (question.length > MAX_QUESTION_CHARS) {
        setState((prev) => ({ ...prev, error: `问题最多 ${MAX_QUESTION_CHARS} 字，精简一下再问。` }));
        return;
      }
      if (busyRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      busyRef.current = true;

      const replyId = nextId('a');
      setState((prev) => ({
        messages: [
          ...prev.messages,
          { id: nextId('q'), role: 'user', content: question, citations: [] },
          { id: replyId, role: 'assistant', content: '', citations: [], chunks: [], pending: true },
        ],
        status: '',
        busy: true,
        error: '',
      }));

      const parser = createSseParser();
      let finished = false;

      const consume = (chunk: string) => {
        for (const frame of parser.push(chunk)) {
          if (frame.event === 'meta') {
            const meta = asRecord(frame.data);
            if (typeof meta?.sessionId === 'string') sessionIdRef.current = meta.sessionId;
            const mode = meta?.mode === 'data' ? 'data' : undefined;
            const degraded = meta?.degraded === true;
            patch(replyId, (message) => ({ ...message, mode, degraded }));
          } else if (frame.event === 'status') {
            const text = textOf(frame.data);
            setState((prev) => ({ ...prev, status: text }));
          } else if (frame.event === 'delta') {
            const text = textOf(frame.data);
            if (!text) continue;
            // 同时记一份分段：渲染层靠它让新到的字单独淡入
            patch(replyId, (message) => ({
              ...message,
              content: message.content + text,
              chunks: [...(message.chunks ?? []), text],
            }));
          } else if (frame.event === 'done') {
            const done = asRecord(frame.data);
            finished = true;
            patch(replyId, (message) => ({
              ...message,
              pending: false,
              // 反馈要靠这个 id，缺了就把反馈按钮藏起来，别让用户点了报错
              messageId: typeof done?.messageId === 'string' ? done.messageId : undefined,
              citations: citationsOf(done?.citations),
              incomplete: done?.incomplete === true,
              degraded: done?.degraded === true || message.degraded === true,
              fallback: done?.fallback === true,
            }));
            setState((prev) => ({ ...prev, status: '' }));
          }
        }
      };

      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            ...(sessionIdRef.current ? { sessionId: sessionIdRef.current } : {}),
            // 条带上点了某天就带上它，服务端按那天取数；没点不发这个字段
            ...(options.date ? { date: options.date } : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const message = await readErrorMessage(res);
          throw new Error(message);
        }
        if (!res.body) throw new Error('当前浏览器不支持流式回答，请换一个现代浏览器。');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // stream: true —— 一个汉字可能被切在两个 chunk 之间
          consume(decoder.decode(value, { stream: true }));
        }
        // 最后一点字节可能还留在解码器里
        consume(decoder.decode());
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === 'AbortError') {
          // 用户主动停止：保留已收到的正文，标记不完整，不弹错误
          patch(replyId, (message) => ({
            ...message,
            pending: false,
            incomplete: true,
            content: message.content || '（已停止）',
          }));
        } else {
          const message = error instanceof Error ? error.message : '助手暂时不可用，请稍后再试。';
          setState((prev) => ({ ...prev, error: message }));
          patch(replyId, (item) => ({
            ...item,
            pending: false,
            failed: true,
            content: item.content || '这次没答上来，换个问法或稍后再试。',
          }));
        }
      } finally {
        busyRef.current = false;
        abortRef.current = null;
        setState((prev) => ({
          ...prev,
          busy: false,
          status: '',
          // 兜底：没收到 done 就断了，也不能留个转圈的气泡
          messages: prev.messages.map((message) =>
            message.id === replyId && message.pending
              ? {
                  ...message,
                  pending: false,
                  incomplete: !finished ? true : message.incomplete,
                  content: message.content || '（没有收到回答）',
                }
              : message,
          ),
        }));
      }
    },
    [patch],
  );

  /**
   * 给一条回答评价：`'up'` / `'down'`（可再带上原因）。再点同一个按钮 = 取消。
   * 乐观更新先亮起选中，失败退回原值并提示——网络慢时用户会以为没点上。
   */
  const submitFeedback = useCallback(
    async (target: AssistantMessage, value: 'up' | 'down', reason?: FeedbackReason) => {
      // 没有服务端 id 就评不了（比如请求直接失败的那条），按钮本来也不会渲染
      if (!target.messageId) return;
      // 用 ref 而不是 message.feedbackSending 拦重复点击：快速双击时两次回调拿到的是
      // 同一份渲染快照，state 里的 true 还没渲染出来，会发出两个请求
      if (feedbackInFlight.current.has(target.id)) return;
      feedbackInFlight.current.add(target.id);

      // 带着原因是「给踩补原因」，不是再点一次，所以不能算取消
      const cancelling = target.feedback === value && !reason;
      const nextValue = cancelling ? null : value;
      const nextReason = cancelling || value === 'up' ? undefined : reason;
      const previous = { feedback: target.feedback, feedbackReason: target.feedbackReason };

      // 上一次评价失败的提示要撤掉，否则用户以为这次也没成功
      setState((prev) => (prev.error ? { ...prev, error: '' } : prev));
      patch(target.id, (message) => ({
        ...message,
        feedback: nextValue,
        feedbackReason: nextReason,
        feedbackSending: true,
      }));

      try {
        const res = await fetch(
          `/api/assistant/messages/${encodeURIComponent(target.messageId)}/feedback`,
          {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(feedbackPayload(nextValue, nextReason)),
          },
        );
        if (!res.ok) throw new Error(await readErrorMessage(res));
        patch(target.id, (message) => ({ ...message, feedbackSending: false }));
      } catch (error) {
        patch(target.id, (message) => ({ ...message, ...previous, feedbackSending: false }));
        setState((prev) => ({
          ...prev,
          error: error instanceof Error ? error.message : '评价没发出去，请稍后再试。',
        }));
      } finally {
        feedbackInFlight.current.delete(target.id);
      }
    },
    [patch],
  );

  return { ...state, send, stop, reset, submitFeedback };
}
