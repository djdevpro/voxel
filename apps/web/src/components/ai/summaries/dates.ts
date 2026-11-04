/** Dates des résumés : clé locale `AAAA-MM-JJ` et libellés (aujourd'hui, hier, jour de la semaine). */
import i18n, { currentLocale } from '@/i18n';

/** Date locale `AAAA-MM-JJ` (aujourd'hui par défaut). */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `AAAA-MM-JJ` → date locale à minuit. */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/** « Aujourd'hui », « Hier », sinon « lundi 2 novembre ». */
export function dayLabel(iso: string): string {
  const now = new Date();
  if (iso === localIsoDate(now)) return i18n.t('ai-summaries:list.today');
  if (iso === localIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return i18n.t('ai-summaries:list.yesterday');
  return new Intl.DateTimeFormat(currentLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(fromIsoDate(iso));
}

/** Date longue (« mercredi 4 novembre 2026 »). */
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'full' }).format(fromIsoDate(iso));
}

/** Heure courte (« 08:12 »). */
export function shortTime(at: number | string): string {
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
}
