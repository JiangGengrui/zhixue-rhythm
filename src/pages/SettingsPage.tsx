import { useMemo, useState } from 'react';
import { Button, Card, Field, Stat } from '../components';
import type { Settings } from '../domain/types';
import type { AppState, Actions } from '../store';

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function SettingsPage({ state, actions }: { state: AppState; actions: Actions }) {
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
    <div className="stack">
      <Card title="每周可用时间" desc="排程只会使用这些时段；周末留白也是一种选择。">
        <div className="stats">
          <Stat label="每周合计" value={(totalMinutes / 60).toFixed(1)} unit="小时" />
          <Stat label="每日上限" value="24" unit="小时" />
          <Stat
            label="周末占比"
            value={totalMinutes > 0 ? `${Math.round(((hours[0]! + hours[6]!) * 60 / totalMinutes) * 100)}%` : '—'}
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

        <div className="form-grid">
          <Field label="每周起始日" hint="影响周视图与周报的统计区间">
            <select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value) === 0 ? 0 : 1)}>
              <option value={1}>周一</option>
              <option value={0}>周日</option>
            </select>
          </Field>
        </div>

        <div className="row">
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存设置'}
          </Button>
          {notice && <span className="notice">{notice}</span>}
        </div>
      </Card>

      <Card title="账号与数据" desc="数据保存在服务端，按账号隔离。">
        <ul className="bullets">
          <li>当前账号：{state.user?.name}（{state.user?.email}）</li>
          <li>会话有效期 30 天，退出后需重新登录。</li>
          <li>删除计划项会同时清理其在本周的任务块，已完成的记录不再计入周报。</li>
        </ul>
      </Card>
    </div>
  );
}
