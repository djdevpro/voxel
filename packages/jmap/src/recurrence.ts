/**
 * Développement des récurrences JSCalendar (RFC 8984 §4.3) sur une plage, module pur testé :
 * règles (`recurrenceRules`, itérées par `ical.js` en heure locale « flottante » du fuseau de l'événement),
 * règles d'exclusion, exceptions (`recurrenceOverrides` : patch, `excluded`, dates ajoutées comme RDATE).
 *
 * Utilisé par le webmail (vues de l'agenda, rappels) et par la passerelle (`expandRecurrences` de la façade CalDAV).
 */
import ICAL from 'ical.js';
import { addDaysLocal, applyEventPatch, eventSpan, utcToZoned, type CalendarEventCreate, type LocalDateTime, type RecurrenceRule } from './jscalendar.ts';

const MAX_ITER = 100_000;
const DAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

/** Règle JSCalendar → valeur RRULE (UNTIL : `untilValue` déjà formatée, sinon date locale compacte). */
export function ruleToRrule(rule: RecurrenceRule, untilValue?: string): string {
  const parts: string[] = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${untilValue ?? rule.until.replace(/[-:]/g, '')}`);
  if (rule.bySecond?.length) parts.push(`BYSECOND=${rule.bySecond.join(',')}`);
  if (rule.byMinute?.length) parts.push(`BYMINUTE=${rule.byMinute.join(',')}`);
  if (rule.byHour?.length) parts.push(`BYHOUR=${rule.byHour.join(',')}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.map((d) => `${d.nthOfPeriod ?? ''}${d.day.toUpperCase()}`).join(',')}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byYearDay?.length) parts.push(`BYYEARDAY=${rule.byYearDay.join(',')}`);
  if (rule.byWeekNo?.length) parts.push(`BYWEEKNO=${rule.byWeekNo.join(',')}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.map((m) => (m.endsWith('L') ? m : String(Number(m)))).join(',')}`);
  if (rule.bySetPosition?.length) parts.push(`BYSETPOS=${rule.bySetPosition.join(',')}`);
  if (rule.firstDayOfWeek && rule.firstDayOfWeek !== 'mo') parts.push(`WKST=${rule.firstDayOfWeek.toUpperCase()}`);
  if (rule.rscale) parts.push(`RSCALE=${rule.rscale.toUpperCase()}`);
  if (rule.skip && rule.skip !== 'omit') parts.push(`SKIP=${rule.skip.toUpperCase()}`);
  return parts.join(';');
}

/** Valeur RRULE → règle JSCalendar (UNTIL laissé tel que donné par `untilToLocal`). */
export function rruleToRule(value: string, untilToLocal: (raw: string) => LocalDateTime): RecurrenceRule {
  const map = new Map<string, string>();
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) map.set(k.toUpperCase(), v);
  }
  const nums = (k: string) => map.get(k)?.split(',').map(Number).filter((n) => Number.isFinite(n));
  const rule: RecurrenceRule = { '@type': 'RecurrenceRule', frequency: (map.get('FREQ') ?? 'DAILY').toLowerCase() as RecurrenceRule['frequency'] };
  const interval = Number(map.get('INTERVAL'));
  if (interval > 1) rule.interval = interval;
  const count = Number(map.get('COUNT'));
  if (count > 0) rule.count = count;
  if (map.has('UNTIL')) rule.until = untilToLocal(map.get('UNTIL')!);
  const byDay = map.get('BYDAY');
  if (byDay)
    rule.byDay = byDay.split(',').flatMap((d) => {
      const m = /^([+-]?\d+)?([A-Za-z]{2})$/.exec(d.trim());
      if (!m) return [];
      return [{ '@type': 'NDay' as const, day: m[2]!.toLowerCase() as 'mo', ...(m[1] ? { nthOfPeriod: Number(m[1]) } : {}) }];
    });
  const assign = (k: string, prop: 'byMonthDay' | 'byYearDay' | 'byWeekNo' | 'byHour' | 'byMinute' | 'bySecond' | 'bySetPosition') => {
    const v = nums(k);
    if (v?.length) rule[prop] = v;
  };
  assign('BYMONTHDAY', 'byMonthDay');
  assign('BYYEARDAY', 'byYearDay');
  assign('BYWEEKNO', 'byWeekNo');
  assign('BYHOUR', 'byHour');
  assign('BYMINUTE', 'byMinute');
  assign('BYSECOND', 'bySecond');
  assign('BYSETPOS', 'bySetPosition');
  const byMonth = map.get('BYMONTH');
  if (byMonth) rule.byMonth = byMonth.split(',').map((m) => m.trim());
  const wkst = map.get('WKST');
  if (wkst && wkst.toLowerCase() !== 'mo') rule.firstDayOfWeek = wkst.toLowerCase() as 'mo';
  if (map.has('RSCALE')) rule.rscale = map.get('RSCALE')!.toLowerCase();
  if (map.has('SKIP')) rule.skip = map.get('SKIP')!.toLowerCase() as 'omit';
  return rule;
}

