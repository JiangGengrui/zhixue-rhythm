import type {
  Block, DecomposeResult, Goal, GoalTemplate, PlanItem, ReplanTrigger, Report, Settings,
} from '../domain/types';

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('网络异常，请检查连接后重试', 'E0001', 0);
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(err?.message ?? '请求失败，请稍后重试', err?.code ?? 'E0000', res.status);
  }
  return data as T;
}

export interface DecomposeResponse {
  result: DecomposeResult;
  /** apply=true 时写入的计划项数量 */
  applied: number;
}

export interface TemplateInfo {
  key: GoalTemplate;
  label: string;
  nodeCount: number;
  totalMinutes: number;
}

export interface ReplanOptionView {
  key: 'defer' | 'compress' | 'substitute' | 'drop';
  label: string;
  reason: string;
  cost: string;
  summary: { added: number; deferred: number; dropped: number; deferredMin: number };
  plannedMin: number;
  bufferMin: number;
  loadIncreasePct: number;
  applicable: boolean;
  feasible: boolean;
}

export interface ReplanResponse {
  weekStart: string;
  replanCount: number;
  trigger: ReplanTrigger;
  blocked: boolean;
  calibration: string | null;
  options: ReplanOptionView[];
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** 管理员（首个注册用户）：可管理主页留言 */
  isAdmin?: boolean;
}

export interface ServerState {
  user: SessionUser;
  goal: Goal | null;
  items: PlanItem[];
  blocks: Block[];
  settings: Settings;
}

export interface GenerateResult {
  blocks: Block[];
  /** 本次新增的任务块数量（0 表示这一周已无可排时段或都排过了） */
  added: number;
  /** fill = 只补没有块的任务；rebuild = 清掉未完成块后整周重排 */
  mode?: 'fill' | 'rebuild';
  capacityMin: number;
  plannedMin: number;
  bufferMin: number;
  suggestions: string[];
  overflow: Array<{ title: string; estimateMin: number; reason: string }>;
}

export const api = {
  register: (input: { email: string; password: string; name: string }) =>
    request<{ user: SessionUser; recoveryCode: string }>('POST', '/api/auth/register', input),
  recover: (input: { email: string; recoveryCode: string; newPassword: string }) =>
    request<{ ok: true; recoveryCode: string }>('POST', '/api/auth/recover', input),
  login: (input: { email: string; password: string }) =>
    request<{ user: SessionUser }>('POST', '/api/auth/login', input),
  /** 免注册登录：服务端建游客账号并下发会话，用于试用与测试 */
  guest: () => request<{ user: SessionUser }>('POST', '/api/auth/guest', {}),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  state: () => request<ServerState>('GET', '/api/state'),
  putGoal: (goal: Omit<Goal, 'id' | 'createdAt'>) =>
    request<{ goal: Goal }>('PUT', '/api/goal', goal),
  addItem: (item: Omit<PlanItem, 'id' | 'goalId'>) =>
    request<{ item: PlanItem }>('POST', '/api/items', item),
  deleteItem: (id: string) => request<{ ok: true }>('DELETE', `/api/items/${id}`),
  exportUrl: (format: 'json' | 'csv') => `/api/export?format=${format}`,
  notifications: () =>
    request<{
      items: Array<{ id: number; kind: string; level: 'info' | 'warn' | 'danger'; title: string; body: string; createdAt: string; read: boolean }>;
      unread: number;
    }>('GET', '/api/notifications'),
  markNotificationsRead: (ids: 'all' | number[]) =>
    request<{ ok: true }>('POST', '/api/notifications/read', { ids }),
  adminFeedback: () =>
    request<{
      items: Array<{ id: number; nickname: string | null; content: string; createdAt: string; hidden: boolean }>;
    }>('GET', '/api/feedback/admin'),
  setFeedbackHidden: (id: number, restore: boolean) =>
    request<{ ok: true; hidden: boolean }>('DELETE', `/api/feedback/${id}?restore=${restore}`),
  deleteAccount: (password: string) => request<{ ok: true }>('DELETE', '/api/account', { password }),
  putSettings: (settings: Settings) =>
    request<{ settings: Settings }>('PUT', '/api/settings', settings),
  generatePlan: (weekStart: string, from?: string, mode: 'fill' | 'rebuild' = 'fill') =>
    request<GenerateResult>('POST', '/api/plan/generate', { weekStart, from, mode }),
  report: (week: string) => request<Report>('GET', `/api/report?week=${week}`),
  putBlocks: (
    weekStart: string,
    blocks: Array<Pick<Block, 'id' | 'itemId' | 'date' | 'startMin' | 'endMin' | 'isBuffer'>>,
  ) => request<{ blocks: Block[] }>('PUT', '/api/blocks', { weekStart, blocks }),
  moveBlock: (id: string, input: { date: string; startMin: number }) =>
    request<{ block: Block }>('PATCH', `/api/blocks/${id}`, input),
  deleteBlock: (id: string) => request<{ ok: true }>('DELETE', `/api/blocks/${id}`),
  decomposeTemplates: () => request<{ templates: TemplateInfo[] }>('GET', '/api/decompose/templates'),
  decompose: (
    template: GoalTemplate,
    options?: {
      apply?: boolean;
      replace?: boolean;
      /** 用户编辑后的草案；apply 时以它为准 */
      items?: Array<{ title: string; subject: string; estimateMin: number; weight: number }>;
    },
  ) => request<DecomposeResponse>('POST', '/api/goal/decompose', { template, ...options }),
  replan: (week: string, manual = true) =>
    request<ReplanResponse>('GET', `/api/plan/replan?week=${week}${manual ? '&manual=1' : ''}`),
  applyReplan: (week: string, option: ReplanOptionView['key']) =>
    request<{ applied: string; summary: ReplanOptionView['summary']; replanCount: number; blocks: Block[] }>(
      'POST',
      '/api/plan/replan/apply',
      { week, option },
    ),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('POST', '/api/auth/password', { currentPassword, newPassword }),
  patchBlock: (
    id: string,
    patch: {
      status?: Block['status'];
      actualMin?: number;
      skipReason?: Block['skipReason'];
      progressPct?: number;
      source?: 'plan' | 'backfill';
      action?: 'pause' | 'resume';
      locked?: boolean;
    },
    opId?: string,
  ) =>
    request<{ block: Block; idempotent?: boolean }>('PATCH', `/api/blocks/${id}`, {
      ...patch,
      opId: opId ?? crypto.randomUUID(),
    }),
};
