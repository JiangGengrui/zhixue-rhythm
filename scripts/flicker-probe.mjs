/**
 * 闪烁定位探针：连续抓帧 → 逐像素差分，找出持续变化的区域（用于定位卡片边缘闪烁）。
 * 用法：node scripts/flicker-probe.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP = 9334;
const URL = process.argv[2] ?? 'http://127.0.0.1:8790/';
const OUT = 'artifacts/flicker';
const FRAMES = Number(process.env.FRAMES ?? 8);
const GAP = Number(process.env.GAP ?? 140);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'zx-flicker-'));
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
    /* 还没起来 */
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
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
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

// 滚到特性卡区域（等布局稳定后再定位，避免字体/脚本撑开页面导致偏移）
await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector('.feature-card');
    if (!el) return 'no-card';
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 140));
    return String(top);
  })()`,
  returnByValue: true,
});
await sleep(900);
const pos = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = document.querySelector('.feature-card');
    if (!el) return 'no-card';
    const r = el.getBoundingClientRect();
    return JSON.stringify({ scrollY: Math.round(window.scrollY), top: Math.round(r.top), bottom: Math.round(r.bottom) });
  })()`,
  returnByValue: true,
});
console.log('滚动位置:', pos.result.value);

mkdirSync(OUT, { recursive: true });

const shots = [];
for (let i = 0; i < FRAMES; i++) {
  await sleep(GAP);
  const res = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(res.data, 'base64');
  shots.push(buf);
  writeFileSync(join(OUT, `frame-${i}.png`), buf);
}
console.log(`已抓 ${shots.length} 帧 → ${OUT}`);

const info = await send('Runtime.evaluate', {
  expression: `(() => {
    const cards = [...document.querySelectorAll('.feature-card')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return JSON.stringify({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight, cards });
  })()`,
  returnByValue: true,
});
console.log('布局:', info.result.value);

const dpr = await send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ dpr: dpr.result.value, frames: FRAMES, gap: GAP }));

await fetch(`http://127.0.0.1:${CDP}/json/close/${(await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json())).find((t) => t.type === 'page').id}`).catch(() => {});
chrome.kill();
ws.close();
process.exit(0);
