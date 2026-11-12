import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Field, ThemeToggle } from '../components';
import type { Actions } from '../store';

type Mode = 'login' | 'register' | 'recover';

export function AuthPage({
  actions,
  error,
  theme,
  onToggleTheme,
  onBack,
  initialMode = 'login',
}: {
  actions: Pick<Actions, 'login' | 'register' | 'recover' | 'guestLogin'>;
  error: string | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onBack: () => void;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [guestBusy, setGuestBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [resetCode, setResetCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setLocalError(null);
    setPassword('');
    setNewPassword('');
    setCode('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setLocalError('请输入有效的邮箱');
      return;
    }

    if (mode === 'recover') {
      if (!code.trim()) {
        setLocalError('请输入恢复码');
        return;
      }
      if (newPassword.length < 8) {
        setLocalError('新密码至少 8 位');
        return;
      }
      setBusy(true);
      try {
        const rotated = await actions.recover(email.trim().toLowerCase(), code.trim(), newPassword);
        setResetCode(rotated);
        setMode('login');
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : '重置失败');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (password.length < 8) {
      setLocalError('密码至少 8 位');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') await actions.login(email.trim().toLowerCase(), password);
      else await actions.register(email.trim().toLowerCase(), password, name.trim() || '同学');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function guestLogin() {
    setLocalError(null);
    setGuestBusy(true);
    try {
      await actions.guestLogin();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '免注册登录失败');
    } finally {
      setGuestBusy(false);
    }
  }

  const eqBars = [16, 26, 20, 34, 24, 30, 18, 22];

  return (
    <div className="auth-wrap">
      <aside className="auth-side">
        <button type="button" className="auth-back" onClick={onBack}>
          <span aria-hidden="true">←</span>
          返回首页
        </button>

        <div>
          <span className="auth-kicker">RHYTHM OS · 学习空间</span>
          <h2>
            计划会变化，
            <br />
            <em>节律</em>帮你回到正轨
          </h2>
          <p>把长期目标拆成每天可执行的三件事，用周视图留出弹性，用周报复盘告诉你时间去了哪里。</p>
          <div className="auth-points">
            <div>
              <i />
              可行性 R 值先判定目标是否排得下
            </div>
            <div>
              <i />
              每周自动预留 15% 弹性位
            </div>
            <div>
              <i />
              偏差归因产出一条可执行建议
            </div>
          </div>
        </div>

        <div className="auth-eq" aria-hidden="true">
          {eqBars.map((h, i) => (
            <i key={i} style={{ height: h, animationDelay: `${i * 0.12}s` }} />
          ))}
        </div>
      </aside>

      <div className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="auth-brand">
              <span className="mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <div>
                <strong>智学节律</strong>
                <small>让计划跟得上现实</small>
              </div>
            </div>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>

          {resetCode ? (
            <div className="auth-done">
              <strong>密码已重置</strong>
              <p>这是新的恢复码，只显示这一次，请立即保存：</p>
              <code className="recovery-code">{resetCode}</code>
              <div className="row">
                <Button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(resetCode);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? '已复制' : '复制恢复码'}
                </Button>
                <Button variant="primary" onClick={() => setResetCode(null)} type="button">
                  去登录
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="auth-tabs">
                <button
                  type="button"
                  className={mode === 'login' ? 'active' : ''}
                  onClick={() => switchMode('login')}
                >
                  登录
                </button>
                <button
                  type="button"
                  className={mode === 'register' ? 'active' : ''}
                  onClick={() => switchMode('register')}
                >
                  注册
                </button>
                <button
                  type="button"
                  className={mode === 'recover' ? 'active' : ''}
                  onClick={() => switchMode('recover')}
                >
                  忘记密码
                </button>
              </div>

              <div className="auth-fields">
                <Field label="邮箱">
                  <input
                    type="email"
                    value={email}
                    autoComplete="email"
                    placeholder="you@example.com"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>

                {mode !== 'recover' && (
                  <Field label="密码" hint={mode === 'register' ? '至少 8 位字符' : undefined}>
                    <input
                      type="password"
                      value={password}
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      placeholder="••••••••"
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                )}

                {mode === 'register' && (
                  <Field label="昵称" hint="可留空，默认「同学」">
                    <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
                  </Field>
                )}

                {mode === 'recover' && (
                  <>
                    <Field label="恢复码" hint="注册时下发的一次性凭证，形如 ABCD-EFGH-JK">
                      <input
                        value={code}
                        placeholder="ABCD-EFGH-JK"
                        autoComplete="one-time-code"
                        onChange={(e) => setCode(e.target.value)}
                      />
                    </Field>
                    <Field label="新密码" hint="至少 8 位">
                      <input
                        type="password"
                        value={newPassword}
                        autoComplete="new-password"
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                    </Field>
                  </>
                )}
              </div>

              {(localError || error) && <p className="auth-error">{localError ?? error}</p>}

              <Button variant="primary" className="auth-submit" disabled={busy} type="submit">
                {busy ? '请稍候…' : mode === 'login' ? '登录' : mode === 'register' ? '创建账号' : '重置密码'}
              </Button>

              <div className="auth-quick">
                <span className="auth-quick-line" aria-hidden="true" />
                <span className="auth-quick-text">或</span>
                <span className="auth-quick-line" aria-hidden="true" />
              </div>

              <Button type="button" className="auth-guest" onClick={guestLogin} disabled={guestBusy}>
                {guestBusy ? '正在创建测试账号…' : '免注册登录 · 直接开始使用'}
              </Button>
              <p className="auth-note auth-guest-note">
                会建一个独立的测试账号，数据与正式账号隔离，刷新后仍然保留。
              </p>

              <p className="auth-note">
                {mode === 'register'
                  ? '注册成功后会显示一次性恢复码，请保存好——忘记密码时只能靠它找回。'
                  : '数据保存在服务端，换设备登录同一账号即可继续。'}
              </p>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
