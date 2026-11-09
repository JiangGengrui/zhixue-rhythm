import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  MAX_QUESTION_CHARS,
  useAssistant,
  type AssistantMessage,
  type Citation,
} from './useAssistant';
import { FEEDBACK_REASONS, suggestionsFor } from './suggestions';

/** 条带上的一列：日期、星期几、当天任务数与已完成数 */
export interface WeekDaySummary {
  date: string;
  label: string;
  total: number;
  done: number;
}

const MODE_LABEL = { knowledge: '功能答疑', data: '你的数据' } as const;
const MODE_HINT = {
  knowledge: '来自功能说明',
  data: '基于你的记录',
} as const;

/**
 * 引用 chip：有 `route` 的可点，跳对应页面；没有对应页面的（讲技术栈 / 部署）渲染成纯文本，
 * 点了不许报错。两侧都带 `title`，鼠标悬停能看清是哪一条。
 */
export function CitationChip({ citation }: { citation: Citation }) {
  if (!citation.route) {
    return (
      <span className="assistant-chip" title={`${citation.title} · 无对应页面`}>
        {citation.title}
      </span>
    );
  }
  return (
    <a
      className="assistant-chip link"
      href={`#${citation.route}`}
      title={`跳转到「${citation.title}」`}
    >
      {citation.title}
    </a>
  );
}

