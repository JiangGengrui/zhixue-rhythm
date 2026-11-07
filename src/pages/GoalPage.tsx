import { useMemo, useState } from 'react';
import { Button, Card, Empty, Field, Meter, Stat } from '../components';
import { feasibility } from '../domain/engine';
import { LEVEL_LABEL, SUBJECT_LABEL } from '../domain/types';
import type { Level, Subject, Verdict } from '../domain/types';
import { fmtDuration, todayISO } from '../domain/date';
import type { AppState, Actions } from '../store';

const VERDICT_TEXT: Record<Verdict, { label: string; tone: string; advice: string }> = {
  'no-data': { label: '待补充', tone: 'quiet', advice: '先添加计划项，才能评估目标是否可行。' },
  comfortable: { label: '可以从容', tone: 'green', advice: '按当前节奏有余量，可以把弹性位留大一些。' },
  reasonable: { label: '合理', tone: 'green', advice: '需求与可用时间基本匹配，按周推进即可。' },
  tight: { label: '偏紧', tone: 'amber', advice: '需要稳定执行，建议减少低优先级任务。' },
  infeasible: { label: '不可行', tone: 'red', advice: '需求远超可用时间，请延长周期或缩小范围。' },
};

export function GoalPage({ state, actions }: { state: AppState; actions: Actions }) {
  const goal = state.goal;
  const items = useMemo(
    () => state.items.filter((i) => i.goalId === goal?.id),
    [state.items, goal?.id],
  );
  const [form, setForm] = useState({
    title: goal?.title ?? '2027 考研 · 计算机科学',
    deadline: goal?.deadline ?? '2026-12-19',
    hours: Math.round(((goal?.weeklyMinutes ?? 600) / 60) * 10) / 10,
    level: (goal?.level ?? 'once') as Level,
  });
  const [draft, setDraft] = useState({
    title: '',
    subject: 'major' as Subject,
    minutes: 60,
    weight: 3,
  });
  const [notice, setNotice] = useState('');

  const result = useMemo(
    () => (goal ? feasibility(goal, items, todayISO()) : null),
    [goal, items],
  );

  function saveGoal() {
    if (!form.title.trim()) {
      setNotice('请填写目标名称');
      return;
    }
    if (!form.deadline) {
      setNotice('请选择目标日期');
      return;
    }
    const weeklyMinutes = Math.max(0, Math.round(form.hours * 60));
    if (weeklyMinutes <= 0) {
      setNotice('每周可用时间需要大于 0');
      return;
    }
    actions.setGoal({
      id: goal?.id ?? `goal_${crypto.randomUUID().slice(0, 8)}`,
      title: form.title.trim(),
      deadline: form.deadline,
      weeklyMinutes,
      level: form.level,
      createdAt: goal?.createdAt ?? new Date().toISOString(),
    });
    setNotice('目标已保存');
  }

  function addItem() {
    if (!goal) {
      setNotice('请先保存目标');
      return;
    }
    if (!draft.title.trim()) {
      setNotice('请填写任务名称');
      return;
    }
    if (draft.minutes <= 0) {
      setNotice('预估工时要大于 0');
      return;
    }
    actions.addItem({
      goalId: goal.id,
      title: draft.title.trim(),
      subject: draft.subject,
      estimateMin: Math.round(draft.minutes),
      weight: draft.weight,
    });
    setDraft({ ...draft, title: '' });
    setNotice('已添加计划项');
  }

  if (!goal) {
    return (
      <Card title="还没有目标" desc="目标决定后面所有排程与复盘的基准。">
        <Empty
          title="先建一个目标，或直接载入示例"
          desc="示例包含 8 个考研计划项，可用来体验完整链路。"
          action={
            <div className="row">
              <Button variant="primary" onClick={actions.seedDemo}>
                载入示例数据
              </Button>
            </div>
          }
        />
        <div className="form-grid">
          <Field label="目标名称">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="目标日期">
            <input
              type="date"
              value={form.deadline}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            />
          </Field>
          <Field label="每周可用（小时）">
            <input
              type="number"
              min={0}
              step={0.5}
              value={form.hours}
              onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })}
            />
          </Field>
          <Field label="基础水平">
            <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as Level })}>
              {Object.entries(LEVEL_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row">
          <Button variant="primary" onClick={saveGoal}>
            保存目标
          </Button>
          {notice && <span className="notice">{notice}</span>}
        </div>
      </Card>
    );
  }

  const demand = result!.demandMin;
  const available = result!.availableMin;

  return (
    <div className="stack">
      <Card
        title={goal.title}
        desc={`目标日期 ${goal.deadline} · 每周可用 ${(goal.weeklyMinutes / 60).toFixed(1)} 小时 · ${LEVEL_LABEL[goal.level]}`}
        action={
          <span className={`pill tone-${VERDICT_TEXT[result!.verdict].tone}`}>
            {VERDICT_TEXT[result!.verdict].label}
          </span>
        }
      >
        <div className="stats">
          <Stat label="需求工时" value={(demand / 60).toFixed(1)} unit="小时" note="含基础系数" />
          <Stat
            label="可用工时"
            value={(available / 60).toFixed(1)}
            unit="小时"
            note={`剩余 ${result!.weeksLeft} 周 · 已打 85 折`}
          />
          <Stat
            label="可行性 R"
            value={Number.isFinite(result!.ratio) ? result!.ratio.toFixed(2) : '∞'}
            note="需求 ÷ 可用"
          />
          <Stat label="计划项" value={String(items.length)} unit="项" />
        </div>
        <div className="meter-row">
          <span>负载</span>
          <Meter
            value={demand}
            max={Math.max(available, demand)}
            tone={result!.verdict === 'infeasible' ? 'red' : result!.verdict === 'tight' ? 'amber' : 'green'}
          />
          <span className="muted">{Math.round((demand / Math.max(1, available)) * 100)}%</span>
        </div>
        <p className="advice">{VERDICT_TEXT[result!.verdict].advice}</p>
      </Card>

      <Card
        title="计划项"
        desc="权重越高越先被排进本周；预估工时会按基础系数放大。"
        action={
          <span className="muted">
            合计 {fmtDuration(items.reduce((s, i) => s + i.estimateMin, 0))}
          </span>
        }
      >
        {items.length === 0 ? (
          <Empty title="还没有计划项" desc="添加几个具体任务，例如「高数 极限与连续 40 题 120 分钟」。" />
        ) : (
          <ul className="item-list">
            {items.map((i) => (
              <li key={i.id}>
                <span className={`tag tag-${i.subject}`}>{SUBJECT_LABEL[i.subject]}</span>
                <strong>{i.title}</strong>
                <span className="muted">{fmtDuration(i.estimateMin)}</span>
                <span className="muted">权重 {i.weight}</span>
                <Button variant="quiet" onClick={() => actions.removeItem(i.id)} aria-label={`删除 ${i.title}`}>
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="form-grid form-grid-4">
          <Field label="任务名称">
            <input
              value={draft.title}
              placeholder="例：408 图的最短路径"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field label="科目">
            <select
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value as Subject })}
            >
              {Object.entries(SUBJECT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="预估（分钟）">
            <input
              type="number"
              min={5}
              step={5}
              value={draft.minutes}
              onChange={(e) => setDraft({ ...draft, minutes: Number(e.target.value) })}
            />
          </Field>
          <Field label="权重 1-5">
            <input
              type="number"
              min={1}
              max={5}
              value={draft.weight}
              onChange={(e) => setDraft({ ...draft, weight: Math.max(1, Math.min(5, Number(e.target.value))) })}
            />
          </Field>
        </div>
        <div className="row">
          <Button variant="primary" onClick={addItem}>
            添加计划项
          </Button>
          {notice && <span className="notice">{notice}</span>}
        </div>
      </Card>
    </div>
  );
}
