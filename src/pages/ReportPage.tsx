import { useMemo, useState } from 'react';
import { Button, Card, Empty, Meter, Stat } from '../components';
import { blocksOfWeek, buildReport } from '../domain/engine';
import { addDays, fmtDuration, startOfWeek, todayISO } from '../domain/date';
import type { AppState, Actions } from '../store';

export function ReportPage({ state }: { state: AppState; actions?: Actions }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayISO(), state.settings.weekStart));

  const blocks = useMemo(
    () => blocksOfWeek(state.blocks, weekStart),
    [state.blocks, weekStart],
  );
  const report = useMemo(
    () => buildReport(blocks, state.settings, weekStart),
    [blocks, state.settings, weekStart],
  );

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const signed = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;

  return (
    <div className="stack">
      <Card
        title="一周复盘"
        desc={`${weekStart} — ${addDays(weekStart, 6)} · 所有数字来自实际记录`}
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
        {!report.hasData ? (
          <Empty title="这一周还没有记录" desc="完成至少一项任务后，复盘才会有内容。" />
        ) : (
          <>
            <div className="stats">
              <Stat label="达成率" value={pct(report.achievement)} note={`${report.doneCount} / ${report.plannedCount} 项`} />
              <Stat label="有效时长" value={(report.effectiveMin / 60).toFixed(1)} unit="小时" note={`计划 ${fmtDuration(report.plannedMin)}`} />
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

      {report.hasData && (
        <Card title="下周建议" desc="由归因结果生成，不是随机文案。">
          <p className="advice big">{report.suggestion}</p>
          <ul className="bullets">
            <li>归因只看本周真实记录：容量、中断、估时三类，占比合计 100%。</li>
            <li>偏差中位数代表你的系统性乐观/悲观程度，P90 代表最坏情况。</li>
          </ul>
        </Card>
      )}

      <Card title="本周明细">
        {blocks.length === 0 ? (
          <Empty title="没有任务块" desc="本周尚未生成计划。" />
        ) : (
          <ul className="item-list">
            {blocks.map((b) => {
              const item = state.items.find((i) => i.id === b.itemId);
              return (
                <li key={b.id}>
                  <span className="muted">{b.date}</span>
                  <strong>{item?.title ?? '已删除的任务'}</strong>
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
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
