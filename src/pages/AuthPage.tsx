import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Field } from '../components';
import type { Actions } from '../store';

export function AuthPage({
  actions,
  error,
}: {
  actions: Pick<Actions, 'login' | 'register'>;
  error: string | null;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setLocalError('请输入有效的邮箱');
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

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
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

        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => { setMode('login'); setLocalError(null); }}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => { setMode('register'); setLocalError(null); }}
          >
            注册
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
          <Field label="密码" hint={mode === 'register' ? '至少 8 位字符' : undefined}>
            <input
              type="password"
              value={password}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="••••••••"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {mode === 'register' && (
            <Field label="昵称" hint="可留空，默认「同学」">
              <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
        </div>

        {(localError || error) && <p className="auth-error">{localError ?? error}</p>}

        <Button variant="primary" className="auth-submit" disabled={busy} type="submit">
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '创建账号'}
        </Button>
        <p className="auth-note">数据保存在服务端，换设备登录同一账号即可继续。</p>
      </form>
    </div>
  );
}
