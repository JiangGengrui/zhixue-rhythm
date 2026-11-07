import { useCallback, useEffect, useState } from 'react';
import { packWeek } from './domain/engine';
import { startOfWeek, todayISO, weekDates } from './domain/date';
import type { Block, BlockStatus, Goal, PlanItem, Settings } from './domain/types';

export const STORAGE_KEY = 'zhixue.app.v2';

export interface AppState {
  version: 2;
  profile: { name: string };
  goal: Goal | null;
  items: PlanItem[];
  blocks: Block[];
  settings: Settings;
}

const defaultSettings: Settings = {
  weekStart: 1,
  // 周日..周六，默认工作日 150 分钟，周末留白
  weekdays: [0, 150, 150, 150, 150, 150, 0],
};

const emptyState: AppState = {
  version: 2,
  profile: { name: '同学' },
  goal: null,
  items: [],
  blocks: [],
  settings: defaultSettings,
};

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (parsed.version !== 2) return emptyState;
    return {
      version: 2,
      profile: parsed.profile ?? emptyState.profile,
      goal: parsed.goal ?? null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
      settings: parsed.settings ?? defaultSettings,
    };
  } catch {
    // 本地数据损坏时回到空状态，而不是白屏
    console.warn('[store] 本地数据解析失败，已重置');
    return emptyState;
  }
}

const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export interface Actions {
  setGoal: (goal: Goal) => void;
  addItem: (item: Omit<PlanItem, 'id'>) => void;
  removeItem: (id: string) => void;
  updateSettings: (settings: Settings) => void;
  generateWeek: (weekStartISO: string) => void;
  setBlockStatus: (
    id: string,
    status: BlockStatus,
    actualMin?: number,
    skipReason?: Block['skipReason'],
  ) => void;
  seedDemo: () => void;
  reset: () => void;
}

export function useAppState(): { state: AppState; actions: Actions } {
  const [state, setState] = useState<AppState>(() => loadState());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      console.warn('[store] 本地存储写入失败（可能是空间不足）');
    }
  }, [state]);

  const setGoal = useCallback((goal: Goal) => {
    setState((prev) => ({ ...prev, goal }));
  }, []);

  const addItem = useCallback((item: Omit<PlanItem, 'id'>) => {
    setState((prev) => ({ ...prev, items: [...prev.items, { ...item, id: uid('item') }] }));
  }, []);

  const removeItem = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      items: prev.items.filter((i) => i.id !== id),
      blocks: prev.blocks.filter((b) => b.itemId !== id),
    }));
  }, []);

  const updateSettings = useCallback((settings: Settings) => {
    setState((prev) => ({ ...prev, settings }));
  }, []);

  /** 生成本周 Block：保留已有完成状态，避免重复生成丢失记录 */
  const generateWeek = useCallback((weekStartISO: string) => {
    setState((prev) => {
      if (!prev.goal) return prev;
      const items = prev.items.filter((i) => i.goalId === prev.goal!.id);
      const packed = packWeek(items, prev.settings, weekStartISO);
      const existing = new Map(prev.blocks.map((b) => [b.id, b]));
      const merged = packed.blocks.map((b) => {
        const old = existing.get(b.id);
        return old
          ? { ...b, status: old.status, actualMin: old.actualMin, skipReason: old.skipReason }
          : b;
      });
      const inWeek = new Set(weekDates(weekStartISO));
      const outside = prev.blocks.filter((b) => !inWeek.has(b.date));
      return { ...prev, blocks: [...outside, ...merged] };
    });
  }, []);

  const setBlockStatus = useCallback(
    (id: string, status: BlockStatus, actualMin?: number, skipReason?: Block['skipReason']) => {
      setState((prev) => ({
        ...prev,
        blocks: prev.blocks.map((b) =>
          b.id === id ? { ...b, status, actualMin: actualMin ?? b.actualMin, skipReason } : b,
        ),
      }));
    },
    [],
  );

  const seedDemo = useCallback(() => {
    const goalId = uid('goal');
    const goal: Goal = {
      id: goalId,
      title: '2027 考研 · 计算机科学',
      deadline: '2026-12-19',
      weeklyMinutes: 900,
      level: 'once',
      createdAt: new Date().toISOString(),
    };
    const items: PlanItem[] = [
      ['高数 · 极限与连续 40 题', 'math', 120, 5],
      ['408 · 二叉树遍历专题', 'major', 90, 5],
      ['英语 · 真题 2018 Text 2', 'english', 60, 4],
      ['线性代数 · 矩阵运算', 'math', 90, 4],
      ['408 · 图的最短路径', 'major', 120, 4],
      ['政治 · 马原第一章', 'politics', 60, 2],
      ['英语 · 长难句 5 句', 'english', 45, 3],
      ['408 · 排序算法复习', 'major', 75, 3],
    ].map(([title, subject, estimateMin, weight]) => ({
      id: uid('item'),
      goalId,
      title: title as string,
      subject: subject as PlanItem['subject'],
      estimateMin: estimateMin as number,
      weight: weight as number,
    }));

    // 示例数据同时生成本周计划，并把最重要的三项落到今天，便于立刻体验执行与复盘
    const weekStart = startOfWeek(todayISO(), defaultSettings.weekStart);
    const packed = packWeek(items, defaultSettings, weekStart);
    const today = todayISO();
    const todayItems = items.slice(0, 3);

    const blocks: Block[] = packed.blocks
      .filter((b) => !todayItems.some((i) => i.id === b.itemId))
      .map((b) => b);

    const todaySlots = [
      { startMin: 9 * 60, endMin: 11 * 60, done: true, actualMin: 128 },
      { startMin: 14 * 60, endMin: 15 * 60 + 30, done: true, actualMin: 85 },
      { startMin: 19 * 60 + 30, endMin: 20 * 60 + 30, done: false, actualMin: 0 },
    ];
    todayItems.forEach((item, i) => {
      const slot = todaySlots[i];
      if (!slot) return;
      blocks.push({
        id: `blk_${today}_${item.id}`,
        itemId: item.id,
        date: today,
        startMin: slot.startMin,
        endMin: slot.endMin,
        isBuffer: false,
        status: slot.done ? 'done' : 'pending',
        actualMin: slot.done ? slot.actualMin : undefined,
      });
    });

    setState((prev) => ({ ...prev, goal, items, blocks }));
  }, []);

  const reset = useCallback(() => {
    setState({ ...emptyState, settings: state.settings });
  }, [state.settings]);

  return {
    state,
    actions: { setGoal, addItem, removeItem, updateSettings, generateWeek, setBlockStatus, seedDemo, reset },
  };
}
