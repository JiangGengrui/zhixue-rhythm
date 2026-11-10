import { useMemo, useState } from 'react';
import { Button, Empty, Field, Meter, Modal, Panel, Ring, Stat } from '../components';
import { feasibility } from '../domain/engine';
import { LEVEL_LABEL, SUBJECT_LABEL } from '../domain/types';
import type { GoalTemplate, Level, StageKey, Subject, Verdict } from '../domain/types';
import type { DecomposeResponse } from '../data/api';
import { daysBetween, fmtDuration, todayISO } from '../domain/date';
import type { AppState, Actions } from '../store';

const VERDICT_TEXT: Record<Verdict, { label: string; tone: string; advice: string }> = {
  'no-data': { label: '待补充', tone: 'quiet', advice: '先添加计划项，才能评估目标是否可行。' },
  comfortable: { label: '可以从容', tone: 'green', advice: '按当前节奏有余量，可以把弹性位留大一些。' },
  reasonable: { label: '合理', tone: 'green', advice: '需求与可用时间基本匹配，按周推进即可。' },
  tight: { label: '偏紧', tone: 'amber', advice: '需要稳定执行，建议减少低优先级任务。' },
  infeasible: { label: '不可行', tone: 'red', advice: '需求远超可用时间，请延长周期或缩小范围。' },
};

