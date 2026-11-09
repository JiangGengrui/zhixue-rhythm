import { newId } from '../auth.mjs';
import { nowISO } from '../db.mjs';

/** 每日提问上限（SPEC R6：30 次/服务器自然日，Asia/Shanghai 00:00 重置） */
export const MAX_DAILY_QUESTIONS = 30;
/** 会话与提问原文的保留天数（SPEC R6：会话存 30 天） */
export const RETENTION_DAYS = 30;

const TITLE_MAX = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 服务器自然日（Asia/Shanghai）。
 * 配额按「自然日」而不是「最近 24 小时」算，所以必须落到日期字符串上，
 * 否则凌晨提问会被算进前一天。
 */
export function shanghaiDay(at = new Date()) {
  // en-CA 的日期格式就是 YYYY-MM-DD，省掉手写 padStart
  return at.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** 下一次额度重置的时刻：Asia/Shanghai 次日 00:00，返回带时区的 ISO 便于前端直接 new Date() */
export function nextShanghaiMidnightISO(at = new Date()) {
  const next = new Date(`${shanghaiDay(at)}T00:00:00+08:00`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function safeParse(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function normalizeSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

export function normalizeMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    mode: row.mode ?? undefined,
    citations: safeParse(row.citations, []),
    toolCalls: safeParse(row.tool_calls, []),
    latencyMs: row.latency_ms ?? undefined,
    feedback: row.feedback ?? undefined,
    createdAt: row.created_at,
  };
}

export function createSessionStore(db) {
  const q = {
    insert: db.prepare(
      'INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ),
    // 软删过的会话一律查不到：所有读接口都带 deleted_at IS NULL
    byId: db.prepare('SELECT * FROM chat_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'),
    // 不带 owner / deleted 条件：用来区分「别人的会话」和「已删的会话」，两者处置不同
    anyById: db.prepare('SELECT * FROM chat_sessions WHERE id = ?'),
    list: db.prepare(
      'SELECT * FROM chat_sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?',
    ),
    touch: db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?'),
    softDelete: db.prepare('UPDATE chat_sessions SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL'),
    insertMessage: db.prepare(`
      INSERT INTO chat_messages
        (id, session_id, user_id, role, content, mode, citations, tool_calls, latency_ms, feedback, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    messages: db.prepare('SELECT * FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC, rowid ASC'),
    // 反馈只改一条消息，条件里必须带 user_id：否则拿到别人的 messageId 就能改别人的数据
    setMessageFeedback: db.prepare('UPDATE chat_messages SET feedback = ? WHERE id = ? AND user_id = ?'),
    // 只取最近 N 条：会话可能攒到上千条，全量读进内存再 slice(-6) 是纯浪费
    recentMessages: db.prepare(
      'SELECT * FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ),
    insertEvent: db.prepare(`
      INSERT INTO assistant_events
        (user_id, session_id, question, mode, tool_names, degraded, first_token_ms, latency_ms,
         prompt_version, feedback, resolved_guess, day, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    usedToday: db.prepare('SELECT COUNT(*) AS c FROM assistant_events WHERE user_id = ? AND day = ?'),
  };

  return {
    /** 新建会话，标题取首问前 30 字 */
    create(userId, question) {
      const id = newId('sess');
      const stamp = nowISO();
      const title = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '新的对话';
      q.insert.run(id, userId, title, stamp, stamp);
      return q.byId.get(id, userId);
    },

    /** 会话存在且属于该用户、未被软删；否则 undefined（调用方转 404） */
    get(userId, sessionId) {
      return q.byId.get(sessionId, userId);
    },

    /** 不看属主与软删状态：用于区分「别人的会话」(404) 与「已删的会话」(新建) */
    findAny(sessionId) {
      return q.anyById.get(sessionId);
    },

    list(userId, limit = 20) {
      return q.list.all(userId, limit).map(normalizeSession);
    },

    touch(userId, sessionId, at = nowISO()) {
      q.touch.run(at, sessionId, userId);
    },

    /** 软删；已删或不属于该用户时返回 false */
    softDelete(userId, sessionId, at = nowISO()) {
      return q.softDelete.run(at, sessionId, userId).changes > 0;
    },

    appendMessage(userId, sessionId, message) {
      const id = message.id ?? newId('msg');
      q.insertMessage.run(
        id,
        sessionId,
        userId,
        message.role,
        message.content,
        message.mode ?? null,
        message.citations ? JSON.stringify(message.citations) : null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.latencyMs ?? null,
        message.feedback ?? null,
        message.createdAt ?? nowISO(),
      );
      return id;
    },

    messages(userId, sessionId) {
      return q.messages.all(sessionId, userId).map(normalizeMessage);
    },

    /** 最近 N 条，按时间正序返回：供上下文裁剪，避免把整段历史读进内存 */
    recentMessages(userId, sessionId, limit = 6) {
      return q.recentMessages.all(sessionId, userId, limit).map(normalizeMessage).reverse();
    },

    /**
     * 记录一条回答的反馈：`'up'` / `'down:<reason>'` / `null`（取消）。
     * 返回 false 表示「这条消息不存在或不属于该用户」——调用方统一转 404，
     * 不区分两者，避免用 id 探测别人有没有这条消息。
     */
    setMessageFeedback(userId, messageId, feedback) {
      return q.setMessageFeedback.run(feedback ?? null, messageId, userId).changes > 0;
    },

    /** 只有真正把 `done` 发出去的请求才调用它——配额与指标都靠这条记录 */
    recordEvent(event) {
      q.insertEvent.run(
        event.userId,
        event.sessionId ?? null,
        event.question,
        event.mode ?? null,
        event.toolNames && event.toolNames.length ? JSON.stringify(event.toolNames) : null,
        event.degraded ? 1 : 0,
        event.firstTokenMs ?? null,
        event.latencyMs ?? null,
        event.promptVersion ?? null,
        event.feedback ?? null,
        event.resolvedGuess ?? null,
        event.day ?? shanghaiDay(),
        event.createdAt ?? nowISO(),
      );
    },

    usedToday(userId, day = shanghaiDay()) {
      return q.usedToday.get(userId, day).c;
    },
  };
}

/**
 * 物理清理：软删满 30 天的会话，连同其消息与事件一并删除；
 * 未被软删但 30 天没动的会话同样过期（SPEC「会话存 30 天」）。
 * 返回删除条数，便于启动日志与测试断言。
 */
export function purgeAssistantData(db, now = Date.now()) {
  const cutoff = new Date(now - RETENTION_DAYS * DAY_MS).toISOString();
  const expired = db
    .prepare(
      `SELECT id FROM chat_sessions
       WHERE (deleted_at IS NOT NULL AND deleted_at <= ?) OR (deleted_at IS NULL AND updated_at <= ?)`,
    )
    .all(cutoff, cutoff)
    .map((row) => row.id);

  if (expired.length === 0) return { sessions: 0, messages: 0, events: 0 };

  const delMessages = db.prepare('DELETE FROM chat_messages WHERE session_id = ?');
  const delEvents = db.prepare('DELETE FROM assistant_events WHERE session_id = ?');
  const delSession = db.prepare('DELETE FROM chat_sessions WHERE id = ?');

  let messages = 0;
  let events = 0;
  db.exec('BEGIN');
  try {
    for (const id of expired) {
      messages += delMessages.run(id).changes;
      events += delEvents.run(id).changes;
      delSession.run(id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { sessions: expired.length, messages, events };
}
