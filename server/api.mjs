import {
  allowLogin, createSession, destroySession, generateRecoveryCode, hashPassword, hashRecoveryCode,
  newId, sessionCookie, clearCookie, verifyPassword, verifyRecoveryCode,
} from './auth.mjs';
import { nowISO, nowLocalISO } from './db.mjs';
import {
  createSessionStore, MAX_DAILY_QUESTIONS, nextShanghaiMidnightISO, normalizeSession,
} from './assistant/sessions.mjs';
import { MAX_QUESTION_CHARS, streamModelReply } from './assistant/chat.mjs';
import { planTools } from './assistant/route.mjs';
import { buildFacts, createToolbox } from './assistant/tools.mjs';
import { applyFault, resolveFault } from './assistant/faults.mjs';
import { buildReport, decomposeGoal, evaluateAlerts, packWeek, planReplan, TEMPLATE_LIST, todayISO } from './engine.generated.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECTS = new Set(['math', 'major', 'english', 'politics', 'other']);
const LEVELS = new Set(['zero', 'once', 'twice', 'more']);
const STATUSES = new Set(['pending', 'running', 'done', 'skipped']);
const SKIP_REASONS = new Set(['interrupt', 'capacity', 'other', '']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 面板上的三个「没用」原因；只认这三值，不让自由文本进库
const FEEDBACK_REASONS = new Set(['wrong', 'unclear', 'not_wanted']);

/** 格式对还不够，2026-02-30 这种也要挡掉：回写比对是最省事的办法 */
const isISODate = (value) => {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    // 少数错误要带结构化附加信息（如 429 的 resetAt），由 index.mjs 平铺进响应体
    if (extra) this.extra = extra;
  }
}

const bad = (code, message) => new HttpError(400, code, message);
const unauthorized = () => new HttpError(401, 'E2001', '请先登录');
const notFound = () => new HttpError(404, 'E4004', '资源不存在或不属于当前用户');

function assert(cond, code, message) {
  if (!cond) throw bad(code, message);
}

const str = (v, name, max = 120) => {
  assert(typeof v === 'string' && v.trim().length > 0, 'E1001', `${name}不能为空`);
  const s = v.trim();
  assert(s.length <= max, 'E1002', `${name}不能超过 ${max} 字`);
  return s;
};

const int = (v, name, min, max) => {
  const n = Number(v);
  assert(Number.isFinite(n), 'E1003', `${name}必须是数字`);
  const r = Math.round(n);
  assert(r >= min && r <= max, 'E1004', `${name}需在 ${min}~${max} 之间`);
  return r;
};

const dateStr = (v, name) => {
  assert(typeof v === 'string' && DATE_RE.test(v), 'E1005', `${name}格式应为 YYYY-MM-DD`);
  return v;
};

function normalizeGoal(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    deadline: row.deadline,
    weeklyMinutes: row.weekly_minutes,
    level: row.level,
    createdAt: row.created_at,
  };
}

function normalizeItem(row) {
  return {
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    subject: row.subject,
    estimateMin: row.estimate_min,
    remainingMin: row.remaining_min ?? row.estimate_min,
    weight: row.weight,
  };
}

function normalizeBlock(row) {
  return {
    id: row.id,
    itemId: row.item_id,
    date: row.date,
    startMin: row.start_min,
    endMin: row.end_min,
    isBuffer: !!row.is_buffer,
    status: row.status,
    actualMin: row.actual_min ?? undefined,
    skipReason: row.skip_reason ?? undefined,
    source: row.source ?? undefined,
    progressPct: row.progress_pct ?? undefined,
    accumulatedSec: row.accumulated_sec ?? 0,
    startedAt: row.started_at ?? undefined,
    locked: !!(row.locked ?? 0),
  };
}

