/**
 * 本地事实摘要：没有模型时，数据类问题也要答得出真实数字。
 *
 * 之前没配模型 Key 就整段回 `DEGRADED_DATA_TEXT`（「暂时取不到你的数据」），
 * 可工具事实其实已经取到了——「这周还剩多少」这种问题根本不需要模型，
 * 把数字按固定模板讲出来就行。这里只讲事实、不加建议：
 * 没有模型兜底时，任何主观判断都可能变成编造。
 */
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const fmtMinutes = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
};

const weekdayOf = (iso) => {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : WEEKDAY[date.getUTCDay()];
};

const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`;

/** 目标 + 可行性 */
function goalLine(goal) {
  // 没问目标时这个工具根本不会跑，不能因为「没取」就说「没设置」
  if (!goal) return '';
  if (goal.hasData === false) {
    return '你还没有设置目标。先在「目标」页写下要考什么、什么时候考，我才能算进度和可行性。';
  }
  const f = goal.feasibility ?? {};
  const verdict =
    f.ratio === null || f.ratio === undefined
      ? '（截止日已过，按当前数据算不出可行性）'
      : f.ratio <= 1
        ? `时间够用，大约还有 ${percent(1 - f.ratio)} 的余量`
        : `按当前节奏需要 ${f.ratio} 倍于可用的时间，偏紧`;
  return `目标「${goal.goal.title}」，${goal.goal.deadline} 截止，还有 ${f.weeksLeft ?? '?'} 周：剩余任务 ${fmtMinutes(f.demandMin)}，可用时间 ${fmtMinutes(f.availableMin)}，${verdict}。`;
}

/** 当天任务 */
function todayLine(today) {
  if (!today) return '';
  const label = `${weekdayOf(today.date)} ${today.date}`.trim();
  const blocks = Array.isArray(today.blocks) ? today.blocks : [];
  if (today.hasData === false || blocks.length === 0) {
    return `${label} 没有排任务。`;
  }
  const detail = blocks
    .map((b) => `${b.title}（${fmtMinutes(b.endMin - b.startMin)}，${b.status === 'done' ? '已完成' : '未完成'}）`)
    .join('、');
  return `${label} 排了 ${blocks.length} 个任务、共 ${fmtMinutes(today.totalMin)}，已完成 ${today.doneCount ?? 0} 个，已投入 ${fmtMinutes(today.accumulatedMin ?? 0)}：${detail}。`;
}

/**
 * 一周按天铺开。
 *
 * `withTotals` 为假时只讲每天的分布：周报那条已经报了「计划多少个」，
 * 两边的统计口径不完全一样（周报含已完成块），并排出现会像在互相打脸。
 */
function weekLine(week, withTotals) {
  if (!week) return '';
  const days = Array.isArray(week.days) ? week.days : [];
  const planned = days.filter((d) => (d.blocks?.length ?? 0) > 0);
  if (week.hasData === false || planned.length === 0) {
    return `${week.weekStart} 这一周还没有生成计划，去「周」页点一下生成就行。`;
  }
  const detail = planned
    .map((d) => `${weekdayOf(d.date)} ${fmtMinutes(d.totalMin)}（${d.doneCount}/${d.blocks.length} 个完成）`)
    .join('；');
  const totals = withTotals
    ? `共排 ${fmtMinutes(week.plannedMin)}、${planned.reduce((acc, d) => acc + d.blocks.length, 0)} 个任务块，已完成 ${week.doneCount} 个：`
    : '每天：';
  return `本周 ${week.weekStart} ~ ${week.weekEnd} ${totals}${detail}。`;
}

/** 周报：达成率与时长 */
function reportLine(report) {
  if (!report) return '';
  if (report.hasData === false) return '这一周还没有执行记录，先完成一两个任务再来看达成率。';
  // 占比 0 的原因不算偏差：全列出来会变成「计划容量 0%、执行中断 0%…」，像在念表格
  const causes = (report.causes ?? [])
    .filter((c) => Number(c?.share) > 0)
    .map((c) => `${c.label} ${percent(c.share)}`)
    .join('、');
  return `本周计划 ${report.plannedCount} 个、完成 ${report.doneCount} 个、跳过 ${report.skippedCount} 个，达成率 ${percent(report.achievement)}；计划 ${fmtMinutes(report.plannedMin)}，有效 ${fmtMinutes(report.effectiveMin)}；主要偏差原因：${causes || '暂无明显偏差'}。`;
}

/** 每周可用时间 */
function settingsLine(settings) {
  if (!settings) return '';
  const weekdays = Array.isArray(settings.weekdays) ? settings.weekdays : [];
  if (weekdays.length === 0) return '';
  const detail = weekdays
    .map((minutes, index) => `${WEEKDAY[index]} ${fmtMinutes(minutes)}`)
    .join('、');
  return `每周可用 ${fmtMinutes(settings.weeklyTotal ?? 0)}：${detail}。`;
}

/**
 * 把工具事实拼成一段可直接下发的正文。
 *
 * @param {object|null|undefined} facts `buildFacts()` 的返回
 * @returns {string} 没有任何可讲的事实时返回空串，交给上层用降级文案
 */
export function summarizeFacts(facts) {
  const tools = facts?.tools ?? {};
  const hasReport = Boolean(tools.get_report && tools.get_report.hasData !== false);
  const lines = [
    goalLine(tools.get_goal),
    todayLine(tools.get_today),
    weekLine(tools.get_week, !hasReport),
    reportLine(tools.get_report),
    settingsLine(tools.get_settings),
  ].filter(Boolean);

  if (lines.length === 0) return '';
  // 工具最多三个，全讲出来也就三四行；再多会盖住用户真正问的那一句
  return lines.slice(0, 4).join('\n');
}
