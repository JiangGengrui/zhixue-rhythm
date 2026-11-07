import { useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Meter, Stat } from '../components';
import { packWeek } from '../domain/engine';
import { addDays, fmtDuration, fmtHM, startOfWeek, todayISO, weekDates, weekdayOf } from '../domain/date';
import { SUBJECT_LABEL } from '../domain/types';
import type { AppState, Actions } from '../store';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const toTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMinutes = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return Math.max(0, Math.min(1439, (h ?? 0) * 60 + (m ?? 0)));
};

export function WeekPage({ state, actions }: { state: AppState; actions: Actions }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayISO(), state.settings.weekStart));
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('19:00');
  const [editError, setEditError] = useState('');

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

  const capacity = dates.reduce((s, d) => s + Math.max(0, state.settings.weekdays[weekdayOf(d)] ?? 0), 0);
  const today = todayISO();
  const isCurrentWeek = weekStart === startOfWeek(today, state.settings.weekStart);
  // 今天及之后还能排多少分钟（非本周时视为整周可用）
  const remainingFromToday = isCurrentWeek
    ? dates.filter((d) => d >= today).reduce((s, d) => s + Math.max(0, state.settings.weekdays[weekdayOf(d)] ?? 0), 0)
    : capacity;
  const noRoomLeft = remainingFromToday === 0;
  const plannedMin = shown.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const bufferMin = shown.filter((b) => b.isBuffer).reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const editing = saved.find((b) => b.id === editingId) ?? null;

  if (!state.goal || items.length === 0) {
    return (
      <Card title="周视图" desc="先生成目标和计划项，才能排出这一周。">
        <Empty title="没有可排的计划" desc="到「目标」页添加计划项后回到这里。" />
      </Card>
    );
  }

  function startEdit(blockId: string) {
    const block = saved.find((b) => b.id === blockId);
    if (!block) return;
    setEditingId(blockId);
    setEditDate(block.date);
    setEditTime(toTime(block.startMin));
    setEditError('');
  }

  return (
    <div className="stack">
      <Card
        title={`${weekStart} — ${addDays(weekStart, 6)}`}
        desc={hasSaved ? `已完成 ${saved.filter((b) => b.status === 'done').length} 项` : '以下为预览，点击「生成本周计划」后写入'}
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
              void actions.generateWeek(weekStart).then((added) =>
                setNotice(
                  added > 0
                    ? `新增 ${added} 个任务块`
                    : '这一周没有可排的时段，未新增任务（可在「设置」调整每日可用时间）',
                ),
              );
            }}
          >
            {hasSaved ? '补排新任务' : '生成本周计划'}
          </Button>
          {notice && <span className="notice">{notice}</span>}
        </div>
      </Card>

      {noRoomLeft && isCurrentWeek && (
        <div className="hint-bar">
          <span>
            从今天起本周已没有可用时段（{WEEKDAY_LABEL[weekdayOf(today)]}及之后都是休息日），所以「生成」不会产出任务。
          </span>
          <Button
            onClick={() => {
              const next = addDays(weekStart, 7);
              setWeekStart(next);
              void actions.generateWeek(next).then((added) =>
                setNotice(added > 0 ? `已为 ${next} 那周生成 ${added} 个任务块` : '下周也没有可用时段，请先到「设置」调整每日可用时间'),
              );
            }}
          >
            为下周生成
          </Button>
        </div>
      )}

      {editing && (
        <Card
          title="调整任务时间"
          desc={`${itemMap.get(editing.itemId)?.title ?? '任务'} · 时长 ${fmtDuration(editing.endMin - editing.startMin)}（不可在此修改）`}
        >
          <div className="form-grid">
            <Field label="日期">
              <select value={editDate} onChange={(e) => setEditDate(e.target.value)}>
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {d}（{WEEKDAY_LABEL[weekdayOf(d)]}）
                  </option>
                ))}
              </select>
            </Field>
            <Field label="开始时间" hint="结束时间按原时长自动顺延">
              <input type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <Button
              variant="primary"
              onClick={() => {
                setEditError('');
                void actions
                  .moveBlock(editing.id, { date: editDate, startMin: toMinutes(editTime) })
                  .then(() => {
                    setEditingId(null);
                    setNotice('已调整任务时间');
                  })
                  .catch((err: unknown) => setEditError(err instanceof Error ? err.message : '调整失败'));
              }}
            >
              保存
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!confirm('删除这个任务块？任务会回到待排状态。')) return;
                setEditError('');
                void actions
                  .deleteBlock(editing.id)
                  .then(() => {
                    setEditingId(null);
                    setNotice('已删除，任务回到待排');
                  })
                  .catch((err: unknown) => setEditError(err instanceof Error ? err.message : '删除失败'));
              }}
            >
              删除任务块
            </Button>
            <Button variant="quiet" onClick={() => setEditingId(null)}>
              取消
            </Button>
          </div>
          {editError && <span className="warn">{editError}</span>}
        </Card>
      )}

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
                    // 只有已落库的块才能调整；预览块点击无对象可改，不显示入口
                    const movable = hasSaved && (b.status === 'pending' || b.status === 'running');
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
                        {movable && (
                          <button type="button" className="slot-edit" onClick={() => startEdit(b.id)}>
                            调整
                          </button>
                        )}
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
        <Card title={`装不下的计划项（${packed.overflow.length}）`} desc="容量不足，剩余部分会留到下一周。">
          <ul className="item-list">
            {packed.overflow.map((o) => (
              <li key={o.item.id}>
                <strong>{o.item.title}</strong>
                <span className="muted">
                  剩余 {fmtDuration(o.remainingMin ?? o.item.estimateMin)}
                </span>
                <Button variant="quiet" onClick={() => void actions.removeItem(o.item.id)}>
                  移除
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="排程说明">
        <ul className="bullets">
          {hasSaved ? (
            <>
              <li>本周已生成 {saved.length} 个任务块，占用 {fmtDuration(plannedMin)}。</li>
              <li>已完成或已调整的块不会被「补排新任务」覆盖。</li>
            </>
          ) : (
            packed.suggestions.map((s) => <li key={s}>{s}</li>)
          )}
          <li>超过单日容量的任务会自动拆分到多天，不丢工作量。</li>
        </ul>
      </Card>
    </div>
  );
}
