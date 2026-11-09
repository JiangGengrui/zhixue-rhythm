/**
 * 换词动画探针：按固定间隔抓帧，只裁出标语关键词那一小块，输出亮度序列。
 * 若过渡生效，亮度会呈现「渐暗 → 落到低点 → 渐亮」的过程，而不是一帧内跳变。
 * 用法：node scripts/morph-probe.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP = 9335;
const URL = process.argv[2] ?? 'http://127.0.0.1:8790/';
const OUT = 'artifacts/morph';
const GAP = Number(process.env.GAP ?? 100);
const FRAMES = Number(process.env.FRAMES ?? 42);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'zx-morph-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(300);
  try {
    const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
  } catch {
    /* 等 Chrome */
  }
}
if (!wsUrl) {
  console.error('Chrome 未能启动');
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) {
      reject(new Error(JSON.stringify(msg.error)));
    } else {
      resolve(msg.result);
    }
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL });
await sleep(2500);

const box = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.getElementById('morph-word');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(document.getElementById('morph-word-text'));
    return JSON.stringify({
      x: Math.floor(r.x) - 6, y: Math.floor(r.y) - 6,
      w: Math.ceil(r.width) + 12, h: Math.ceil(r.height) + 12,
      bgImage: cs.backgroundImage.slice(0, 60),
      dpr: devicePixelRatio,
    });
  })()`,
  returnByValue: true,
});
const info = JSON.parse(box.result.value);
console.log('词框:', info.x, info.y, info.w, info.h, '| 渐变在动画层:', info.bgImage.includes('gradient'));

mkdirSync(OUT, { recursive: true });
const frames = [];
for (let i = 0; i < FRAMES; i++) {
  await sleep(GAP);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: info.x, y: info.y, width: info.w, height: info.h, scale: 2 },
  });
  const buf = Buffer.from(shot.data, 'base64');
  writeFileSync(join(OUT, `m-${String(i).padStart(2, '0')}.png`), buf);
  // 顺便记下当前词与 class 状态
  const st = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.getElementById('morph-word-text');
      return JSON.stringify({ t: el.textContent, c: el.className, o: getComputedStyle(el).opacity });
    })()`,
    returnByValue: true,
  });
  frames.push({ file: `m-${String(i).padStart(2, '0')}.png`, ...JSON.parse(st.result.value) });
}
writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames, null, 2));
console.log(`已抓 ${frames.length} 帧 → ${OUT}`);

chrome.kill();
ws.close();
process.exit(0);
