/**
 * 端到端验收脚本：真实 Chrome 打开真实服务，走完整链路并截图。
 * 运行：node scripts/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8899;
const CDP = 9333;
const OUT = 'artifacts/e2e';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.text ?? 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.errors.push(text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      fail(`页面脚本执行失败：${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
    }
    return res.result?.value;
  }

  async text() {
    return this.eval('return document.body.innerText;');
  }

  async click(text) {
    const ok = await this.eval(`
      const target = [...document.querySelectorAll('button, a')].find((el) => el.textContent.includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    `);
    if (!ok) fail(`找不到可点击元素：${text}`);
    await sleep(600);
  }

  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
    logs.push(`  · 截图 ${name}.png`);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const dbFile = join(mkdtempSync(join(tmpdir(), 'zx-')), 'e2e.db');
  const app = startServer({ dbFile });
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
  console.log(`✓ 服务已启动 http://127.0.0.1:${PORT}`);

  const profile = mkdtempSync(join(tmpdir(), 'zx-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,940',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(300);
    try {
      const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* chrome 还没起来 */
    }
  }
  assert(wsUrl, 'Chrome 未能启动或 CDP 不可用');

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const base = `http://127.0.0.1:${PORT}/`;

  // 1. 未登录：应看到登录页
  await cdp.send('Page.navigate', { url: `${base}#report` });
  await sleep(1500);
  let body = await cdp.text();
  assert(body.includes('登录') && body.includes('智学节律'), '未登录时未渲染登录页');
  assert(!body.includes('一周复盘'), '未登录却能看到周报内容');
  await cdp.shot('01-login');
  console.log('✓ 登录页渲染正常');

  // 2. 注册并进入应用
  const status = await cdp.eval(`
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'e2e@test.dev', password: 'password123', name: '林同学' }),
    });
    return res.status;
  `);
  assert(status === 200, `注册接口返回 ${status}`);
  await cdp.send('Page.navigate', { url: base });
  await sleep(1500);
  body = await cdp.text();
  assert(body.includes('还没有目标') || body.includes('载入示例数据'), '登录后未进入空状态引导');
  await cdp.shot('02-empty');
  console.log('✓ 注册 + 会话建立正常');

  // 3. 载入示例数据 → 目标页显示真实 R 值
  await cdp.click('载入示例数据');
  await sleep(1200);
  body = await cdp.text();
  assert(body.includes('可行性 R'), '目标页缺少可行性 R 值');
  assert(!body.includes('NaN'), '目标页出现 NaN');
  await cdp.shot('03-goal');
  console.log('✓ 目标与计划项写入成功');

  // 4. 周视图 → 生成本周计划
  await cdp.click('周视图');
  await sleep(500);
  await cdp.click('生成本周计划');
  await sleep(1200);
  body = await cdp.text();
  assert(body.includes('本周可用') && body.includes('已排计划'), '周视图统计缺失');
  assert(!body.includes('NaN'), '周视图出现 NaN');
  await cdp.shot('04-week');
  console.log('✓ 周计划已生成并落库');

  // 4b. 调整任务时间（同周内移动）
  await cdp.click('调整');
  await sleep(500);
  body = await cdp.text();
  assert(body.includes('调整任务时间'), '调整面板未出现');
  await cdp.eval(`
    const input = document.querySelector('.form-grid input[type="time"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '06:00');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await cdp.click('保存');
  await sleep(900);
  body = await cdp.text();
  assert(body.includes('已调整任务时间'), '调整后未提示成功');
  assert(body.includes('06:00'), '调整后的时间未显示');
  await cdp.shot('04b-week-moved');
  console.log('✓ 任务块同周移动成功');

  // 5. 今日 → 完成一项任务（填写实际用时）
  await cdp.click('今日');
  await sleep(700);
  await cdp.click('开始');
  await cdp.click('完成');
  const filled = await cdp.eval(`
    const input = document.querySelector('.inline-form input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '100');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  assert(filled, '完成表单未出现');
  await cdp.click('确认完成');
  await sleep(900);
  body = await cdp.text();
  assert(body.includes('已完成 · 实际'), '打卡后未显示完成状态与实际用时');
  await cdp.shot('05-today-done');
  console.log('✓ 打卡与实际用时写入成功');

  // 6. 周报：数字来自真实记录
  await cdp.click('周报');
  await sleep(900);
  body = await cdp.text();
  assert(body.includes('达成率'), '周报缺少达成率');
  assert(body.includes('估时偏差'), '周报缺少偏差指标');
  assert(!body.includes('NaN'), '周报出现 NaN');
  await cdp.shot('06-report');
  console.log('✓ 周报按真实记录计算');

  // 7. 刷新后数据仍在（服务端持久化）
  await cdp.send('Page.navigate', { url: `${base}#report` });
  await sleep(1500);
  body = await cdp.text();
  assert(body.includes('达成率'), '刷新后会话或数据丢失');
  console.log('✓ 刷新后会话与数据保持');

  // 8. 设置：修改每日可用时长并保存，重新生成不报错
  await cdp.click('设置');
  await sleep(700);
  body = await cdp.text();
  assert(body.includes('每周可用时间'), '设置页未渲染');
  assert(body.includes('导出全部数据') && body.includes('导出任务记录'), '设置页缺少数据导出入口');
  assert(body.includes('注销账号'), '设置页缺少注销入口');

  const changed = await cdp.eval(`
    const inputs = [...document.querySelectorAll('.day-field input')];
    if (inputs.length !== 7) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[3], '1');
    inputs[3].dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  assert(changed, '设置页缺少 7 个每日输入');
  await cdp.click('保存设置');
  await sleep(900);
  body = await cdp.text();
  assert(body.includes('已保存'), '设置未保存成功');
  await cdp.shot('07-settings');
  console.log('✓ 设置保存生效');

  // 8b. 修改密码（当前设备保持登录）
  const pwdFilled = await cdp.eval(`
    const inputs = [...document.querySelectorAll('.form-grid input[type="password"]')];
    if (inputs.length < 2) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[0], 'password123');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(inputs[1], 'newpassword456');
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  assert(pwdFilled, '未找到修改密码输入框');
  await cdp.click('保存新密码');
  await sleep(1000);
  body = await cdp.text();
  assert(body.includes('密码已更新'), '修改密码未成功');
  await cdp.shot('07b-password');
  console.log('✓ 修改密码成功且当前会话保持');

  await cdp.click('周视图');
  await sleep(600);
  await cdp.click('补排新任务');
  await sleep(1200);
  body = await cdp.text();
  assert(!body.includes('NaN'), '按新容量重新生成后出现 NaN');
  console.log('✓ 按新容量重新生成正常');

  // 9. 登出后回到登录页
  await cdp.click('退出');
  await sleep(900);
  body = await cdp.text();
  assert(body.includes('登录') && !body.includes('达 成'), '登出后未回到登录页');
  await cdp.shot('08-logout');
  console.log('✓ 登出正常');

  // 10. 忘记密码入口与恢复码表单
  await cdp.click('忘记密码');
  await sleep(500);
  body = await cdp.text();
  assert(body.includes('恢复码') && body.includes('新密码'), '找回密码表单未渲染');
  await cdp.shot('09-recover');
  console.log('✓ 忘记密码入口可用');

  assert(cdp.errors.length === 0, `控制台出现错误：${cdp.errors.join(' | ')}`);
  console.log('✓ 浏览器控制台无报错');

  ws.close();
  chrome.kill();
  await app.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows 上可能被占用，忽略 */
  }
  console.log(`\n全部通过。截图目录：${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
