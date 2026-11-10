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
      // 自动确认原生 confirm，否则无头浏览器会一直等弹窗
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.ws.send(JSON.stringify({ id: ++this.id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
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
    if (!ok) {
      const labels = await this.eval(`
        return [...document.querySelectorAll('button, a')].map((el) => el.textContent.trim()).filter(Boolean).slice(0, 24).join(' | ');
      `);
      fail(`找不到可点击元素：${text}；当前可用按钮：${labels}`);
    }
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

  const origin = `http://127.0.0.1:${PORT}`;
  const base = `${origin}/`;

  /** 完成今日一项任务：旧 UI 是「开始→完成→填时长」，新 UI 待完成项直接「补录」 */
  /** 填写完成表单（用时 + 完成度默认 100）并确认 */
  const fillDoneForm = async (minutes) => {
    await cdp.eval(`
      const input = document.querySelector('.inline-form input[type="number"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${minutes}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await cdp.click('确认完成');
    await sleep(900);
  };

  /** 完成一项任务：计时流程（开始 → 暂停 → 继续 → 完成）或补录表单 */
  const completeOneTask = async (minutes = 100) => {
    const labels = await cdp.eval(`
      return [...document.querySelectorAll('button')].map((b) => b.textContent.trim());
    `);
    if (labels.includes('开始')) {
      await cdp.click('开始');
      await sleep(400);
      // 计时交互：暂停 → 已暂停 → 继续 → 执行中
      await cdp.click('暂停');
      await sleep(500);
      let body = await cdp.text();
      assert(body.includes('已暂停'), '暂停后未显示已暂停状态');
      await cdp.click('继续');
      await sleep(500);
      body = await cdp.text();
      assert(body.includes('执行中'), '继续后未恢复计时');
      console.log('✓ 计时暂停/继续正常');
      await cdp.click('完成');
      await fillDoneForm(minutes);
    } else {
      await cdp.click('补录');
      await sleep(400);
      await fillDoneForm(minutes);
    }
  };

  // 0. 根路径直接是应用主界面（提交版删掉了落地页与登录页）
  await cdp.send('Page.navigate', { url: `${origin}/` });
  await sleep(1500);
  const home = await cdp.text();
  assert(home.includes('今日'), '根路径未渲染今日页');
  assert(!home.includes('注册') && !home.includes('忘记密码'), '提交版不应再有登录/注册入口');
  await cdp.shot('00-home');
  console.log('✓ 根路径直进今日页，无需登录');

  // 1. 未登录深链也应直达应用：没有会话就用演示账号
  await cdp.send('Page.navigate', { url: `${base}#report` });
  await sleep(1500);
  let body = await cdp.text();
  assert(!body.includes('登录') && !body.includes('注册'), '不应再出现登录页');
  await cdp.shot('01-home-deeplink');
  console.log('✓ 未登录深链直达应用');

  // 2. 首次启动是空状态（演示账号在全新库里没有任何数据）
  await cdp.send('Page.navigate', { url: base });
  await sleep(1500);
  body = await cdp.text();
  assert(body.includes('还没有目标') || body.includes('载入示例数据'), '未进入空状态引导');
  await cdp.shot('02-empty');
  console.log('✓ 演示账号空状态正常');

  // 2b. 顶栏「设置目标」在每一页都可见，且能跳到目标页
  await cdp.eval(`window.confirm = () => true; return true;`);
  await cdp.click('今日');
  await sleep(500);
  body = await cdp.text();
  assert(body.includes('设置目标'), '顶栏缺少「设置目标」按钮');
  await cdp.click('设置目标');
  await sleep(700);
  body = await cdp.text();
  assert(body.includes('载入示例数据') || body.includes('还没有目标'), '「设置目标」未跳转到目标页');

  // 目标页右上角「设置目标」→ 弹窗内修改，不再把表单铺满页面
  const goalBtn = await cdp.eval(`
    const target = [...document.querySelectorAll('.page-head .head-actions button')].find((b) => b.textContent.includes('设置目标'));
    if (target) target.click();
    return !!target;
  `);
  assert(goalBtn, '目标页缺少右上角「设置目标」按钮');
  await sleep(600);
  body = await cdp.text();
  assert(body.includes('目标名称') && body.includes('每周可用（小时）'), '「设置目标」弹窗未出现');
  await cdp.shot('02b-set-goal');
  await cdp.click('取消');
  await sleep(400);
  console.log('✓ 顶栏「设置目标」每页可见且可用，目标设置改为弹窗');

  // 3. 载入示例数据 → 目标页显示真实 R 值
  await cdp.click('载入示例');
  await sleep(1200);
  body = await cdp.text();
  assert(body.includes('可行性 R'), '目标页缺少可行性 R 值');
  assert(!body.includes('NaN'), '目标页出现 NaN');
  await cdp.shot('03-goal');
  console.log('✓ 目标与计划项写入成功');



  // 3b. 智能拆解：弹窗内生成草案 → 阶段与裁断结果可见（不采纳，避免覆盖示例数据）
  const decomposeBtn = await cdp.eval(`
    const target = [...document.querySelectorAll('.page-head .head-actions button')].find((b) => b.textContent.includes('智能拆解'));
    if (target) target.click();
    return !!target;
  `);
  assert(decomposeBtn, '目标页缺少「智能拆解」按钮');
  await sleep(600);
  await cdp.click('生成草案');
  await sleep(1500);
  body = await cdp.text();
  assert(body.includes('基础') && body.includes('强化') && body.includes('冲刺'), '拆解草案缺少三阶段');
  assert(body.includes('采纳这份草案'), '拆解草案缺少采纳入口');
  assert(!body.includes('NaN'), '拆解草案出现 NaN');
  const trimInfo = await cdp.eval(`
    return { hasVerdict: /R\\s*[0-9]/.test(document.body.innerText), txt: document.body.innerText.length };
  `);
  assert(trimInfo.hasVerdict, '拆解草案缺少 R 值');
  await cdp.shot('03b-decompose');
  await cdp.click('关闭');
  await sleep(400);
  console.log('✓ 智能拆解草案生成正常');

  // 4. 周视图 → 生成本周计划
  await cdp.click('周视图');
  await sleep(500);
  await cdp.click('生成本周计划');
  await sleep(1200);
  body = await cdp.text();
  assert(body.includes('本周可用') && body.includes('已排计划'), '周视图统计缺失');
  assert(!body.includes('NaN'), '周视图出现 NaN');
  // 若今天之后已无可排时段（如周日），生成会为 0 块：直接从本周一起排，保证后续步骤有任务
  const adjustCount = await cdp.eval(`return document.querySelectorAll('.slot-edit').length;`);
  if (adjustCount === 0) {
    const filled = await cdp.eval(`
      const pad = (n) => String(n).padStart(2, '0');
      const now = new Date();
      const dow = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
      const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const start = iso(monday);
      const res = await fetch('/api/plan/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekStart: start, from: start }),
      });
      const data = await res.json();
      return Array.isArray(data.blocks) ? data.blocks.length : 0;
    `);
    assert(filled > 0, '本周已无可排时段，且补排后仍没有任务块');
    await cdp.send('Page.reload');
    await sleep(1800);
    await cdp.click('周视图');
    await sleep(800);
    const retry = await cdp.eval(`return document.querySelectorAll('.slot-edit').length;`);
    assert(retry > 0, '补齐本周计划后仍没有可调整的任务');
  }

  await cdp.shot('04-week');
  console.log('✓ 周计划已生成并落库');

  // 4b. 重排建议：弹窗内评估 → 四个方案可见（含不适用/超载标记）
  await cdp.click('重排建议');
  await sleep(1600);
  body = await cdp.text();
  assert(body.includes('顺延') && body.includes('压缩') && body.includes('替换'), '重排方案未渲染');
  const optCount = await cdp.eval(`return document.querySelectorAll('.opt-card').length;`);
  assert(optCount === 4, `重排方案应有 4 个，实际 ${optCount}`);
  await cdp.shot('04b-replan');
  console.log('✓ 重排方案评估正常');
  // 关掉方案弹窗，避免影响后续步骤的按钮查找
  await cdp.click('关闭');
  await cdp.eval(`window.scrollTo(0, 0); return true;`);

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

  // 4c. 锁定该任务块：重排与重建都保留
  await cdp.click('调整');
  await sleep(500);
  await cdp.click('锁定此时间');
  await sleep(800);
  body = await cdp.text();
  assert(body.includes('已锁定'), '锁定后未提示');
  assert(body.includes('🔒'), '锁定块未显示 🔒 标记');
  await cdp.shot('04c-locked');
  console.log('✓ 任务块锁定正常');
  console.log('✓ 任务块同周移动成功');

  // 5. 今日 → 完成一项任务（填写实际用时）
  await cdp.click('今日');
  await sleep(700);
  await completeOneTask(100);
  body = await cdp.text();
  assert(body.includes('已完成'), '打卡后未显示完成状态');
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
  // 3a. 通知中心：临时把截止日拉近制造截止风险 → 铃铛未读 → 面板 → 全部已读 → 还原目标
  const goalSnap = await cdp.eval(`
    const st = await (await fetch('/api/state')).json();
    return st.goal
      ? { title: st.goal.title, deadline: st.goal.deadline, weeklyMinutes: st.goal.weeklyMinutes, level: st.goal.level }
      : null;
  `);
  assert(goalSnap, '缺少目标，无法测试通知中心');
  await cdp.eval(`
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(); d.setDate(d.getDate() + 2);
    const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    await fetch('/api/goal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ${JSON.stringify(goalSnap.title)}, deadline: iso, weeklyMinutes: ${goalSnap.weeklyMinutes}, level: ${JSON.stringify(goalSnap.level)} }),
    });
    return iso;
  `);
  await cdp.eval(`return document.querySelector('[aria-label="通知中心"]')?.click(); true;`);
  await sleep(1400);
  body = await cdp.text();
  assert(body.includes('通知中心'), '通知面板未打开');
  const notifDiag = await cdp.eval(`
    return {
      count: document.querySelectorAll('.notif-item').length,
      levels: [...document.querySelectorAll('.notif-level')].map((el) => el.textContent.trim()),
    };
  `);
  assert(notifDiag.count > 0, '通知面板没有任何通知');
  assert(notifDiag.levels.includes('紧急') || notifDiag.levels.includes('提醒'), '通知缺少预警级别');
  const unreadBefore = await cdp.eval(`return document.querySelector('.notif-dot')?.textContent ?? '0';`);
  await cdp.click('全部已读');
  await sleep(800);
  const unreadAfter = await cdp.eval(`return document.querySelector('.notif-dot')?.textContent ?? '0';`);
  assert(unreadBefore !== '0', '打开面板前应有未读角标');
  assert(unreadAfter === '0', '全部已读后角标应消失');
  await cdp.eval(`return document.querySelector('[aria-label="通知中心"]')?.click(); true;`);
  await sleep(500);
  await cdp.shot('03c-notifications');
  await cdp.eval(`
    await fetch('/api/goal', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ${JSON.stringify(goalSnap.title)}, deadline: ${JSON.stringify(goalSnap.deadline)}, weeklyMinutes: ${goalSnap.weeklyMinutes}, level: ${JSON.stringify(goalSnap.level)} }),
    });
    return true;
  `);
  await cdp.send('Page.reload');
  await sleep(1800);
  console.log('✓ 通知中心：预警生成与已读闭环正常');

  // 6b. 离线打卡：断网仍可操作，恢复网络后补传
  await cdp.click('今日');
  await sleep(600);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await completeOneTask(30);
  body = await cdp.text();
  assert(body.includes('待同步'), '离线操作未进入队列');
  if (body.includes('补录')) console.log('  · 补录标识已显示');
  await cdp.shot('06b-offline');
  console.log('✓ 离线打卡已暂存');

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  // 恢复联网会触发 online 事件自动补传；不点重试按钮，验证的就是自动补传本身
  await sleep(2500);
  body = await cdp.text();
  assert(!body.includes('项待同步'), '恢复网络后队列未自动清空');
  console.log('✓ 恢复网络后自动补传');

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

  await cdp.click('周视图');
  await sleep(600);
  await cdp.click('重新排这一周');
  await sleep(1200);
  body = await cdp.text();
  assert(!body.includes('NaN'), '按新容量重新生成后出现 NaN');
  console.log('✓ 按新容量重新生成正常');
  assert(await cdp.eval(`return document.body.innerText.includes('🔒');`), '重排后锁定块标记丢失');
  console.log('✓ 重建/重排保留锁定块');

  // 8b. 翻到下一周：未生成的周应为空状态，而不是复用同一份课表
  await cdp.click('›');
  await sleep(900);
  let next = await cdp.eval(`
    return {
      slots: document.querySelectorAll('.slot').length,
      hint: document.body.innerText.includes('这一周还没有排计划'),
      label: [...document.querySelectorAll('button')].map((b) => b.textContent).includes('生成本周计划'),
    };
  `);
  assert(next.slots === 0, '未生成的下一周不应显示任务块');
  assert(next.hint, '未生成的下一周缺少引导提示');
  await cdp.shot('08b-next-week-empty');
  console.log('✓ 未生成的周显示空状态，不再复用同一份课表');

  // 8c. 在下一周生成 → 删除任务块后当日「已排/可用」应即时减少
  await cdp.click('生成本周计划');
  await sleep(1800);
  const before = await cdp.eval(`
    return {
      slots: document.querySelectorAll('.slot').length,
      totals: [...document.querySelectorAll('.day-cap i')].map((el) => el.style.width).join('|'),
    };
  `);
  assert(before.slots > 0, '下一周生成后仍没有任务块');

  await cdp.click('调整');
  await sleep(500);
  await cdp.click('删除任务块');
  await sleep(1500);
  body = await cdp.text();
  assert(body.includes('已删除'), '删除任务块后没有反馈');
  const after = await cdp.eval(`
    return {
      slots: document.querySelectorAll('.slot').length,
      totals: [...document.querySelectorAll('.day-cap i')].map((el) => el.style.width).join('|'),
    };
  `);
  assert(after.slots === before.slots - 1, '删除后任务块数量未减少');
  assert(after.totals !== before.totals, '删除任务块后当日合计没有变化');
  await cdp.shot('08c-delete');
  console.log('✓ 删除任务块后当日合计同步更新');

  // 8d. 离线冷启动：断网状态下刷新，应用用本地快照只读展示
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  });
  await cdp.send('Page.navigate', { url: base });
  await sleep(2500);
  body = await cdp.text();
  assert(body.includes('离线模式'), '断网冷启动未进入离线模式');
  assert(body.includes('生成本周计划') || body.includes('今日'), '离线模式下数据未展示');
  await cdp.shot('08d-offline-cold');
  console.log('✓ 离线冷启动：快照只读展示');

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await cdp.send('Page.navigate', { url: base });
  await sleep(2200);
  body = await cdp.text();
  assert(!body.includes('离线模式'), '联网后未恢复在线模式');
  console.log('✓ 联网后恢复在线模式');

  // 9. 设置页不再有账号管理入口（提交版免登录）
  await cdp.click('设置');
  await sleep(700);
  body = await cdp.text();
  assert(!body.includes('退出登录') && !body.includes('注销账号'), '设置页仍有账号管理入口');
  assert(body.includes('演示模式'), '设置页缺少演示模式说明');
  console.log('✓ 设置页已无账号管理入口');

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
