import { KNOWLEDGE } from './knowledge.mjs';

const PUNCT = /[\s，。？！、；：“”‘’（）《》【】,.?!;:'"()[\]<>~`·…—\-_/\\|+*=@#$%^&]+/g;

/** 归一化：去掉标点与空白，统一小写，中英文混排也能对齐 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(PUNCT, '');
}

/** 中文没有空格分词，用二元组近似，够用于几十条语料的召回 */
export function bigrams(text) {
  const s = normalize(text);
  const set = new Set();
  if (s.length === 1) set.add(s);
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function overlap(a, b) {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
}

function scoreEntry(q, qBigrams, entry) {
  let score = 0;

  // 关键词命中权重最高：key 越长越具体
  for (const key of entry.keys) {
    const k = normalize(key);
    if (k && q.includes(k)) score += 6 + Math.min(k.length, 8) * 0.5;
  }

  // 标题相似度兜底，处理「换个说法」的提问
  score += Math.min(overlap(qBigrams, bigrams(entry.title)) * 1.5, 6);

  // 正文只做弱信号，避免无关问题被正文里的常见词带偏
  score += Math.min(overlap(qBigrams, bigrams(entry.answer)) * 0.2, 3);

  return score;
}

/**
 * 检索知识库。
 * 不依赖模型：没有 API Key、断网、模型超时时都能直接拿它作答。
 */
export function search(query, { limit = 3, minScore = 5, knowledge = KNOWLEDGE } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const qBigrams = bigrams(query);

  return knowledge
    .map((entry) => ({ entry, score: scoreEntry(q, qBigrams, entry) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({
      id: entry.id,
      title: entry.title,
      answer: entry.answer,
      doc: entry.doc,
      route: entry.route ?? null,
      score: Math.round(score * 10) / 10,
    }));
}

/** 兜底文案：与 SPEC 附录 B 逐字一致，验收用全等比对，改动等于改契约 */
export const FALLBACK_TEXT =
  '这个问题我暂时没有把握，避免编造就不猜了。可以问我：目标怎么设、计划怎么排、怎么打卡、周报怎么看、数据怎么导出。';

/** 给前端直接渲染的降级回答：带引用，不编造 */
export function answerFromKnowledge(query, options) {
  const hits = search(query, options);
  if (hits.length === 0) {
    return { mode: 'fallback', text: FALLBACK_TEXT, citations: [] };
  }
  const [top] = hits;
  return {
    mode: 'knowledge',
    text: top.answer,
    citations: hits.map((hit) => ({ title: hit.title, doc: hit.doc, route: hit.route })),
  };
}
