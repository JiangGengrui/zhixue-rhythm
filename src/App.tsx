import { Component, useEffect, useMemo, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import {
  Button,
  IconGoal,
  IconLogout,
  IconReport,
  IconSettings,
  IconToday,
  IconWeek,
  Sparkbars,
  ThemeToggle,
} from './components';
import { useAppState } from './store';
import { GoalPage } from './pages/GoalPage';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';
import { ReportPage } from './pages/ReportPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuthPage } from './pages/AuthPage';
import { startOfWeek, todayISO, weekDates, weekdayOf } from './domain/date';

type Tab = 'today' | 'goal' | 'week' | 'report' | 'settings';
type Theme = 'dark' | 'light';

const TABS: Array<{ key: Tab; label: string; icon: (p: { className?: string }) => ReactNode }> = [
  { key: 'today', label: '今日', icon: IconToday },
  { key: 'goal', label: '目标', icon: IconGoal },
  { key: 'week', label: '周视图', icon: IconWeek },
  { key: 'report', label: '周报', icon: IconReport },
  { key: 'settings', label: '设置', icon: IconSettings },
];

const THEME_KEY = 'zhixue-theme';

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* 隐私模式下忽略 */
  }
  return 'dark';
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof document === 'undefined') return 'dark';
    const attr = document.documentElement.dataset.theme;
    return attr === 'light' ? 'light' : readTheme();
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 忽略写入失败 */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#05080d' : '#f5f8f9');
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  };
}

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
        <div className="page">
          <section className="panel">
            <div className="panel-body">
              <div className="empty">
                <strong>页面出了点问题</strong>
                <p>已记录错误：{this.state.error.message}</p>
                <Button variant="primary" onClick={() => location.reload()}>
                  重新加载
                </Button>
              </div>
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}

