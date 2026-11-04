/**
 * Dates de l'agenda : jours locaux (`AAAA-MM-JJ`), début de semaine selon la langue, plages des
 * vues, mises en forme par `Intl` dans la langue courante. Les heures affichées sont celles du navigateur.
 */
import type { CalendarViewKind } from '@/nav/nav';

export const DAY_MS = 86_400_000;

export function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Minuit local d'un jour `AAAA-MM-JJ`. */
export function dateOf(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function addMonths(d: Date, n: number): Date {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Premier jour de la semaine pour une langue (0 = dimanche … 6 = samedi), par `Intl.Locale` si possible. */
export function firstDayOfWeek(lang: string): number {
  try {
    const loc = new Intl.Locale(lang) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    /* moteur sans weekInfo */
  }
  return ({ en: 0, ar: 6 } as Record<string, number>)[lang.split('-')[0]!] ?? 1;
}

export function startOfWeek(d: Date, firstDay: number): Date {
  const diff = (d.getDay() - firstDay + 7) % 7;
  return addDays(d, -diff);
}

/** Jours affichés et plage [from, to[ (ms) d'une vue. */
export function viewRange(view: CalendarViewKind, iso: string, firstDay: number): { days: Date[]; from: number; to: number } {
  const d = dateOf(iso);
  let start: Date;
  let n: number;
  if (view === 'month') {
    start = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1), firstDay);
    n = 42;
  } else if (view === 'week') {
    start = startOfWeek(d, firstDay);
    n = 7;
  } else if (view === 'day') {
    start = d;
    n = 1;
  } else {
    start = d;
    n = 30;
  }
  const days = Array.from({ length: n }, (_, i) => addDays(start, i));
  return { days, from: start.getTime(), to: addDays(start, n).getTime() };
}

/** Date de la période précédente / suivante. */
export function shiftDate(view: CalendarViewKind, iso: string, dir: 1 | -1): string {
  const d = dateOf(iso);
  if (view === 'month') return isoOf(addMonths(new Date(d.getFullYear(), d.getMonth(), 1), dir));
  if (view === 'week') return isoOf(addDays(d, 7 * dir));
  if (view === 'agenda') return isoOf(addDays(d, 30 * dir));
  return isoOf(addDays(d, dir));
}

/** Titre de la période (mois et année, plage de la semaine, jour complet). */
export function periodTitle(view: CalendarViewKind, iso: string, lang: string, firstDay: number): string {
  const d = dateOf(iso);
  if (view === 'month') return new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(d);
  if (view === 'day') return new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const { days } = viewRange(view, iso, firstDay);
  const a = days[0]!;
  const b = days[days.length - 1]!;
  const fmt = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  return typeof fmt.formatRange === 'function' ? fmt.formatRange(a, b) : `${fmt.format(a)} – ${fmt.format(b)}`;
}

export function fmtTime(ms: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(ms);
}

export function fmtTimeRange(a: number, b: number, lang: string): string {
  const f = new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' });
  return typeof f.formatRange === 'function' ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
}

/** Libellé d'heure de la grille (ex. « 09:00 », « 9 AM »). */
export function hourLabel(h: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { hour: 'numeric' }).format(new Date(2000, 0, 1, h));
}

export function weekdayNames(lang: string, firstDay: number, style: 'short' | 'long' | 'narrow' = 'short'): string[] {
  const f = new Intl.DateTimeFormat(lang, { weekday: style });
  // 2023-01-01 était un dimanche
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2023, 0, 1 + ((firstDay + i) % 7))));
}

/** Minutes depuis minuit (heure locale) d'un instant, bornées au jour donné. */
export function minutesInDay(ms: number, day: Date): number {
  const start = day.getTime();
  const end = addDays(day, 1).getTime();
  const clamped = Math.min(Math.max(ms, start), end);
  return Math.round((clamped - start) / 60_000);
}

/** Fuseau du navigateur. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Fuseaux IANA proposés (ceux du moteur, sinon une courte liste). */
export function timeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list?.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    /* ignoré */
  }
  return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Africa/Casablanca', 'Asia/Dubai'];
}
