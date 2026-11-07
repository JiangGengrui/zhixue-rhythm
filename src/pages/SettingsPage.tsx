import { useMemo, useState } from 'react';
import { Button, Card, Field, Stat } from '../components';
import { api } from '../data/api';
import type { Settings } from '../domain/types';
import type { AppState, Actions } from '../store';

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function SettingsPage({ state, actions }: { state: AppState; actions: Actions }) {
  const [hours, setHours] = useState(() => state.settings.weekdays.map((m) => Math.round((m / 60) * 10) / 10));
  const [weekStart, setWeekStart] = useState<0 | 1>(state.settings.weekStart);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [delMsg, setDelMsg] = useState('');
  const [delBusy, setDelBusy] = useState(false);

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

      <Card title="修改密码" desc="修改成功后，其它设备上的登录会话会全部失效。">
        <div className="form-grid">
          <Field label="当前密码">
            <input
              type="password"
              value={curPwd}
              autoComplete="current-password"
              onChange={(e) => setCurPwd(e.target.value)}
            />
          </Field>
          <Field label="新密码" hint="至少 8 位">
            <input
              type="password"
              value={newPwd}
              autoComplete="new-password"
              onChange={(e) => setNewPwd(e.target.value)}
            />
          </Field>
        </div>
        <div className="row">
          <Button
            variant="primary"
            disabled={pwdBusy}
            onClick={async () => {
              setPwdMsg('');
              if (newPwd.length < 8) {
                setPwdMsg('新密码至少 8 位');
                return;
              }
              setPwdBusy(true);
              try {
                await actions.changePassword(curPwd, newPwd);
                setCurPwd('');
                setNewPwd('');
                setPwdMsg('密码已更新，当前设备保持登录');
              } catch (err) {
                setPwdMsg(err instanceof Error ? err.message : '修改失败');
              } finally {
                setPwdBusy(false);
              }
            }}
          >
            {pwdBusy ? '保存中…' : '保存新密码'}
          </Button>
          {pwdMsg && <span className="notice">{pwdMsg}</span>}
        </div>
      </Card>

      <Card title="账号与数据" desc="数据保存在服务端，按账号隔离，可随时导出带走。">
        <ul className="bullets">
          <li>当前账号：{state.user?.name}（{state.user?.email}）</li>
          <li>会话有效期 30 天，退出后需重新登录。</li>
          <li>删除计划项会同时清理其在本周的任务块，已完成的记录不再计入周报。</li>
        </ul>

        <div className="row">
          <Button onClick={() => { location.href = api.exportUrl('json'); }}>导出全部数据（JSON）</Button>
          <Button onClick={() => { location.href = api.exportUrl('csv'); }}>导出任务记录（CSV）</Button>
        </div>

        <div className="danger-zone">
          <strong>注销账号</strong>
          <p className="muted">目标、计划项与全部打卡记录会被永久删除，无法恢复。</p>
          <div className="row">
            <input
              type="password"
              placeholder="输入密码确认"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <Button
              variant="danger"
              disabled={delBusy}
              onClick={async () => {
                if (!password) {
                  setDelMsg('请输入密码');
                  return;
                }
                if (!confirm('注销后所有数据将被永久删除，确定继续？')) return;
                setDelBusy(true);
                setDelMsg('');
                try {
                  await actions.deleteAccount(password);
                } catch (err) {
                  setDelMsg(err instanceof Error ? err.message : '注销失败');
                } finally {
                  setDelBusy(false);
                }
              }}
            >
              {delBusy ? '注销中…' : '注销账号'}
            </Button>
          </div>
          {delMsg && <span className="warn">{delMsg}</span>}
        </div>
      </Card>
    </div>
  );
}
