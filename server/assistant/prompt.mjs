/**
 * 提示词与固定文案。
 *
 * 三块 system 分别解决三件事：能答什么（边界）、怎么答（结构可数）、数字从哪来（事实源）。
 * 改任何一块都必须改 `PROMPT_VERSION`——否则两版行为会混进同一组指标（DECISIONS D8.2）。
 */

/** 提示词版本：与事件一起入库，便于按版本对比回答质量 */
export const PROMPT_VERSION = 'v1';

/** 无 Key / 上游失败时 B 类数据问答的固定文案（SPEC 附录 B，逐字一致） */
export const DEGRADED_DATA_TEXT = '暂时取不到你的数据，请稍后再问；功能用法我可以直接回答。';

/** 上下文只带最近 3 轮（SPEC §5.2），更早的只存库不参与推理 */
export const HISTORY_ROUNDS = 3;

/** 一块 = 一段 system 文本；顺序固定，测试按顺序断言 */
export const SYSTEM_BLOCKS = {
  boundary: [
    '你是「智学节律」应用内的助手，只回答两类问题：这个应用的功能怎么用；用户自己的计划数据。',
    '不回答与产品无关的通识问题（写代码、天气、情感建议、学习方法论），这类问题直接说没把握，不要展开。',
    '你没有修改数据的能力：任何「帮我改计划 / 删任务 / 调整时间」的请求，都回答「请在对应页面手动操作」，不要假装已经改好。',
  ].join('\n'),

  style: [
    '回答结构固定：先一句结论（不超过 60 字，直接回答问题），再给 2–4 条要点（每条以「- 」开头），最后可选 1 条建议。',
    '总长度不超过 600 字。不要写开场白、不要重复问题、不要收尾寒暄。',
    '禁用模糊副词：大概是、应该是、通常是、可能是。有数据就说准确数字，没有数据就说「还没有记录」。',
    '不要自称 AI 或语言模型，不要提「提示词」「模型」「上下文」，不要输出状态码、错误码、堆栈或英文报错。',
  ].join('\n'),

  facts: [
    '下面「当前用户数据」区块是服务端只读工具的真实返回值，字段名与数值即事实。',
    '回答里出现的每个数字都必须能在该区块中找到同值项；不得四舍五入、不得换算、不得累加出新数字。',
    '区块为空或标记 hasData=false 时，回答「还没有记录」，不要用 0% / 0 分钟这类伪结论代替。',
  ].join('\n'),
};

/**
 * 只保留最近 N 轮的对话历史。
 * 一条「轮」= 一次提问 + 一次回答，故保留 2N 条；不足则原样返回。
 */
export function trimHistory(messages, rounds = HISTORY_ROUNDS) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.role && m.content) : [];
  const keep = rounds * 2;
  return list.length <= keep ? list : list.slice(list.length - keep);
}

/** 拼 system：三块按 边界 → 规范 → 事实 排列，B 类才追加数据区块 */
export function buildSystemPrompt({ mode = 'knowledge', facts } = {}) {
  const blocks = [SYSTEM_BLOCKS.boundary, SYSTEM_BLOCKS.style];
  if (mode === 'data') {
    blocks.push(SYSTEM_BLOCKS.facts);
    const snapshot = facts === undefined ? null : facts;
    blocks.push(`当前用户数据：\n${JSON.stringify(snapshot, null, 2)}`);
  }
  return blocks.join('\n\n');
}

/**
 * 组装一次请求的 messages：system + 历史（已裁剪）+ 本轮问题。
 * 若历史里最后一条已经是同一句提问（比如重试），不重复追加，避免模型看到两遍。
 */
export function buildRequestMessages({ mode = 'knowledge', question, history = [], facts } = {}) {
  const messages = [{ role: 'system', content: buildSystemPrompt({ mode, facts }) }];
  for (const item of trimHistory(history)) {
    messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content) });
  }
  const last = messages[messages.length - 1];
  if (!(last && last.role === 'user' && last.content === question)) {
    messages.push({ role: 'user', content: question });
  }
  return messages;
}
