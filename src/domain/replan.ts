import { addDays, daysBetween, weekDates, weekdayOf } from './date';
import { packWeek } from './engine';
import type {
  Block,
  PlanItem,
  ReplanItemChange,
  ReplanOption,
  ReplanResult,
  ReplanSummary,
  ReplanTrigger,
  Settings,
} from './types';

const round15 = (n: number) => Math.max(15, Math.round(n / 15) * 15);

/** 未来 7 天欠账阈值（PRD 8.4 触发条件） */
export const BACKLOG_THRESHOLD_MIN = 150;
/** 单次重排允许的未来 7 天负载增幅上限 */
export const MAX_LOAD_INCREASE_PCT = 20;
/** 连续重排次数上限，超过则转为目标校准 */
export const MAX_REPLAN_ATTEMPTS = 3;

const pendingOf = (blocks: Block[]) => blocks.filter((b) => b.status === 'pending' || b.status === 'running');

/**
 * 触发检测（PRD 8.4）：连续低完成 / 滚动欠账 / 主动请求 / 长期中断。
 * 关闭的规则不做静默处理——原因会逐条返回，由界面决定怎么呈现。
 */
export function detectReplanTrigger(input: {
  blocks: Block[];
  items: PlanItem[];
  settings: Settings;
  weekStart: string;
  today: string;
  manual?: boolean;
}): ReplanTrigger {
  const reasons: ReplanTrigger['reasons'] = [];
  const { blocks, settings, today } = input;

  // 连续 2 天达成率 < 60%
  const lowDays: string[] = [];
  for (let offset = 1; offset >= 0; offset--) {
    const date = addDays(today, -offset);
    const dayBlocks = blocks.filter((b) => b.date === date);
    if (dayBlocks.length === 0) continue;
    const done = dayBlocks.filter((b) => b.status === 'done').length;
    const rate = done / dayBlocks.length;
    if (rate < 0.6) lowDays.push(`${date} ${Math.round(rate * 100)}%`);
  }
  if (lowDays.length >= 2) {
    reasons.push({
      code: 'low-achievement',
      label: '连续两天完成率偏低',
      detail: `${lowDays.join('、')}，低于 60%`,
    });
  }

  // 未来 7 天欠账 > 150 分钟
  const horizon = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const capacity = horizon.reduce((s, d) => s + Math.max(0, settings.weekdays[weekdayOf(d)] ?? 0), 0);
  const pendingMin = pendingOf(blocks)
    .filter((b) => b.date >= today && b.date <= addDays(today, 6))
    .reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const backlogMin = Math.max(0, pendingMin - capacity);
  if (backlogMin > BACKLOG_THRESHOLD_MIN) {
    reasons.push({
      code: 'backlog',
      label: '未来 7 天装不下',
      detail: `待完成 ${Math.round(pendingMin / 60)} 小时，可用仅 ${Math.round(capacity / 60)} 小时，欠账 ${Math.round(backlogMin / 60)} 小时`,
    });
  }

  // 连续 ≥ 3 天无执行记录 → 挽救模式
  const breakDays = [0, 1, 2].map((i) => addDays(today, -i));
  const hasDone = blocks.some((b) => breakDays.includes(b.date) && b.status === 'done');
  // 只有"确实执行过、但最近三天没记录"才算中断；全新用户不该被判定为断更
  const everDone = blocks.some((b) => b.status === 'done');
  const rescue = everDone && !hasDone;
  if (rescue) {
    reasons.push({ code: 'long-break', label: '连续多日没有执行记录', detail: '转入挽救模式，不再追加任务' });
  }

  if (input.manual) {
    reasons.unshift({ code: 'manual', label: '你主动发起了重排', detail: '主动请求优先级最高，不再二次确认' });
  }

  return { triggered: reasons.length > 0, rescue, backlogMin, reasons };
}

interface OptionSpec {
  key: ReplanOption['key'];
  label: string;
  reason: string;
  cost: string;
  items: PlanItem[];
  itemChanges: ReplanItemChange[];
  applicable: boolean;
}

/**
 * 重排方案（PRD 8.4）：按「顺延 → 压缩 → 替代 → 放弃」的优先级给出候选，
 * 每个方案都带变更摘要、负载增幅与代价说明；不做静默决策。
 */
