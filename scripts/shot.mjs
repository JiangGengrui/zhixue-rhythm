/**
 * 通用截图工具：导航 → 可选执行一段脚本 → 截图（可整页）。
 * 用法：node scripts/shot.mjs <url> <输出文件> [--light] [--full] [--width=1280] [--height=900]
 *   --light 会在同源下写入 localStorage 切浅色主题后刷新
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP = 9336;
const [url, out] = process.argv.slice(2);
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const width = Number(flags.find((f) => f.startsWith('--width='))?.split('=')[1] ?? 1280);
const height = Number(flags.find((f) => f.startsWith('--height='))?.split('=')[1] ?? 900);
const light = flags.includes('--light');
const full = flags.includes('--full');

if (!url || !out) {
  console.error('用法：node scripts/shot.mjs <url> <输出文件> [--light] [--full]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'zx-shot-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
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
const errors = [];
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
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.text ?? 'exception');
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await sleep(2600);

if (light) {
  await send('Runtime.evaluate', { expression: `localStorage.setItem('zhixue-theme','light'); location.reload();` });
  await sleep(2400);
}

const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
writeFileSync(out, Buffer.from(res.data, 'base64'));
console.log(`已保存 ${out}${errors.length ? ` | 控制台错误 ${errors.length}: ${errors.slice(0, 3).join(' | ')}` : ' | 控制台无错误'}`);

chrome.kill();
ws.close();
process.exit(0);
