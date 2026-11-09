/**
 * 故障注入：只服务验收与排障，**生产环境强制关闭**。
 *
 * 为什么需要它：SPEC R5 要求「无 Key / 上游 5xx / 超时」三种场景下行为一致，
 * 但真实上游不可控——本地没 Key、上游也不会配合返回 500。用一个环境变量把
 * 三条路径变成可重复的测试，比手工断网可靠。
 *
 * 开关：`ASSISTANT_FAULT=nokey|upstream500|timeout`
 * - 只有 `NODE_ENV !== 'production'` 才生效，生产环境读到了也只打一行警告；
 * - 注入 500 / 超时时会同时塞一个假 Key 与假 fetch，既不联网也不会读真实凭据。
 */
import { llmConfig } from './llm.mjs';

export const FAULT_KINDS = ['nokey', 'upstream500', 'timeout'];

/** 超时注入用的总时长：比真实 20s 短得多，测试不必干等 */
export const FAULT_TIMEOUT_MS = 50;

let warnedInProduction = false;

/** 读取并校验开关，返回 `null` 表示不注入 */
export function resolveFault(env = process.env) {
  const raw = String(env.ASSISTANT_FAULT ?? '').trim();
  if (!raw || !FAULT_KINDS.includes(raw)) return null;
  if (env.NODE_ENV === 'production') {
    if (!warnedInProduction) {
      warnedInProduction = true;
      console.warn(`[assistant] 生产环境忽略 ASSISTANT_FAULT=${raw}`);
    }
    return null;
  }
  return raw;
}

/** 返回一个永远返回 5xx 的 fetch：不联网，也不读上游正文 */
function failingFetch(status) {
  return async () => ({ ok: false, status, body: null });
}

/** 返回一个永不 resolve 的 fetch：等 AbortSignal 触发后按取消收尾 */
function hangingFetch() {
  return (url, init) =>
    new Promise((resolve, reject) => {
      if (init?.signal) {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }
    });
}

/**
 * 把故障翻译成 `streamModelReply` 的入参覆盖项。
 * - `nokey`：清空 Key，走「未配置」分支；
 * - `upstream500`：给假 Key + 假 fetch，强制进入模型调用再失败；
 * - `timeout`：假 Key + 永不返回的 fetch + 极短超时。
 */
export function applyFault(kind, env = process.env) {
  if (!kind) return {};
  const config = llmConfig(env);
  if (kind === 'nokey') return { config: { ...config, apiKey: '' } };
  if (kind === 'upstream500') {
    return { config: { ...config, apiKey: 'fault-injected-key' }, fetchImpl: failingFetch(500) };
  }
  if (kind === 'timeout') {
    return {
      config: { ...config, apiKey: 'fault-injected-key', timeoutMs: FAULT_TIMEOUT_MS },
      fetchImpl: hangingFetch(),
    };
  }
  return {};
}
