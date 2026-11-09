import type { AssistantMode } from './useAssistant';

export interface Suggestion {
  mode: AssistantMode;
  text: string;
}

/** 反馈只有三种取值：评、取消；'down' 再带一个原因 */
export type FeedbackValue = 'up' | 'down' | null;
export type FeedbackReason = 'wrong' | 'unclear' | 'not_wanted';

export interface ReasonOption {
  value: FeedbackReason;
  label: string;
}

/**
 * 「没用」的三种原因，与服务端白名单一一对应（`server/api.mjs` 的 `FEEDBACK_REASONS`）。
 * 两端各自定义是因为 `src/` 与 `server/` 没有共享模块；多一个值会被服务端 400 拒掉，
 * 由 `suggestions.test.ts` 的条数断言 + `api.test.mjs` 的非法原因用例一起守住。
 */
export const FEEDBACK_REASONS: ReasonOption[] = [
  { value: 'wrong', label: '答错了' },
  { value: 'unclear', label: '没看懂' },
  { value: 'not_wanted', label: '不是我想要的' },
];

/**
 * 空态建议问题：2 个功能类 + 2 个数据类（SPEC R8），按「有没有自己的数据」切换。
 * 还没有目标/计划时再问「这周还剩多少」只会得到「先建目标」，所以换成引导式问法。
 */
export function suggestionsFor(hasData: boolean): Suggestion[] {
  if (!hasData) {
    return [
      { mode: 'knowledge', text: '怎么设置目标和截止日？' },
      { mode: 'knowledge', text: '周计划是怎么排出来的？' },
      // 这两句都含数据指代词（「我的目标」「今天任务」），才会真的走数据类分支；
      // 无目标时工具返回空，助手据此引导先建目标，而不是答一堆通用建议
      { mode: 'data', text: '今天任务从哪开始？' },
      { mode: 'data', text: '我的目标还能达成吗？' },
    ];
  }
  return [
    { mode: 'knowledge', text: '周计划是怎么排出来的？' },
    { mode: 'knowledge', text: '怎么调整每周可用时间？' },
    { mode: 'data', text: '这周还剩多少任务？' },
    { mode: 'data', text: '今天的安排还剩多少？' },
  ];
}

/** PATCH 请求体：取消时只发 `{ value: null }`，避免 reason 跟着一起去掉整条反馈 */
export function feedbackPayload(value: FeedbackValue, reason?: FeedbackReason) {
  if (value === null) return { value: null };
  if (value === 'down' && reason) return { value, reason };
  return { value };
}
