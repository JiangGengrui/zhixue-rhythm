import { useEffect, useState } from 'react';
import { Button, Card, Empty, Meter, Stat } from '../components';
import { addDays, fmtDuration, startOfWeek, todayISO } from '../domain/date';
import type { Report } from '../domain/types';
import { api } from '../data/api';
import type { AppState } from '../store';

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

  return (
    <div className="stack">
      <Card
        title="一周复盘"
        desc={`${weekStart} — ${addDays(weekStart, 6)} · 由服务端按真实记录计算`}
        action={
          <div className="row">
            <Button onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="上一周">
              ‹
            </Button>
            <Button variant="quiet" onClick={() => setWeekStart(startOfWeek(todayISO(), state.settings.weekStart))}>
              本周
            </Button>
            <Button onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="下一周">
              ›
            </Button>
          </div>
        }
      >
        {loading && <p className="muted">正在计算…</p>}
        {!loading && error && (
          <div className="row">
            <span className="warn">{error}</span>
            <Button onClick={() => setNonce((n) => n + 1)}>重试</Button>
          </div>
        )}
        {!loading && !error && report && !report.hasData && (
          <Empty title="这一周还没有记录" desc="完成至少一项任务后，复盘才会有内容。" />
        )}
        {!loading && !error && report && report.hasData && (
          <>
            <div className="stats">
              <Stat
                label="达成率"
                value={pct(report.achievement)}
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
              />
              <Stat
                label="偏差 P90"
                value={report.deviation.count > 0 ? pct(report.deviation.p90) : '—'}
                note="最坏 10% 的情况"
              />
            </div>

            <div className="causes">
              {report.causes.map((c) => (
                <div key={c.key} className="cause">
                  <div className="cause-head">
                    <span>{c.label}</span>
                    <strong>{c.share}%</strong>
                  </div>
                  <Meter value={c.share} max={100} tone={c.key === 'capacity' ? 'amber' : 'green'} />
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {!loading && !error && report?.hasData && (
        <>
          <Card title="下周建议" desc="由归因结果生成，不是随机文案。">
            <p className="advice big">{report.suggestion}</p>
            <ul className="bullets">
              <li>归因只看本周真实记录：容量、中断、估时三类，占比合计 100%。</li>
              <li>偏差中位数代表系统性乐观/悲观程度，P90 代表最坏情况。</li>
            </ul>
          </Card>

          <Card title="本周明细">
            <ul className="item-list">
              {state.blocks
                .filter((b) => b.date >= weekStart && b.date <= addDays(weekStart, 6))
                .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1))
                .map((b) => (
                  <li key={b.id}>
                    <span className="muted">{b.date}</span>
                    <strong>{itemTitle(b.itemId)}</strong>
                    <span className={`status status-${b.status}`}>
                      {b.status === 'done'
                        ? `完成 · ${fmtDuration(b.actualMin ?? b.endMin - b.startMin)}`
                        : b.status === 'skipped'
                          ? '跳过'
                          : b.status === 'running'
                            ? '执行中'
                            : '未开始'}
                    </span>
                  </li>
                ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
