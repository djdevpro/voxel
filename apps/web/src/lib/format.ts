import type { EmailAddress } from '@voxel/jmap';
import i18n, { currentLocale } from '@/i18n';

// Formateurs Intl mis en cache par langue (la langue courante vient de src/i18n).
const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>(key: string, make: (locale: string) => T): T {
  const locale = currentLocale();
  const k = `${locale}|${key}`;
  let f = cache.get(k) as T | undefined;
  if (!f) {
    f = make(locale);
    cache.set(k, f);
  }
  return f;
}

const dtf = (key: string, opts: Intl.DateTimeFormatOptions) => cached(`d:${key}`, (l) => new Intl.DateTimeFormat(l, opts));
// timeStyle « short » : 14:32 / 02:41 en fr-de, 2:41 AM en anglais, selon les conventions de chaque langue
const timeFmt = () => dtf('time', { timeStyle: 'short' });
const dayMonthFmt = () => dtf('dayMonth', { day: 'numeric', month: 'short' });
const fullDateFmt = () => dtf('full', { day: 'numeric', month: 'short', year: 'numeric' });
const weekdayFmt = () => dtf('weekday', { weekday: 'short' });
const longFmt = () => dtf('long', { dateStyle: 'full', timeStyle: 'short' });
const rtf = () => cached('rtf', (l) => new Intl.RelativeTimeFormat(l, { numeric: 'auto' }));

/** Date compacte pour la liste : 14:32 · hier · lun. · 3 févr. · 3 févr. 2023 (selon la langue). */
export function listDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return timeFmt().format(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return rtf().format(-1, 'day');
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (diffDays < 6 && diffDays > 0) return weekdayFmt().format(d);
  if (d.getFullYear() === now.getFullYear()) return dayMonthFmt().format(d);
  return fullDateFmt().format(d);
}

export function longDate(iso: string, capitalize = true): string {
  const s = longFmt().format(new Date(iso));
  return capitalize ? s.charAt(0).toLocaleUpperCase(currentLocale()) + s.slice(1) : s;
}

/** Date et heure courtes (programmation d'envoi) : « mar. 4 nov., 08:00 ». */
export function shortDateTime(d: Date): string {
  return dtf('shortDateTime', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Date ISO ou SQLite (« AAAA-MM-JJ HH:MM:SS », UTC implicite). */
export function parseDate(v: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v)) return new Date(v.replace(' ', 'T') + 'Z');
  return new Date(v);
}

export function relative(iso: string): string {
  const diff = (parseDate(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return i18n.t('common:time.justNow');
  if (abs < 3600) return rtf().format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf().format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf().format(Math.round(diff / 86400), 'day');
  return fullDateFmt().format(parseDate(iso));
}

/** Taille de fichier localisée (unités Intl : o/Ko/Mo, B/kB/MB, بايت…). */
export function fileSize(n: number): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : i === 1 && v >= 10 ? 0 : 1;
  return cached(`size:${units[i]}:${digits}`, (l) =>
    new Intl.NumberFormat(l, { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: digits }),
  ).format(v);
}

/** Nombre localisé (séparateurs de milliers, chiffres de la langue). */
export function formatNumber(n: number): string {
  return cached('num', (l) => new Intl.NumberFormat(l)).format(n);
}

export function displayName(a: EmailAddress | null | undefined): string {
  if (!a) return '';
  if (a.name && a.name.trim()) return a.name.trim().replace(/^"|"$/g, '');
  return a.email.split('@')[0] ?? a.email;
}

export function firstName(a: EmailAddress | null | undefined): string {
  const n = displayName(a);
  return n.split(/\s+/)[0] ?? n;
}

export function initials(nameOrEmail: string): string {
  const s = nameOrEmail.replace(/<.*>/, '').replace(/@.*/, '').trim();
  const parts = s.split(/[\s._\-·|,]+/).filter((p) => /[\p{L}\p{N}]/u.test(p));
  const first = (p: string | undefined) => (p?.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
  if (parts.length >= 2) return first(parts[0]) + first(parts[1]);
  return first(parts[0]) || '?';
}

/** Teinte déterministe pour l'avatar d'un expéditeur. */
const AVATAR_HUES = [12, 28, 45, 145, 170, 195, 215, 245, 270, 300, 330];
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_HUES[Math.abs(h) % AVATAR_HUES.length] ?? 215;
}

/** Liste localisée « a, b et c ». */
export function formatList(items: string[]): string {
  return new Intl.ListFormat(currentLocale(), { style: 'short', type: 'conjunction' }).format(items);
}
