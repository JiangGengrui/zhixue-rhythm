import { useMemo, useState } from 'react';
import { Button, Card, Empty, Meter, Stat } from '../components';
import { addDays, fmtDuration, fmtHM, startOfWeek, todayISO, weekdayOf } from '../domain/date';
import { SUBJECT_LABEL } from '../domain/types';
import type { Block } from '../domain/types';
import type { AppState, Actions } from '../store';

export function TodayPage({ state, actions }: { state: AppState; actions: Actions }) {
  const today = todayISO();
  const [editing, setEditing] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(0);

  const itemMap = useMemo(() => new Map(state.items.map((i) => [i.id, i])), [state.items]);
  const blocks = useMemo(
    () => state.blocks.filter((b) => b.date === today).sort((a, b) => a.startMin - b.startMin),
    [state.blocks, today],
  );
  const done = blocks.filter((b) => b.status === 'done');
  const plannedMin = blocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const effectiveMin = done.reduce((s, b) => s + (b.actualMin ?? b.endMin - b.startMin), 0);

  function startComplete(b: Block) {
    setEditing(b.id);
    setMinutes(b.endMin - b.startMin);
  }

  if (!state.goal) {
    return (
      <Card title="今日" desc="先建立目标，今天才有内容可执行。">
        <Empty
          title="还没有目标"
          desc="载入示例数据可以立刻体验完整链路。"
          action={
            <Button variant="primary" onClick={actions.seedDemo}>
              载入示例数据
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card
        title={today}
        desc={`${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekdayOf(today)]} · 今天 ${blocks.length} 项`}
        action={
          <Button
            onClick={() => actions.generateWeek(startOfWeek(today, state.settings.weekStart))}
            variant="quiet"
          >
            生成本周计划
          </Button>
        }
      >
        <div className="stats">
          <Stat label="今日计划" value={(plannedMin / 60).toFixed(1)} unit="小时" />
          <Stat label="已完成" value={String(done.length)} unit={`/ ${blocks.length}`} />
          <Stat label="实际投入" value={(effectiveMin / 60).toFixed(1)} unit="小时" />
        </div>
        <div className="meter-row">
          <span>进度</span>
          <Meter value={done.length} max={Math.max(1, blocks.length)} />
          <span className="muted">
            {blocks.length === 0 ? '—' : `${Math.round((done.length / blocks.length) * 100)}%`}
          </span>
        </div>
      </Card>

      {blocks.length === 0 ? (
        <Card title="今天没有安排">
          <Empty
            title="这一周还没排计划"
            desc="去周视图生成计划，或直接点上面的按钮。"
            action={
              <Button
                variant="primary"
                onClick={() => actions.generateWeek(startOfWeek(today, state.settings.weekStart))}
              >
                生成本周计划
              </Button>
            }
          />
        </Card>
      ) : (
        <Card title="今天的任务" desc="点「开始」进入执行，完成后填写实际用时。">
          <ul className="task-list">
            {blocks.map((b) => {
              const item = itemMap.get(b.itemId);
              const planned = b.endMin - b.startMin;
              return (
                <li key={b.id} className={`task task-${b.status}`}>
                  <div className="task-time">
                    <strong>{fmtHM(b.startMin)}</strong>
                    <small>{fmtDuration(planned)}</small>
                  </div>
                  <div className="task-main">
                    <div className="task-title">
                      {item && <span className={`tag tag-${item.subject}`}>{SUBJECT_LABEL[item.subject]}</span>}
                      <strong>{item?.title ?? '已删除的任务'}</strong>
                      {b.isBuffer && <span className="tag tag-buffer">弹性位</span>}
                    </div>
                    <div className="task-meta">
                      <StatusText block={b} />
                    </div>
                  </div>
                  <div className="task-actions">
                    {b.status === 'pending' && (
                      <>
                        <Button variant="primary" onClick={() => actions.setBlockStatus(b.id, 'running')}>
                          开始
                        </Button>
                        <Button onClick={() => startComplete(b)}>直接完成</Button>
                        <Button
                          variant="quiet"
                          onClick={() => actions.setBlockStatus(b.id, 'skipped', undefined, 'other')}
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
                        <Button
                          variant="quiet"
                          onClick={() => actions.setBlockStatus(b.id, 'skipped', undefined, 'interrupt')}
                        >
                          中断放弃
                        </Button>
                      </>
                    )}
                    {b.status === 'done' && (
                      <Button variant="quiet" onClick={() => actions.setBlockStatus(b.id, 'pending')}>
                        撤销
                      </Button>
                    )}
                    {b.status === 'skipped' && (
                      <Button variant="quiet" onClick={() => actions.setBlockStatus(b.id, 'pending')}>
                        恢复
                      </Button>
                    )}
                  </div>
                  {editing === b.id && (
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
                      <Button
                        variant="primary"
                        onClick={() => {
                          const safe = Math.max(1, Math.round(minutes));
                          actions.setBlockStatus(b.id, 'done', safe);
                          setEditing(null);
                        }}
                      >
                        确认完成
                      </Button>
                      <Button variant="quiet" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card title="明天之后" desc="提前看一眼，避免临时赶工。">
        <ul className="bullets">
          {[1, 2].map((offset) => {
            const date = addDays(today, offset);
            const list = state.blocks.filter((b) => b.date === date);
            return (
              <li key={date}>
                {date}：{list.length === 0 ? '暂无安排' : `${list.length} 项，共 ${fmtDuration(list.reduce((s, b) => s + (b.endMin - b.startMin), 0))}`}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function StatusText({ block }: { block: Block }) {
  if (block.status === 'done') {
    return <span className="ok">已完成 · 实际 {fmtDuration(block.actualMin ?? block.endMin - block.startMin)}</span>;
  }
  if (block.status === 'running') return <span className="running">执行中…</span>;
  if (block.status === 'skipped') {
    return (
      <span className="warn">
        已跳过 · {block.skipReason === 'interrupt' ? '被打断' : block.skipReason === 'capacity' ? '容量不足' : '主动跳过'}
      </span>
    );
  }
  return <span className="muted">待开始</span>;
}
