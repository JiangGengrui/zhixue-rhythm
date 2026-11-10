import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Panel, Stat, ThemeToggle } from '../components';
import { api } from '../data/api';
import type { Settings } from '../domain/types';
import type { AppState, Actions } from '../store';

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function SettingsPage({
  state,
  actions,
  theme,
  onToggleTheme,
}: {
  state: AppState;
  actions: Actions;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}) {
  const [hours, setHours] = useState(() => state.settings.weekdays.map((m) => Math.round((m / 60) * 10) / 10));
  const [weekStart, setWeekStart] = useState<0 | 1>(state.settings.weekStart);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const totalMinutes = useMemo(
    () => hours.reduce((s, h) => s + Math.max(0, Math.round(h * 60)), 0),
    [hours],
  );

  async function save() {
    setBusy(true);
    setNotice('');
    try {
      const next: Settings = {
        weekStart,
        weekdays: hours.map((h) => Math.max(0, Math.min(1440, Math.round(h * 60)))),
      };
      await actions.updateSettings(next);
      setNotice('已保存。重新生成周计划后会按新容量排程。');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page-enter">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="live" />
            SETTINGS · 系统
          </div>
          <h1>设置</h1>
          <p className="sub">
            演示模式 · 免登录，数据保存在本机服务端
          </p>
        </div>
      </header>

      <div className="grid-main">
        <div className="col">
          <Panel title="每周可用时间" desc="排程只在以下时段内安排">
            <div className="stat-row" style={{ marginBottom: 16 }}>
              <Stat label="每周合计" value={(totalMinutes / 60).toFixed(1)} unit="小时" />
              <Stat
                label="周末占比"
                value={totalMinutes > 0 ? String(Math.round(((hours[0]! + hours[6]!) * 60 / totalMinutes) * 100)) : '—'}
                unit={totalMinutes > 0 ? '%' : undefined}
                note="周日 + 周六"
              />
            </div>

            <div className="day-grid">
              {DAYS.map((label, i) => (
                <label key={label} className="day-field">
                  <span>{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={24}
                    step={0.5}
                    value={hours[i]}
                    onChange={(e) => {
                      const next = [...hours];
                      next[i] = Math.max(0, Math.min(24, Number(e.target.value) || 0));
                      setHours(next);
                    }}
                  />
                  <small>小时</small>
                </label>
              ))}
            </div>

            <div className="form-grid" style={{ marginTop: 16, maxWidth: 260 }}>
              <Field label="每周起始日" hint="影响周视图与周报的统计区间">
                <select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value) === 0 ? 0 : 1)}>
                  <option value={1}>周一</option>
                  <option value={0}>周日</option>
                </select>
              </Field>
            </div>

            <div className="row" style={{ marginTop: 16 }}>
              <Button variant="primary" onClick={() => void save()} disabled={busy}>
                {busy ? '保存中…' : '保存设置'}
              </Button>
              {notice && <span className="notice">{notice}</span>}
            </div>
          </Panel>

          <Panel title="数据" desc="存在本机 SQLite，可随时导出">
            <ul className="bullets">
              <li>演示版免登录，打开即是同一个演示账号。</li>
              <li>数据写入运行目录的 data/zhixue.db，重启不丢。</li>
            </ul>

            <div className="row" style={{ marginTop: 14 }}>
              <Button onClick={() => { location.href = api.exportUrl('json'); }}>导出全部数据（JSON）</Button>
              <Button onClick={() => { location.href = api.exportUrl('csv'); }}>导出任务记录（CSV）</Button>
            </div>
          </Panel>

          {state.user?.isAdmin && <FeedbackAdmin />}
        </div>

        <div className="col">
          <Panel title="外观">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <b style={{ fontSize: 12 }}>{theme === 'dark' ? '深空' : '冷光'}</b>
                <p className="muted" style={{ marginTop: 4 }}>
                  {theme === 'dark' ? '适合夜间与长时间专注' : '适合白天与明亮环境'}
                </p>
              </div>
              <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            </div>
          </Panel>

          <Panel title="本周概览" desc="当前演示账号的数据">
            <div className="stack-tight">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">本周任务块</span>
                <b className="mono">{state.blocks.length}</b>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">计划项</span>
                <b className="mono">{state.items.length}</b>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}


function FeedbackAdmin() {
  const [items, setItems] = useState<
    Array<{ id: number; nickname: string | null; content: string; createdAt: string; hidden: boolean }>
  >([]);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api
      .adminFeedback()
      .then((res) => setItems(res.items))
      .catch((err: unknown) => setMsg(err instanceof Error ? err.message : '加载失败'));
  }, []);

  async function toggle(id: number, restore: boolean) {
    try {
      await api.setFeedbackHidden(id, restore);
      const res = await api.adminFeedback();
      setItems(res.items);
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : '操作失败');
    }
  }

  return (
    <Panel title="留言管理" desc="主页留言板的公开内容；隐藏后访客不可见，可恢复。">
      {msg && <p className="notice">{msg}</p>}
      {items.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>暂无留言。</p>
      ) : (
        <ul className="bullets">
          {items.map((f) => (
            <li key={f.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ flex: 1 }}>
                <b style={{ fontSize: 12 }}>{f.nickname || '匿名'}</b>
                            <span style={{ fontSize: 12 }}>：{f.content}</span>
                {f.hidden && <span className="pill tone-amber">已隐藏</span>}
              </span>
              <Button variant="quiet" size="sm" onClick={() => void toggle(f.id, f.hidden)}>
                {f.hidden ? '恢复' : '隐藏'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
