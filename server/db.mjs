import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_WEEKDAYS = JSON.stringify([0, 150, 150, 150, 150, 150, 120]);

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      week_start INTEGER NOT NULL DEFAULT 1,
      weekdays TEXT NOT NULL DEFAULT '${DEFAULT_WEEKDAYS}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      deadline TEXT NOT NULL,
      weekly_minutes INTEGER NOT NULL,
      level TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      estimate_min INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);

    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      is_buffer INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      actual_min INTEGER,
      skip_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_user_date ON blocks(user_id, date);

    CREATE TABLE IF NOT EXISTS ops (
      user_id TEXT NOT NULL,
      op_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, op_id)
    );

    -- 产品主页留言：无需登录，公开可读
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- 站点统计（当前仅访问计数）
    CREATE TABLE IF NOT EXISTS site_stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- 重排日志：同周计数用于 PRD 8.4 的「连续 3 次仍未达标则停止重排」
    CREATE TABLE IF NOT EXISTS replan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      option_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- 站内通知：进度预警 / 挽救信号 / 周报生成等
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);

    -- 助手会话：deleted_at 非空即软删，30 天后由 purgeAssistantData 物理清理
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT,
      citations TEXT,
      tool_calls TEXT,
      latency_ms INTEGER,
      feedback TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

    -- 指标与配额同表：day 是 Asia/Shanghai 自然日，配额按它计数，避免每次请求算时区
    CREATE TABLE IF NOT EXISTS assistant_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      question TEXT NOT NULL,
      mode TEXT,
      tool_names TEXT,
      degraded INTEGER NOT NULL DEFAULT 0,
      first_token_ms INTEGER,
      latency_ms INTEGER,
      prompt_version TEXT,
      feedback TEXT,
      resolved_guess TEXT,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_events_quota ON assistant_events(user_id, day);
  `);

  // 增量迁移：任务剩余工时（老库补列，默认取预估工时）
  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'recovery_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT');
  }

  const userCols0 = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols0.some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    // 迁移收口：若还没有管理员，把最早的注册用户提为管理员
    const anyAdmin = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get();
    if (!anyAdmin.c) {
      const first = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
      if (first) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(first.id);
    }
  }

  const fbCols = db.prepare('PRAGMA table_info(feedback)').all();
  if (!fbCols.some((c) => c.name === 'hidden')) {
    db.exec('ALTER TABLE feedback ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }

  const blockCols = db.prepare('PRAGMA table_info(blocks)').all();
  if (!blockCols.some((c) => c.name === 'source')) {
    db.exec("ALTER TABLE blocks ADD COLUMN source TEXT"); // plan | backfill
  }
  if (!blockCols.some((c) => c.name === 'progress_pct')) {
    db.exec('ALTER TABLE blocks ADD COLUMN progress_pct INTEGER'); // 完成度 1-100
  }
  if (!blockCols.some((c) => c.name === 'accumulated_sec')) {
    db.exec("ALTER TABLE blocks ADD COLUMN accumulated_sec INTEGER NOT NULL DEFAULT 0");
  }
  if (!blockCols.some((c) => c.name === 'started_at')) {
    db.exec('ALTER TABLE blocks ADD COLUMN started_at TEXT'); // 当前一段执行的开始时间；NULL=未在计时
  }
  if (!blockCols.some((c) => c.name === 'locked')) {
    db.exec('ALTER TABLE blocks ADD COLUMN locked INTEGER NOT NULL DEFAULT 0'); // 用户锁定：重排/重建时保留
  }

  const cols = db.prepare('PRAGMA table_info(items)').all();
  if (!cols.some((c) => c.name === 'remaining_min')) {
    db.exec('ALTER TABLE items ADD COLUMN remaining_min INTEGER');
  }
}

export const nowISO = () => new Date().toISOString();
/** 本地时区 ISO（带偏移）：其前 10 位与 todayISO() 一致，避免凌晨时段按 UTC 日期算成前一天 */
export const nowLocalISO = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};
export const defaultWeekdays = DEFAULT_WEEKDAYS;
