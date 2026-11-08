import { useMemo, useState } from 'react';
import { Button, Empty, Field, Meter, Panel } from '../components';
import { packWeek } from '../domain/engine';
import { addDays, fmtDuration, fmtHM, startOfWeek, todayISO, weekDates, weekdayOf } from '../domain/date';
import type { AppState, Actions } from '../store';
import type { ReplanResponse } from '../data/api';

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const toTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMinutes = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return Math.max(0, Math.min(1439, (h ?? 0) * 60 + (m ?? 0)));
};

export function WeekPage({ state, actions }: { state: AppState; actions: Actions }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayISO(), state.settings.weekStart));
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [replanData, setReplanData] = useState<ReplanResponse | null>(null);
  const [replanBusy, setReplanBusy] = useState(false);
  const [replanMsg, setReplanMsg] = useState('');
  // 用户点过「生成」后不再展示预览，避免删空后预览块又冒出来
  const [everGenerated, setEverGenerated] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('19:00');
  const [editError, setEditError] = useState('');

  const items = useMemo(
    () => state.items.filter((i) => i.goalId === state.goal?.id),
    [state.items, state.goal?.id],
  );
  const itemMap = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // 预览按"剩余工时"算：已完成的部分不该再出现在预览里
  const pendingItems = useMemo(
    () =>
      items
        .filter((i) => (i.remainingMin ?? i.estimateMin) > 0)
        .map((i) => ({ ...i, estimateMin: i.remainingMin ?? i.estimateMin })),
    [items],
  );

  const packed = useMemo(
    () => packWeek(pendingItems, state.settings, weekStart),
    [pendingItems, state.settings, weekStart],
  );

  const dates = weekDates(weekStart);
  const today = todayISO();
  const isCurrentWeek = weekStart === startOfWeek(today, state.settings.weekStart);
  const saved = state.blocks.filter((b) => dates.includes(b.date));
  const hasSaved = saved.length > 0;
  // 预览只给「本周、还没生成过」用：翻到其它周时不再显示雷同的假课表
  const previewable = isCurrentWeek && !hasSaved && !everGenerated;
  const shown = previewable ? packed.blocks : saved;

  const capacity = dates.reduce((s, d) => s + Math.max(0, state.settings.weekdays[weekdayOf(d)] ?? 0), 0);
  // 今天及之后还能排多少分钟（非本周时视为整周可用）
  const remainingFromToday = isCurrentWeek
    ? dates.filter((d) => d >= today).reduce((s, d) => s + Math.max(0, state.settings.weekdays[weekdayOf(d)] ?? 0), 0)
    : capacity;
  const noRoomLeft = remainingFromToday === 0;
  const plannedMin = shown.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const bufferMin = shown.filter((b) => b.isBuffer).reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const editing = saved.find((b) => b.id === editingId) ?? null;
  const doneCount = saved.filter((b) => b.status === 'done').length;

  /** 排程统一入口：fill 只补没有块的任务，rebuild 清掉未完成块后整周重排 */
  async function runGenerate(mode: 'fill' | 'rebuild') {
    if (mode === 'rebuild' && hasSaved && !confirm('重新安排这一周？已完成的任务块会保留，其余会重新分配时间。')) return;
    setBusy(true);
    setNotice(mode === 'rebuild' ? '正在重新排程…' : '正在排程…');
    try {
      const added = await actions.generateWeek(weekStart, mode);
      setEverGenerated(true);
      if (added > 0) {
        setNotice(mode === 'rebuild' ? `已重排：排入 ${added} 个任务块` : `已补排 ${added} 个任务块`);
      } else if (noRoomLeft && isCurrentWeek) {
        setNotice('这一周从今天起已经排不出时间了，可用上方「为下周生成」');
      } else {
        setNotice('没有可排的任务：工时可能已排完，或都已排进这一周');
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '排程失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  async function checkReplan() {
    setReplanBusy(true);
    setReplanMsg('正在评估…');
    try {
      const res = await actions.replan(weekStart);
      setReplanData(res);
      setReplanMsg(
        res.blocked
          ? '连续多次重排仍未达标，建议调整目标而不是继续排'
          : res.trigger.triggered
            ? '检测到需要调整的信号，下面是四个可选方案'
            : '当前节奏正常，暂时不需要重排',
      );
    } catch (err) {
      setReplanMsg(err instanceof Error ? err.message : '评估失败');
    } finally {
      setReplanBusy(false);
    }
  }

  async function useOption(key: 'defer' | 'compress' | 'substitute' | 'drop', label: string) {
    if (!confirm(`采用「${label}」？这一周未完成的任务块会被重新安排。`)) return;
    setReplanBusy(true);
    try {
      const count = await actions.applyReplan(weekStart, key);
      setReplanData(null);
      setReplanMsg(`已采用「${label}」，这是本周第 ${count} 次重排`);
      setNotice(`已应用「${label}」`);
    } catch (err) {
      setReplanMsg(err instanceof Error ? err.message : '应用失败');
    } finally {
      setReplanBusy(false);
    }
  }

  if (!state.goal || items.length === 0) {
    return (
      <div className="page page-enter">
        <header className="page-head">
          <div>
            <div className="eyebrow">WEEK · 周视图</div>
            <h1>周视图</h1>
            <p className="sub">先生成目标和计划项，才能排出这一周。</p>
          </div>
        </header>
        <Panel>
          <Empty title="没有可排的计划" desc="到「目标」页添加计划项后回到这里。" />
        </Panel>
      </div>
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
    <div className="page page-enter">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="live" />
            {weekStart} — {addDays(weekStart, 6)}
          </div>
          <h1>这一周怎么用</h1>
          <p className="sub">
            {hasSaved ? (
              <>
                已完成 <b>{doneCount}</b> 项 · 共 <b>{saved.length}</b> 个任务块
              </>
            ) : (
              '以下为排程预览，点击「生成本周计划」后写入'
            )}
          </p>
        </div>
        <div className="head-actions">
          <Button className="btn-icon" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="上一周">
            ‹
          </Button>
          <Button onClick={() => setWeekStart(startOfWeek(todayISO(), state.settings.weekStart))}>本周</Button>
          <Button className="btn-icon" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="下一周">
            ›
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void runGenerate(hasSaved ? 'rebuild' : 'fill')}>
            {busy ? '排程中…' : hasSaved ? '重新排这一周' : '生成本周计划'}
          </Button>
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}

      <Panel flush>
        <div className="week-stats">
          <div className="wk">
            <span>本周可用</span>
            <b>
              {(capacity / 60).toFixed(1)}
              <small>小时</small>
            </b>
          </div>
          <div className="wk">
            <span>已排计划</span>
            <b>
              {(plannedMin / 60).toFixed(1)}
              <small>小时</small>
            </b>
          </div>
          <div className="wk">
            <span>占用率</span>
            <b>
              {capacity > 0 ? Math.round((plannedMin / capacity) * 100) : '—'}
              {capacity > 0 && <small>%</small>}
            </b>
          </div>
          <div className="wk">
            <span>弹性位占用</span>
            <b>
              {Math.round(bufferMin)}
              <small>分钟</small>
            </b>
          </div>
        </div>

        <div className="panel-body tight" style={{ paddingTop: 0 }}>
          <div className="meter-row">
            <span>容量</span>
            <Meter value={plannedMin} max={Math.max(capacity, plannedMin)} tone={plannedMin > capacity ? 'red' : 'green'} />
            <span className="mono">
              {fmtDuration(plannedMin)} / {fmtDuration(capacity)}
            </span>
          </div>
        </div>

        <div className="week scroll">
          {dates.map((date) => {
            const dayBlocks = shown.filter((b) => b.date === date);
            const dayPlanned = dayBlocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
            const cap = Math.max(0, state.settings.weekdays[weekdayOf(date)] ?? 0);
            const isToday = date === today;
            const fill = cap > 0 ? Math.min(100, Math.round((dayPlanned / cap) * 100)) : 0;
            return (
              <div key={date} className={`day ${isToday ? 'day-today' : ''}`}>
                <div className="day-head">
                  <span>{WEEKDAY_LABEL[weekdayOf(date)]}</span>
                  <b>{date.slice(8)}</b>
                </div>
                <div className="day-cap">
                  <i className={fill > 100 ? 'full' : ''} style={{ width: `${fill}%` }} />
                </div>
                <div className="day-body">
                  {dayBlocks.length === 0 ? (
                    <span className="slot-empty">{cap === 0 ? '休息' : '留白'}</span>
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
                            {b.locked ? ' · 🔒' : ''}
                          </small>
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
      </Panel>

      <Panel
        title="重排建议"
        desc="按「顺延 → 压缩 → 替代 → 放弃」给出方案，每个方案都标明代价与未来 7 天负载增幅"
        action={
          <Button variant="ghost" size="sm" disabled={replanBusy} onClick={() => void checkReplan()}>
            {replanBusy ? '评估中…' : '评估是否需要重排'}
          </Button>
        }
      >
        {replanMsg && <p className="notice">{replanMsg}</p>}

        {replanData && (
          <>
            <ul className="bullets" style={{ marginTop: 8 }}>
              {replanData.trigger.reasons.map((r) => (
                <li key={r.code}>
                  <b>{r.label}</b> · {r.detail}
                </li>
              ))}
              {replanData.trigger.reasons.length === 0 && <li>没有触发条件，保持当前节奏即可。</li>}
            </ul>

            {replanData.blocked && replanData.calibration && (
              <div className="hint-bar" style={{ marginTop: 12 }}>
                <span>{replanData.calibration}</span>
              </div>
            )}

            {!replanData.blocked && (
              <div className="opt-grid" style={{ marginTop: 14 }}>
                {replanData.options.map((o) => {
                  const off = !o.applicable || !o.feasible;
                  return (
                    <article key={o.key} className={`opt-card ${off ? 'is-off' : ''}`}>
                      <h3>
                        {o.label}
                        {!o.applicable && <span className="pill tone-quiet">不适用</span>}
                        {o.applicable && !o.feasible && <span className="pill tone-amber">超载</span>}
                      </h3>
                      <p className="muted">{o.reason}</p>
                      <div className="meta">
                        <span>新增 {o.summary.added}</span>
                        <span>延期 {o.summary.deferred}</span>
                        <span>放弃 {o.summary.dropped}</span>
                        <span>
                          负载 {o.loadIncreasePct >= 0 ? '+' : ''}
                          {o.loadIncreasePct}%
                        </span>
                      </div>
                      <p className="muted small">代价：{o.cost}</p>
                      <Button
                        variant={off ? 'quiet' : 'primary'}
                        size="sm"
                        disabled={off || replanBusy}
                        onClick={() => void useOption(o.key, o.label)}
                      >
                        {off ? '当前不可用' : '采用这个方案'}
                      </Button>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Panel>

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

      {!hasSaved && !previewable && (
        <div className="hint-bar">
          <span>
            {weekStart} — {addDays(weekStart, 6)} 这一周还没有排计划。点「生成本周计划」把待完成任务排进这一周的可用时段。
          </span>
        </div>
      )}

      {editing && (
        <Panel
          title="调整任务时间"
          desc={`${itemMap.get(editing.itemId)?.title ?? '任务'} · 时长 ${fmtDuration(editing.endMin - editing.startMin)}（不可在此修改）`}
        >
          {editing.locked && (
            <p className="notice">🔒 已锁定：重排、重建都不会改动这个时间；解锁后才能调整。</p>
          )}
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
          <div className="row" style={{ marginTop: 14 }}>
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
              variant="ghost"
              onClick={() => {
                setEditError('');
                void actions
                  .setBlockLocked(editing.id, !editing.locked)
                  .then(() => setNotice(editing.locked ? '已解锁' : '已锁定：重排与重建都会保留这个时间'))
                  .catch((err: unknown) => setEditError(err instanceof Error ? err.message : '操作失败'));
              }}
            >
              {editing.locked ? '解锁' : '锁定此时间'}
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
        </Panel>
      )}

      <div className="split-2">
        {packed.overflow.length > 0 ? (
          <Panel title={`装不下的计划项（${packed.overflow.length}）`} desc="容量不足，剩余部分会留到下一周">
            <ul className="item-list">
              {packed.overflow.map((o) => (
                <li key={o.item.id}>
                  <strong title={o.item.title}>{o.item.title}</strong>
                  <span className="muted">剩余 {fmtDuration(o.remainingMin ?? o.item.estimateMin)}</span>
                  <Button variant="quiet" size="sm" onClick={() => void actions.removeItem(o.item.id)}>
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <Panel className="insight-card" title="排程说明">
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
          </Panel>
        )}

        <Panel title="本周节奏" desc="柱高 = 当天已排时长占可用时长">
          <div className="stack-tight">
            {dates.map((d) => {
              const min = shown.filter((b) => b.date === d).reduce((s, b) => s + (b.endMin - b.startMin), 0);
              const cap = Math.max(1, state.settings.weekdays[weekdayOf(d)] ?? 0);
              return (
                <div key={d} className="fc">
                  <b>{WEEKDAY_LABEL[weekdayOf(d)]}</b>
                  <div>
                    <div className="fc-bar">
                      <i style={{ width: `${Math.min(100, (min / cap) * 100)}%` }} />
                    </div>
                    <small>{min === 0 ? '留白' : `${(min / 60).toFixed(1)} / ${(cap / 60).toFixed(1)} 小时`}</small>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {hasSaved && editing === null && (
        <div className="center-note">点任务块上的「调整」可以改日期与开始时间，时长保持不变。</div>
      )}
    </div>
  );
}