const TEMPLATES: Array<{ key: GoalTemplate; label: string }> = [
  { key: 'postgrad-cs', label: '考研 · 计算机' },
  { key: 'civil-service', label: '考公 · 行测申论' },
  { key: 'project-self', label: '项目导学' },
];
const STAGE_TEXT: Record<StageKey, string> = { foundation: '基础', strengthen: '强化', sprint: '冲刺' };
const REASON_TEXT: Record<string, string> = {
  'low-priority': '低频低分',
  mastered: '已有基础',
  merged: '已合并',
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
  const [goalOpen, setGoalOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [template, setTemplate] = useState<GoalTemplate>('postgrad-cs');
  const [plan, setPlan] = useState<DecomposeResponse | null>(null);
  const [draftRows, setDraftRows] = useState<
    Array<{ key: string; title: string; subject: string; estimateMin: number; weight: number; included: boolean }>
  >([]);
  const [planBusy, setPlanBusy] = useState(false);
  const [planMsg, setPlanMsg] = useState('');

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
    actions
      .setGoal({
        id: goal?.id ?? `goal_${crypto.randomUUID().slice(0, 8)}`,
        title: form.title.trim(),
        deadline: form.deadline,
        weeklyMinutes,
        level: form.level,
        createdAt: goal?.createdAt ?? new Date().toISOString(),
      })
      // 服务端会把"每周可用"同步成每日可用时段，这里拉一次让容量立刻对齐
      .then(() => actions.refresh())
      .catch(() => undefined);
    setGoalOpen(false);
    setNotice('目标已保存');
  }

  function addItem() {
    if (!goal) {
      setNotice('请先设置目标');
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
      title: draft.title.trim(),
      subject: draft.subject,
      estimateMin: Math.round(draft.minutes),
      weight: draft.weight,
    });
    setDraft({ ...draft, title: '' });
    setNotice('已添加计划项');
  }

  async function previewPlan() {
    if (!goal) {
      setPlanMsg('请先设置目标');
      return;
    }
    setPlanBusy(true);
    setPlanMsg('正在拆解…');
    try {
      const res = await actions.decompose(template);
      setPlan(res);
      setDraftRows(
        res.result.items.map((i) => ({
          key: i.key,
          title: i.title,
          subject: i.subject,
          estimateMin: i.estimateMin,
          weight: i.weight,
          included: true,
        })),
      );
      setPlanMsg(`已生成 ${res.result.items.length} 个计划项`);
    } catch (err) {
      setPlanMsg(err instanceof Error ? err.message : '拆解失败');
    } finally {
      setPlanBusy(false);
    }
  }

  async function adoptPlan() {
    if (!plan) return;
    const chosen = draftRows.filter((r) => r.included);
    if (chosen.length === 0) {
      setPlanMsg('至少保留一条计划项。');
      return;
    }
    const minutes = chosen.reduce((sum, r) => sum + r.estimateMin, 0);
    const ok = confirm(
      `将用 ${chosen.length} 条计划项（共 ${(minutes / 60).toFixed(1)} 小时）替换现有的 ${items.length} 条，并清空已排任务块。确定吗？`,
    );
    if (!ok) return;
    setPlanBusy(true);
    setPlanMsg('正在写入…');
    try {
      const res = await actions.decompose(
        template,
        true,
        chosen.map((r) => ({ title: r.title.trim() || r.key, subject: r.subject, estimateMin: Math.round(r.estimateMin), weight: r.weight })),
      );
      setPlan(res);
      setPlanMsg(`已写入 ${res.applied} 条计划项，去「周视图」生成这一周的计划`);
      setPlanOpen(false);
      setNotice(`已按草案写入 ${res.applied} 条计划项`);
    } catch (err) {
      setPlanMsg(err instanceof Error ? err.message : '写入失败');
    } finally {
      setPlanBusy(false);
    }
  }

  const totalMin = items.reduce((s, i) => s + i.estimateMin, 0);

  const goalForm = (
    <>
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
      {notice && <p className="notice" style={{ marginTop: 12 }}>{notice}</p>}
    </>
  );

  const goalModal = (
    <Modal
      open={goalOpen}
      title="设置目标"
      desc="目标日期与每周可用时间决定排程容量"
      onClose={() => setGoalOpen(false)}
      footer={
        <>
          <Button variant="quiet" onClick={() => setGoalOpen(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={saveGoal}>
            保存
          </Button>
        </>
      }
    >
      {goalForm}
    </Modal>
  );

  if (!goal) {
    return (
      <div className="page page-enter">
        <header className="page-head">
          <div>
            <div className="eyebrow">GOAL · 目标</div>
            <h1>还没有目标</h1>
            <p className="sub">设置目标后就能添加计划项、生成排程。</p>
          </div>
          <div className="head-actions">
            <Button onClick={actions.seedDemo}>载入示例</Button>
            <Button variant="primary" onClick={() => setGoalOpen(true)}>
              设置目标
            </Button>
          </div>
        </header>
        <Panel>
          <Empty
            title="先设置一个目标"
            desc="填目标名称、日期与每周可用时间即可；也可以直接载入示例数据体验完整链路。"
            action={
              <Button variant="primary" onClick={() => setGoalOpen(true)}>
                设置目标
              </Button>
            }
          />
        </Panel>
        {goalModal}
      </div>
    );
  }

  const demand = result!.demandMin;
  const available = result!.availableMin;
  const verdict = VERDICT_TEXT[result!.verdict];
  const loadPct = Math.round((demand / Math.max(1, available)) * 100);
  const leftDays = daysBetween(todayISO(), goal.deadline);

  return (
    <div className="page page-enter">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="live" />
            GOAL · 目标日期 {goal.deadline}
            {leftDays >= 0 ? ` · 还有 ${leftDays} 天` : ' · 已过期'}
          </div>
          <h1>{goal.title}</h1>
          <p className="sub">
            每周可用 <b>{(goal.weeklyMinutes / 60).toFixed(1)} 小时</b> · 基础水平 <b>{LEVEL_LABEL[goal.level]}</b>
          </p>
        </div>
        <div className="head-actions">
          <span className={`pill tone-${verdict.tone}`}>{verdict.label}</span>
          <Button onClick={() => setPlanOpen(true)}>智能拆解</Button>
          <Button variant="primary" onClick={() => setGoalOpen(true)}>
            设置目标
          </Button>
        </div>
      </header>

      {notice && <p className="notice">{notice}</p>}

      <div className="grid-main goal-grid">
        <div className="col">
          <section className="panel accent rise">
            <div className="hero-row">
              <Ring value={demand} max={Math.max(available, demand)} label="负载率" size={132} />
              <div className="stat-row">
                <Stat label="需求工时" value={(demand / 60).toFixed(1)} unit="小时" />
                <Stat
                  label="可用工时"
                  value={(available / 60).toFixed(1)}
                  unit="小时"
                  note={`剩余 ${result!.weeksLeft} 周`}
                />
                <Stat
                  label="可行性 R"
                  value={Number.isFinite(result!.ratio) ? result!.ratio.toFixed(2) : '∞'}
                />
                <Stat label="计划项" value={String(items.length)} unit="项" />
              </div>
            </div>
            <div className="panel-body" style={{ paddingTop: 0 }}>
              <div className="meter-row">
                <span>负载 {loadPct}%</span>
                <Meter
                  value={demand}
                  max={Math.max(available, demand)}
                  tone={result!.verdict === 'infeasible' ? 'red' : result!.verdict === 'tight' ? 'amber' : 'green'}
                />
                <span className="mono">
                  {(demand / 60).toFixed(1)} / {(available / 60).toFixed(1)}h
                </span>
              </div>
              <p className="advice" style={{ marginTop: 14 }}>
                {verdict.advice}
              </p>
            </div>
          </section>
        </div>

        <div className="col">
          <Panel
            title="计划项"
            action={
              <span className="muted">
                {items.length} 项 · {fmtDuration(totalMin)}
              </span>
            }
          >
            {items.length === 0 ? (
              <Empty title="还没有计划项" desc="在下方添加具体任务，或点「智能拆解」批量生成。" />
            ) : (
              <ul className="item-list scroll-y">
                {items.map((i) => (
                  <li key={i.id}>
                    <span className={`tag tag-${i.subject}`}>{SUBJECT_LABEL[i.subject]}</span>
                    {/* 标题单独一行可换行，时长/剩余/权重收进第二行，窄栏里不再互相挤 */}
                    <strong title={i.title}>{i.title}</strong>
                    <span className="item-meta">
                      <span className="mono">{fmtDuration(i.estimateMin)}</span>
                      {typeof i.remainingMin === 'number' && i.remainingMin !== i.estimateMin && (
                        <span>剩 {fmtDuration(i.remainingMin)}</span>
                      )}
                      <span>W{i.weight}</span>
                    </span>
                    <Button variant="quiet" size="sm" onClick={() => actions.removeItem(i.id)} aria-label={`删除 ${i.title}`}>
                      删除
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="item-add" style={{ marginTop: 16 }}>
              <Field label="任务">
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
              <Field label="预估(分)">
                <input
                  type="number"
                  min={5}
                  step={5}
                  value={draft.minutes}
                  onChange={(e) => setDraft({ ...draft, minutes: Number(e.target.value) })}
                />
              </Field>
              <Field label="权重">
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={draft.weight}
                  onChange={(e) => setDraft({ ...draft, weight: Math.max(1, Math.min(5, Number(e.target.value))) })}
                />
              </Field>
              <Button variant="primary" onClick={addItem}>
                添加
              </Button>
            </div>
          </Panel>
        </div>
      </div>

      {goalModal}

      <Modal
        open={planOpen}
        title="智能拆解"
        desc="生成后可改工时与权重，取消勾选即放弃"
        width={760}
        onClose={() => setPlanOpen(false)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setPlanOpen(false)}>
              关闭
            </Button>
            <Button variant="primary" disabled={!plan || planBusy} onClick={() => void adoptPlan()}>
              采纳这份草案
            </Button>
          </>
        }
      >
        <div className="row" style={{ gap: 10, alignItems: 'end' }}>
          <Field label="目标类型">
            <select value={template} onChange={(e) => setTemplate(e.target.value as GoalTemplate)}>
              {TEMPLATES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="primary" size="sm" disabled={planBusy} onClick={() => void previewPlan()}>
            {planBusy ? '处理中…' : '生成草案'}
          </Button>
        </div>
        {planMsg && <p className="notice" style={{ marginTop: 10 }}>{planMsg}</p>}

        {plan && (
          <>
            <div className="row" style={{ marginTop: 12, gap: 10, flexWrap: 'wrap' }}>
              <span className={`pill tone-${VERDICT_TEXT[plan.result.verdict].tone}`}>
                {VERDICT_TEXT[plan.result.verdict].label}
              </span>
              <span className="muted mono">
                R {Number.isFinite(plan.result.ratio) ? plan.result.ratio.toFixed(2) : '∞'}
              </span>
              <span className="muted mono">
                {(plan.result.demandMin / 60).toFixed(1)}h / {(plan.result.availableMin / 60).toFixed(1)}h
              </span>
              <span className="muted mono">{plan.result.weeksLeft} 周</span>
            </div>

            <div className="stack-tight" style={{ marginTop: 12 }}>
              {plan.result.stages.map((st) => (
                <div className="row" key={st.key} style={{ justifyContent: 'space-between' }}>
                  <span className="muted">
                    {STAGE_TEXT[st.key]} · {st.startDate} → {st.endDate}
                  </span>
                  <b className="mono">{(st.minutes / 60).toFixed(1)}h</b>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">
                  草案 {draftRows.filter((r) => r.included).length}/{draftRows.length}
                </span>
              </div>
              <div className="draft-list">
                {draftRows.map((row, index) => (
                  <div key={row.key} className={`draft-row ${row.included ? '' : 'is-off'}`}>
                    <label className="draft-check">
                      <input
                        type="checkbox"
                        checked={row.included}
                        onChange={(e) =>
                          setDraftRows((prev) =>
                            prev.map((r, i) => (i === index ? { ...r, included: e.target.checked } : r)),
                          )
                        }
                      />
                    </label>
                    <input
                      className="draft-title"
                      value={row.title}
                      onChange={(e) =>
                        setDraftRows((prev) =>
                          prev.map((r, i) => (i === index ? { ...r, title: e.target.value } : r)),
                        )
                      }
                    />
                    <input
                      className="draft-min"
                      type="number"
                      min={5}
                      step={5}
                      value={row.estimateMin}
                      onChange={(e) =>
                        setDraftRows((prev) =>
                          prev.map((r, i) =>
                            i === index ? { ...r, estimateMin: Math.max(5, Number(e.target.value) || 5) } : r,
                          ),
                        )
                      }
                    />
                    <select
                      className="draft-weight"
                      value={row.weight}
                      onChange={(e) =>
                        setDraftRows((prev) =>
                          prev.map((r, i) => (i === index ? { ...r, weight: Number(e.target.value) } : r)),
                        )
                      }
                    >
                      {[5, 4, 3, 2, 1].map((w) => (
                        <option key={w} value={w}>
                          权重 {w}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {plan.result.trimmed.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <span className="muted">被放弃项（{plan.result.trimmed.length}）</span>
                <ul className="bullets" style={{ marginTop: 6 }}>
                  {plan.result.trimmed.slice(0, 6).map((t) => (
                    <li key={t.id}>
                      {t.title} · {REASON_TEXT[t.reason] ?? t.reason} · {Math.round(t.minutes / 60)}h
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.result.warnings.length > 0 && (
              <ul className="bullets" style={{ marginTop: 10 }}>
                {plan.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