/** 复制优先走异步剪贴板；http 非 localhost 下它不存在，退回 execCommand，别让按钮点了没反应 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或非安全上下文：继续走下面的兜底
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function ReplyBody({ message, status }: { message: AssistantMessage; status: string }) {
  return (
    <div className={`assistant-bubble ${message.failed ? 'failed' : ''}`}>
      {message.content ? (
        <p className="assistant-text">{message.content}</p>
      ) : (
        <p className="assistant-text empty">{status || '正在组织回答…'}</p>
      )}

      {/* 首 token 慢的时候服务端会推 status，正文已经开始了就不必再喊等待 */}
      {message.pending && message.content ? <p className="assistant-note">{status || '继续生成中…'}</p> : null}

      {message.incomplete ? <p className="assistant-note warn">这次回答不完整，可以再问一次。</p> : null}
      {/* 只有数据类才有「降级」含义；知识类的 degraded 只表示没接模型，正文仍是语料原文 */}
      {message.degraded && message.mode === 'data' ? (
        <p className="assistant-note">这条回答没有用到你的实时数据。</p>
      ) : null}
      {message.fallback ? <p className="assistant-note">这条还没有标准答案，下面是我按功能整理的理解。</p> : null}

      {message.citations.length > 0 ? (
        <div className="assistant-cites">
          <span className="assistant-cites-label">来源</span>
          {message.citations.map((citation) => (
            <CitationChip key={`${citation.doc}:${citation.title}`} citation={citation} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 本周七列：点一列就把提问日期固定到那天，再点一次取消 */
function WeekStrip({
  days,
  selected,
  onSelect,
}: {
  days: WeekDaySummary[];
  selected: string | null;
  onSelect: (date: string | null) => void;
}) {
  return (
    <div className="assistant-strip" role="group" aria-label="按日期提问">
      {days.map((day) => {
        const active = day.date === selected;
        return (
          <button
            key={day.date}
            type="button"
            className={`assistant-strip-day${active ? ' active' : ''}`}
            aria-pressed={active}
            data-date={day.date}
            onClick={() => onSelect(active ? null : day.date)}
            title={`${day.date} 周${day.label}${day.total ? ` · ${day.done}/${day.total} 项已完成` : ' · 暂无安排'}`}
          >
            <span className="assistant-strip-label">{day.label}</span>
            <span className="assistant-strip-num">{Number(day.date.slice(8, 10))}</span>
            <span className="assistant-strip-progress" aria-hidden="true">
              {day.total ? `${day.done}/${day.total}` : '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AssistantPanel({
  offline = false,
  days = [],
  hasData = false,
}: {
  offline?: boolean;
  days?: WeekDaySummary[];
  hasData?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { messages, status, busy, error, send, stop, reset, submitFeedback } = useAssistant();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 新消息或新状态都要把视线拉到底部，否则用户看不见正在生成的那句
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, status]);

  const length = draft.trim().length;
  const tooLong = length > MAX_QUESTION_CHARS;
  const canSend = !busy && !offline && length > 0 && !tooLong;
  const suggestions = suggestionsFor(hasData);
  const focusLabel = selectedDate
    ? days.find((day) => day.date === selectedDate)?.label ?? ''
    : '';

  function ask(question: string) {
    if (busy || offline) return;
    setDraft('');
    void send(question, { date: selectedDate ?? undefined });
  }

  function sendNow() {
    if (!canSend) return;
    const question = draft;
    setDraft('');
    void send(question, { date: selectedDate ?? undefined });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    sendNow();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter 发送、Shift+Enter 换行：手机上 Enter 本来就是换行，所以只在无 Shift 时拦截
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendNow();
    }
  }

  async function copy(message: AssistantMessage) {
    const ok = await copyText(message.content);
    if (!ok) return;
    setCopiedId(message.id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === message.id ? null : current));
    }, 1600);
  }

  function clear() {
    // 清空不可撤销，必须问一句；原生 confirm 在手机与桌面都能用，不额外做一套弹层
    if (!window.confirm('清空后这段对话不会保留，确定吗？')) return;
    reset();
    setSelectedDate(null);
  }

  return (
    <div className="assistant">
      <button
        type="button"
        className="assistant-fab"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls="assistant-panel"
        disabled={offline}
        title={offline ? '离线状态，恢复网络后再问' : '问问你的学习助手'}
      >
        <span aria-hidden="true">?</span>
        问助手
      </button>

      {open ? (
        <section id="assistant-panel" className="assistant-panel" role="dialog" aria-label="学习助手">
          <header className="assistant-head">
            <div>
              <strong>学习助手</strong>
              <p>可以问功能怎么用，也可以问这周还剩多少任务</p>
            </div>
            <div className="assistant-head-actions">
              {messages.length > 0 ? (
                <button type="button" className="assistant-clear" onClick={clear}>
                  清空
                </button>
              ) : null}
              <button type="button" className="assistant-close" onClick={() => setOpen(false)} aria-label="关闭助手">
                ×
              </button>
            </div>
          </header>

          {days.length === 7 ? (
            <WeekStrip days={days} selected={selectedDate} onSelect={setSelectedDate} />
          ) : null}

          <div className="assistant-list" ref={listRef}>
            {messages.length === 0 ? (
              <div className="assistant-empty">
                <p>试试这样问：</p>
                <div className="assistant-suggest">
                  {suggestions.map((item) => (
                    <button
                      key={item.text}
                      type="button"
                      data-question={item.text}
                      disabled={busy || offline}
                      onClick={() => ask(item.text)}
                    >
                      <span className={`assistant-suggest-mode ${item.mode}`}>
                        {MODE_LABEL[item.mode]}
                      </span>
                      {item.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) =>
                message.role === 'user' ? (
                  <div className="assistant-msg user" key={message.id}>
                    <p className="assistant-bubble">{message.content}</p>
                  </div>
                ) : (
                  <div className="assistant-msg bot" key={message.id}>
                    {message.mode ? (
                      <span className={`assistant-tag ${message.mode}`} title={MODE_HINT[message.mode]}>
                        {MODE_LABEL[message.mode]}
                      </span>
                    ) : null}
                    <ReplyBody message={message} status={status} />

                    {message.messageId && !message.pending ? (
                      <div className="assistant-actions">
                        <button type="button" onClick={() => void copy(message)}>
                          {copiedId === message.id ? '已复制' : '复制'}
                        </button>
                        <button
                          type="button"
                          className={message.feedback === 'up' ? 'on' : ''}
                          aria-pressed={message.feedback === 'up'}
                          disabled={message.feedbackSending}
                          onClick={() => void submitFeedback(message, 'up')}
                        >
                          有用
                        </button>
                        <button
                          type="button"
                          className={message.feedback === 'down' ? 'on' : ''}
                          aria-pressed={message.feedback === 'down'}
                          disabled={message.feedbackSending}
                          onClick={() => void submitFeedback(message, 'down')}
                        >
                          没用
                        </button>
                      </div>
                    ) : null}

                    {message.feedback === 'down' ? (
                      <div className="assistant-reasons">
                        <span>哪里不对？</span>
                        {FEEDBACK_REASONS.map((reason) => (
                          <button
                            key={reason.value}
                            type="button"
                            className={message.feedbackReason === reason.value ? 'on' : ''}
                            aria-pressed={message.feedbackReason === reason.value}
                            disabled={message.feedbackSending}
                            onClick={() => void submitFeedback(message, 'down', reason.value)}
                          >
                            {reason.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ),
              )
            )}
          </div>

          {error ? (
            <p className="assistant-error" role="alert">
              {error}
            </p>
          ) : null}

          <form className="assistant-composer" onSubmit={submit}>
            {selectedDate ? (
              <div className="assistant-focus">
                <span>
                  已选 {Number(selectedDate.slice(5, 7))} 月 {Number(selectedDate.slice(8, 10))} 日
                  {focusLabel ? `（周${focusLabel}）` : ''}，提问按这天算
                </span>
                <button type="button" onClick={() => setSelectedDate(null)} aria-label="取消日期">
                  ×
                </button>
              </div>
            ) : null}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              aria-label="提问内容"
              placeholder={offline ? '离线中，恢复网络后再问' : '输入问题，Enter 发送'}
            />
            <div className="assistant-bar">
              <span className={tooLong ? 'assistant-count over' : 'assistant-count'}>
                {length}/{MAX_QUESTION_CHARS}
              </span>
              {busy ? (
                <button type="button" className="assistant-send stop" onClick={stop}>
                  停止
                </button>
              ) : (
                <button type="submit" className="assistant-send" disabled={!canSend}>
                  发送
                </button>
              )}
            </div>
            {tooLong ? (
              <p className="assistant-note warn">
                问题最多 {MAX_QUESTION_CHARS} 字，超出的部分发不出去。
              </p>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
