import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from './components';
import { useAppState } from './store';
import { GoalPage } from './pages/GoalPage';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';
import { ReportPage } from './pages/ReportPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuthPage } from './pages/AuthPage';
import { startOfWeek, todayISO, weekDates } from './domain/date';

type Tab = 'today' | 'goal' | 'week' | 'report' | 'settings';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'goal', label: '目标' },
  { key: 'week', label: '周视图' },
  { key: 'report', label: '周报' },
  { key: 'settings', label: '设置' },
];

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[zhixue] 渲染异常', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card">
          <div className="empty">
            <strong>页面出了点问题</strong>
            <p>已记录错误：{this.state.error.message}</p>
            <Button variant="primary" onClick={() => location.reload()}>
              重新加载
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function RecoveryNotice({ code, onClose }: { code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="recovery-overlay" role="dialog" aria-modal="true" aria-label="请保存恢复码">
      <div className="recovery-card">
        <strong>请保存你的恢复码</strong>
        <p>忘记密码时只能用它重置，关闭后不再显示。</p>
        <code className="recovery-code">{code}</code>
        <div className="row">
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? '已复制' : '复制恢复码'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            我已保存
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { phase, error, state, actions, recoveryCode } = useAppState();
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.slice(1);
    return TABS.some((t) => t.key === h) ? (h as Tab) : 'today';
  });

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.slice(1);
      if (TABS.some((t) => t.key === h)) setTab(h as Tab);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function go(next: Tab) {
    setTab(next);
    history.replaceState(null, '', `#${next}`);
  }

  if (phase === 'loading') {
    return (
      <div className="boot">
        <span className="mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <p>正在恢复会话…</p>
      </div>
    );
  }

  if (phase === 'guest') {
    return <AuthPage actions={actions} error={error} />;
  }

  if (phase === 'error') {
    return (
      <div className="boot">
        <p>{error ?? '加载失败'}</p>
        <Button variant="primary" onClick={() => void actions.refresh()}>
          重试
        </Button>
      </div>
    );
  }

  const weekStart = startOfWeek(todayISO(), state.settings.weekStart);
  const weekSet = new Set(weekDates(weekStart));
  const weekBlocks = state.blocks.filter((b) => weekSet.has(b.date));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>智学节律</strong>
            <small>让计划跟得上现实 · v0.2</small>
          </span>
        </div>

        <nav className="tabs" aria-label="主导航">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'tab active' : 'tab'}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => go(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="top-actions">
          <span className="hint">
            {state.user?.name} · 本周 {weekBlocks.length} 项
          </span>
          <Button variant="quiet" onClick={() => void actions.logout()}>
            退出
          </Button>
        </div>
      </header>

      <main className="main">
        {error && (
          <div className="banner" role="alert">
            {error}
          </div>
        )}
        <ErrorBoundary>
          {tab === 'today' && <TodayPage state={state} actions={actions} />}
          {tab === 'goal' && <GoalPage state={state} actions={actions} />}
          {tab === 'week' && <WeekPage state={state} actions={actions} />}
          {tab === 'report' && <ReportPage state={state} />}
          {tab === 'settings' && <SettingsPage state={state} actions={actions} />}
        </ErrorBoundary>
      </main>

      {recoveryCode && <RecoveryNotice code={recoveryCode} onClose={actions.dismissRecovery} />}

      <footer className="foot">
        <span>账号与数据保存在服务端 · 会话 30 天</span>
        <span>引擎：可行性 R 值 / 周装箱 / 偏差与归因（纯函数，可单测）</span>
      </footer>
    </div>
  );
}
