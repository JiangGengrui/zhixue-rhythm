import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './data/api';
import { clearSnapshot, enqueue, isOfflineError, loadOps, loadSnapshot, removeOp, saveSnapshot } from './data/offlineQueue';
import type { StatusPatch } from './data/offlineQueue';
import type { DecomposeResponse, ReplanOptionView, ReplanResponse, SessionUser } from './data/api';
import { addDays, todayISO, weekDates } from './domain/date';
import type { Block, BlockStatus, Goal, GoalTemplate, PlanItem, Settings } from './domain/types';

export const defaultSettings: Settings = {
  weekStart: 1,
  weekdays: [0, 150, 150, 150, 150, 150, 120],
};

export type Phase = 'loading' | 'guest' | 'ready' | 'error' | 'offline';

export interface AppState {
  user: SessionUser | null;
  goal: Goal | null;
  items: PlanItem[];
  blocks: Block[];
  settings: Settings;
}

const emptyState: AppState = {
  user: null,
  goal: null,
  items: [],
  blocks: [],
  settings: defaultSettings,
};

export interface Actions {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<string>;
  recover: (email: string, recoveryCode: string, newPassword: string) => Promise<string>;
  dismissRecovery: () => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setGoal: (goal: Goal) => Promise<void>;
  addItem: (item: Omit<PlanItem, 'id' | 'goalId'>) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  updateSettings: (settings: Settings) => Promise<void>;
  generateWeek: (weekStartISO: string, mode?: 'fill' | 'rebuild') => Promise<number>;
  setBlockStatus: (
    id: string,
    status: BlockStatus,
    actualMin?: number,
    skipReason?: Block['skipReason'],
    extra?: { progressPct?: number; source?: 'plan' | 'backfill' },
  ) => Promise<void>;
  seedDemo: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  flushOps: () => Promise<void>;
  pauseBlock: (id: string) => Promise<void>;
  loadNotifications: () => Promise<void>;
  markNotificationsRead: () => Promise<void>;
  resumeBlock: (id: string) => Promise<void>;
  setBlockLocked: (id: string, locked: boolean) => Promise<void>;
  moveBlock: (id: string, input: { date: string; startMin: number }) => Promise<void>;
  deleteBlock: (id: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** 拆解预览（apply 时写库并刷新状态） */
  decompose: (
    template: GoalTemplate,
    apply?: boolean,
    items?: Array<{ title: string; subject: string; estimateMin: number; weight: number }>,
  ) => Promise<DecomposeResponse>;
  /** 重排方案（只读） */
  replan: (week: string) => Promise<ReplanResponse>;
  /** 应用重排方案并刷新状态 */
  applyReplan: (week: string, option: ReplanOptionView['key']) => Promise<number>;
}

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : '操作失败，请稍后重试');

