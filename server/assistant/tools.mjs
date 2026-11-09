/**
 * B 类数据问答的只读工具（SPEC R3）。
 *
 * 设计要点：
 * - **白名单**：只有这 5 个函数，模型既不能写 SQL 也不能挑表（SPEC §5.4「禁自由 SQL」）。
 * - **只读**：全部从内存里的 `state` 派生，不碰写库路径，天然没有改错数据的风险。
 * - **可核对**：返回值就是给模型看的 JSON，测试可以逐个数字回到 `/api/state` 比对。
 * - **会失败**：每个工具都有 3s 超时与异常兜底，失败返回 `status:'fail'` 而不是抛出，
 *   由上层决定降级为 `DEGRADED_DATA_TEXT`（SPEC §9「工具超时/异常」）。
 */
import { buildReport, feasibility } from '../engine.generated.mjs';

/** 白名单：顺序即前端展示顺序 */
export const TOOL_NAMES = ['get_goal', 'get_week', 'get_today', 'get_report', 'get_settings'];

/** 单次工具调用上限（SPEC R3：单次超时 3s） */
export const TOOL_TIMEOUT_MS = 3000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 按「周起始日」把某天归到所属周的起始日（0=周日、1=周一，与 settings.weekStart 一致） */
export function weekStartFor(dateISO, weekStartsOn = 1) {
  const date = new Date(`${dateISO}T00:00:00Z`);
  const diff = (date.getUTCDay() - weekStartsOn + 7) % 7;
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

const round = (n, digits = 2) => {
  const base = 10 ** digits;
  return Math.round(n * base) / base;
};

const sum = (list, pick) => list.reduce((acc, item) => acc + pick(item), 0);

const blockMinutes = (block) => Math.max(0, (block.endMin ?? 0) - (block.startMin ?? 0));

/** 给 Promise.race 用的超时包装：超时拒绝，正常清定时器 */
export async function runWithTimeout(fn, timeoutMs = TOOL_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('工具执行超时')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把多个工具结果合成注入 prompt 的 `facts`。
 *
 * - 一个都没成功：返回 `null`，上层据此**不调模型**（没有事实就不许开口）；
 * - 部分失败：把失败工具名留在 `failedTools` 里，让模型知道「这部分没取到」，
 *   而不是把缺项当成 0 说出去。
 */
export function buildFacts(results) {
  const ok = (results ?? []).filter((item) => item && item.status === 'ok');
  if (ok.length === 0) return null;

  const facts = { hasData: false, tools: {} };
  for (const item of ok) {
    facts.tools[item.name] = item.data;
    if (item.data && item.data.hasData !== false) facts.hasData = true;
  }
  const failedTools = (results ?? [])
    .filter((item) => item && item.status !== 'ok')
    .map((item) => item.name);
  if (failedTools.length > 0) facts.failedTools = failedTools;
  return facts;
}

/**
 * 用一份 `state`（等价于 `GET /api/state` 的返回）造工具箱。
 * `today` 可注入，测试不必依赖真实时钟。
 */
export function createToolbox({ state, today, weekStart }) {
  const goal = state?.goal ?? null;
  const items = Array.isArray(state?.items) ? state.items : [];
  const blocks = Array.isArray(state?.blocks) ? state.blocks : [];
  const settings = state?.settings ?? { weekStart: 1, weekdays: [0, 0, 0, 0, 0, 0, 0] };
  const todayDate = today ?? new Date().toISOString().slice(0, 10);
  // 默认取「今天所在的周」，而不是从今天起算 7 天：后者会把跨周的两截拼成一周
  const weekStartDate = weekStart ?? weekStartFor(todayDate, settings.weekStart ?? 1);

  const titleOf = (itemId) => items.find((item) => item.id === itemId)?.title ?? '任务';
  const estimateOf = (itemId) => items.find((item) => item.id === itemId)?.estimateMin ?? null;
  const tasksOf = (list) =>
    list
      .filter((block) => !block.isBuffer)
      .map((block) => ({
        title: titleOf(block.itemId),
        status: block.status,
        startMin: block.startMin,
        endMin: block.endMin,
        estimateMin: estimateOf(block.itemId),
        actualMin: block.actualMin ?? null,
      }));

  const tools = {
    /** 目标 + 可行性 R 值；没建目标时给 null，让模型说「先建目标」而不是猜 */
    get_goal() {
      if (!goal) return { hasData: false, goal: null };
      const result = feasibility(goal, items, todayDate);
      return {
        hasData: true,
        goal: {
          title: goal.title,
          deadline: goal.deadline,
          weeklyMinutes: goal.weeklyMinutes,
          level: goal.level,
        },
        feasibility: {
          demandMin: result.demandMin,
          availableMin: result.availableMin,
          weeksLeft: result.weeksLeft,
          // 截止日已过时 ratio 是 Infinity，JSON 里会变成 null，显式转掉免得上游收到怪值
          ratio: Number.isFinite(result.ratio) ? round(result.ratio) : null,
          verdict: result.verdict,
        },
      };
    },

    /** 按天聚合一周：只统计任务块，缓冲块单独给出，避免把余量算成任务 */
    get_week({ weekStart } = {}) {
      const start = typeof weekStart === 'string' && DATE_RE.test(weekStart) ? weekStart : weekStartDate;
      const end = new Date(`${start}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      const endDate = end.toISOString().slice(0, 10);

      const inWeek = blocks.filter((block) => block.date >= start && block.date <= endDate);
      const days = [];
      for (let i = 0; i < 7; i += 1) {
        const cursor = new Date(`${start}T00:00:00Z`);
        cursor.setUTCDate(cursor.getUTCDate() + i);
        const date = cursor.toISOString().slice(0, 10);
        const dayBlocks = inWeek.filter((block) => block.date === date);
        const tasks = dayBlocks.filter((block) => !block.isBuffer);
        days.push({
          date,
          totalMin: sum(tasks, blockMinutes),
          bufferMin: sum(dayBlocks.filter((block) => block.isBuffer), blockMinutes),
          doneCount: tasks.filter((block) => block.status === 'done').length,
          blocks: tasksOf(dayBlocks),
        });
      }

      return {
        hasData: inWeek.length > 0,
        weekStart: start,
        weekEnd: endDate,
        plannedMin: sum(days, (day) => day.totalMin),
        doneCount: sum(days, (day) => day.doneCount),
        days,
      };
    },

    /** 当天：前端传本地日期，服务端只校验格式、不做时区换算（SPEC R3） */
    get_today({ date } = {}) {
      const day = typeof date === 'string' && DATE_RE.test(date) ? date : todayDate;
      const dayBlocks = blocks.filter((block) => block.date === day);
      const tasks = dayBlocks.filter((block) => !block.isBuffer);
      return {
        hasData: tasks.length > 0,
        date: day,
        totalMin: sum(tasks, blockMinutes),
        doneCount: tasks.filter((block) => block.status === 'done').length,
        // 已完成块用 actualMin（计时器结算过的准数），进行中的块才用 accumulatedSec：
        // 两者混用会出现「已完成 120 分钟，累计 0 分钟」这种自相矛盾的结论
        accumulatedMin: round(
          sum(tasks, (block) => (
            typeof block.actualMin === 'number'
              ? block.actualMin
              : (block.accumulatedSec ?? 0) / 60
          )),
          1,
        ),
        blocks: tasksOf(dayBlocks),
      };
    },

    /** 周报：直接复用引擎的 buildReport，保证与 `GET /api/report` 完全同源 */
    get_report({ weekStart } = {}) {
      const start = typeof weekStart === 'string' && DATE_RE.test(weekStart) ? weekStart : weekStartDate;
      const end = new Date(`${start}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      const endDate = end.toISOString().slice(0, 10);
      const inWeek = blocks.filter((block) => block.date >= start && block.date <= endDate);
      return buildReport(inWeek, settings, start);
    },

    /** 每周可用分钟：7 个数字，只读 */
    get_settings() {
      const weekdays = Array.isArray(settings.weekdays) ? settings.weekdays : [];
      return {
        hasData: weekdays.some((minutes) => minutes > 0),
        weekStart: settings.weekStart ?? 1,
        weekdays,
        weeklyTotal: sum(weekdays, (minutes) => Math.max(0, minutes)),
      };
    },
  };

  return {
    names: TOOL_NAMES,
    /**
     * 调用一个工具，永不抛错：失败也返回结构化结果，交给上层决定降级文案。
     * `timeoutMs` 可注入，测试用它验证超时分支。
     */
    async call(name, args = {}, { timeoutMs = TOOL_TIMEOUT_MS } = {}) {
      const fn = tools[name];
      if (!fn) return { name, status: 'fail', error: '未知工具' };
      try {
        const data = await runWithTimeout(() => fn(args ?? {}), timeoutMs);
        return { name, status: 'ok', data };
      } catch (err) {
        return { name, status: 'fail', error: err instanceof Error ? err.message : '工具执行失败' };
      }
    },
  };
}
