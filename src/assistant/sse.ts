/**
 * SSE 增量解析：把 `fetch` 的字节流切成 `{ event, data }` 帧。
 *
 * 为什么不直接用 `EventSource`：本项目要先 POST 提问体、还要能 `AbortController`
 * 取消，`EventSource` 只支持 GET 且不能带请求体。于是自己读 `ReadableStream`。
 *
 * 两个容易出错的地方，这里都单独处理：
 * 1. **跨块拆包**：一个帧可能被网络切成两次到达，残包必须留在 buffer 里等下一块；
 * 2. **换行差异**：服务端发 `\n\n`，但反代可能改写成 `\r\n\r\n`，统一归一化后再找分隔。
 */

export interface SseFrame {
  /** 帧名，本项目只发 meta / status / delta / done */
  event: string;
  /** 解析后的 JSON；不是合法 JSON 时原样给字符串，由调用方决定忽略还是展示 */
  data: unknown;
}

export interface SseParser {
  /** 喂一段文本，返回这段里已经完整的帧 */
  push(chunk: string): SseFrame[];
  /** 还没收完的残包，便于排障与测试断言 */
  readonly pending: string;
}

/**
 * 解析单个帧块。
 *
 * `data:` 允许出现多行（SSE 规范用换行拼接），注释行（`:` 开头，常见于心跳）
 * 直接跳过；没有 `data` 的块视为无效帧，不产生事件。
 */
function parseBlock(block: string): SseFrame | null {
  const lines = block.split('\n');
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // 规范允许冒号后跟一个空格，去掉它但不吃掉正文里真正的空格
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) as unknown };
  } catch {
    // 上游若发来非 JSON，宁可让调用方看到原文，也不要在这里抛错中断整条流
    return { event, data: raw };
  }
}

export function createSseParser(): SseParser {
  let buffer = '';

  return {
    push(chunk: string) {
      // 每次都归一化整段缓冲：`\r` 与 `\n` 分属两个 chunk 时也能在下一块到达后拼对
      buffer = `${buffer}${chunk}`.replace(/\r\n/g, '\n');
      const frames: SseFrame[] = [];

      for (;;) {
        const index = buffer.indexOf('\n\n');
        if (index < 0) break;
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseBlock(block);
        if (frame) frames.push(frame);
      }

      return frames;
    },
    get pending() {
      return buffer;
    },
  };
}
