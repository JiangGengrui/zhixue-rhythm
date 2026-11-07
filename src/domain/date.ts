const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Date → 本地日期字符串（不使用 toISOString，避免时区偏移） */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地日期字符串 → 当天 00:00 的 Date */
export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** 0=周日 ... 6=周六 */
export function weekdayOf(iso: string): number {
  return parseISODate(iso).getDay();
}

/** 取所在周的起始日 */
export function startOfWeek(iso: string, weekStart: 0 | 1): string {
  const wd = weekdayOf(iso);
  const diff = weekStart === 1 ? (wd + 6) % 7 : wd;
  return addDays(iso, -diff);
}

export function weekDates(startISO: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(startISO, i));
}

/** b - a 的天数（a、b 均为 YYYY-MM-DD） */
export function daysBetween(a: string, b: string): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86400000);
}

export function fmtHM(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
}

export function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} 分钟`;
  if (rest === 0) return `${h} 小时`;
  return `${h} 小时 ${rest} 分`;
}

export function todayISO(): string {
  return toISODate(new Date());
}