export function planReplan(input: {
  blocks: Block[];
  items: PlanItem[];
  settings: Settings;
  weekStart: string;
  today: string;
  deviationMedian?: number;
  manual?: boolean;
  replanCount?: number;
  /** 本周要保留的占用（已完成 / 锁定的块），重排时精确避开 */
  busy?: Array<{ date: string; startMin: number; endMin: number }>;
}): ReplanResult {
  const { blocks, items, settings, weekStart, today } = input;
  const from = today >= weekStart ? today : weekStart;
  const weekEnd = addDays(weekStart, 6);

  const trigger = detectReplanTrigger({
    blocks,
    items,
    settings,
    weekStart,
    today,
    manual: input.manual,
  });

  const weekBlocks = blocks.filter((b) => b.date >= weekStart && b.date <= weekEnd);
  const baselineMin = pendingOf(weekBlocks)
    .filter((b) => b.date >= from)
    .reduce((s, b) => s + (b.endMin - b.startMin), 0);

  // 重排的对象是「这一周已经排了块的任务」，而不是整个计划：
  // 把全部待办都塞进一周会让每个方案都显示"延期 100+ 小时"，没有产品意义。
  const weekItemIds = new Set(weekBlocks.map((b) => b.itemId));
  const pool = weekItemIds.size > 0 ? items.filter((i) => weekItemIds.has(i.id)) : items;
  const active = pool
    .map((i) => ({ ...i, estimateMin: Math.max(0, i.remainingMin ?? i.estimateMin) }))
    .filter((i) => i.estimateMin > 0);

  const specs: OptionSpec[] = [];

  // 1. 顺延：按现有工时重新装箱，装不下的留给下周
  specs.push({
    key: 'defer',
    label: '顺延到下周',
    reason: '把这一周装不下的部分顺延，本周只保留能完成的量',
    cost: '未来的弹性空间会被挤占，下一周会更紧',
    items: active,
    itemChanges: [],
    applicable: true,
  });

  // 2. 压缩：非核心节点（权重 ≤ 3）工时压到 70%
  const compressChanges: ReplanItemChange[] = [];
  const compressed = active.map((i) => {
    if (i.weight > 3) return i;
    const next = Math.max(30, round15(i.estimateMin * 0.7));
    if (next >= i.estimateMin) return i;
    compressChanges.push({ id: i.id, remainingMin: next });
    return { ...i, estimateMin: next };
  });
  specs.push({
    key: 'compress',
    label: '压缩非核心任务',
    reason:
      compressChanges.length > 0
        ? `把 ${compressChanges.length} 个权重 ≤ 3 的任务工时压缩 30%，先保证核心任务排得下`
        : '本周排的都是核心任务（权重 > 3），没有可压缩的非核心项',
    cost:
      compressChanges.length > 0
        ? '学习深度会下降，被压缩的任务会标记为「降级」'
        : '这条方案在当前排布下用不上',
    items: compressed,
    itemChanges: compressChanges,
    applicable: compressChanges.length > 0,
  });

  // 3. 替代：不再排最低权重的任务，把时间让给高权重
  const substituted = active.filter((i) => i.weight > 2);
  const substitutable = active.length - substituted.length;
  specs.push({
    key: 'substitute',
    label: '用核心任务替换',
    reason:
      substitutable > 0
        ? `本周先不排 ${substitutable} 个权重 ≤ 2 的任务，把时间让给高频高权重的部分`
        : '本周没有权重 ≤ 2 的任务可供替换',
    cost:
      substitutable > 0 ? '覆盖范围收窄，低权重任务会推迟到下一轮' : '这条方案在当前排布下用不上',
    items: substituted,
    itemChanges: [],
    applicable: substitutable > 0,
  });

  // 4. 放弃：显式放弃权重最低的一项（需用户确认并留痕）
  const lowest = [...active].sort((a, b) => a.weight - b.weight)[0];
  const dropApplicable = Boolean(lowest) && active.length > 1;
  specs.push({
    key: 'drop',
    label: '放弃最低优先级任务',
    reason: dropApplicable
      ? `放弃「${lowest!.title}」，其余任务按原工时推进`
      : active.length <= 1
        ? '本周只有一个任务，放弃它等于清空整周'
        : '没有可放弃的任务',
    cost: dropApplicable ? '该任务会从计划中移除并留痕，可由用户手动恢复' : '这条方案在当前排布下用不上',
    items: dropApplicable ? active.filter((i) => i.id !== lowest!.id) : active,
    itemChanges: dropApplicable ? [{ id: lowest!.id, remove: true }] : [],
    applicable: dropApplicable,
  });

  const options: ReplanOption[] = specs.map((spec) => {
    const packed = packWeek(spec.items, settings, weekStart, from, { busy: input.busy ?? [] });
    const deferredMin = packed.overflow.reduce(
      (s, o) => s + (o.remainingMin ?? o.item.estimateMin),
      0,
    );
    const dropped = spec.itemChanges.filter((c) => c.remove).length;
    const summary: ReplanSummary = {
      added: packed.blocks.length,
      deferred: packed.overflow.length,
      dropped,
      deferredMin,
    };
    const plannedMin = packed.blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
    const loadIncreasePct =
      baselineMin > 0 ? Math.round(((plannedMin - baselineMin) / baselineMin) * 100) : 0;
    return {
      key: spec.key,
      label: spec.label,
      reason: spec.reason,
      cost: spec.cost,
      summary,
      plannedMin,
      bufferMin: packed.blocks.filter((b) => b.isBuffer).reduce((s, b) => s + (b.endMin - b.startMin), 0),
      loadIncreasePct,
      // 顺延的语义就是"装不下的留到下周"，因此延期量不影响它的可行性；
      // 压缩/替代/放弃则要求本周能完全装下。
      applicable: spec.applicable,
      // 顺延本身就是"把装不下的留到下周"，所以不受负载增幅约束
      feasible:
        spec.applicable &&
        (spec.key === 'defer'
          ? true
          : loadIncreasePct <= MAX_LOAD_INCREASE_PCT && deferredMin === 0),
      blocks: packed.blocks,
      itemChanges: spec.itemChanges,
    };
  });

  const replanCount = Math.max(0, input.replanCount ?? 0);
  // 「未达标」= 顺延之后仍有装不下的工作量；重排到这个程度就该谈目标，而不是继续排
  const stillOverflow = (options.find((o) => o.key === 'defer')?.summary.deferredMin ?? 0) > 0;
  const blocked = replanCount >= MAX_REPLAN_ATTEMPTS && stillOverflow;

  let calibration: string | undefined;
  if (blocked) {
    const needMin = Math.max(...options.map((o) => o.plannedMin), baselineMin);
    const perWeekCapacity = Array.from({ length: 7 }, (_, i) => weekdayOf(addDays(weekStart, i)))
      .reduce((s, wd) => s + Math.max(0, settings.weekdays[wd] ?? 0), 0);
    const extraWeeks =
      perWeekCapacity > 0 ? Math.ceil((needMin - perWeekCapacity) / perWeekCapacity) : 0;
    calibration = `连续 ${replanCount} 次重排仍未达标：建议把目标日期顺延约 ${Math.max(1, extraWeeks)} 周，或把每周可用时长提高约 ${Math.max(
      1,
      Math.round(((needMin - perWeekCapacity) / 60) * 10) / 10,
    )} 小时，也可以缩小目标范围。`;
  }

  return { trigger, options, blocked, calibration };
}

/** 方案应用到「哪些块要写入、哪些计划项要改」的纯数据描述，落库交给调用方 */
export function summarizeOption(option: ReplanOption): string {
  const parts = [`新增 ${option.summary.added} 项`];
  if (option.summary.deferred > 0) parts.push(`延期 ${option.summary.deferred} 项`);
  if (option.summary.dropped > 0) parts.push(`放弃 ${option.summary.dropped} 项`);
  return parts.join('、');
}

/** 距目标还剩几周，供界面展示 */
export function weeksUntil(today: string, deadline: string): number {
  return Math.max(0, Math.ceil(daysBetween(today, deadline) / 7));
}

/** 本周剩余容量（今天及之后），供界面提示 */
export function remainingCapacity(settings: Settings, weekStart: string, today: string): number {
  return weekDates(weekStart)
    .filter((d) => d >= today)
    .reduce((s, d) => s + Math.max(0, settings.weekdays[weekdayOf(d)] ?? 0), 0);
}
