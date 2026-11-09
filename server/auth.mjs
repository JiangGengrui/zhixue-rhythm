import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { nowISO } from './db.mjs';

const SESSION_DAYS = 30;
const KEY_LEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEY_LEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    created.toISOString(),
    expires.toISOString(),
  );
  return { token, expiresAt: expires.toISOString() };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const raw = part.slice(idx + 1).trim();
    // 畸形 cookie（如 %E0%A4%A）不能让整个请求 500，解析失败就按原文使用
    try {
      out[part.slice(0, idx).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, idx).trim()] = raw;
    }
  }
  return out;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `zx_sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clearCookie = 'zx_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

/** 从请求中解析用户；过期会话会被清理 */
export function currentUser(db, req) {
  const token = parseCookies(req.headers.cookie).zx_sid;
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT s.token, s.expires_at, u.id, u.email, u.name, u.week_start, u.weekdays, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    token,
    isAdmin: !!row.is_admin,
    settings: {
      weekStart: row.week_start === 0 ? 0 : 1,
      weekdays: safeWeekdays(row.weekdays),
    },
  };
}

function safeWeekdays(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 7 && parsed.every((n) => Number.isFinite(n))) {
      return parsed.map((n) => Math.max(0, Math.min(1440, Math.round(n))));
    }
  } catch {
    /* 落到默认值 */
  }
  return [120, 150, 150, 150, 150, 150, 120];
}

/** 登录失败限流：同一 IP 每分钟最多 10 次 */
const attempts = new Map();

export function allowLogin(ip, scope = 'login') {
  const key = `${scope}:${String(ip || 'unknown')}`;
  const now = Date.now();
  const bucket = attempts.get(key) ?? [];
  const fresh = bucket.filter((t) => now - t < 60000);
  if (fresh.length >= 10) {
    attempts.set(key, fresh);
    return false;
  }
  fresh.push(now);
  attempts.set(key, fresh);
  // 兜底清理：避免 Map 随 IP 数量无限增长
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.every((t) => now - t >= 60000)) attempts.delete(k);
    }
  }
  return true;
}

/** 生成一次性恢复码：去掉易混淆字符，形如 ABCD-EFGH-JK */
export function generateRecoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3 || i === 7) out += '-';
  }
  return out;
}

/** 恢复码比较：忽略大小写与分隔符 */
export function normalizeRecoveryCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code) {
  return hashPassword(normalizeRecoveryCode(code));
}

export function verifyRecoveryCode(code, stored) {
  if (!stored) return false;
  return verifyPassword(normalizeRecoveryCode(code), stored);
}

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export const createdStamp = nowISO;
