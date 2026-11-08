import { useEffect, useState } from 'react';
import { Button, Empty, Meter, Panel, Ring, Stat } from '../components';
import { addDays, fmtDuration, startOfWeek, todayISO } from '../domain/date';
import type { Report } from '../domain/types';
import { api } from '../data/api';
import type { AppState } from '../store';

const CAUSE_COLOR: Record<string, string> = {
  capacity: 'var(--amber)',
  interrupt: 'var(--violet)',
  estimate: 'var(--cyan)',
};

const CAUSE_TONE: Record<string, 'amber' | 'quiet'> = {
  capacity: 'amber',
  interrupt: 'quiet',
  estimate: 'quiet',
};

export function ReportPage({ state }: { state: AppState }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayISO(), state.settings.weekStart));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .report(weekStart)
      .then((r) => {
        if (!alive) return;
        setReport(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : '周报加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [weekStart, nonce]);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const signed = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;

  const itemTitle = (id: string) => state.items.find((i) => i.id === id)?.title ?? '已删除的任务';
  const weekBlocks = state.blocks
    .filter((b) => b.date >= weekStart && b.date <= addDays(weekStart, 6))
    .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));

  return (
    <div className="page page-enter">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="live" />
            {weekStart} — {addDays(weekStart, 6)} · 一周复盘
          </div>
          <h1>时间去了哪里</h1>
          <p className="sub">由服务端按本周真实记录计算，不是随机文案</p>
        </div>
        <div className="head-actions">
          <Button className="btn-icon" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="上一周">
            ‹
          </Button>
          <Button onClick={() => setWeekStart(startOfWeek(todayISO(), state.settings.weekStart))}>本周</Button>
          <Button className="btn-icon" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="下一周">
            ›
          </Button>
        </div>
      </header>

      {loading && (
        <Panel>
          <p className="muted">正在计算…</p>
        </Panel>
      )}

      {!loading && error && (
        <div className="banner" role="alert">
          {error}{' '}
          <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}

      {!loading && !error && report && !report.hasData && (
        <Panel title="一周复盘">
          <Empty title="这一周还没有记录" desc="完成至少一项任务后，复盘才会有内容。" />
        </Panel>
      )}

      {!loading && !error && report && report.hasData && (
        <>
          <div className="grid-main">
            <div className="col">
              <section className="panel accent rise">
                <div className="hero-row">
                  <Ring value={report.doneCount} max={Math.max(1, report.plannedCount)} label="达成率" size={132} />
                  <div className="stat-row">
                    <Stat
                      label="达成率"
                      value={String(Math.round(report.achievement * 100))}
                      unit="%"
                      note={`${report.doneCount} / ${report.plannedCount} 项`}
                    />
                    <Stat
                      label="有效时长"
                      value={(report.effectiveMin / 60).toFixed(1)}
                      unit="小时"
                      note={`计划 ${fmtDuration(report.plannedMin)}`}
                    />
                    <Stat
                      label="估时偏差（中位）"
                      value={report.deviation.count > 0 ? signed(report.deviation.median) : '—'}
                      note={`基于 ${report.deviation.count} 条记录`}
                      tone={report.deviation.median > 0 ? 'warn' : 'up'}
                    />
                    <Stat
                      label="偏差 P90"
                      value={report.deviation.count > 0 ? pct(report.deviation.p90) : '—'}
                      note="最坏 10% 的情况"
                    />
                  </div>
                </div>
              </section>

              <Panel title="偏差归因" desc="容量、中断、估时三类，占比合计 100%">
                <div className="causes">
                  <div className="stack-bar">
                    {report.causes.map((c) => (
                      <i key={c.key} style={{ width: `${c.share}%`, background: CAUSE_COLOR[c.key] ?? 'var(--line-2)' }} />
                    ))}
                  </div>
                  <div className="legend">
                    {report.causes.map((c) => (
                      <div
                        key={c.key}
                        className="lg"
                        style={{ gridTemplateColumns: '10px 68px minmax(0, 1fr) 42px' }}
                      >
                        <i style={{ background: CAUSE_COLOR[c.key] ?? 'var(--line-2)' }} />
                        <span>{c.label}</span>
                        <Meter value={c.share} max={100} tone={CAUSE_TONE[c.key] ?? 'green'} />
                        <b style={{ textAlign: 'right' }}>{c.share}%</b>
                      </div>
                    ))}
                  </div>
                  <p className="muted" style={{ lineHeight: 1.7 }}>
                    归因只统计本周真实记录：容量是排不下、中断是执行中放弃、估时是实际用时的偏长。
                  </p>
                </div>
              </Panel>
            </div>

            <div className="col">
              <Panel className="insight-card" title="下周建议" desc="由归因结果生成">
                <p className="advice big">{report.suggestion}</p>
                <ul className="bullets" style={{ marginTop: 14 }}>
                  <li>偏差中位数代表系统性乐观/悲观程度。</li>
                  <li>P90 代表最坏 10% 的情况，用来定弹性位。</li>
                </ul>
              </Panel>

              <Panel title="本周关键数字">
                <div className="stack-tight">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">计划时长</span>
                    <b className="mono">{fmtDuration(report.plannedMin)}</b>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">有效时长</span>
                    <b className="mono">{fmtDuration(report.effectiveMin)}</b>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">跳过 / 中断</span>
                    <b className="mono">{report.skippedCount} 项</b>
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="muted">偏差样本</span>
                    <b className="mono">{report.deviation.count} 条</b>
                  </div>
                </div>
              </Panel>
            </div>
          </div>

          <Panel title="本周明细" desc={`${weekBlocks.length} 个任务块，按日期与开始时间排序`} flush>
            <ul className="task-list">
              {weekBlocks.map((b) => (
                <li key={b.id} className={`task task-${b.status}`} style={{ gridTemplateColumns: '74px 1fr auto' }}>
                  <div className="t-time">
                    <b>{b.date.slice(5)}</b>
                    <span>{b.status === 'done' ? '已完成' : b.status === 'skipped' ? '已跳过' : '未完成'}</span>
                  </div>
                  <div className="t-main">
                    <div className="t-title">{itemTitle(b.itemId)}</div>
                  </div>
                  <span className="mono muted" style={{ fontSize: 11.5 }}>
                    {b.status === 'done'
                      ? fmtDuration(b.actualMin ?? b.endMin - b.startMin)
                      : `${fmtDuration(b.endMin - b.startMin)} 计划`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </div>
  );
}
