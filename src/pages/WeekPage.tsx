import { useMemo, useState } from 'react';
import { Button, Card, Empty, Meter, Stat } from '../components';
import { packWeek } from '../domain/engine';
import { addDays, fmtDuration, fmtHM, startOfWeek, todayISO, weekDates, weekdayOf } from '../domain/date';
import { SUBJECT_LABEL } from '../domain/types';
import type { AppState, Actions } from '../store';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function WeekPage({ state, actions }: { state: AppState; actions: Actions }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayISO(), state.settings.weekStart));
  const [notice, setNotice] = useState('');

  const items = useMemo(
    () => state.items.filter((i) => i.goalId === state.goal?.id),
    [state.items, state.goal?.id],
  );
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const packed = useMemo(
    () => packWeek(items, state.settings, weekStart),
    [items, state.settings, weekStart],
  );

  const dates = weekDates(weekStart);
  const saved = state.blocks.filter((b) => dates.includes(b.date));
  const hasSaved = saved.length > 0;
  const shown = hasSaved ? saved : packed.blocks;
  const isPreview = !hasSaved;

  const capacity = dates.reduce((s, d) => s + Math.max(0, state.settings.weekdays[weekdayOf(d)] ?? 0), 0);
  const plannedMin = shown.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const bufferMin = shown.filter((b) => b.isBuffer).reduce((s, b) => s + (b.endMin - b.startMin), 0);

  if (!state.goal || items.length === 0) {
    return (
      <Card title="周视图" desc="先生成目标和计划项，才能排出这一周。">
        <Empty title="没有可排的计划" desc="到「目标」页添加计划项后回到这里。" />
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card
        title={`${weekStart} — ${addDays(weekStart, 6)}`}
        desc={isPreview ? '以下为预览，点击「生成本周计划」后写入' : `已完成 ${saved.filter((b) => b.status === 'done').length} 项`}
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
        <div className="stats">
          <Stat label="本周可用" value={(capacity / 60).toFixed(1)} unit="小时" />
          <Stat label="已排计划" value={(plannedMin / 60).toFixed(1)} unit="小时" />
          <Stat
            label="占用率"
            value={capacity > 0 ? String(Math.round((plannedMin / capacity) * 100)) : '—'}
            unit={capacity > 0 ? '%' : undefined}
          />
          <Stat label="弹性位占用" value={String(Math.round(bufferMin))} unit="分钟" />
        </div>
        <div className="meter-row">
          <span>容量</span>
          <Meter value={plannedMin} max={Math.max(capacity, plannedMin)} tone={plannedMin > capacity ? 'red' : 'green'} />
          <span className="muted">
            {fmtDuration(plannedMin)} / {fmtDuration(capacity)}
          </span>
        </div>
        <div className="row">
          <Button
            variant="primary"
            onClick={() => {
              actions.generateWeek(weekStart);
              setNotice('已生成本周计划');
            }}
          >
            {hasSaved ? '重新生成（保留完成状态）' : '生成本周计划'}
          </Button>
          {notice && <span className="notice">{notice}</span>}
        </div>
      </Card>

      <div className="week-grid">
        {dates.map((date) => {
          const dayBlocks = shown.filter((b) => b.date === date);
          const cap = Math.max(0, state.settings.weekdays[weekdayOf(date)] ?? 0);
          const isToday = date === todayISO();
          return (
            <div key={date} className={`day ${isToday ? 'day-today' : ''}`}>
              <header>
                <span>{WEEKDAY_LABEL[weekdayOf(date)]}</span>
                <strong>{date.slice(8)}</strong>
                <small>{cap === 0 ? '休息' : `${(cap / 60).toFixed(1)}h`}</small>
              </header>
              <div className="day-body">
                {dayBlocks.length === 0 ? (
                  <span className="slot-empty">{cap === 0 ? '—' : '留白'}</span>
                ) : (
                  dayBlocks.map((b) => {
                    const item = itemMap.get(b.itemId);
                    return (
                      <div
                        key={b.id}
                        className={`slot slot-${item?.subject ?? 'other'} ${b.isBuffer ? 'slot-buffer' : ''} ${
                          b.status === 'done' ? 'slot-done' : ''
                        }`}
                      >
                        <b>{item?.title ?? '已删除的任务'}</b>
                        <small>
                          {fmtHM(b.startMin)} · {fmtDuration(b.endMin - b.startMin)}
                          {b.isBuffer ? ' · 弹性' : ''}
                        </small>
                        {item && <span className="slot-subject">{SUBJECT_LABEL[item.subject]}</span>}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>

      {packed.overflow.length > 0 && (
        <Card title={`装不下的计划项（${packed.overflow.length}）`} desc="当前容量不足，需要做取舍。">
          <ul className="item-list">
            {packed.overflow.map((o) => (
              <li key={o.item.id}>
                <strong>{o.item.title}</strong>
                <span className="muted">{fmtDuration(o.item.estimateMin)}</span>
                <Button variant="quiet" onClick={() => actions.removeItem(o.item.id)}>
                  移除
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="排程说明">
        <ul className="bullets">
          {packed.suggestions.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