function toIcalTime(local: LocalDateTime, isDate: boolean): ICAL.Time {
  const [y, m, d] = local.slice(0, 10).split('-').map(Number);
  const [hh, mm, ss] = (local.slice(11) || '00:00:00').split(':').map(Number);
  return ICAL.Time.fromData({ year: y!, month: m!, day: d!, hour: isDate ? 0 : (hh ?? 0), minute: isDate ? 0 : (mm ?? 0), second: isDate ? 0 : (ss ?? 0), isDate });
}

function fromIcalTime(t: ICAL.Time): LocalDateTime {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(t.year, 4)}-${p(t.month)}-${p(t.day)}T${p(t.isDate ? 0 : t.hour)}:${p(t.isDate ? 0 : t.minute)}:${p(t.isDate ? 0 : t.second)}`;
}

/** Dates locales produites par une règle depuis `start`, jusqu'à `cutoff` (inclus) ou la fin de la règle. */
export function ruleDates(rule: RecurrenceRule, start: LocalDateTime, cutoff: LocalDateTime, isDate = false): LocalDateTime[] {
  const recur = ICAL.Recur.fromString(ruleToRrule(isDate && rule.until ? { ...rule, until: `${rule.until.slice(0, 10)}T00:00:00` } : rule, isDate && rule.until ? rule.until.slice(0, 10).replace(/-/g, '') : undefined));
  const it = recur.iterator(toIcalTime(start, isDate));
  const out: LocalDateTime[] = [];
  for (let i = 0; i < MAX_ITER; i++) {
    const t = it.next();
    if (!t) break;
    const s = fromIcalTime(t);
    if (s > cutoff) break;
    out.push(s);
  }
  return out;
}

export interface Occurrence {
  /** Id de l'événement (maître) dans le cache. */
  eventId: string;
  /** Date locale d'origine de l'occurrence (`null` : événement non récurrent). */
  recurrenceId: LocalDateTime | null;
  /** Événement effectif (exception appliquée, sans les règles). */
  event: CalendarEventCreate;
  start: number;
  end: number;
}

const BASE_ONLY = ['recurrenceRules', 'excludedRecurrenceRules', 'recurrenceOverrides'] as const;

/** Instance d'une occurrence (exception appliquée) ; `null` si elle est exclue. */
export function occurrenceOf(ev: CalendarEventCreate, recurrenceId: LocalDateTime): CalendarEventCreate | null {
  const base: Record<string, unknown> = { ...ev, start: recurrenceId };
  for (const k of BASE_ONLY) delete base[k];
  const patch = ev.recurrenceOverrides?.[recurrenceId];
  if (patch?.excluded) return null;
  const inst = patch ? applyEventPatch(base, patch) : base;
  inst.recurrenceId = recurrenceId;
  return inst as CalendarEventCreate;
}

/**
 * Occurrences d'un événement qui touchent la plage [from, to[ (ms UTC), triées par début.
 * `maxDurationDays` : marge pour les occurrences commencées avant la plage.
 */
export function expandEvent(ev: CalendarEventCreate & { id?: string }, from: number, to: number, opts: { maxResults?: number } = {}): Occurrence[] {
  const id = ev.id ?? '';
  const isRecurring = !!(ev.recurrenceRules?.length || (ev.recurrenceOverrides && Object.keys(ev.recurrenceOverrides).length));
  if (!ev.start) return [];
  if (!isRecurring) {
    const span = eventSpan(ev);
    const hit = span.end > from && span.start < to || (span.start === span.end && span.start >= from && span.start < to);
    return hit ? [{ eventId: id, recurrenceId: null, event: ev, ...span }] : [];
  }
  const tz = ev.showWithoutTime ? null : (ev.timeZone ?? null);
  const isDate = !!ev.showWithoutTime;
  // borne locale : fin de plage dans le fuseau de l'événement, plus deux jours de marge (décalages horaires)
  const cutoff = addDaysLocal(utcToZoned(to, tz), 2);
  const set = new Set<LocalDateTime>([ev.start]);
  for (const r of ev.recurrenceRules ?? []) for (const d of ruleDates(r, ev.start, cutoff, isDate)) set.add(d);
  for (const r of ev.excludedRecurrenceRules ?? []) for (const d of ruleDates(r, ev.start, cutoff, isDate)) set.delete(d);
  for (const [rid, patch] of Object.entries(ev.recurrenceOverrides ?? {})) {
    if (patch?.excluded) set.delete(rid);
    else set.add(rid);
  }
  const out: Occurrence[] = [];
  for (const rid of [...set].sort()) {
    const inst = occurrenceOf(ev, rid);
    if (!inst) continue;
    const span = eventSpan(inst);
    if (span.end > from && span.start < to || (span.start === span.end && span.start >= from && span.start < to)) {
      out.push({ eventId: id, recurrenceId: rid, event: inst, ...span });
      if (opts.maxResults && out.length >= opts.maxResults) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Jour de la semaine JSCalendar d'une date locale (`mo`…`su`). */
export function weekdayOf(local: LocalDateTime): NonNullable<RecurrenceRule['firstDayOfWeek']> {
  const [y, m, d] = local.slice(0, 10).split('-').map(Number);
  return DAY_CODES[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()] as 'mo';
}
