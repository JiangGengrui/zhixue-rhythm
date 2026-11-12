import { Button, ThemeToggle } from '../components';

const FEATURES = [
  {
    tag: 'R 值',
    title: '先算能不能排下',
    body: '输入目标与截止日期，先按每周可用小时数算出可行性 R 值。排不下的目标，一开始就告诉你。',
  },
  {
    tag: '三件事',
    title: '每天只做三件',
    body: '今日视图固定三条主线，做完了才算过完一天。不再对着二十条待办发呆。',
  },
  {
    tag: '弹性',
    title: '每周留 15% 空位',
    body: '周计划自动把 15% 的时间挂起，用来接住临时插入的事，而不是让整周崩盘。',
  },
  {
    tag: '归因',
    title: '偏差变成建议',
    body: '周报把没做完的部分归类到时段冲突、估时不准或优先级偏移，给出下一条可执行建议。',
  },
];

const STEPS = [
  ['01', '定目标', '写清截止日期与每周可投入时长'],
  ['02', '排周计划', '拆到具体科目与时段，自动留弹性'],
  ['03', '做今天', '只盯三件事，完成后打勾'],
  ['04', '看周报', '偏差归因，下一条建议直接进计划'],
];

export function LandingPage({
  theme,
  onToggleTheme,
  onEnter,
}: {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onEnter: (mode: 'login' | 'register') => void;
}) {
  return (
    <div className="land">
      <div className="land-bg" aria-hidden="true">
        <span className="land-grid" />
        <span className="land-glow" />
      </div>

      <header className="land-nav">
        <div className="land-brand">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>智学节律</strong>
            <small>RHYTHM OS</small>
          </div>
        </div>
        <nav className="land-links">
          <a href="#features">功能</a>
          <a href="#flow">怎么用</a>
          <a href="#start">开始</a>
        </nav>
        <div className="row">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <Button onClick={() => onEnter('login')}>登录</Button>
          <Button variant="primary" onClick={() => onEnter('register')}>
            免费开始
          </Button>
        </div>
      </header>

      <main className="land-hero">
        <div className="land-hero-copy">
          <span className="land-kicker">
            <i aria-hidden="true" />
            为长期备考的人做的计划系统
          </span>
          <h1>
            把长目标，
            <br />
            拆成今天做得完的
            <em>三件事</em>
          </h1>
          <p className="land-lead">
            先算可行性，再排计划；每周自动留出弹性；做不完的偏差，会变成下一条具体建议。不是又一个待办清单。
          </p>

          <div className="land-cta">
            <Button variant="primary" className="land-cta-main" onClick={() => onEnter('register')}>
              创建账号 · 免费
            </Button>
            <Button className="land-cta-sub" onClick={() => onEnter('login')}>
              我已有账号
            </Button>
          </div>

          <ul className="land-meta">
            <li>
              <strong>3</strong>
              <span>件事 / 天</span>
            </li>
            <li>
              <strong>15%</strong>
              <span>弹性预留</span>
            </li>
            <li>
              <strong>R</strong>
              <span>可行性判定</span>
            </li>
            <li>
              <strong>7</strong>
              <span>天一次复盘</span>
            </li>
          </ul>
        </div>

        <div className="land-demo" aria-hidden="true">
          <div className="land-demo-bar">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            <span className="land-demo-title">本周 · 第 6 周</span>
            <span className="land-demo-chip">R 1.24 可排</span>
          </div>

          <div className="land-demo-week">
            {['一', '二', '三', '四', '五', '六', '日'].map((d, day) => (
              <div className="land-day" key={d}>
                <span className="land-day-name">{d}</span>
                <div className="land-day-cells">
                  {(day % 3 === 0 ? [1, 0, 1] : day % 3 === 1 ? [1, 1, 0] : [0, 1, 1]).map((on, i) => (
                    <span
                      key={i}
                      className={`land-cell ${on ? 'on' : ''} ${day === 2 && i === 0 ? 'flex' : ''}`}
                      style={{ animationDelay: `${(day * 3 + i) * 0.06}s` }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="land-demo-task">
            <span className="land-check" />
            <span>数学 · 概率论 3 节</span>
            <span className="land-demo-tag">主线</span>
          </div>
          <div className="land-demo-task">
            <span className="land-check" />
            <span>英语 · 阅读 2 篇 + 精读</span>
            <span className="land-demo-tag">主线</span>
          </div>
          <div className="land-demo-task quiet">
            <span className="land-check" />
            <span>弹性位 · 接住临时插入</span>
            <span className="land-demo-tag">15%</span>
          </div>
        </div>
      </main>

      <section className="land-features" id="features">
        <div className="land-sec-head">
          <span className="land-kicker">
            <i aria-hidden="true" />
            四个关键设计
          </span>
          <h2>不作弊的排期，才有可执行的计划</h2>
        </div>
        <div className="land-cards">
          {FEATURES.map((f) => (
            <article className="land-card" key={f.tag}>
              <span className="land-card-tag">{f.tag}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="land-flow" id="flow">
        <div className="land-sec-head">
          <span className="land-kicker">
            <i aria-hidden="true" />
            一周就是一轮
          </span>
          <h2>从目标到复盘，四个环节闭环</h2>
        </div>
        <ol className="land-steps">
          {STEPS.map(([no, title, desc]) => (
            <li key={no}>
              <span className="land-step-no">{no}</span>
              <strong>{title}</strong>
              <p>{desc}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="land-band" id="start">
        <div>
          <h2>今晚花十分钟，把这一周排明白</h2>
          <p>不绑定手机号，不需要邀请码。先注册一个账号，或者用免注册登录直接看效果。</p>
        </div>
        <div className="row">
          <Button variant="primary" className="land-cta-main" onClick={() => onEnter('register')}>
            免费开始
          </Button>
          <Button className="land-cta-sub" onClick={() => onEnter('login')}>
            免注册试用
          </Button>
        </div>
      </section>

      <footer className="land-foot">
        <div className="land-brand">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>智学节律</strong>
            <small>让计划跟得上现实</small>
          </div>
        </div>
        <p>数据存在你自己的账号里 · 周报只统计你自己的记录</p>
      </footer>
    </div>
  );
}
