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
  `);

  // 增量迁移：任务剩余工时（老库补列，默认取预估工时）
  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'recovery_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT');
  }

  const cols = db.prepare('PRAGMA table_info(items)').all();
  if (!cols.some((c) => c.name === 'remaining_min')) {
    db.exec('ALTER TABLE items ADD COLUMN remaining_min INTEGER');
  }
}

export const nowISO = () => new Date().toISOString();
export const defaultWeekdays = DEFAULT_WEEKDAYS;
