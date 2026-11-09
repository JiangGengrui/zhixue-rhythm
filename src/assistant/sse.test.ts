import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse';

describe('createSseParser', () => {
  it('解析单个帧：event + JSON 数据', () => {
    const parser = createSseParser();
    const frames = parser.push('event: delta\ndata: {"text":"这周还剩"}\n\n');
    expect(frames).toEqual([{ event: 'delta', data: { text: '这周还剩' } }]);
    expect(parser.pending).toBe('');
  });

  it('粘包：一次到达的两帧都要吐出，且顺序不变', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'event: status\ndata: {"text":"正在取数据"}\n\nevent: delta\ndata: {"text":"好"}\n\n',
    );
    expect(frames.map((frame) => frame.event)).toEqual(['status', 'delta']);
  });

  it('拆包：帧被切成两次到达时不吐半帧，拼完再吐', () => {
    const parser = createSseParser();
    expect(parser.push('event: delta\ndata: {"te')).toEqual([]);
    expect(parser.pending).toBe('event: delta\ndata: {"te');
    expect(parser.push('xt":"3 个"}\n\n')).toEqual([{ event: 'delta', data: { text: '3 个' } }]);
  });

  it('兼容 CRLF：\\r\\n\\r\\n 与跨块的 \\r / \\n 都能拼对', () => {
    const crlf = createSseParser();
    expect(crlf.push('event: done\r\ndata: {"incomplete":false}\r\n\r\n')).toEqual([
      { event: 'done', data: { incomplete: false } },
    ]);

    // \r 与 \n 分属两个 chunk：常见于反代按行 flush
    const split = createSseParser();
    expect(split.push('event: meta\r')).toEqual([]);
    expect(split.push('\ndata: {"mode":"data"}\n\n')).toEqual([
      { event: 'meta', data: { mode: 'data' } },
    ]);
  });

  it('忽略注释行（心跳）与没有 data 的块', () => {
    const parser = createSseParser();
    // 第一个块只有注释，第二个块有 event + data：注释不产出事件，正文照常解析
    const frames = parser.push(': keep-alive\n\nevent: delta\ndata: {"text":"a"}\n\n');
    expect(frames).toEqual([{ event: 'delta', data: { text: 'a' } }]);
  });

  it('data 多行按规范用换行拼接后再解析', () => {
    const parser = createSseParser();
    // 尾部空行只会带来空白，JSON 允许值后跟空白，所以能正常解析
    const frames = parser.push('event: delta\ndata: {"text":"第一行"}\ndata: \n\n');
    expect(frames).toEqual([{ event: 'delta', data: { text: '第一行' } }]);
  });

  it('非法 JSON 不抛错，原样保留便于排障', () => {
    const parser = createSseParser();
    const frames = parser.push('event: delta\ndata: <html>502</html>\n\n');
    expect(frames).toEqual([{ event: 'delta', data: '<html>502</html>' }]);
  });

  it('JSON 转义序列被切成两半时也能拼回（emoji 不丢）', () => {
    const parser = createSseParser();
    const payload = 'event: delta\ndata: {"text":"专注\\ud83d\\ude80"}\n\n';
    const cut = payload.indexOf('\\ud83d') + 2;
    expect(parser.push(payload.slice(0, cut))).toEqual([]);
    expect(parser.push(payload.slice(cut))).toEqual([{ event: 'delta', data: { text: '专注🚀' } }]);
  });
});
