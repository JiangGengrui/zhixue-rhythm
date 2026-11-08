import { addDays, daysBetween } from './date';
import { CAPACITY_DISCOUNT } from './engine';
import { TEMPLATES } from './templates';
import { LEVEL_COEF, STAGE_LABEL } from './types';
import type {
  DecomposeResult,
  DecomposeStage,
  DraftItem,
  GoalTemplate,
  KnowledgeNode,
  Level,
  StageKey,
  TrimmedNode,
  Verdict,
} from './types';

const round15 = (n: number) => Math.max(15, Math.round(n / 15) * 15);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 节点优先级：考频 60% + 分值占比 40% */
export function nodePriority(node: Pick<KnowledgeNode, 'frequency' | 'share'>): number {
  return node.frequency * 0.6 + node.share * 0.4;
}

/** 映射为 1–5 的排程权重（排程引擎用它决定先后） */
export function nodeWeight(node: Pick<KnowledgeNode, 'frequency' | 'share'>): number {
  return clamp(Math.round(1 + nodePriority(node) * 4), 1, 5);
}

function verdictOf(ratio: number): Verdict {
  if (!Number.isFinite(ratio)) return 'infeasible';
  if (ratio <= 0.85) return 'comfortable';
  if (ratio <= 1) return 'reasonable';
  if (ratio <= 1.15) return 'tight';
  return 'infeasible';
}

interface WorkingNode extends KnowledgeNode {
  /** 按基础水平修正后的工时 */
  est: number;
  nodeIds: string[];
}

const STAGE_ORDER: StageKey[] = ['foundation', 'strengthen', 'sprint'];

/**
 * 拆解引擎（PRD 8.2）：模板骨架 → 参数填充 → 智能裁断，纯函数、可复现。
 *
 * - 工时按基础水平系数缩放（零基础 1.3 … 多战 0.6）；
 * - 可用时间 = 每周可用 × 剩余周数 × 0.85；
 * - R > 1 时按「低频低分 → 已有基础 → 可合并」的顺序裁断，每一项都记录在 trimmed 里显式展示。
 */