function IconBell() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function NotificationBell({
  notifs,
  onRefresh,
  onReadAll,
}: {
  notifs: { items: Array<{ id: number; kind: string; level: string; title: string; body: string; createdAt: string; read: boolean }>; unread: number };
  onRefresh: () => void;
  onReadAll: () => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) onRefresh();
  }

  return (
    <div className="notif-wrap">
      <button type="button" className="btn btn-icon btn-quiet" onClick={toggle} aria-label="通知中心" title="通知中心">
        <IconBell />
        {notifs.unread > 0 && <span className="notif-dot">{notifs.unread > 9 ? '9+' : notifs.unread}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="通知中心">
          <div className="notif-head">
            <b>通知中心</b>
            {notifs.items.length > 0 && (
              <button type="button" className="notif-mark" onClick={onReadAll}>
                全部已读
              </button>
            )}
          </div>
          {notifs.items.length === 0 ? (
            <p className="notif-empty">暂无通知。进度落后、临近超载或连续中断时，预警会出现在这里。</p>
          ) : (
            <ul className="notif-list">
              {notifs.items.map((n) => (
                <li key={n.id} className={`notif-item lv-${n.level} ${n.read ? 'is-read' : 'is-unread'}`}>
                  <span className="notif-level">{n.level === 'danger' ? '紧急' : n.level === 'warn' ? '提醒' : '通知'}</span>
                  <div className="notif-body">
                    <b>{n.title}</b>
                    <p>{n.body}</p>
                    <time>{n.createdAt.slice(5, 16).replace('T', ' ')}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function RecoveryNotice({ code, onClose }: { code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="请保存恢复码">
      <div className="modal-card">
        <strong style={{ fontSize: 16 }}>请保存你的恢复码</strong>
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
  const { phase, error, state, actions, recoveryCode, pendingOps, notifs, offlineSince } = useAppState();

  // 通知轮询：登录态下每 60 秒刷新一次预警
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = window.setInterval(() => void actions.loadNotifications(), 60_000);
    return () => window.clearInterval(timer);
  }, [phase, actions]);
  const { theme, toggle } = useTheme();
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
    if (next === tab) return;
    setTab(next);
    history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const today = todayISO();
  const weekStart = startOfWeek(today, state.settings?.weekStart ?? 1);
  const weekBlocks = useMemo(() => {
    const set = new Set(weekDates(weekStart));
    return state.blocks.filter((b) => set.has(b.date));
  }, [state.blocks, weekStart]);

  const todayBlocks = weekBlocks.filter((b) => b.date === today);
  const capacityMin = state.settings
    ? weekDates(weekStart).reduce((s, d) => s + Math.max(0, state.settings.weekdays[weekdayOf(d)] ?? 0), 0)
    : 0;
  const plannedMin = weekBlocks.reduce((s, b) => s + (b.endMin - b.startMin), 0);
  const dayPlanned = weekDates(weekStart).map((d) =>
    weekBlocks.filter((b) => b.date === d).reduce((s, b) => s + (b.endMin - b.startMin), 0),
  );
  const todayIndex = (weekdayOf(today) - (state.settings?.weekStart ?? 1) + 7) % 7;

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
    return <AuthPage actions={actions} error={error} theme={theme} onToggleTheme={toggle} />;
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

  // 离线冷启动：用上次同步的数据只读展示；联网后「重试」即恢复
  const isOffline = phase === 'offline';

  const initial = (state.user?.name ?? '学').slice(0, 1);

  return (
    <div className="shell">
      <aside className="rail">
        <a
          className="brand"
          href="#today"
          onClick={(e) => {
            e.preventDefault();
            go('today');
          }}
          aria-label="回到今日"
        >
          <span className="mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-text">
            <strong>智学节律</strong>
            <small>RHYTHM OS</small>
          </span>
        </a>

        <nav className="nav" aria-label="主导航">
          <div className="nav-label">学习空间</div>
          {TABS.slice(0, 4).map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                className={`nav-item ${tab === t.key ? 'on' : ''}`}
                aria-current={tab === t.key ? 'page' : undefined}
                onClick={() => go(t.key)}
                title={t.label}
              >
                <Icon />
                <span className="nav-text">{t.label}</span>
                {t.key === 'today' && todayBlocks.length > 0 && <span className="nav-badge">{todayBlocks.length}</span>}
              </button>
            );
          })}
          <div className="nav-label" style={{ paddingTop: 16 }}>
            系统
          </div>
          <button
            type="button"
            className={`nav-item ${tab === 'settings' ? 'on' : ''}`}
            aria-current={tab === 'settings' ? 'page' : undefined}
            onClick={() => go('settings')}
            title="设置"
          >
            <IconSettings />
            <span className="nav-text">设置</span>
          </button>
        </nav>

        <div className="rail-foot">
          <div className="cap-card">
            <span>本周容量 · 已排</span>
            <strong>
              {(plannedMin / 60).toFixed(1)}
              <small>/ {(capacityMin / 60).toFixed(1)} 小时</small>
            </strong>
            <Sparkbars values={dayPlanned} todayIndex={todayIndex} />
          </div>

          {pendingOps > 0 && (
            <button type="button" className="pill tone-amber" onClick={() => void actions.flushOps()}>
              离线 {pendingOps} 项待同步 · 重试
            </button>
          )}

          <ThemeToggle theme={theme} onToggle={toggle} />

          <div className="row" style={{ gap: 8 }}>
            <NotificationBell
              notifs={notifs}
              onRefresh={() => void actions.loadNotifications()}
              onReadAll={() => void actions.markNotificationsRead()}
            />
            <button type="button" className="rail-user" onClick={() => go('settings')}>
              <span className="avatar">{initial}</span>
              <div>
                <b>{state.user?.name}</b>
                <span>本周 {weekBlocks.length} 项</span>
              </div>
            </button>
            <button
              type="button"
              className="btn btn-icon btn-quiet"
              onClick={() => void actions.logout()}
              aria-label="退出登录"
              title="退出登录"
            >
              <IconLogout />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="appbar">
          <a
            className="brand"
            href="#today"
            onClick={(e) => {
              e.preventDefault();
              go('today');
            }}
          >
            <span className="mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="brand-text">
              <strong>智学节律</strong>
              <small>RHYTHM OS</small>
            </span>
          </a>
          {pendingOps > 0 && (
            <button type="button" className="pill tone-amber" onClick={() => void actions.flushOps()}>
              离线 {pendingOps}
            </button>
          )}
          <NotificationBell notifs={notifs} onRefresh={() => void actions.loadNotifications()} onReadAll={() => void actions.markNotificationsRead()} />
          <ThemeToggle theme={theme} onToggle={toggle} />
        </header>

        {error && (
          <div className="page" style={{ paddingBottom: 0 }}>
            <div className="banner" role="alert">
              {error}
            </div>
          </div>
        )}

        {isOffline && (
          <div className="page" style={{ paddingBottom: 0 }}>
            <div className="banner" role="status" style={{ background: '#fdf6ec', color: '#8a6432', borderColor: '#f0dcc2' }}>
              离线模式：显示 {offlineSince ? offlineSince.slice(5, 16).replace('T', ' ') : '上次'} 同步的数据。
              打卡等操作可以照常进行，联网后会自动同步；刷新本页即可重新连接。
              <Button variant="quiet" size="sm" style={{ marginLeft: 10 }} onClick={() => void actions.refresh()}>
                重试连接
              </Button>
            </div>
          </div>
        )}

        <ErrorBoundary key={tab}>
          {tab === 'today' && <TodayPage state={state} actions={actions} onGoGoal={() => go('goal')} />}
          {tab === 'goal' && <GoalPage state={state} actions={actions} />}
          {tab === 'week' && <WeekPage state={state} actions={actions} />}
          {tab === 'report' && <ReportPage state={state} />}
          {tab === 'settings' && <SettingsPage state={state} actions={actions} theme={theme} onToggleTheme={toggle} />}
        </ErrorBoundary>

        <footer className="foot">
          <span>账号与数据保存在服务端 · 会话 30 天</span>
          <span>引擎：可行性 R 值 / 周装箱 / 偏差与归因（纯函数，可单测）· v1.1.0</span>
        </footer>
      </div>

      <nav className="tabbar" aria-label="主导航">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              className={`tb ${tab === t.key ? 'on' : ''}`}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => go(t.key)}
            >
              <Icon />
              {t.label}
            </button>
          );
        })}
      </nav>

      {recoveryCode && <RecoveryNotice code={recoveryCode} onClose={actions.dismissRecovery} />}
    </div>
  );
}
