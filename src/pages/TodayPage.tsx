import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, IconCheck, Panel, Ring, Stat } from '../components';
import { addDays, daysBetween, fmtDuration, fmtHM, startOfWeek, todayISO, weekDates, weekdayOf } from '../domain/date';
import { SUBJECT_LABEL } from '../domain/types';
import type { Block } from '../domain/types';
import type { AppState, Actions } from '../store';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 秒数 → mm:ss（超 1 小时 h:mm:ss） */
function fmtClock(totalSec: number) {
  const sec = Math.max(0, Math.round(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function TodayPage({
  state,
  actions,
  onGoGoal,
}: {
  state: AppState;
  actions: Actions;
  onGoGoal: () => void;
}) {
  const today = todayISO();
  const [editing, setEditing] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<'plan' | 'backfill'>('plan');
  const [minutes, setMinutes] = useState(0);
  const [progressPct, setProgressPct] = useState(100);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  /** 当前已执行秒数：累计段 + 正在进行的段（暂停时 startedAt 为空） */
  function elapsedSecOf(b: Block) {
    const base = b.accumulatedSec ?? 0;
    if (!b.startedAt) return base;
    const started = Date.parse(b.startedAt);
    return base + (Number.isFinite(started) ? Math.max(0, (nowTick - started) / 1000) : 0);
  }

  const itemMap = useMemo(() => new Map(state.items.map((i) => [i.id, i])), [state.items]);
  const blocks = useMemo(
    () => state.blocks.filter((b) => b.date === today).sort((a, b) => a.startMin - b.startMin),
    [state.blocks, today],
  );

  const hasRunning = blocks.some((b) => b.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  // 本周其他日期仍未完成的任务：允许补打卡，避免"今天没排到"就无事可做
  const weekStart = startOfWeek(today, state.settings.weekStart);
  const weekSet = useMemo(() => new Set(weekDates(weekStart)), [weekStart]);
  const backfill = useMemo(
    () =>
      state.blocks
        .filter((b) => b.date !== today && weekSet.has(b.date) && (b.status === 'pending' || b.status === 'running'))
        .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1)),
    [state.blocks, today, weekSet],
  );

  const backfillDone = useMemo(
    () =>
      state.blocks
        .filter((b) => b.date !== today && weekSet.has(b.date) && b.status === 'done')
        .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date > b.date ? -1 : 1))
        .slice(0, 6),
    [state.blocks, today, weekSet],
  );

  const weekBlockCount = state.blocks.filter((b) => weekSet.has(b.date)).length;

  /** 今日页的排程入口：必须给出结果反馈，否则用户会以为按钮坏了 */
  async function generate() {
    setBusy(true);
    setNotice('正在排程…');
    try {
      const added = await actions.generateWeek(weekStart, 'fill');
      setNotice(
        added > 0
          ? `已排入 ${added} 个任务块${blocks.length === 0 ? '（今天没有可用时段，已排到本周其它日子）' : ''}`
          : '没有可排的任务：本周从今天起可能已无可用时段，或任务都已排过，可到「周视图」重排',
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '排程失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  const done = blocks.filter((b) => b.status === 'done');
  const plannedMin = blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const effectiveMin = done.reduce((s, b) => s + (b.actualMin ?? b.endMin - b.startMin), 0);
  const leftDays = state.goal ? daysBetween(today, state.goal.deadline) : null;

  function startComplete(b: Block, source: 'plan' | 'backfill' = 'plan') {
    setEditing(b.id);
    setEditingSource(source);
    setProgressPct(100);
    // 执行中的任务用计时器预填，避免用户凭感觉报数
    setMinutes(b.status === 'running' ? Math.max(1, Math.round(elapsedSecOf(b) / 60)) : b.endMin - b.startMin);
  }

  /** 完成表单：用时 + 完成度。今日任务与补录行共用 */
  function renderDoneForm(b: Block) {
    if (editing !== b.id) return null;
    return (
      <div className="inline-form">
        <label>
          实际用时（分钟）
          <input
            type="number"
            min={1}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            autoFocus
          />
        </label>
        <label className="progress-field">
          完成度 <b className="mono">{progressPct}%</b>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={progressPct}
            onChange={(e) => setProgressPct(Number(e.target.value))}
          />
        </label>
        {progressPct < 100 && (
          <small className="form-hint">剩余的 {100 - progressPct}% 工作量会自动滚入下次排程，不会丢。</small>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const safe = Math.max(1, Math.round(minutes));
            void actions.setBlockStatus(b.id, 'done', safe, undefined, {
              progressPct,
              source: editingSource,
            });
            setEditing(null);
          }}
        >
          确认完成
        </Button>
        <Button variant="quiet" size="sm" onClick={() => setEditing(null)}>
          取消
        </Button>
      </div>
    );
  }

  function renderTask(b: Block, showDate = false) {
    const item = itemMap.get(b.itemId);
    const planned = b.endMin - b.startMin;
    return (
      <li key={b.id} className={`task task-${b.status}`}>
        <div className="t-time">
          <b>{fmtHM(b.startMin)}</b>
          <span>{showDate ? `${b.date.slice(5)} · ${fmtDuration(planned)}` : fmtDuration(planned)}</span>
        </div>
        <div className="t-main">
          <div className="t-title">
            {b.status === 'done' && (
              <span className="check">
                <IconCheck />
              </span>
            )}
            <span>{item?.title ?? '已删除的任务'}</span>
            {item && <span className={`tag tag-${item.subject}`}>{SUBJECT_LABEL[item.subject]}</span>}
            {b.isBuffer && <span className="tag tag-buffer">弹性位</span>}
          </div>
          <div className="t-meta">
            <StatusText block={b} elapsedSec={elapsedSecOf(b)} />
          </div>
        </div>
        <div className="t-act">
          {b.status === 'pending' && (
            <>
              <Button variant="primary" onClick={() => void actions.setBlockStatus(b.id, 'running')}>
                开始
              </Button>
              <Button size="sm" onClick={() => startComplete(b)}>
                直接完成
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void actions.setBlockStatus(b.id, 'skipped', undefined, 'other')}
              >
                跳过
              </Button>
            </>
          )}
          {b.status === 'running' && (
            <>
              <Button variant="primary" onClick={() => startComplete(b)}>
                完成
              </Button>
              {b.startedAt ? (
                <Button size="sm" onClick={() => void actions.pauseBlock(b.id)}>
                  暂停
                </Button>
              ) : (
                <Button size="sm" onClick={() => void actions.resumeBlock(b.id)}>
                  继续
                </Button>
              )}
              <Button
                variant="quiet"
                size="sm"
                onClick={() => void actions.setBlockStatus(b.id, 'skipped', undefined, 'interrupt')}
              >
                中断放弃
              </Button>
            </>
          )}
          {b.status === 'done' && (
            <Button variant="quiet" size="sm" onClick={() => void actions.setBlockStatus(b.id, 'pending')}>
              撤销
            </Button>
          )}
          {b.status === 'skipped' && (
            <Button variant="quiet" size="sm" onClick={() => void actions.setBlockStatus(b.id, 'pending')}>
              恢复
            </Button>
          )}
        </div>
        {renderDoneForm(b)}
      </li>
    );
  }

  if (!state.goal) {
    return (
      <div className="page page-enter">
        <header className="page-head">
          <div>
            <div className="eyebrow">{today} · {WEEKDAY_LABEL[weekdayOf(today)]}</div>
            <h1>{greeting()}，{state.user?.name}</h1>
            <p className="sub">先建立目标，今天才有内容可执行。</p>
          </div>
        </header>
        <Panel title="今日" desc="还没有目标">
          <Empty
            title="还没有目标"
            desc="载入示例数据可以立刻体验完整链路。"
            action={
              <div className="row">
                <Button variant="primary" onClick={() => void actions.seedDemo()}>
                  载入示例数据
                </Button>
                <Button onClick={onGoGoal}>去设置目标</Button>
              </div>
            }
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="page page-enter">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="live" />
            {today} · {WEEKDAY_LABEL[weekdayOf(today)]}
            {leftDays !== null && leftDays >= 0 ? ` · 距目标 ${leftDays} 天` : ''}
          </div>
          <h1>
            {greeting()}，{state.user?.name}
          </h1>
          <p className="sub">
            今天 <b>{blocks.length} 项</b> · 计划 <b>{(plannedMin / 60).toFixed(1)} 小时</b> · 已投入{' '}
            <b>{(effectiveMin / 60).toFixed(1)} 小时</b>
          </p>
        </div>
        <div className="head-actions">
          <Button onClick={onGoGoal}>设置目标</Button>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void generate()}>
            {busy ? '排程中…' : '生成本周计划'}
          </Button>
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}

      <div className="grid-main">
        <div className="col">
          <section className="panel accent rise">
            <div className="hero-row">
              <Ring
                value={done.length}
                max={Math.max(1, blocks.length)}
                label="今日进度"
                size={132}
              />
              <div className="stat-row">
                <Stat label="今日计划" value={(plannedMin / 60).toFixed(1)} unit="小时" note={`${blocks.length} 个任务块`} />
                <Stat
                  label="已完成"
                  value={String(done.length)}
                  unit={`/ ${blocks.length}`}
                  note={done.length > 0 ? `完成 ${Math.round((done.length / Math.max(1, blocks.length)) * 100)}%` : '尚未开始'}
                  tone="up"
                />
                <Stat label="实际投入" value={(effectiveMin / 60).toFixed(1)} unit="小时" note="按打卡记录累计" />
              </div>
            </div>
          </section>

          <Panel
            title="今日执行"
            desc="点「开始」计时，完成时填实际用时"
            action={<span className="pill tone-quiet">{blocks.length} 块</span>}
          >
            {blocks.length === 0 ? (
              <Empty
                title="今天没有安排"
                desc={
                  weekBlockCount > 0
                    ? `本周已排 ${weekBlockCount} 项，今天（${WEEKDAY_LABEL[weekdayOf(today)]}）没有时段。`
                    : '可以生成本周计划，或到「周视图」手动安排。'
                }
                action={
                  <Button variant="primary" disabled={busy} onClick={() => void generate()}>
                    {busy ? '排程中…' : '生成本周计划'}
                  </Button>
                }
              />
            ) : (
              <ul className="task-list">{blocks.map((b) => renderTask(b))}</ul>
            )}
          </Panel>
        </div>

        <div className="col">
          {backfill.length > 0 && (
            <Panel
              title="本周待完成"
              desc="可直接在此补打卡"
              action={<span className="pill tone-amber">{backfill.length}</span>}
            >
              {backfill.map((b) => {
                const item = itemMap.get(b.itemId);
                return (
                  <div key={b.id}>
                    <div className="mini-row">
                      {item && <span className={`tag tag-${item.subject}`}>{SUBJECT_LABEL[item.subject]}</span>}
                      <b title={item?.title}>{item?.title ?? '已删除的任务'}</b>
                      <time>{b.date.slice(5)}</time>
                      <Button variant="quiet" size="sm" onClick={() => startComplete(b, 'backfill')}>
                        补录
                      </Button>
                    </div>
                    {renderDoneForm(b)}
                  </div>
                );
              })}
            </Panel>
          )}

          {backfillDone.length > 0 && (
            <Panel title={`本周已完成（${backfillDone.length}）`} desc="补录会进入周报统计，可撤销">
              <ul className="task-list">
                {backfillDone.map((b) => {
                  const item = itemMap.get(b.itemId);
                  return (
                    <li key={b.id} className="mini-row" style={{ gap: 8 }}>
                      <span className="check">
                        <IconCheck />
                      </span>
                      <b title={item?.title}>{item?.title ?? '已删除的任务'}</b>
                      {b.source === 'backfill' && <span className="tag tag-buffer">补录</span>}
                      <time>{b.date.slice(5)}</time>
                      <Button variant="quiet" size="sm" onClick={() => void actions.setBlockStatus(b.id, 'pending')}>
                        撤销
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          <Panel title="接下来两天">
            <div className="forecast">
              {[1, 2].map((offset) => {
                const date = addDays(today, offset);
                const list = state.blocks.filter((b) => b.date === date);
                const min = list.reduce((s, b) => s + (b.endMin - b.startMin), 0);
                const cap = Math.max(1, state.settings.weekdays[weekdayOf(date)] ?? 0);
                return (
                  <div key={date} className="fc">
                    <b>{date.slice(5)}</b>
                    <div>
                      <div className="fc-bar">
                        <i style={{ width: `${Math.min(100, (min / cap) * 100)}%` }} />
                      </div>
                      <small>
                        {list.length === 0
                          ? '暂无安排'
                          : `${list.length} 项 · 共 ${fmtDuration(min)}`}
                      </small>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function StatusText({ block, elapsedSec }: { block: Block; elapsedSec: number }) {
  if (block.status === 'done') {
    const pct = block.progressPct;
    return (
      <span className="ok">
        已完成 · 实际 {fmtDuration(block.actualMin ?? block.endMin - block.startMin)}
        {typeof pct === 'number' && pct < 100 ? ` · 完成度 ${pct}%` : ''}
        {block.source === 'backfill' ? ' · 补录' : ''}
      </span>
    );
  }
  if (block.status === 'running') {
    return (
      <span className="running-text">
        <i className="dot-status" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
        {block.startedAt ? `执行中 ${fmtClock(elapsedSec)}` : `已暂停 · 累计 ${fmtClock(elapsedSec)}`}
      </span>
    );
  }
  if (block.status === 'skipped') {
    return (
      <span className="warn">
        已跳过 · {block.skipReason === 'interrupt' ? '被打断' : block.skipReason === 'capacity' ? '容量不足' : '主动跳过'}
      </span>
    );
  }
  return (
    <span>
      <i className="dot-status" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />
      待开始
    </span>
  );
}