export function decomposeGoal(input: {
  template: GoalTemplate;
  today: string;
  deadline: string;
  weeklyMinutes: number;
  level: Level;
}): DecomposeResult {
  const template = TEMPLATES[input.template] ?? TEMPLATES['postgrad-cs'];
  const coef = LEVEL_COEF[input.level] ?? 1;

  const alive: WorkingNode[] = template.nodes.map((node) => ({
    ...node,
    est: round15(node.minutes * coef),
    nodeIds: [node.id],
  }));

  const daysLeft = daysBetween(input.today, input.deadline);

  // 目标日期已过：拆解没有意义，直接返回空草案与告警，避免算出"1 周可用"的假象
  if (daysLeft <= 0) {
    const emptyStages: DecomposeStage[] = STAGE_ORDER.map((key) => ({
      key,
      label: STAGE_LABEL[key],
      startDate: input.today,
      endDate: input.today,
      minutes: 0,
      milestone: '目标日期已过，暂无可执行阶段',
    }));
    return {
      template: template.key,
      stages: emptyStages,
      items: [],
      demandMin: 0,
      availableMin: 0,
      ratio: Number.POSITIVE_INFINITY,
      verdict: 'infeasible',
      weeksLeft: 0,
      stageRatio: template.stageRatio,
      trimmed: [],
      warnings: ['目标日期已过，无法拆解出可执行计划：请先把目标日期改到将来'],
    };
  }

  const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
  const availableMin = Math.round(Math.max(0, input.weeklyMinutes) * weeksLeft * CAPACITY_DISCOUNT);

  const sumEst = () => alive.reduce((s, n) => s + n.est, 0);
  const trimmed: TrimmedNode[] = [];
  const over = () => sumEst() > availableMin;

  const remove = (node: WorkingNode, reason: TrimmedNode['reason'], note: string) => {
    const index = alive.indexOf(node);
    if (index >= 0) alive.splice(index, 1);
    trimmed.push({ id: node.id, title: node.title, minutes: node.est, reason, note });
  };

  // 第一顺位：低频低分节点（priority < 0.62，从低到高）
  const lowPriority = [...alive].filter((n) => nodePriority(n) < 0.62).sort((a, b) => nodePriority(a) - nodePriority(b));
  for (const node of lowPriority) {
    if (!over() || availableMin <= 0) break;
    if (!alive.includes(node)) continue;
    remove(node, 'low-priority', `考频 ${node.frequency.toFixed(2)} / 分值 ${node.share.toFixed(2)}，优先级最低`);
  }

  // 第二顺位：已有基础的节点（二刷及以上才启用）
  if (over() && (input.level === 'twice' || input.level === 'more')) {
    const rest = [...alive].sort((a, b) => nodePriority(a) - nodePriority(b));
    for (const node of rest) {
      if (!over()) break;
      remove(node, 'mastered', `当前基础为「${input.level === 'twice' ? '二刷' : '多战'}」，可暂时跳过`);
    }
  }

  // 第三顺位：可合并节点并入同模块的兄弟节点（工时按 0.8 折算）
  if (over()) {
    const mergeables = [...alive].filter((n) => n.mergeable).sort((a, b) => nodePriority(a) - nodePriority(b));
    for (const node of mergeables) {
      if (!over()) break;
      const host = alive.find((n) => n !== node && n.module === node.module);
      if (!host) continue;
      host.est = round15(host.est + node.est * 0.8);
      host.nodeIds.push(...node.nodeIds);
      remove(node, 'merged', `并入「${host.title}」，工时按 80% 折算`);
    }
  }

  const demandMin = sumEst();
  const ratio = availableMin > 0 ? demandMin / availableMin : Number.POSITIVE_INFINITY;

  // 阶段切分：按 template.stageRatio 在 [today, deadline] 上等比切三段
  const span = Math.max(1, daysLeft);
  const [r1, r2, r3] = template.stageRatio;
  const b1 = addDays(input.today, Math.round(span * r1));
  const b2 = addDays(input.today, Math.round(span * (r1 + r2)));
  const bounds: Array<{ key: StageKey; startDate: string; endDate: string }> = [
    { key: 'foundation', startDate: input.today, endDate: b1 },
    { key: 'strengthen', startDate: addDays(b1, 1), endDate: b2 },
    { key: 'sprint', startDate: addDays(b2, 1), endDate: input.deadline },
  ];

  const items: DraftItem[] = alive.map((node) => ({
    key: node.id,
    title: node.title,
    subject: node.subject,
    module: node.module,
    estimateMin: node.est,
    weight: nodeWeight(node),
    stage: node.stage,
    nodeIds: node.nodeIds,
  }));

  const stages: DecomposeStage[] = bounds.map((b, i) => {
    const list = items.filter((it) => it.stage === b.key);
    const minutes = list.reduce((s, it) => s + it.estimateMin, 0);
    const topModules = [...new Set(list.map((it) => it.module))].slice(0, 2);
    const target = [60, 70, 80][i] ?? 60;
    return {
      key: b.key,
      label: STAGE_LABEL[b.key],
      startDate: b.startDate,
      endDate: b.endDate,
      minutes,
      milestone:
        topModules.length > 0
          ? `完成 ${topModules.join('、')} 的第一轮，正确率 ≥ ${target}%；阶段末做一次限时自测`
          : `本阶段没有保留的计划项（可用时间不足），可延长周期或降低范围`,
    };
  });

  const warnings: string[] = [];
  if (trimmed.length > 0) {
    const cutMin = trimmed.reduce((s, t) => s + t.minutes, 0);
    warnings.push(
      `按当前可用时间裁掉了 ${trimmed.length} 项、约 ${Math.round(cutMin / 60)} 小时，已在「被放弃项」中列出，可随时手动加回`,
    );
  }
  if (demandMin > availableMin) {
    const gapH = Math.round((demandMin - availableMin) / 60);
    warnings.push(`即使裁到最小范围，仍超出可用时间约 ${gapH} 小时：建议延长目标日期或提高每周可用时长`);
  }
  if (availableMin <= 0) warnings.push('目标日期已过或每周可用为 0，无法拆解出可执行计划');

  return {
    template: template.key,
    stages,
    items: items.sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || b.weight - a.weight,
    ),
    demandMin,
    availableMin,
    ratio,
    verdict: verdictOf(ratio),
    weeksLeft,
    stageRatio: [r1, r2, r3],
    trimmed,
    warnings,
  };
}