export function createApi(db) {
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, email, name, pass_hash, recovery_hash, week_start, weekdays, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ),
    updateRecovery: db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?'),
    updateSettings: db.prepare('UPDATE users SET week_start = ?, weekdays = ? WHERE id = ?'),
    goalByUser: db.prepare('SELECT * FROM goals WHERE user_id = ?'),
    upsertGoal: db.prepare(`
      INSERT INTO goals (id, user_id, title, deadline, weekly_minutes, level, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        title = excluded.title, deadline = excluded.deadline,
        weekly_minutes = excluded.weekly_minutes, level = excluded.level
    `),
    itemsByUser: db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY created_at ASC'),
    insertItem: db.prepare(
      'INSERT INTO items (id, user_id, goal_id, title, subject, estimate_min, remaining_min, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    consumeWork: db.prepare(
      'UPDATE items SET remaining_min = MAX(0, COALESCE(remaining_min, estimate_min) - ?) WHERE id = ? AND user_id = ?',
    ),
    blockedElsewhere: db.prepare(
      "SELECT DISTINCT item_id FROM blocks WHERE user_id = ? AND status IN ('pending','running') AND (date < ? OR date > ?)",
    ),
    sessionsOfUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    updatePassword: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
    insertFeedback: db.prepare('INSERT INTO feedback (nickname, content, created_at) VALUES (?, ?, ?)'),
    recentFeedback: db.prepare('SELECT id, nickname, content, created_at FROM feedback WHERE hidden = 0 ORDER BY id DESC LIMIT ?'),
    adminFeedback: db.prepare('SELECT id, nickname, content, created_at, hidden FROM feedback ORDER BY id DESC LIMIT 50'),
    hideFeedback: db.prepare('UPDATE feedback SET hidden = 1 WHERE id = ?'),
    showFeedback: db.prepare('UPDATE feedback SET hidden = 0 WHERE id = ?'),
    feedbackById: db.prepare('SELECT * FROM feedback WHERE id = ?'),
    adminCount: db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1'),
    bumpVisit: db.prepare("INSERT INTO site_stats (key, value) VALUES ('visit', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"),
    readVisit: db.prepare("SELECT value FROM site_stats WHERE key = 'visit'"),
    blocksByDate: db.prepare('SELECT * FROM blocks WHERE user_id = ? AND date = ?'),
    moveBlock: db.prepare('UPDATE blocks SET date = ?, start_min = ?, end_min = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
    deleteBlock: db.prepare('DELETE FROM blocks WHERE id = ? AND user_id = ?'),
    startRun: db.prepare("UPDATE blocks SET status='running', started_at=?, updated_at=? WHERE id=? AND user_id=?"),
    pauseRun: db.prepare("UPDATE blocks SET accumulated_sec = accumulated_sec + ?, started_at=NULL, updated_at=? WHERE id=? AND user_id=?"),
    resumeRun: db.prepare("UPDATE blocks SET started_at=?, updated_at=? WHERE id=? AND user_id=?"),
    finishBlock: db.prepare("UPDATE blocks SET status='done', actual_min=?, progress_pct=?, source=?, started_at=NULL, updated_at=? WHERE id=? AND user_id=?"),
    skipWithSource: db.prepare("UPDATE blocks SET status='skipped', skip_reason=?, source=?, updated_at=? WHERE id=? AND user_id=?"),
    revertBlock: db.prepare("UPDATE blocks SET status='pending', actual_min=NULL, skip_reason=NULL, progress_pct=NULL, source=NULL, started_at=NULL, accumulated_sec=0, updated_at=? WHERE id=? AND user_id=?"),
    refundWork: db.prepare('UPDATE items SET remaining_min = COALESCE(remaining_min, estimate_min) + ? WHERE id = ? AND user_id = ?'),
    insertNotif: db.prepare('INSERT INTO notifications (user_id, kind, level, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    notifToday: db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND kind = ? AND substr(created_at, 1, 10) = ?"),
    recentNotifs: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30'),
    unreadCount: db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    markAllRead: db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"),
    markRead: db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?'),
    notifById: db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?'),
    deletePendingWeek: db.prepare("DELETE FROM blocks WHERE user_id = ? AND date >= ? AND date <= ? AND status <> 'done' AND locked = 0"),
    // 往周遗留的未完成块：重新规划时当作"顺延"，避免同一任务挂在过去又排进未来
    deletePendingBefore: db.prepare("DELETE FROM blocks WHERE user_id = ? AND date < ? AND status IN ('pending','running') AND locked = 0"),
    setLocked: db.prepare('UPDATE blocks SET locked = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
    clearItems: db.prepare('DELETE FROM items WHERE user_id = ?'),
    clearBlocks: db.prepare('DELETE FROM blocks WHERE user_id = ?'),
    setRemaining: db.prepare('UPDATE items SET remaining_min = ? WHERE id = ? AND user_id = ?'),
    countReplan: db.prepare('SELECT COUNT(*) AS c FROM replan_log WHERE user_id = ? AND week_start = ?'),
    insertReplan: db.prepare('INSERT INTO replan_log (user_id, week_start, option_key, created_at) VALUES (?, ?, ?, ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    itemById: db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?'),
    deleteItem: db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?'),
    deleteBlocksOfItem: db.prepare('DELETE FROM blocks WHERE item_id = ? AND user_id = ?'),
    blocksByUser: db.prepare('SELECT * FROM blocks WHERE user_id = ? ORDER BY date ASC, start_min ASC'),
    blocksByWeek: db.prepare('SELECT * FROM blocks WHERE user_id = ? AND date BETWEEN ? AND ?'),
    deleteWeek: db.prepare('DELETE FROM blocks WHERE user_id = ? AND date BETWEEN ? AND ?'),
    insertBlock: db.prepare(`
      INSERT INTO blocks (id, user_id, item_id, date, start_min, end_min, is_buffer, status, actual_min, skip_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    blockById: db.prepare('SELECT * FROM blocks WHERE id = ? AND user_id = ?'),
    updateBlock: db.prepare(
      'UPDATE blocks SET status = ?, actual_min = ?, skip_reason = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    ),
    opExists: db.prepare('SELECT 1 AS ok FROM ops WHERE user_id = ? AND op_id = ?'),
    insertOp: db.prepare('INSERT INTO ops (user_id, op_id, created_at) VALUES (?, ?, ?)'),
  };

  // 助手会话与配额的读写全部收敛在这个 store 里，api.mjs 只做参数校验与状态码
  const chat = createSessionStore(db);

  function stateOf(user) {
    const goal = normalizeGoal(q.goalByUser.get(user.id));
    const items = q.itemsByUser.all(user.id).map(normalizeItem);
    const blocks = q.blocksByUser.all(user.id).map(normalizeBlock);
    return {
      user: { id: user.id, name: user.name, email: user.email, isAdmin: !!user.isAdmin },
      goal,
      items,
      blocks,
      settings: user.settings,
    };
  }

  /**
   * 会话归属判定（SPEC §9 + R7）：
   * - 带 id 且属于自己、未软删 → 用它
   * - 带 id 但不属于自己 → 404，避免用 id 探测别人的会话
   * - 带 id 但已软删 / 根本不存在 → 新建，并把新 id 通过 meta 回给前端
   */
  function resolveChatSession(userId, question, sessionId) {
    if (typeof sessionId === 'string' && sessionId) {
      const owned = chat.get(userId, sessionId);
      if (owned) return owned;
      const any = chat.findAny(sessionId);
      if (any && any.user_id !== userId) throw notFound();
    }
    return chat.create(userId, question);
  }

  const handlers = {
    'POST /api/auth/register': ({ body, res }) => {
      const email = str(body.email, '邮箱', 120).toLowerCase();
      assert(EMAIL_RE.test(email), 'E1006', '邮箱格式不正确');
      const password = String(body.password ?? '');
      assert(password.length >= 8, 'E1007', '密码至少 8 位');
      assert(password.length <= 72, 'E1007', '密码不能超过 72 位');
      const name = str(body.name ?? '同学', '昵称', 30);
      if (q.userByEmail.get(email)) throw new HttpError(409, 'E4001', '该邮箱已注册');

      const id = newId('usr');
      const becomeAdmin = q.adminCount.get().c === 0;
      const recoveryCode = generateRecoveryCode();
      q.insertUser.run(
        id, email, name, hashPassword(password), hashRecoveryCode(recoveryCode),
        '[120,150,150,150,150,150,120]', nowISO(),
      );
      if (becomeAdmin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
      const user = q.userById.get(id);
      const { token } = createSession(db, id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      // 恢复码只在此刻明文返回一次，服务端只存哈希
      return { user: { id: user.id, name: user.name, email: user.email, isAdmin: becomeAdmin }, recoveryCode };
    },

    'POST /api/auth/login': ({ body, res, ip }) => {
      if (!allowLogin(ip)) throw new HttpError(429, 'E2002', '尝试过于频繁，请稍后再试');
      const email = str(body.email, '邮箱', 120).toLowerCase();
      const password = String(body.password ?? '');
      const row = q.userByEmail.get(email);
      if (!row || !verifyPassword(password, row.pass_hash)) {
        throw new HttpError(401, 'E2003', '邮箱或密码不正确');
      }
      const { token } = createSession(db, row.id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      return { user: { id: row.id, name: row.name, email: row.email } };
    },

    /**
     * 免注册登录：直接建一个独立的游客账号并下发会话，用于试用与测试。
     * pass_hash 不是可用的 scrypt 结构，恢复码为空，所以这个账号无法用
     * 密码登录、也无法找回——只能从登录页的「免注册登录」进来，
     * 数据仍然按账号隔离，不会污染别人的数据。
     */
    'POST /api/auth/guest': ({ res }) => {
      const id = newId('usr');
      const email = `${id}@guest.local`;
      const name = '测试同学';
      q.insertUser.run(
        id, email, name, 'guest$no-login$0', null,
        '[120,150,150,150,150,150,120]', nowISO(),
      );
      const { token } = createSession(db, id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      return { user: { id, name, email }, guest: true };
    },

    'POST /api/auth/recover': ({ body, res, ip }) => {
      if (!allowLogin(ip, 'recover')) throw new HttpError(429, 'E2002', '尝试过于频繁，请稍后再试');
      const email = str(body.email, '邮箱', 120).toLowerCase();
      const code = String(body.recoveryCode ?? '');
      const next = String(body.newPassword ?? '');
      assert(next.length >= 8, 'E1007', '新密码至少 8 位');

      const row = q.userByEmail.get(email);
      // 统一提示，避免暴露邮箱是否存在
      if (!row || !verifyRecoveryCode(code, row.recovery_hash)) {
        throw new HttpError(400, 'E1029', '邮箱或恢复码不正确');
      }

      const rotated = generateRecoveryCode();
      q.updatePassword.run(hashPassword(next), row.id);
      q.updateRecovery.run(hashRecoveryCode(rotated), row.id);
      // 重置后所有旧会话失效，需重新登录
      q.sessionsOfUser.run(row.id);
      res.setHeader('Set-Cookie', clearCookie);
      return { ok: true, recoveryCode: rotated };
    },

    'POST /api/auth/logout': ({ res, user }) => {
      destroySession(db, user.token);
      res.setHeader('Set-Cookie', clearCookie);
      return { ok: true };
    },

    // demo: true 表示这是免登录的演示账号，前端据此隐藏账号管理入口
    'GET /api/me': ({ user }) => ({ user: { id: user.id, name: user.name, email: user.email, isAdmin: !!user.isAdmin, demo: !!user.demo } }),

    // 站内通知：拉取时先跑一遍预警规则（同类别同日只落一条），再返回列表与未读数
    'GET /api/notifications': ({ user }) => {
      const today = todayISO();
      if (q.goalByUser.get(user.id)) {
        const state = stateOf(user);
        const alerts = evaluateAlerts({
          goal: q.goalByUser.get(user.id),
          items: state.items,
          blocks: state.blocks,
          settings: state.settings,
          today,
        });
        for (const a of alerts) {
          const exists = q.notifToday.get(user.id, a.kind, today).c;
          if (!exists) q.insertNotif.run(user.id, a.kind, a.level, a.title, a.body, nowLocalISO());
        }
      }
      const items = q.recentNotifs.all(user.id).map((row) => ({
        id: row.id,
        kind: row.kind,
        level: row.level,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
        read: row.read_at != null,
      }));
      return { items, unread: q.unreadCount.get(user.id).c };
    },

    'POST /api/notifications/read': ({ user, body }) => {
      const now = nowISO();
      if (body?.ids === 'all') {
        q.markAllRead.run(now, user.id);
        return { ok: true };
      }
      const ids = Array.isArray(body?.ids) ? body.ids.map((v) => Number(v)).filter(Number.isInteger) : [];
      for (const id of ids) {
        if (q.notifById.get(id, user.id)) q.markRead.run(now, id, user.id);
      }
      return { ok: true, count: ids.length };
    },

    'GET /api/decompose/templates': () => ({ templates: TEMPLATE_LIST }),

    // 拆解：默认只返回草案；apply=true 时写库（已有计划项需 replace=true 确认覆盖）
    'POST /api/goal/decompose': ({ user, body }) => {
      const goal = q.goalByUser.get(user.id);
      if (!goal) throw new HttpError(409, 'E4003', '请先创建目标');
      const template = body?.template ?? 'postgrad-cs';
      const result = decomposeGoal({
        template,
        today: todayISO(),
        deadline: goal.deadline,
        // 注意：这里是数据库原始行（未 normalize），列名是 weekly_minutes
        weeklyMinutes: goal.weekly_minutes,
        level: goal.level,
      });

      if (!body?.apply) return { result, applied: 0 };

      const existing = q.itemsByUser.all(user.id);
      if (existing.length > 0 && body?.replace !== true) {
        throw new HttpError(409, 'E4009', '已有计划项，覆盖前请确认（replace=true）');
      }

      // 用户在预览里编辑过草案时，以编辑后的列表为准（字段逐一校验）
      let drafts = result.items;
      if (Array.isArray(body?.items)) {
        drafts = body.items.map((raw, index) => {
          const title = String(raw?.title ?? '').trim();
          assert(title.length >= 1 && title.length <= 60, 'E1040', `第 ${index + 1} 项标题需为 1–60 字`);
          const estimateMin = int(raw?.estimateMin, `第 ${index + 1} 项预估工时`, 5, 1440);
          const weight = int(raw?.weight ?? 3, `第 ${index + 1} 项权重`, 1, 5);
          const subject = String(raw?.subject ?? 'other');
          assert(SUBJECTS.has(subject), 'E1041', `第 ${index + 1} 项科目不合法`);
          return { title, subject, estimateMin, weight };
        });
        assert(drafts.length > 0, 'E1042', '至少保留一条计划项');
      }

      db.exec('BEGIN');
      try {
        q.clearBlocks.run(user.id);
        q.clearItems.run(user.id);
        const now = nowISO();
        for (const draft of drafts) {
          q.insertItem.run(
            newId('item'), user.id, goal.id, draft.title, draft.subject,
            draft.estimateMin, draft.estimateMin, draft.weight, now,
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { result, applied: drafts.length };
    },

    // 重排：只给方案，不写库；写库走 /api/plan/replan/apply
    'GET /api/plan/replan': ({ user, query }) => {
      const weekStart = dateStr(query.get('week') ?? '', '周');
      const state = stateOf(user);
      const replanCount = q.countReplan.get(user.id, weekStart).c;
      const plan = planReplan({
        blocks: state.blocks,
        items: state.items,
        settings: state.settings,
        weekStart,
        today: todayISO(),
        manual: query.has('manual'),
        replanCount,
      });
      return {
        weekStart,
        replanCount,
        trigger: plan.trigger,
        blocked: plan.blocked,
        calibration: plan.calibration ?? null,
        options: plan.options.map((o) => ({
          key: o.key,
          label: o.label,
          reason: o.reason,
          cost: o.cost,
          summary: o.summary,
          plannedMin: o.plannedMin,
          bufferMin: o.bufferMin,
          loadIncreasePct: o.loadIncreasePct,
          applicable: o.applicable,
          feasible: o.feasible,
        })),
      };
    },

    'POST /api/plan/replan/apply': ({ user, body }) => {
      const weekStart = dateStr(body?.week, '周');
      const key = String(body?.option ?? '');
      const weekEnd = addDays(weekStart, 6);
      const state = stateOf(user);
      const replanCount = q.countReplan.get(user.id, weekStart).c;

      // 锁定块不参与重排：从方案输入中剔除，其占用的工时也从任务剩余量里扣除，
      // 否则同一条任务会被「保留的锁定块 + 重新生成的块」重复规划（block id 还会冲突）
      const lockedWeek = state.blocks.filter(
        (b) => b.locked && b.date >= weekStart && b.date <= weekEnd && b.status !== 'done',
      );
      const lockedIds = new Set(lockedWeek.map((b) => b.id));
      const lockedMinByItem = new Map();
      for (const b of lockedWeek) {
        lockedMinByItem.set(b.itemId, (lockedMinByItem.get(b.itemId) ?? 0) + (b.endMin - b.startMin));
      }
      const itemsForPlan = state.items.map((i) => {
        const lockedMin = lockedMinByItem.get(i.id);
        if (!lockedMin) return i;
        const rest = Math.max(0, (i.remainingMin ?? i.estimateMin) - lockedMin);
        return { ...i, remainingMin: rest, estimateMin: rest };
      });
      const plan = planReplan({
        blocks: state.blocks.filter((b) => !lockedIds.has(b.id)),
        items: itemsForPlan,
        settings: state.settings,
        weekStart,
        today: todayISO(),
        manual: true,
        replanCount,
        // 已完成 / 锁定的块要保留，重排后的新块必须避开它们所在时段
        busy: state.blocks
          .filter((b) => b.date >= weekStart && b.date <= weekEnd && (b.locked || b.status === 'done'))
          .map((b) => ({ date: b.date, startMin: b.startMin, endMin: b.endMin })),
      });

      if (plan.blocked) {
        throw new HttpError(409, 'E1035', plan.calibration ?? '连续多次重排仍未达标，建议调整目标');
      }
      const option = plan.options.find((o) => o.key === key);
      if (!option) throw bad('E1033', '未知的重排方案');
      if (!option.applicable) throw bad('E1036', '这个方案在当前排布下不适用');
      if (!option.feasible && (option.key === 'defer' || option.key === 'compress')) {
        throw new HttpError(409, 'E1034', '这个方案仍然装不下，建议改用「替代」或「放弃」，或延长目标日期');
      }

      // 时间地点没变的块复用原 id：前端手上的 id 不会因为点一次「应用重排」就全部失效
      const reusableIds = new Map();
      for (const b of state.blocks) {
        if (b.date < weekStart || b.date > weekEnd) continue;
        if (b.locked || b.status === 'done' || b.status === 'skipped') continue;
        reusableIds.set(`${b.itemId}|${b.date}|${b.startMin}`, b.id);
      }
      const takenIds = new Set();

      db.exec('BEGIN');
      try {
        q.deletePendingWeek.run(user.id, weekStart, weekEnd);
        // 锁定块未被 deletePendingWeek 删除，仍在表里；只写回方案生成的块
        for (const block of option.blocks) {
          const slot = `${block.itemId}|${block.date}|${block.startMin}`;
          const reused = reusableIds.get(slot);
          // 复用的 id 必须唯一且不与保留块冲突，否则退回随机 id
          const id = reused && !takenIds.has(reused) ? reused : newId('blk');
          takenIds.add(id);
          q.insertBlock.run(
            id, user.id, block.itemId, block.date, block.startMin, block.endMin,
            block.isBuffer ? 1 : 0, 'pending', null, null, nowISO(),
          );
        }
        for (const change of option.itemChanges) {
          if (change.remove) {
            q.deleteBlocksOfItem.run(change.id, user.id);
            q.deleteItem.run(change.id, user.id);
          } else if (typeof change.remainingMin === 'number') {
            q.setRemaining.run(change.remainingMin, change.id, user.id);
          }
        }
        q.insertReplan.run(user.id, weekStart, option.key, nowISO());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      const after = stateOf(user);
      return {
        applied: option.key,
        summary: option.summary,
        replanCount: replanCount + 1,
        blocks: after.blocks.filter((b) => b.date >= weekStart && b.date <= weekEnd),
      };
    },

    // 产品主页的公开接口：无需登录
    'GET /api/feedback': ({ query }) => {
      const raw = Number(query.get('limit') ?? 8);
      const limit = Math.min(20, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : 8));
      return {
        messages: q.recentFeedback.all(limit).map((row) => ({
          id: row.id,
          nickname: row.nickname,
          content: row.content,
          createdAt: row.created_at,
        })),
      };
    },

    'POST /api/feedback': ({ body, ip }) => {
      if (!allowLogin(ip, 'feedback')) throw new HttpError(429, 'E2002', '提交过于频繁，请稍后再试');
      const content = String(body?.content ?? '').trim();
      const nicknameRaw = body?.nickname == null ? '' : String(body.nickname).trim();
      assert(content.length >= 1 && content.length <= 500, 'E1031', '留言内容需为 1—500 字');
      if (nicknameRaw) assert(nicknameRaw.length <= 30, 'E1032', '昵称不能超过 30 字');
      const createdAt = nowISO();
      q.insertFeedback.run(nicknameRaw || null, content, createdAt);
      return { message: { nickname: nicknameRaw || null, content, createdAt } };
    },

    'GET /api/visit': () => ({ count: q.readVisit.get()?.value ?? 0 }),

    // 留言管理：仅管理员
    'GET /api/feedback/admin': ({ user }) => {
      if (!user.isAdmin) throw new HttpError(403, 'E2005', '仅管理员可以管理留言');
      return {
        items: q.adminFeedback.all().map((row) => ({
          id: row.id,
          nickname: row.nickname,
          content: row.content,
          createdAt: row.created_at,
          hidden: !!row.hidden,
        })),
      };
    },



    'POST /api/visit': () => {
      q.bumpVisit.run();
      return { count: q.readVisit.get()?.value ?? 0 };
    },

    'POST /api/auth/password': ({ user, body, res }) => {
      const current = String(body?.currentPassword ?? '');
      const next = String(body?.newPassword ?? '');
      const row = q.userById.get(user.id);
      if (!row) throw unauthorized();
      if (!verifyPassword(current, row.pass_hash)) throw new HttpError(400, 'E1025', '当前密码不正确');
      assert(next.length >= 8, 'E1007', '新密码至少 8 位');
      assert(next.length <= 72, 'E1007', '新密码不能超过 72 位');
      assert(next !== current, 'E1026', '新密码不能与当前密码相同');

      q.updatePassword.run(hashPassword(next), user.id);
      // 所有旧会话失效，并为当前设备重新建立会话
      q.sessionsOfUser.run(user.id);
      const { token } = createSession(db, user.id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      return { ok: true };
    },

    'GET /api/export': ({ user, query, res }) => {
      const format = String(query.get('format') ?? 'json').toLowerCase();
      const state = stateOf(user);
      const stamp = todayISO();

      if (format === 'csv') {
        const byId = new Map(state.items.map((i) => [i.id, i]));
        const head = ['日期', '开始', '结束', '任务', '科目', '状态', '计划分钟', '实际分钟'];
        const rows = [head];
        for (const b of state.blocks) {
          const item = byId.get(b.itemId);
          rows.push([
            b.date,
            fmtMinute(b.startMin),
            fmtMinute(b.endMin),
            item?.title ?? '',
            item?.subject ?? '',
            b.status,
            String(b.endMin - b.startMin),
            b.actualMin == null ? '' : String(b.actualMin),
          ]);
        }
        const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
        sendFile(res, csv, 'text/csv; charset=utf-8', `zhixue-blocks-${stamp}.csv`);
        return { __sent: true };
      }

      const payload = { exportedAt: nowISO(), ...state };
      sendFile(res, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8', `zhixue-export-${stamp}.json`);
      return { __sent: true };
    },

    'DELETE /api/account': ({ user, body, res }) => {
      const password = String(body?.password ?? '');
      const row = q.userById.get(user.id);
      if (!row) throw unauthorized();
      if (!verifyPassword(password, row.pass_hash)) throw bad('E1023', '密码不正确，无法注销');
      db.exec('BEGIN');
      try {
        q.sessionsOfUser.run(user.id);
        q.deleteUser.run(user.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      res.setHeader('Set-Cookie', clearCookie);
      return { ok: true };
    },

    'GET /api/state': ({ user }) => stateOf(user),

    'PUT /api/goal': ({ user, body }) => {
      assert(body && typeof body === 'object', 'E1001', '缺少目标数据');
      const title = str(body.title, '目标名称', 60);
      const deadline = dateStr(body.deadline, '目标日期');
      const weeklyMinutes = int(body.weeklyMinutes, '每周可用分钟', 30, 10080);
      const level = String(body.level ?? 'once');
      assert(LEVELS.has(level), 'E1008', '基础水平取值不合法');
      const existing = q.goalByUser.get(user.id);
      q.upsertGoal.run(
        existing ? existing.id : newId('goal'),
        user.id,
        title,
        deadline,
        weeklyMinutes,
        level,
        existing ? existing.created_at : nowISO(),
      );
      // 目标页填的"每周可用"就是排程容量：同步到每日时段，避免两个口径互相打架
      const planDays = user.settings.weekdays.map((v) => Math.max(0, v));
      const totalPlanned = planDays.reduce((a, b) => a + b, 0);
      let nextWeekdays = null;
      if (totalPlanned === 0) {
        // 平均分到 7 天，余数补到前几天的 1 分钟上，保证合计精确等于每周可用
        const base = Math.floor(weeklyMinutes / 7);
        const rest = weeklyMinutes - base * 7;
        nextWeekdays = Array.from({ length: 7 }, (_, i) => base + (i < rest ? 1 : 0));
      } else if (Math.abs(totalPlanned - weeklyMinutes) > weeklyMinutes * 0.1) {
        // 按比例缩放，保留用户原本每天多寡的相对分布
        const ratio = weeklyMinutes / totalPlanned;
        nextWeekdays = planDays.map((v) => Math.min(1440, Math.round((v * ratio) / 5) * 5));
        const diff = weeklyMinutes - nextWeekdays.reduce((a, b) => a + b, 0);
        if (diff !== 0) {
          let top = 0;
          for (let i = 1; i < nextWeekdays.length; i++) {
            if (nextWeekdays[i] > nextWeekdays[top]) top = i;
          }
          nextWeekdays[top] = Math.max(0, Math.min(1440, nextWeekdays[top] + diff));
        }
      }
      if (nextWeekdays) {
        q.updateSettings.run(user.settings.weekStart ?? 1, JSON.stringify(nextWeekdays), user.id);
      }
      return {
        goal: normalizeGoal(q.goalByUser.get(user.id)),
        settings: nextWeekdays
          ? { weekStart: user.settings.weekStart ?? 1, weekdays: nextWeekdays }
          : user.settings,
      };
    },

    'POST /api/items': ({ user, body }) => {
      const goal = q.goalByUser.get(user.id);
      if (!goal) throw new HttpError(409, 'E4003', '请先创建目标');
      const item = {
        id: newId('item'),
        goalId: goal.id,
        title: str(body.title, '任务名称', 80),
        subject: String(body.subject ?? 'other'),
        estimateMin: int(body.estimateMin, '预估工时', 5, 1440),
        remainingMin: int(body.estimateMin, '预估工时', 5, 1440),
        weight: int(body.weight ?? 3, '权重', 1, 5),
      };
      assert(SUBJECTS.has(item.subject), 'E1009', '科目取值不合法');
      q.insertItem.run(
        item.id, user.id, item.goalId, item.title, item.subject,
        item.estimateMin, item.estimateMin, item.weight, nowISO(),
      );
      return { item };
    },

    'PUT /api/settings': ({ user, body }) => {
      const weekStart = Number(body.weekStart);
      assert(weekStart === 0 || weekStart === 1, 'E1010', '周起始日只能是 0 或 1');
      const weekdays = body.weekdays;
      assert(Array.isArray(weekdays) && weekdays.length === 7, 'E1011', '可用时段需要 7 个数值');
      const safe = weekdays.map((n) => int(n, '每日可用分钟', 0, 1440));
      q.updateSettings.run(weekStart, JSON.stringify(safe), user.id);
      return { settings: { weekStart, weekdays: safe } };
    },

    'POST /api/plan/generate': ({ user, body }) => {
      const goal = q.goalByUser.get(user.id);
      if (!goal) throw new HttpError(409, 'E4003', '请先创建目标');
      const weekStart = dateStr(body.weekStart, '周起始日');
      const weekEnd = addDays(weekStart, 6);
      const from = body.from ? dateStr(body.from, '排程起始日') : weekStart;
      assert(from >= weekStart && from <= weekEnd, 'E1021', '排程起始日必须落在本周');
      const mode = body?.mode === 'rebuild' ? 'rebuild' : 'fill';

      // rebuild：先清掉这一周未完成的块，再把剩余工作量重新装一遍（已完成的记录保留）
      if (mode === 'rebuild') {
        q.deletePendingWeek.run(user.id, weekStart, weekEnd);
        // 更早几周遗留的未完成块顺延过来，否则这些任务会被 bookedElsewhere 全部排除、新周排不出东西
        q.deletePendingBefore.run(user.id, weekStart);
      }

      // 本周已有块原样保留：当作"已占用时段"精确避开，而不是简单扣当日容量（否则会重叠）
      const existingWeek = q.blocksByWeek.all(user.id, weekStart, weekEnd);
      const busy = existingWeek
        .filter((row) => row.status !== 'skipped')
        .map((row) => ({ date: row.date, startMin: row.start_min, endMin: row.end_min }));

      // 本周已排但未完成的时长要从未完成工时里扣掉，避免同一任务被重复规划
      const scheduledByItem = new Map();
      for (const row of existingWeek) {
        if (row.status === 'done' || row.status === 'skipped') continue;
        scheduledByItem.set(
          row.item_id,
          (scheduledByItem.get(row.item_id) ?? 0) + (row.end_min - row.start_min),
        );
      }

      const bookedElsewhere = new Set(
        q.blockedElsewhere.all(user.id, weekStart, weekEnd).map((row) => row.item_id),
      );
      const items = q.itemsByUser
        .all(user.id)
        .map(normalizeItem)
        .filter((i) => i.goalId === goal.id)
        .filter((i) => !bookedElsewhere.has(i.id))
        .map((i) => {
          const left = (i.remainingMin ?? i.estimateMin) - (scheduledByItem.get(i.id) ?? 0);
          return { ...i, estimateMin: Math.max(0, left) };
        })
        .filter((i) => i.estimateMin > 0);

      // 块 id 由服务端随机生成：本周保留下来的已完成块不会再撞主键
      const packed = packWeek(items, user.settings, weekStart, from, {
        busy,
        makeId: () => newId('blk'),
      });

      if (packed.blocks.length > 0) {
        db.exec('BEGIN');
        try {
          for (const b of packed.blocks) {
            q.insertBlock.run(
              b.id, user.id, b.itemId, b.date, b.startMin, b.endMin, b.isBuffer ? 1 : 0,
              b.status, null, null, nowISO(),
            );
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }

      const allBlocks = q.blocksByWeek.all(user.id, weekStart, weekEnd).map(normalizeBlock);
      const totalCapacity = weekWeekCapacity(user.settings, weekStart);
      return {
        blocks: allBlocks,
        capacityMin: totalCapacity,
        plannedMin: allBlocks.reduce((sum, b) => sum + (b.endMin - b.startMin), 0),
        bufferMin: allBlocks.filter((b) => b.isBuffer).reduce((sum, b) => sum + (b.endMin - b.startMin), 0),
        added: packed.blocks.length,
        mode,
        suggestions: packed.suggestions,
        overflow: packed.overflow.map((o) => ({
          title: o.item.title,
          estimateMin: o.remainingMin ?? o.item.estimateMin,
          reason: o.reason,
        })),
      };
    },

    'GET /api/report': ({ user, query }) => {
      const week = dateStr(query.get('week') ?? '', '周');
      const blocks = q.blocksByWeek.all(user.id, week, addDays(week, 6)).map(normalizeBlock);
      return buildReport(blocks, user.settings, week);
    },

    'PUT /api/blocks': ({ user, body }) => {
      const weekStart = dateStr(body.weekStart, '周起始日');
      const blocks = body.blocks;
      assert(Array.isArray(blocks), 'E1012', 'blocks 必须是数组');
      assert(blocks.length <= 120, 'E1013', '一次最多写入 120 个任务块');
      const weekEnd = addDays(weekStart, 6);

      const prepared = blocks.map((b) => {
        const item = q.itemById.get(String(b.itemId ?? ''), user.id);
        if (!item) throw bad('E1014', '任务不属于当前用户');
        const date = dateStr(b.date, '日期');
        assert(date >= weekStart && date <= weekEnd, 'E1015', '任务块日期必须落在本周');
        const start = int(b.startMin, '开始时间', 0, 1439);
        const end = int(b.endMin, '结束时间', 1, 1440);
        assert(end > start, 'E1016', '结束时间必须晚于开始时间');
        return {
          id: String(b.id ?? `${date}_${item.id}`),
          itemId: item.id,
          date,
          start,
          end,
          isBuffer: b.isBuffer ? 1 : 0,
          status: 'pending',
          actualMin: null,
          skipReason: null,
        };
      });

      // 同一天内不允许时间重叠
      const byDate = new Map();
      for (const b of prepared) {
        const list = byDate.get(b.date) ?? [];
        list.push(b);
        byDate.set(b.date, list);
      }
      for (const [date, list] of byDate) {
        list.sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i++) {
          if (list[i].start < list[i - 1].end) {
            throw bad('E1022', `${date} 存在重叠的任务块`);
          }
        }
      }

      db.exec('BEGIN');
      try {
        q.deleteWeek.run(user.id, weekStart, weekEnd);
        for (const b of prepared) {
          q.insertBlock.run(
            b.id, user.id, b.itemId, b.date, b.start, b.end, b.isBuffer, b.status, b.actualMin, b.skipReason, nowISO(),
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { blocks: q.blocksByWeek.all(user.id, weekStart, weekEnd).map(normalizeBlock) };
    },

    // 面板不接这个入口（DECISIONS D8.1），留给排障与脚本：只返回当前用户最近 20 条
    'GET /api/assistant/sessions': ({ user }) => ({ sessions: chat.list(user.id, 20) }),

    // 助手问答：只走「问自己的数据」这一条通道（功能答疑已移除）
    'POST /api/assistant/chat': async ({ user, body, res }) => {
      const question = typeof body?.question === 'string' ? body.question.trim() : '';
      if (!question) throw bad('E1001', '问题不能为空');
      assert(question.length <= MAX_QUESTION_CHARS, 'E1002', `问题不能超过 ${MAX_QUESTION_CHARS} 字`);

      // 限流在开流之前判：429 必须是普通 JSON，而不是开了流再报错（SPEC R6）
      if (chat.usedToday(user.id) >= MAX_DAILY_QUESTIONS) {
        throw new HttpError(
          429,
          'E2002',
          `今天的 ${MAX_DAILY_QUESTIONS} 个问题已经问完，明天 00:00 恢复`,
          { resetAt: nextShanghaiMidnightISO() },
        );
      }

      const session = resolveChatSession(user.id, question, body?.sessionId);
      // 面板上点了条带里的某天就带上它。不合法当没传：UI 的小错不该把提问变成 400
      const focusDate = isISODate(body?.date) ? body.date : undefined;

      // 先取只读工具事实，再让模型把数字讲顺；取不到事实就不调模型（DECISIONS D9.2）。
      // 提交版移除了知识库直答，问题一律走这条数据通道：答不出数据时由
      // streamModelReply 走固定文案降级，不会退化成编造数字。
      // today 换成所选日期：get_today 取的是那天，「今天做了多久」才不会答成今天
      const toolbox = createToolbox({ state: stateOf(user), today: focusDate });
      const names = planTools(question);
      const results = await Promise.all(names.map((name) => toolbox.call(name)));
      const facts = buildFacts(results);
      // 显式告诉模型它在讲哪一天，避免它把 focusDate 的数据说成「今天」
      if (facts && focusDate) facts.focusDate = focusDate;
      // 故障注入只改「模型这一段」，工具事实照常取：这样三条降级路径的
      // 前置条件（有事实、有权限）与生产一致，测的才是真正的降级分支
      const override = applyFault(resolveFault());
      await streamModelReply({
        res,
        store: chat,
        userId: user.id,
        question,
        sessionId: session.id,
        mode: 'data',
        history: chat.recentMessages(user.id, session.id, 6),
        // buildFacts 在「一个工具都没成功」时返回 null，正好让 streamModelReply 走降级
        facts: facts ?? undefined,
        toolCalls: results.map(({ name, status }) => ({ name, status })),
        ...override,
      });
      return { __sent: true };
    },
  };

  return async function route(method, path, ctx) {
    // 助手会话：GET 取消息、DELETE 软删（软删 30 天后由 purgeAssistantData 物理清理）
    const sessionMatch = path.match(/^\/api\/assistant\/sessions\/([\w-]+)$/);
    if (sessionMatch) {
      const user = requireUser(ctx);
      const sessionId = sessionMatch[1];
      if (method === 'GET') {
        const session = chat.get(user.id, sessionId);
        if (!session) throw notFound();
        return { session: normalizeSession(session), messages: chat.messages(user.id, sessionId) };
      }
      if (method !== 'DELETE') throw new HttpError(405, 'E1000', '方法不支持');
      // 不属于当前用户与已软删都返回同一个 404，避免用 id 探测别人的会话
      if (!chat.softDelete(user.id, sessionId)) throw notFound();
      return { ok: true };
    }

    // 助手回答的赞/踩：value 为 'up' / 'down' / null（取消），down 可带三种原因之一
    const messageFeedbackMatch = path.match(/^\/api\/assistant\/messages\/([\w-]+)\/feedback$/);
    if (messageFeedbackMatch) {
      if (method !== 'PATCH') throw new HttpError(405, 'E1000', '方法不支持');
      const user = requireUser(ctx);
      const value = ctx.body?.value;
      const reason = ctx.body?.reason;
      // 取消也要能落到库里，所以 value=null 是合法输入，不能用「必填」去卡
      if (value !== null && value !== 'up' && value !== 'down') {
        throw bad('E1016', '反馈只能是「有用」「没用」或取消');
      }
      if (value === 'down' && reason != null && !FEEDBACK_REASONS.has(reason)) {
        throw bad('E1016', '反馈原因只能是答错了、没看懂、不是我想要的');
      }
      const feedback = value === null ? null : value === 'down' && reason ? `down:${reason}` : value;
      // 不是自己的消息一律 404：不用「403」告诉对方这条消息存在
      if (!chat.setMessageFeedback(user.id, messageFeedbackMatch[1], feedback)) throw notFound();
      return { ok: true, feedback };
    }

    // 动态路由：/api/items/:id、/api/blocks/:id
    const itemMatch = path.match(/^\/api\/items\/([\w-]+)$/);
    if (itemMatch) {
      const user = requireUser(ctx);
      if (method !== 'DELETE') throw new HttpError(405, 'E1000', '方法不支持');
      const item = q.itemById.get(itemMatch[1], user.id);
      if (!item) throw notFound();
      q.deleteBlocksOfItem.run(item.id, user.id);
      q.deleteItem.run(item.id, user.id);
      return { ok: true };
    }

    const feedbackMatch = path.match(/^\/api\/feedback\/(\d+)$/);
    if (feedbackMatch) {
      if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
        throw new HttpError(405, 'E1000', '方法不支持');
      }
      const user = requireUser(ctx);
      if (!user.isAdmin) throw new HttpError(403, 'E2005', '仅管理员可以管理留言');
      const row = q.feedbackById.get(Number(feedbackMatch[1]));
      if (!row) throw notFound();
      const restore = ctx.query?.get('restore') === 'true' || ctx.body?.restore === true;
      if (restore) q.showFeedback.run(row.id);
      else q.hideFeedback.run(row.id);
      return { ok: true, hidden: !restore };
    }

    const blockMatch = path.match(/^\/api\/blocks\/([\w-]+)$/);
    if (blockMatch) {
      const user = requireUser(ctx);
      if (method === 'DELETE') {
        const block = q.blockById.get(blockMatch[1], user.id);
        if (!block) throw notFound();
        q.deleteBlock.run(block.id, user.id);
        return { ok: true };
      }
      if (method !== 'PATCH') throw new HttpError(405, 'E1000', '方法不支持');
      // opId 在成功之后才记账：失败的请求不会烧掉 opId，离线重试才能真正补上
      const id = blockMatch[1];
      const opId = typeof ctx.body?.opId === 'string' ? ctx.body.opId.slice(0, 64) : '';
      if (opId && q.opExists.get(user.id, opId)) {
        const existing = q.blockById.get(id, user.id);
        if (existing) return { block: normalizeBlock(existing), idempotent: true };
      }
      const result = patchBlock(user, id, ctx.body);
      if (opId) q.insertOp.run(user.id, opId, nowISO());
      return result;
    }

    const key = `${method} ${path}`;
    const handler = handlers[key];
    if (!handler) return undefined;
    const PUBLIC = new Set(['POST /api/feedback', 'GET /api/feedback', 'POST /api/visit', 'GET /api/visit']);
    const needsAuth = !key.startsWith('POST /api/auth/') && !PUBLIC.has(key);
    if (needsAuth) requireUser(ctx);
    return handler({ ...ctx, user: ctx.user, query: ctx.query ?? new URLSearchParams() });
  };

  function requireUser(ctx) {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  }

  function patchBlock(user, id, body) {
    const block = q.blockById.get(id, user.id);
    if (!block) throw notFound();

    // 锁定 / 解锁：锁定的块不会被重排或重建改动，也不能移动
    if (body && typeof body.locked === 'boolean') {
      q.setLocked.run(body.locked ? 1 : 0, nowISO(), id, user.id);
      return { block: normalizeBlock(q.blockById.get(id, user.id)) };
    }

    // 移动：改日期/开始时间，时长保持不变；锁定块禁止移动
    if (body && (body.date !== undefined || body.startMin !== undefined)) {
      if (block.locked) throw bad('E1038', '任务已锁定，请先解锁再调整时间');
      const date = dateStr(body.date ?? block.date, '日期');
      const start = int(body.startMin ?? block.start_min, '开始时间', 0, 1439);
      const duration = block.end_min - block.start_min;
      const end = start + duration;
      if (end > 1440) throw bad('E1027', '结束时间不能超过 24:00');

      const weekStart = startOfWeekISO(block.date, user.settings.weekStart ?? 1);
      const weekEnd = addDays(weekStart, 6);
      if (date < weekStart || date > weekEnd) throw bad('E1028', '只能在同一个周内移动任务');

      const others = q.blocksByDate.all(user.id, date).filter((row) => row.id !== id);
      for (const row of others) {
        if (start < row.end_min && row.start_min < end) {
          throw bad('E1024', '该时间段与已有任务重叠');
        }
      }

      q.moveBlock.run(date, start, end, nowISO(), id, user.id);
      return { block: normalizeBlock(q.blockById.get(id, user.id)) };
    }

    const source = body.source === 'backfill' ? 'backfill' : body.source === 'plan' ? 'plan' : block.source ?? 'plan';

    // 计时控制：暂停 / 继续（不改状态，只影响计时）
    const action = typeof body.action === 'string' ? body.action : '';
    if (action === 'pause' || action === 'resume') {
      if (block.status !== 'running') throw bad('E1037', '只有执行中的任务可以暂停或继续');
      if (action === 'pause') {
        if (block.started_at) q.pauseRun.run(elapsedSec(block.started_at), nowISO(), id, user.id);
      } else if (!block.started_at) {
        q.resumeRun.run(nowISO(), nowISO(), id, user.id);
      }
      return { block: normalizeBlock(q.blockById.get(id, user.id)) };
    }

    const status = String(body.status ?? '');
    assert(STATUSES.has(status), 'E1017', '状态取值不合法');
    const allowed = {
      pending: ['running', 'done', 'skipped'],
      running: ['done', 'skipped', 'pending'],
      done: ['pending'],
      skipped: ['pending'],
    };
    assert(allowed[block.status].includes(status), 'E1018', `不允许从 ${block.status} 变为 ${status}`);

    if (status === 'running') {
      q.startRun.run(nowISO(), nowISO(), id, user.id);
      return { block: normalizeBlock(q.blockById.get(id, user.id)) };
    }

    if (status === 'done') {
      const planned = block.end_min - block.start_min;
      const progressPct = body.progressPct == null ? 100 : int(body.progressPct, '完成度', 1, 100);
      let actualMin;
      if (body.actualMin != null) {
        actualMin = int(body.actualMin, '实际用时', 1, 1440);
      } else {
        // 未填写用时：由计时器推导（暂停段不计）
        const sec = (block.accumulated_sec ?? 0) + (block.started_at ? elapsedSec(block.started_at) : 0);
        actualMin = Math.max(1, Math.round(sec / 60));
      }
      q.finishBlock.run(actualMin, progressPct, source, nowISO(), id, user.id);
      // 剩余工时按「完成的工作量」扣减：完成 60% 就只消耗 60% 的计划量，没做完的滚入下次排程
      q.consumeWork.run(Math.round(planned * progressPct / 100), block.item_id, user.id);
      return { block: normalizeBlock(q.blockById.get(id, user.id)) };
    }

    if (status === 'skipped') {
      const reason = String(body.skipReason ?? 'other');
      assert(SKIP_REASONS.has(reason), 'E1019', '跳过原因不合法');
      q.skipWithSource.run(reason || 'other', source, nowISO(), id, user.id);
      return { block: normalizeBlock(q.blockById.get(id, user.id)) };
    }

    // 回退到待开始：撤销完成时把已消耗的工时加回去
    if (block.status === 'done') {
      const planned = block.end_min - block.start_min;
      const pct = block.progress_pct ?? 100;
      q.refundWork.run(Math.round(planned * pct / 100), block.item_id, user.id);
    }
    q.revertBlock.run(nowISO(), id, user.id);
    return { block: normalizeBlock(q.blockById.get(id, user.id)) };
  }
}

/** ISO 时间到当前的秒数（≥0），用于计时推导 */
function elapsedSec(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function startOfWeekISO(iso, weekStartDay = 1) {
  const d = new Date(`${iso}T00:00:00`);
  // 跟随用户在设置里选择的一周起点（0=周日，1=周一）
  const offset = (d.getDay() - (weekStartDay % 7) + 7) % 7;
  return addDays(iso, -offset);
}

function weekWeekCapacity(settings, weekStart) {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const wd = new Date(`${addDays(weekStart, i)}T00:00:00`).getDay();
    total += Math.max(0, settings.weekdays[wd] ?? 0);
  }
  return total;
}

function fmtMinute(min) {
  const m = Math.max(0, Math.round(min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendFile(res, body, contentType, filename) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export { HttpError };