export function useAppState() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pendingOps, setPendingOps] = useState<number>(() => loadOps().length);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [notifs, setNotifs] = useState<{ items: Array<{ id: number; kind: string; level: 'info' | 'warn' | 'danger'; title: string; body: string; createdAt: string; read: boolean }>; unread: number }>({ items: [], unread: 0 });

  const loadNotifications = useCallback(async () => {
    try {
      setNotifs(await api.notifications());
    } catch {
      /* 通知拉取失败不打扰主流程 */
    }
  }, []);

  const markNotificationsRead = useCallback(async () => {
    try {
      await api.markNotificationsRead('all');
      setNotifs((prev) => ({ items: prev.items.map((n) => ({ ...n, read: true })), unread: 0 }));
    } catch {
      /* 忽略 */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setState({
        user: s.user,
        goal: s.goal,
        items: s.items,
        blocks: s.blocks,
        settings: s.settings ?? defaultSettings,
      });
      setPhase('ready');
      setError(null);
      setOfflineSince(null);
      saveSnapshot(s);
      void loadNotifications();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase('guest');
        setState(emptyState);
        clearSnapshot();
        return;
      }
      if (isOfflineError(err)) {
        const snap = loadSnapshot();
        if (snap) {
          // 离线冷启动：用上次同步的数据只读展示，写操作仍会进入队列
          setState({
            user: snap.user as typeof state.user,
            goal: snap.goal as typeof state.goal,
            items: snap.items as typeof state.items,
            blocks: snap.blocks as typeof state.blocks,
            settings: snap.settings as typeof state.settings,
          });
          setOfflineSince(snap.savedAt);
          setPhase('offline');
          return;
        }
      }
      setError(messageOf(err));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase('guest');
        return;
      }
      setError(messageOf(err));
      throw err;
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      await api.login({ email, password });
      await load();
    },
    [load],
  );

  const register = useCallback(
    async (email: string, password: string, name: string) => {
      const res = await api.register({ email, password, name });
      setRecoveryCode(res.recoveryCode);
      await load();
      return res.recoveryCode;
    },
    [load],
  );

  const recover = useCallback(async (email: string, code: string, newPassword: string) => {
    const res = await api.recover({ email, recoveryCode: code, newPassword });
    setRecoveryCode(res.recoveryCode);
    setPhase('guest');
    return res.recoveryCode;
  }, []);

  const dismissRecovery = useCallback(() => setRecoveryCode(null), []);

  const logout = useCallback(async () => {
    clearSnapshot();
    await api.logout().catch(() => undefined);
    setState(emptyState);
    setPhase('guest');
  }, []);

  const setGoal = useCallback(async (goal: Goal) => {
    await run(async () => {
      const res = await api.putGoal({
        title: goal.title,
        deadline: goal.deadline,
        weeklyMinutes: goal.weeklyMinutes,
        level: goal.level,
      });
      setState((prev) => ({ ...prev, goal: res.goal }));
    });
  }, [run]);

  const addItem = useCallback(async (item: Omit<PlanItem, 'id' | 'goalId'>) => {
    await run(async () => {
      const res = await api.addItem(item);
      setState((prev) => ({ ...prev, items: [...prev.items, res.item] }));
    });
  }, [run]);

  const removeItem = useCallback(async (id: string) => {
    await run(async () => {
      await api.deleteItem(id);
      setState((prev) => ({
        ...prev,
        items: prev.items.filter((i) => i.id !== id),
        blocks: prev.blocks.filter((b) => b.itemId !== id),
      }));
    });
  }, [run]);

  const updateSettings = useCallback(async (settings: Settings) => {
    await run(async () => {
      const res = await api.putSettings(settings);
      setState((prev) => ({ ...prev, settings: res.settings }));
    });
  }, [run]);

  const generateWeek = useCallback(async (weekStartISO: string, mode: 'fill' | 'rebuild' = 'fill'): Promise<number> => {
    let added = 0;
    await run(async () => {
      const weekEnd = addDays(weekStartISO, 6);
      const today = todayISO();
      const from = today >= weekStartISO && today <= weekEnd ? today : weekStartISO;
      const res = await api.generatePlan(weekStartISO, from, mode);
      added = res.added ?? res.blocks.length;
      const inWeek = weekDates(weekStartISO);
      setState((prev) => ({
        ...prev,
        blocks: [...prev.blocks.filter((b) => !inWeek.includes(b.date)), ...res.blocks],
      }));
    });
    return added;
  }, [run]);

  const setBlockStatus = useCallback(
    async (
      id: string,
      status: BlockStatus,
      actualMin?: number,
      skipReason?: Block['skipReason'],
      extra?: { progressPct?: number; source?: 'plan' | 'backfill' },
    ) => {
      const before = state.blocks.find((b) => b.id === id);
      const patch: StatusPatch = { status, actualMin, skipReason, ...extra };
      // 先乐观更新，离线时界面也能立即反映（含计时起点，保证离线也能开始/暂停）
      setState((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.id === id
            ? {
                ...b,
                status,
                startedAt:
                  status === 'running'
                    ? new Date().toISOString()
                    : status === 'pending'
                      ? undefined
                      : b.startedAt,
                actualMin: status === 'done' ? actualMin ?? b.endMin - b.startMin : b.actualMin,
                skipReason: status === 'skipped' ? skipReason ?? 'other' : undefined,
                progressPct: status === 'done' ? extra?.progressPct ?? b.progressPct ?? 100 : b.progressPct,
                source: extra?.source ?? b.source,
              }
            : b,
        ),
      }));

      try {
        const res = await api.patchBlock(id, patch);
        setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? res.block : b)) }));
        setError(null);
      } catch (err) {
        if (isOfflineError(err)) {
          setPendingOps(
            enqueue({ id: crypto.randomUUID(), kind: 'status', blockId: id, payload: patch }).length,
          );
          setError('当前处于离线状态，打卡已暂存，联网后会自动同步');
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          setPhase('guest');
          return;
        }
        setError(messageOf(err));
        if (before) {
          setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? before : b)) }));
        }
      }
    },
    [state.blocks],
  );

  const pauseBlock = useCallback(
    async (id: string) => {
      const before = state.blocks.find((b) => b.id === id);
      setState((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.id === id ? { ...b, startedAt: undefined, accumulatedSec: b.accumulatedSec ?? 0 } : b,
        ),
      }));
      try {
        const res = await api.patchBlock(id, { action: 'pause' });
        setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? res.block : b)) }));
        setError(null);
      } catch (err) {
        if (isOfflineError(err)) {
          setPendingOps(enqueue({ id: crypto.randomUUID(), kind: 'status', blockId: id, payload: { action: 'pause' } }).length);
          setError('当前处于离线状态，暂停已暂存，联网后会自动同步');
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          setPhase('guest');
          return;
        }
        setError(messageOf(err));
        if (before) {
          setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? before : b)) }));
        }
      }
    },
    [state.blocks],
  );

  const resumeBlock = useCallback(
    async (id: string) => {
      const before = state.blocks.find((b) => b.id === id);
      setState((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => (b.id === id ? { ...b, startedAt: new Date().toISOString() } : b)),
      }));
      try {
        const res = await api.patchBlock(id, { action: 'resume' });
        setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? res.block : b)) }));
        setError(null);
      } catch (err) {
        if (isOfflineError(err)) {
          setPendingOps(enqueue({ id: crypto.randomUUID(), kind: 'status', blockId: id, payload: { action: 'resume' } }).length);
          setError('当前处于离线状态，继续执行已暂存，联网后会自动同步');
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          setPhase('guest');
          return;
        }
        setError(messageOf(err));
        if (before) {
          setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? before : b)) }));
        }
      }
    },
    [state.blocks],
  );

  const setBlockLocked = useCallback(
    async (id: string, locked: boolean) => {
      const before = state.blocks.find((b) => b.id === id);
      setState((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) => (b.id === id ? { ...b, locked } : b)),
      }));
      try {
        const res = await api.patchBlock(id, { locked });
        setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? res.block : b)) }));
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setPhase('guest');
          return;
        }
        setError(messageOf(err));
        if (before) {
          setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? before : b)) }));
        }
      }
    },
    [state.blocks],
  );

  const moveBlock = useCallback(
    async (id: string, input: { date: string; startMin: number }) => {
      const before = state.blocks.find((b) => b.id === id);
      setState((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.id === id ? { ...b, date: input.date, startMin: input.startMin, endMin: input.startMin + (b.endMin - b.startMin) } : b,
        ),
      }));
      try {
        const res = await api.moveBlock(id, input);
        setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? res.block : b)) }));
        setError(null);
      } catch (err) {
        if (isOfflineError(err)) {
          setPendingOps(enqueue({ id: crypto.randomUUID(), kind: 'move', blockId: id, payload: input }).length);
          setError('当前处于离线状态，调整已暂存，联网后会自动同步');
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          setPhase('guest');
          return;
        }
        setError(messageOf(err));
        if (before) {
          setState((prev) => ({ ...prev, blocks: prev.blocks.map((b) => (b.id === id ? before : b)) }));
        }
      }
    },
    [state.blocks],
  );

  const deleteBlock = useCallback(async (id: string) => {
    const before = state.blocks;
    setState((prev) => ({ ...prev, blocks: prev.blocks.filter((b) => b.id !== id) }));
    try {
      await api.deleteBlock(id);
      setError(null);
    } catch (err) {
      if (isOfflineError(err)) {
        setPendingOps(enqueue({ id: crypto.randomUUID(), kind: 'delete', blockId: id, payload: {} }).length);
        setError('当前处于离线状态，删除已暂存，联网后会自动同步');
        return;
      }
      setError(messageOf(err));
      setState((prev) => ({ ...prev, blocks: before }));
    }
  }, [state.blocks]);

  /** 按入队顺序补传；服务端用 opId 幂等，重复提交不会重复计数 */
  const flushOps = useCallback(async () => {
    const ops = loadOps();
    if (ops.length === 0) return;
    for (const op of ops) {
      try {
        if (op.kind === 'status') {
          await api.patchBlock(op.blockId, op.payload, op.id);
        } else if (op.kind === 'move') {
          await api.moveBlock(op.blockId, op.payload);
        } else {
          await api.deleteBlock(op.blockId).catch((err: unknown) => {
            if (err instanceof ApiError && err.status === 404) return;
            throw err;
          });
        }
        setPendingOps(removeOp(op.id).length);
      } catch (err) {
        if (isOfflineError(err)) return; // 仍然离线，等下一次
        if (err instanceof ApiError && (err.status === 400 || err.status === 404)) {
          setPendingOps(removeOp(op.id).length); // 无效操作直接丢弃，避免卡死队列
          continue;
        }
        return;
      }
    }
    setError(null);
    await load();
  }, [load]);

  useEffect(() => {
    void flushOps();
    const onOnline = () => void flushOps();
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => {
      if (loadOps().length > 0) void flushOps();
    }, 20000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, [flushOps]);

  const seedDemo = useCallback(async () => {
    await run(async () => {
      await api.putGoal({
        title: '2027 考研 · 计算机科学',
        deadline: '2026-12-19',
        weeklyMinutes: 900,
        level: 'once',
      });
      const drafts: Array<Omit<PlanItem, 'id' | 'goalId'>> = [
        { title: '高数 · 极限与连续 40 题', subject: 'math', estimateMin: 120, weight: 5 },
        { title: '408 · 二叉树遍历专题', subject: 'major', estimateMin: 90, weight: 5 },
        { title: '英语 · 真题 2018 Text 2', subject: 'english', estimateMin: 60, weight: 4 },
        { title: '线性代数 · 矩阵运算', subject: 'math', estimateMin: 90, weight: 4 },
        { title: '408 · 图的最短路径', subject: 'major', estimateMin: 120, weight: 4 },
        { title: '政治 · 马原第一章', subject: 'politics', estimateMin: 60, weight: 2 },
        { title: '英语 · 长难句 5 句', subject: 'english', estimateMin: 45, weight: 3 },
        { title: '408 · 排序算法复习', subject: 'major', estimateMin: 75, weight: 3 },
      ];
      for (const d of drafts) await api.addItem(d);
      await load();
    });
  }, [run, load]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.changePassword(currentPassword, newPassword);
  }, []);

  const decompose = useCallback(
    async (
      template: GoalTemplate,
      apply = false,
      items?: Array<{ title: string; subject: string; estimateMin: number; weight: number }>,
    ) => {
      let res: DecomposeResponse | null = null;
      await run(async () => {
        res = await api.decompose(
          template,
          apply ? { apply: true, replace: true, items } : undefined,
        );
        if (apply) await load();
      });
      return res!;
    },
    [run, load],
  );

  const replan = useCallback(async (week: string) => api.replan(week), []);

  const applyReplan = useCallback(
    async (week: string, option: ReplanOptionView['key']) => {
      let count = 0;
      await run(async () => {
        const res = await api.applyReplan(week, option);
        count = res.replanCount;
        await load();
      });
      return count;
    },
    [run, load],
  );

  const deleteAccount = useCallback(async (password: string) => {
    await api.deleteAccount(password);
    setState(emptyState);
    setPhase('guest');
  }, []);

  return {
    phase,
    error,
    state,
    recoveryCode,
    pendingOps,
    offlineSince,
    notifs,
    actions: {
      login, register, recover, dismissRecovery, logout, refresh: load,
      setGoal, addItem, removeItem, updateSettings, generateWeek, setBlockStatus, seedDemo, deleteAccount,
      pauseBlock, resumeBlock, setBlockLocked, moveBlock, deleteBlock, changePassword, flushOps, decompose, replan, applyReplan, loadNotifications, markNotificationsRead,
    } satisfies Actions,
  };
}
