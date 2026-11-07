/**
 * 数据库冷备：checkpoint WAL → 复制到 backups/ → 只保留最近 14 份。
 * 用法：npm run backup（可用系统计划任务每日调用）
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const dbFile = process.env.DB_FILE ?? 'data/zhixue.db';
const dir = process.env.BACKUP_DIR ?? 'backups';
const keep = Number(process.env.BACKUP_KEEP ?? 14);

if (!existsSync(dbFile)) {
  console.error(`找不到数据库：${dbFile}`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });

// 让 WAL 内容合并进主文件，避免备份缺少最近写入
const db = new DatabaseSync(dbFile);
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} finally {
  db.close();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = join(dir, `zhixue-${stamp}.db`);
copyFileSync(dbFile, target);
console.log(`已备份 → ${target}`);

const files = readdirSync(dir)
  .filter((f) => f.startsWith('zhixue-') && f.endsWith('.db'))
  .sort();
while (files.length > keep) {
  const old = files.shift();
  if (old) unlinkSync(join(dir, old));
  console.log(`清理旧备份 ${old}`);
}
