import { useEffect, useId, useRef, useState } from 'react';
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

/* ── 落地页底层抖动带：Bayer 8×8 有序抖动，纯 WebGL 无依赖 ──
   拿不到 WebGL 上下文时直接返回，一个 canvas 都不挂，
   底层就只剩 .land-dither 的 CSS 渐变（视觉降级但仍然成立）。
   颜色全部从 CSS 变量读，换主题自动跟着走。 */

const DITHER_VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const DITHER_FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform float uTime;
uniform float uCell;

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}
float bayer4(vec2 a) {
  return bayer2(a * 0.5) * 0.25 + bayer2(a);
}
float bayer8(vec2 a) {
  return bayer4(a * 0.5) * 0.25 + bayer2(a);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;

  /* 顶部最密、向下渐隐；左侧收着走，别把抖动铺到标题底下 */
  float g = smoothstep(0.0, 1.0, uv.y);
  g *= smoothstep(0.1, 0.62, uv.x);
  g *= 0.72;

  /* 极慢的呼吸与横向漂移，呼应“节律”，幅度压到只有隐约可感 */
  g += 0.026 * sin(uTime * 0.5) + 0.015 * sin(uv.x * 3.2 + uTime * 0.19);
  g = clamp(g, 0.0, 1.0);

  float d = clamp(bayer8(gl_FragCoord.xy / uCell), 0.0, 1.0);
  gl_FragColor = vec4(mix(uPaper, uInk, step(d, g)), 1.0);
}
`;

function hexToRgb(raw: string): [number, number, number] | null {
  const v = raw.trim().replace('#', '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return null;
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function DitherBackdrop() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, DITHER_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, DITHER_FRAG);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    if (aPos >= 0) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    }

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uPaper = gl.getUniformLocation(program, 'uPaper');
    const uInk = gl.getUniformLocation(program, 'uInk');
    const uCell = gl.getUniformLocation(program, 'uCell');

    /* 主题切换按钮会改 data-theme，抖动色得跟着重算，
       否则切到浅色主题后还留着深色墨点。颜色全从 CSS 变量取 */
    const applyColors = () => {
      const style = getComputedStyle(host);
      const paper = hexToRgb(style.getPropertyValue('--bg')) ?? [0.02, 0.031, 0.051];
      const mint = hexToRgb(style.getPropertyValue('--mint')) ?? [0.169, 0.902, 0.682];
      /* 最密格用墨绿而不是纯 mint：纯 mint 在深底上刺眼，还会把标题压下去 */
      const ink: [number, number, number] = [
        mint[0] * 0.22 + paper[0] * 0.78,
        mint[1] * 0.22 + paper[1] * 0.78,
        mint[2] * 0.22 + paper[2] * 0.78,
      ];
      gl.uniform3f(uPaper, paper[0], paper[1], paper[2]);
      gl.uniform3f(uInk, ink[0], ink[1], ink[2]);
      gl.uniform1f(uCell, 3);
    };

    const resize = () => {
      const w = Math.max(1, Math.round(host.clientWidth));
      const h = Math.max(1, Math.round(host.clientHeight));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    };

    host.appendChild(canvas);
    resize();

    const startedAt = performance.now();
    let frame = 0;
    let lastPaint = 0;
    let inView = true;
    let running = false;

    const paint = (seconds: number) => {
      gl.uniform1f(uTime, seconds);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const tick = (now: number) => {
      if (!running) return;
      frame = requestAnimationFrame(tick);
      /* 30fps 足够看清抖动，省下的帧留给滚动 */
      if (now - lastPaint < 33) return;
      lastPaint = now;
      paint((now - startedAt) / 1000);
    };

    const play = () => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(tick);
    };
    const pause = () => {
      running = false;
      if (frame) cancelAnimationFrame(frame);
    };
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    /* 只留这一个地方决定「跑不跑」：视口内、页面可见、且没要求减少动效。
       之前把降级判断拆在别处，IntersectionObserver 的首个回调会绕过它把动画又拉起来 */
    const sync = () => {
      if (!inView || document.hidden || reduceQuery.matches) {
        pause();
        return;
      }
      play();
    };

    const io = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? false;
        sync();
      },
      { threshold: 0 },
    );
    io.observe(host);

    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const onVisibility = () => sync();
    document.addEventListener('visibilitychange', onVisibility);

    const onReduce = () => {
      if (reduceQuery.matches) {
        pause();
        paint(0);
      } else {
        sync();
      }
    };
    reduceQuery.addEventListener('change', onReduce);

    const themeObserver = new MutationObserver(() => {
      applyColors();
      /* 静止时（降级或不在视口）得补一帧，否则颜色要等到下次滚动才更新 */
      if (!running) paint(0);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    applyColors();
    if (reduceQuery.matches) paint(0);
    else sync();

    return () => {
      pause();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduceQuery.removeEventListener('change', onReduce);
      themeObserver.disconnect();
      canvas.remove();
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      /* 主动还上下文，避免来回切页时攒下一堆 GL 上下文被浏览器丢掉 */
      const lose = gl.getExtension('WEBGL_lose_context') as { loseContext: () => void } | null;
      lose?.loseContext();
    };
  }, []);

  return <div className="land-dither" ref={hostRef} aria-hidden="true" />;
}
