import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Card(props: {
  title?: string;
  desc?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${props.className ?? ''}`}>
      {(props.title || props.action) && (
        <header className="card-head">
          <div>
            {props.title && <h2>{props.title}</h2>}
            {props.desc && <p>{props.desc}</p>}
          </div>
          {props.action}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function Stat(props: { label: string; value: string; unit?: string; note?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <strong className="stat-value">
        {props.value}
        {props.unit && <small>{props.unit}</small>}
      </strong>
      {props.note && <span className="stat-note">{props.note}</span>}
    </div>
  );
}

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'quiet' | 'danger';
  },
) {
  const { variant = 'ghost', className = '', ...rest } = props;
  return <button type="button" className={`btn btn-${variant} ${className}`} {...rest} />;
}

export function Field(props: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Empty(props: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{props.title}</strong>
      {props.desc && <p>{props.desc}</p>}
      {props.action}
    </div>
  );
}

export function Meter(props: { value: number; max: number; tone?: 'green' | 'amber' | 'red' }) {
  const pct = props.max > 0 ? Math.min(100, Math.round((props.value / props.max) * 100)) : 0;
  return (
    <div className="meter" role="img" aria-label={`已用 ${pct}%`}>
      <i className={`meter-fill tone-${props.tone ?? 'green'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
