/**
 * 生成 README 展示图：真实服务 + 真实数据（一个完整周的排程、部分打卡、一条跳过），
 * 截取今日 / 周视图 / 周报 / 智能拆解 / 产品主页。
 * 运行：node scripts/demo-shots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8897;
const CDP = 9337;
const OUT = 'docs/screenshots';
const W = 1280;
const H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const today = new Date();
const monday = addDays(today, -((today.getDay() + 6) % 7));
const weekStart = iso(monday);
const deadline = iso(addDays(today, 180));

const app = startServer({ dbFile: join(mkdtempSync(join(tmpdir(), 'zx-shots-')), 'shots.db') });
await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;
console.log(`✓ 服务已启动 ${base}（本周 ${weekStart}）`);

// ── 造数据：一个节奏正常、已有执行记录的考研备考周 ──
let cookie = '';
const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
};

await call('POST', '/api/auth/register', { email: 'demo@zhixue.dev', password: 'demo12345678', name: '林林' });
// 周日也留 3 小时，让"今日"页有内容
await call('PUT', '/api/settings', { weekStart: 1, weekdays: [180, 150, 150, 150, 150, 150, 120] });
await call('PUT', '/api/goal', {
  title: '2027 考研 · 计算机 380 分',
  deadline,
  weeklyMinutes: 900,
  level: 'once',
});

const items = [
  ['高数 · 极限与连续 40 题', 'math', 120, 5],
  ['408 · 二叉树遍历专题', 'major', 90, 5],
  ['英语 · 真题 2018 Text 2', 'english', 60, 4],
  ['线性代数 · 矩阵运算', 'math', 90, 4],
  ['408 · 图的最短路径', 'major', 120, 4],
  ['政治 · 马原第一章', 'politics', 60, 2],
  ['英语 · 长难句 5 句', 'english', 45, 3],
  ['408 · 排序算法复习', 'major', 75, 3],
  ['高数 · 中值定理证明', 'math', 100, 4],
];
for (const [title, subject, estimateMin, weight] of items) {
  await call('POST', '/api/items', { title, subject, estimateMin, weight });
}

const gen = await call('POST', '/api/plan/generate', { weekStart, from: weekStart });
console.log(`  已生成 ${gen.blocks.length} 个任务块`);

// 已过去的块：大部分完成（实际用时略高于预估），一条跳过
const now = new Date();
const past = gen.blocks
  .filter((b) => new Date(`${b.date}T00:00:00`) <= now)
  .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));

let doneCount = 0;
for (const b of past) {
  const plan = b.endMin - b.startMin;
  if (doneCount < 8) {
    await call('PATCH', `/api/blocks/${b.id}`, {
      status: 'done',
      actualMin: Math.round(plan * (doneCount === 2 ? 1.32 : 1.08)),
      opId: `seed-${b.id}`,
    });
    doneCount += 1;
  } else if (doneCount === 8) {
    await call('PATCH', `/api/blocks/${b.id}`, { status: 'skipped', skipReason: 'interrupt', opId: `seed-${b.id}` });
    doneCount += 1;
    break;
  }
}
console.log(`  已打卡 ${doneCount} 条（含 1 条跳过）`);

// 装箱是从周一起填，周日可能排不到任务；把两项待办挪到今天，让「今日」页有内容
const todayISO = iso(today);
const fresh = await call('GET', '/api/state');   // 必须读最新状态：gen.blocks 仍是刚生成时的快照
const movable = fresh.blocks
  .filter((b) => b.date !== todayISO && b.status === 'pending')
  .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));
const slots = [19 * 60, 21 * 60 + 30];
let moved = 0;
for (const b of movable) {
  if (moved >= slots.length) break;
  try {
    await call('PATCH', `/api/blocks/${b.id}`, {
      date: todayISO,
      startMin: slots[moved],
      opId: `move-${b.id}`,
    });
    moved += 1;
  } catch {
    /* 与本日已有块冲突就跳过 */
  }
}
console.log(`  已把 ${moved} 项待办挪到今天`);

// ── 浏览器 ──
const profile = mkdtempSync(join(tmpdir(), 'zx-shots-chrome-'));
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
    `--window-size=${W},${H}`,
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
if (!wsUrl) throw new Error('Chrome 未能启动');

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
    return;
  }
  // 采纳草案会弹原生 confirm，无头浏览器不处理会一直卡住
  if (msg.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
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
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const token = cookie.split('=')[1];
await send('Network.setCookie', { name: 'zx_sid', value: token, domain: '127.0.0.1', path: '/', httpOnly: true });

mkdirSync(OUT, { recursive: true });
const shot = async (name) => {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
  console.log(`  · ${OUT}/${name}.png`);
};
const go = async (hash, wait = 1800) => {
  await send('Page.navigate', { url: `${base}/${hash}` });
  await sleep(wait);
};

await go('#today', 2600);
await shot('today');

await go('#week');
await shot('week');

await go('#report');
await shot('report');

// 目标页：生成拆解草案并采纳，让页面里的 R 值与草案一致（否则两处数字对不上）
await go('#goal');
await send('Runtime.evaluate', {
  expression: `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('生成草案'))?.click();`,
});
await sleep(2400);
await send('Runtime.evaluate', {
  expression: `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('采纳这份草案'))?.click();`,
});
await sleep(2800);
await send('Runtime.evaluate', {
  expression: `(() => {
    const panel = [...document.querySelectorAll('.panel')].find((p) => p.textContent.includes('智能拆解'));
    if (!panel) return false;
    const top = panel.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 96));   // 让面板顶部留在页头下方，避免切掉半张卡片
    return true;
  })()`,
});
await sleep(900);
await shot('goal-decompose');

// 目标页主界面：检查计划项面板的空间分配
await send('Page.navigate', { url: `${base}/#goal` });
await sleep(2600);
await shot('goal');

// 应用首页（今日）
await send('Page.navigate', { url: `${base}/` });
await sleep(2600);
await shot('home');

chrome.kill();
ws.close();
await app.close();
console.log('✓ 展示图已生成');
process.exit(0);
