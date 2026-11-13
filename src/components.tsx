import { useEffect, useId, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/* ══ 基础容器 ══ */

export function Panel(props: {
  title?: string;
  desc?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClass?: string;
  /** 正文自己带内边距时用 */
  flush?: boolean;
}) {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      {(props.title || props.action) && (
        <header className="panel-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.desc && <p>{props.desc}</p>}
          </div>
          {props.action}
        </header>
      )}
      <div className={props.flush ? undefined : `panel-body ${props.bodyClass ?? ''}`}>{props.children}</div>
    </section>
  );
}

/* ══ 数字滚动 ══ */

function useCountUp(raw: string, duration = 560) {
  const numeric = /^-?\d+(\.\d+)?$/.test(raw);
  const target = Number(raw);
  const [shown, setShown] = useState(numeric ? 0 : NaN);

  useEffect(() => {
    if (!numeric) return;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(target * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else setShown(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [numeric, target, duration]);

  if (!numeric) return raw;
  const decimals = raw.includes('.') ? raw.split('.')[1]!.length : 0;
  return shown.toFixed(decimals);
}

export function Stat(props: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  tone?: 'up' | 'warn';
}) {
  const shown = useCountUp(props.value);
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <strong className="stat-value">
        {shown}
        {props.unit && <small>{props.unit}</small>}
      </strong>
      {props.note && <span className={`stat-note ${props.tone === 'up' ? 'up' : ''}`}>{props.note}</span>}
    </div>
  );
}

/* ══ 环形进度 ══ */

export function Ring(props: {
  value: number;
  max: number;
  size?: number;
  label?: string;
  suffix?: string;
  stroke?: number;
}) {
  const size = props.size ?? 132;
  const stroke = props.stroke ?? 9;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const pct = props.max > 0 ? Math.max(0, Math.min(1, props.value / props.max)) : 0;
  const r = (size - stroke) / 2 - 2;
  const c = 2 * Math.PI * r;
  const [on, setOn] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={`ring-${uid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--mint)" />
            <stop offset="1" stopColor="var(--cyan)" />
          </linearGradient>
        </defs>
        <circle className="ring-bg" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="ring-fg"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          stroke={`url(#ring-${uid})`}
          strokeDasharray={c}
          strokeDashoffset={on ? c * (1 - pct) : c}
        />
      </svg>
      <div className="ring-center">
        <b>
          {Math.round(pct * 100)}
          <span>{props.suffix ?? '%'}</span>
        </b>
        {props.label && <small>{props.label}</small>}
      </div>
    </div>
  );
}

/* ══ 细进度条 ══ */

export function Meter(props: { value: number; max: number; tone?: 'green' | 'amber' | 'red' | 'quiet' }) {
  const pct = props.max > 0 ? Math.min(100, Math.round((props.value / props.max) * 100)) : 0;
  return (
    <div className="meter" role="img" aria-label={`占用 ${pct}%`}>
      <i className={`meter-fill tone-${props.tone ?? 'green'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ══ 周容量柱状 ══ */

export function Sparkbars(props: { values: number[]; todayIndex?: number }) {
  const max = Math.max(1, ...props.values);
  return (
    <div className="cap-bars" aria-hidden="true">
      {props.values.map((v, i) => {
        const h = v <= 0 ? 8 : Math.max(18, Math.round((v / max) * 100));
        const cls = i === props.todayIndex ? 'today' : v > 0 ? 'fill' : '';
        return <i key={i} className={cls} style={{ height: `${v <= 0 ? 8 : h}%` }} />;
      })}
    </div>
  );
}

/* ══ 按钮 ══ */

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'quiet' | 'danger';
    size?: 'sm' | 'md' | 'lg';
  },
) {
  const { variant = 'ghost', size = 'md', className = '', ...rest } = props;
  const sizeClass = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '';
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${sizeClass} ${className}`}
      {...rest}
    />
  );
}

/* ══ 表单字段 ══ */

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

/* ══ 空状态 ══ */

export function Empty(props: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{props.title}</strong>
      {props.desc && <p>{props.desc}</p>}
      {props.action}
    </div>
  );
}

/* ══ 弹窗 ══ */

export function Modal(props: {
  open: boolean;
  title: string;
  desc?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 内容较多时放宽 */
  width?: number;
}) {
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        style={props.width ? { width: `min(${props.width}px, 100%)` } : undefined}
      >
        <header className="modal-head">
          <div>
            <h2>{props.title}</h2>
            {props.desc && <p>{props.desc}</p>}
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

/* ══ 主题切换 ══ */

export function ThemeToggle(props: { theme: 'dark' | 'light'; onToggle: () => void }) {
  const label = props.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  return (
    <button type="button" className="theme-toggle" onClick={props.onToggle} aria-label={label} title={label}>
      <span className="thumb" aria-hidden="true" />
      <span className={`opt ${props.theme === 'dark' ? 'on' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.8 6.8 0 0 0 9.8 9.8Z" />
        </svg>
      </span>
      <span className={`opt ${props.theme === 'light' ? 'on' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
        </svg>
      </span>
    </button>
  );
}

/* ══ 图标 ══ */

type IconProps = { className?: string };

export function IconToday({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

export function IconGoal({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.8V2M12 22v-1.8M3.8 12H2M22 12h-1.8" />
    </svg>
  );
}

export function IconWeek({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
      <path d="M3.5 9.6h17M9 9.6v9.9M15 9.6v9.9" />
    </svg>
  );
}

export function IconReport({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 19.5V9M9.5 19.5V4.5M15 19.5v-7M20.5 19.5v-4" />
    </svg>
  );
}

export function IconSettings({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </svg>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6.4 4.8 9 10 3.2" />
    </svg>
  );
}

export function IconLogout({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5.5H7.5A1.5 1.5 0 0 0 6 7v10a1.5 1.5 0 0 0 1.5 1.5H15M13 12h8M18 9l3 3-3 3" />
    </svg>
  );
}
