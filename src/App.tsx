import { Component, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from './components';
import { useAppState } from './store';
import { GoalPage } from './pages/GoalPage';
import { TodayPage } from './pages/TodayPage';
import { WeekPage } from './pages/WeekPage';
import { ReportPage } from './pages/ReportPage';
import { startOfWeek, todayISO, weekDates } from './domain/date';

type Tab = 'today' | 'goal' | 'week' | 'report';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'goal', label: '目标' },
  { key: 'week', label: '周视图' },
  { key: 'report', label: '周报' },
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

export default function App() {
  const { state, actions } = useAppState();
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

  // 分享演示链接：?demo=1 时自动载入示例（已有数据则不动）
  useEffect(() => {
    if (new URLSearchParams(location.search).get('demo') === '1' && !state.goal) {
      actions.seedDemo();
    }
    // 只在首次挂载时判断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(next: Tab) {
    setTab(next);
    history.replaceState(null, '', `#${next}`);
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
            <small>让计划跟得上现实 · MVP v0.1</small>
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
          <span className="hint">本周 {weekBlocks.length} 项</span>
          <Button
            variant="quiet"
            onClick={() => {
              if (confirm('清空所有本地数据？此操作不可撤销。')) actions.reset();
            }}
          >
            重置
          </Button>
        </div>
      </header>

      <main className="main">
        <ErrorBoundary>
          {tab === 'today' && <TodayPage state={state} actions={actions} />}
          {tab === 'goal' && <GoalPage state={state} actions={actions} />}
          {tab === 'week' && <WeekPage state={state} actions={actions} />}
          {tab === 'report' && <ReportPage state={state} />}
        </ErrorBoundary>
      </main>

      <footer className="foot">
        <span>数据保存在本机浏览器 · 后续接入账号与云端同步</span>
        <span>引擎：可行性 R 值 / 周装箱 / 偏差与归因（纯函数，可单测）</span>
      </footer>
    </div>
  );
}
