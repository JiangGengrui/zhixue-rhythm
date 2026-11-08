import {
  allowLogin, createSession, destroySession, generateRecoveryCode, hashPassword, hashRecoveryCode,
  newId, sessionCookie, clearCookie, verifyPassword, verifyRecoveryCode,
} from './auth.mjs';
import { nowISO } from './db.mjs';
import { buildReport, decomposeGoal, packWeek, planReplan, TEMPLATE_LIST, todayISO } from './engine.generated.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECTS = new Set(['math', 'major', 'english', 'politics', 'other']);
const LEVELS = new Set(['zero', 'once', 'twice', 'more']);
const STATUSES = new Set(['pending', 'running', 'done', 'skipped']);
const SKIP_REASONS = new Set(['interrupt', 'capacity', 'other', '']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
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
    recentFeedback: db.prepare('SELECT id, nickname, content, created_at FROM feedback ORDER BY id DESC LIMIT ?'),
    bumpVisit: db.prepare("INSERT INTO site_stats (key, value) VALUES ('visit', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"),
    readVisit: db.prepare("SELECT value FROM site_stats WHERE key = 'visit'"),
    blocksByDate: db.prepare('SELECT * FROM blocks WHERE user_id = ? AND date = ?'),
    moveBlock: db.prepare('UPDATE blocks SET date = ?, start_min = ?, end_min = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
    deleteBlock: db.prepare('DELETE FROM blocks WHERE id = ? AND user_id = ?'),
    deletePendingWeek: db.prepare("DELETE FROM blocks WHERE user_id = ? AND date >= ? AND date <= ? AND status <> 'done'"),
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

  function stateOf(user) {
    const goal = normalizeGoal(q.goalByUser.get(user.id));
    const items = q.itemsByUser.all(user.id).map(normalizeItem);
    const blocks = q.blocksByUser.all(user.id).map(normalizeBlock);
    return {
      user: { id: user.id, name: user.name, email: user.email },
      goal,
      items,
      blocks,
      settings: user.settings,
    };
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
      const recoveryCode = generateRecoveryCode();
      q.insertUser.run(
        id, email, name, hashPassword(password), hashRecoveryCode(recoveryCode),
        '[0,150,150,150,150,150,120]', nowISO(),
      );
      const user = q.userById.get(id);
      const { token } = createSession(db, id);
      res.setHeader('Set-Cookie', sessionCookie(token, 30 * 86400));
      // 恢复码只在此刻明文返回一次，服务端只存哈希
      return { user: { id: user.id, name: user.name, email: user.email }, recoveryCode };
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

    'GET /api/me': ({ user }) => ({ user: { id: user.id, name: user.name, email: user.email } }),

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

      db.exec('BEGIN');
      try {
        q.clearBlocks.run(user.id);
        q.clearItems.run(user.id);
        const now = nowISO();
        for (const draft of result.items) {
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
      return { result, applied: result.items.length };
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

      const plan = planReplan({
        blocks: state.blocks,
        items: state.items,
        settings: state.settings,
        weekStart,
        today: todayISO(),
        manual: true,
        replanCount,
      });

      if (plan.blocked) {
        throw new HttpError(409, 'E1035', plan.calibration ?? '连续多次重排仍未达标，建议调整目标');
      }
      const option = plan.options.find((o) => o.key === key);
      if (!option) throw bad('E1033', '未知的重排方案');
      if (!option.feasible && (option.key === 'defer' || option.key === 'compress')) {
        throw new HttpError(409, 'E1034', '这个方案仍然装不下，建议改用「替代」或「放弃」，或延长目标日期');
      }

      db.exec('BEGIN');
      try {
        q.deletePendingWeek.run(user.id, weekStart, weekEnd);
        for (const block of option.blocks) {
          q.insertBlock.run(
            block.id, user.id, block.itemId, block.date, block.startMin, block.endMin,
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
      const stamp = new Date().toISOString().slice(0, 10);

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
      return { goal: normalizeGoal(q.goalByUser.get(user.id)) };
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
      }

      // fill：本周已有块原样保留（已完成记录不会被重排覆盖），只为没有块的任务补排
      const existingWeek = q.blocksByWeek.all(user.id, weekStart, weekEnd);
      const existingItems = new Set(existingWeek.map((row) => row.item_id));

      // 已有块占用的时间从当日容量中扣除
      const usedByDate = new Map();
      for (const row of existingWeek) {
        usedByDate.set(row.date, (usedByDate.get(row.date) ?? 0) + (row.end_min - row.start_min));
      }
      const weekdays = user.settings.weekdays.slice();
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        const used = usedByDate.get(date) ?? 0;
        const wd = new Date(`${date}T00:00:00`).getDay();
        weekdays[wd] = Math.max(0, (weekdays[wd] ?? 0) - used);
      }
      const adjusted = { ...user.settings, weekdays };

      const bookedElsewhere = new Set(
        q.blockedElsewhere.all(user.id, weekStart, weekEnd).map((row) => row.item_id),
      );
      const items = q.itemsByUser
        .all(user.id)
        .map(normalizeItem)
        .filter((i) => i.goalId === goal.id)
        .filter((i) => (i.remainingMin ?? i.estimateMin) > 0)
        .filter((i) => !existingItems.has(i.id))
        .filter((i) => !bookedElsewhere.has(i.id))
        .map((i) => ({ ...i, estimateMin: i.remainingMin ?? i.estimateMin }));

      const packed = packWeek(items, adjusted, weekStart, from);

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
  };

  return async function route(method, path, ctx) {
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
      return patchBlock(user, blockMatch[1], ctx.body);
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

    // 移动：改日期/开始时间，时长保持不变
    if (body && (body.date !== undefined || body.startMin !== undefined)) {
      const date = dateStr(body.date ?? block.date, '日期');
      const start = int(body.startMin ?? block.start_min, '开始时间', 0, 1439);
      const duration = block.end_min - block.start_min;
      const end = start + duration;
      if (end > 1440) throw bad('E1027', '结束时间不能超过 24:00');

      const weekStart = startOfWeekISO(block.date);
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

    const opId = typeof body.opId === 'string' ? body.opId.slice(0, 64) : '';
    if (opId) {
      if (q.opExists.get(user.id, opId)) return { block: normalizeBlock(block), idempotent: true };
      q.insertOp.run(user.id, opId, nowISO());
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

    let actualMin = null;
    let skipReason = null;
    if (status === 'done') {
      const fallback = block.end_min - block.start_min;
      actualMin = int(body.actualMin ?? fallback, '实际用时', 1, 1440);
    }
    if (status === 'skipped') {
      const reason = String(body.skipReason ?? 'other');
      assert(SKIP_REASONS.has(reason), 'E1019', '跳过原因不合法');
      skipReason = reason || 'other';
    }

    q.updateBlock.run(status, actualMin, skipReason, nowISO(), id, user.id);
    // 完成时按实际投入扣减剩余工时（未完成的工作量留到下一次排程）
    if (status === 'done' && actualMin) {
      q.consumeWork.run(actualMin, block.item_id, user.id);
    }
    return { block: normalizeBlock(q.blockById.get(id, user.id)) };
  }
}

function startOfWeekISO(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const offset = (d.getDay() + 6) % 7; // 周一为一周起点
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
