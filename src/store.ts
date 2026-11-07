import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './data/api';
import type { SessionUser } from './data/api';
import { addDays, todayISO, weekDates } from './domain/date';
import type { Block, BlockStatus, Goal, PlanItem, Settings } from './domain/types';

export const defaultSettings: Settings = {
  weekStart: 1,
  weekdays: [0, 150, 150, 150, 150, 150, 120],
};

export type Phase = 'loading' | 'guest' | 'ready' | 'error';

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
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setGoal: (goal: Goal) => Promise<void>;
  addItem: (item: Omit<PlanItem, 'id' | 'goalId'>) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  updateSettings: (settings: Settings) => Promise<void>;
  generateWeek: (weekStartISO: string) => Promise<void>;
  setBlockStatus: (
    id: string,
    status: BlockStatus,
    actualMin?: number,
    skipReason?: Block['skipReason'],
  ) => Promise<void>;
  seedDemo: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
}

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : '操作失败，请稍后重试');

export function useAppState() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [state, setState] = useState<AppState>(emptyState);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase('guest');
        setState(emptyState);
        return;
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
      await api.register({ email, password, name });
      await load();
    },
    [load],
  );

  const logout = useCallback(async () => {
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

  const generateWeek = useCallback(async (weekStartISO: string) => {
    await run(async () => {
      const weekEnd = addDays(weekStartISO, 6);
      const today = todayISO();
      const from = today >= weekStartISO && today <= weekEnd ? today : weekStartISO;
      const res = await api.generatePlan(weekStartISO, from);
      const inWeek = weekDates(weekStartISO);
      setState((prev) => ({
        ...prev,
        blocks: [...prev.blocks.filter((b) => !inWeek.includes(b.date)), ...res.blocks],
      }));
    });
  }, [run]);

  const setBlockStatus = useCallback(
    async (id: string, status: BlockStatus, actualMin?: number, skipReason?: Block['skipReason']) => {
      await run(async () => {
        const res = await api.patchBlock(id, { status, actualMin, skipReason });
        setState((prev) => ({
          ...prev,
          blocks: prev.blocks.map((b) => (b.id === id ? res.block : b)),
        }));
      });
    },
    [run],
  );

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

  const deleteAccount = useCallback(async (password: string) => {
    await api.deleteAccount(password);
    setState(emptyState);
    setPhase('guest');
  }, []);

  return {
    phase,
    error,
    state,
    actions: {
      login, register, logout, refresh: load,
      setGoal, addItem, removeItem, updateSettings, generateWeek, setBlockStatus, seedDemo, deleteAccount,
    } satisfies Actions,
  };
}
