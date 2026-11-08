import type { Block } from '../domain/types';

const KEY = 'zhixue.ops.v1';

export type StatusPatch = {
  status?: Block['status'];
  actualMin?: number;
  skipReason?: Block['skipReason'];
  progressPct?: number;
  source?: 'plan' | 'backfill';
  action?: 'pause' | 'resume';
};

export type PendingOp =
  | { id: string; kind: 'status'; blockId: string; payload: StatusPatch; createdAt: string }
  | { id: string; kind: 'move'; blockId: string; payload: { date: string; startMin: number }; createdAt: string }
  | { id: string; kind: 'delete'; blockId: string; payload: Record<string, never>; createdAt: string };

export function loadOps(): PendingOp[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingOp[];
    return Array.isArray(parsed) ? parsed.filter((op) => op && typeof op.id === 'string') : [];
  } catch {
    console.warn('[offline] 队列数据损坏，已丢弃');
    return [];
  }
}

function saveOps(ops: PendingOp[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ops));
  } catch {
    console.warn('[offline] 队列写入失败（可能是空间不足）');
  }
}

export function enqueue(op: Omit<PendingOp, 'createdAt'>): PendingOp[] {
  const ops = loadOps();
  const next = [...ops, { ...op, createdAt: new Date().toISOString() } as PendingOp];
  saveOps(next);
  return next;
}

export function removeOp(id: string): PendingOp[] {
  const next = loadOps().filter((op) => op.id !== id);
  saveOps(next);
  return next;
}

export function clearOps(): PendingOp[] {
  saveOps([]);
  return [];
}

export const isOfflineError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 0;


/* ── 离线快照：最近一次成功同步的服务端状态，供断网冷启动只读展示 ── */

const SNAP_KEY = 'zhixue.snapshot.v1';

export interface StateSnapshot {
  user: { id: string; name: string; email: string };
  goal: unknown;
  items: unknown[];
  blocks: unknown[];
  settings: unknown;
  savedAt: string;
}

export function saveSnapshot(state: Omit<StateSnapshot, 'savedAt'>): void {
  try {
    localStorage.setItem(
      SNAP_KEY,
      JSON.stringify({ ...state, savedAt: new Date().toISOString() } satisfies StateSnapshot),
    );
  } catch {
    /* 空间不足时静默放弃，不影响主流程 */
  }
}

export function loadSnapshot(): StateSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StateSnapshot;
    return parsed && typeof parsed.savedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAP_KEY);
  } catch {
    /* 忽略 */
  }
}
