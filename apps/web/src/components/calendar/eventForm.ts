/**
 * Formulaire d'événement ↔ JSCalendar : titre, agenda, journée entière, début et fin avec fuseau,
 * récurrence (aucune, quotidienne, hebdomadaire avec jours, mensuelle, annuelle ; jusqu'à une date ou N fois),
 * rappels (minutes avant), lieu, description, participants (adresses), disponibilité. Ce que le formulaire ne sait
 * pas représenter (règle complexe, rappel absolu, propriétés inconnues, participants détaillés) est conservé.
 */
import {
  addDaysLocal,
  dayOf,
  durationSeconds,
  formatDuration,
  participantEmail,
  type Alert,
  type CalendarEvent,
  type CalendarEventCreate,
  type NDay,
  type Participant,
  type RecurrenceRule,
} from '@voxel/jmap';

export type RepeatKind = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type EndsKind = 'never' | 'on' | 'after';
export type Weekday = NDay['day'];
export const WEEKDAYS: Weekday[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

export interface EventForm {
  title: string;
  /** `<boîte>:<agenda>` */
  calendar: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  repeat: RepeatKind;
  interval: number;
  byDay: Weekday[];
  ends: EndsKind;
  until: string;
  count: number;
  /** Rappels : minutes avant le début. */
  reminders: number[];
  location: string;
  description: string;
  /** Adresses des participants (hors organisateur). */
  participants: string[];
  busy: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const timeOf = (local: string) => local.slice(11, 16);
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export const isEmail = (s: string) => EMAIL_RE.test(s.trim());

/** Jour de la semaine JSCalendar d'une date `AAAA-MM-JJ`. */
export function weekdayOfIso(iso: string): Weekday {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
}

/** Formulaire vide pour une plage (création par clic ou glisser). */
export function emptyForm(calendar: string, startMs: number, endMs: number, allDay: boolean, timeZone: string): EventForm {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const sIso = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  // fin exclusive d'une journée entière → dernier jour inclus
  const eDay = allDay ? new Date(endMs - 1) : e;
  const eIso = `${eDay.getFullYear()}-${pad(eDay.getMonth() + 1)}-${pad(eDay.getDate())}`;
  return {
    title: '',
    calendar,
    allDay,
    startDate: sIso,
    startTime: `${pad(s.getHours())}:${pad(s.getMinutes())}`,
    endDate: eIso,
    endTime: `${pad(e.getHours())}:${pad(e.getMinutes())}`,
    timeZone,
    repeat: 'none',
    interval: 1,
    byDay: [weekdayOfIso(sIso)],
    ends: 'never',
    until: '',
    count: 10,
    reminders: allDay ? [] : [15],
    location: '',
    description: '',
    participants: [],
    busy: true,
  };
}

function ruleKind(r: RecurrenceRule | undefined): RepeatKind {
  if (!r) return 'none';
  const simple =
    !r.byMonthDay?.length && !r.byMonth?.length && !r.byYearDay?.length && !r.byWeekNo?.length && !r.byHour?.length && !r.byMinute?.length && !r.bySecond?.length && !r.bySetPosition?.length && !r.rscale;
  const dayOk = !r.byDay?.length || (r.frequency === 'weekly' && r.byDay.every((d) => !d.nthOfPeriod));
  if (!simple || !dayOk || !['daily', 'weekly', 'monthly', 'yearly'].includes(r.frequency)) return 'custom';
  return r.frequency as RepeatKind;
}

/** Événement (ou occurrence) → formulaire. */
export function formOf(ev: CalendarEventCreate, calendar: string, browserTz: string): EventForm {
  const start = ev.start ?? '1970-01-01T00:00:00';
  const allDay = !!ev.showWithoutTime;
  const secs = durationSeconds(ev.duration);
  const end = allDay ? addDaysLocal(start, Math.max(1, Math.round(secs / 86400)) - 1) : addDaysLocal(start, 0);
  const endLocalStr = allDay ? end : new Date(Date.parse(`${start}Z`) + Math.max(0, secs) * 1000).toISOString().slice(0, 19);
  const rule = ev.recurrenceRules?.[0];
  const kind = (ev.recurrenceRules?.length ?? 0) > 1 ? 'custom' : ruleKind(rule);
  const me = Object.values(ev.participants ?? {});
  return {
    title: ev.title ?? '',
    calendar,
    allDay,
    startDate: dayOf(start),
    startTime: timeOf(start),
    endDate: dayOf(endLocalStr),
    endTime: allDay ? '10:00' : timeOf(endLocalStr),
    timeZone: allDay ? browserTz : (ev.timeZone ?? browserTz),
    repeat: kind,
    interval: rule?.interval ?? 1,
    byDay: rule?.byDay?.length ? rule.byDay.map((d) => d.day) : [weekdayOfIso(dayOf(start))],
    ends: rule?.until ? 'on' : rule?.count ? 'after' : 'never',
    until: rule?.until ? dayOf(rule.until) : '',
    count: rule?.count ?? 10,
    reminders: Object.values(ev.alerts ?? {})
      .map((a) => {
        const t = a.trigger as { '@type': string; offset?: string; relativeTo?: string };
        return t['@type'] === 'OffsetTrigger' && t.relativeTo !== 'end' ? Math.round(-durationSeconds(t.offset) / 60) : null;
      })
      .filter((m): m is number => m !== null && m >= 0),
    location: Object.values(ev.locations ?? {})
      .map((l) => l.name ?? '')
      .filter(Boolean)
      .join(', '),
    description: ev.description ?? '',
    participants: me.filter((p) => !p.roles?.owner).map((p) => participantEmail(p) ?? '').filter(Boolean),
    busy: ev.freeBusyStatus !== 'free',
  };
}

export type FormError = 'endBeforeStart' | 'badEmail' | 'badUntil' | 'noDays';

export function validateForm(f: EventForm): FormError | null {
  if (f.participants.some((p) => !isEmail(p))) return 'badEmail';
  if (f.repeat === 'weekly' && !f.byDay.length) return 'noDays';
  if (f.repeat !== 'none' && f.repeat !== 'custom' && f.ends === 'on' && (!f.until || f.until < f.startDate)) return 'badUntil';
  if (f.allDay) return f.endDate < f.startDate ? 'endBeforeStart' : null;
  if (`${f.endDate}T${f.endTime}` < `${f.startDate}T${f.startTime}`) return 'endBeforeStart';
  return null;
}

/**
 * Formulaire → événement, à partir de l'événement d'origine (`base`, conservé pour tout ce que le formulaire ne
 * gère pas). `me` : adresse de la boîte (organisateur si des participants sont ajoutés).
 */
export function eventOf(f: EventForm, base: Partial<CalendarEvent> | null, me: string): CalendarEventCreate {
  const ev: CalendarEventCreate = { ...(base ?? {}), '@type': 'Event' };
  delete (ev as { id?: string }).id;
  delete (ev as { baseEventId?: string }).baseEventId;
  ev.title = f.title.trim();
  if (f.allDay) {
    ev.showWithoutTime = true;
    ev.start = `${f.startDate}T00:00:00`;
    const days = Math.max(1, Math.round((Date.parse(`${f.endDate}T00:00:00Z`) - Date.parse(`${f.startDate}T00:00:00Z`)) / 86_400_000) + 1);
    ev.duration = `P${days}D`;
    delete ev.timeZone;
  } else {
    delete ev.showWithoutTime;
    ev.start = `${f.startDate}T${f.startTime}:00`;
    ev.timeZone = f.timeZone || null;
    const secs = (Date.parse(`${f.endDate}T${f.endTime}:00Z`) - Date.parse(`${ev.start}Z`)) / 1000;
    ev.duration = formatDuration(Math.max(0, secs));
  }
  // récurrence : une règle « personnalisée » (non représentable) est gardée telle quelle
  if (f.repeat === 'none') {
    // retirées ici ; le patch d'une série existante les met à `null`
    delete ev.recurrenceRules;
    delete ev.recurrenceOverrides;
  } else if (f.repeat !== 'custom') {
    const rule: RecurrenceRule = { '@type': 'RecurrenceRule', frequency: f.repeat };
    if (f.interval > 1) rule.interval = Math.min(999, Math.round(f.interval));
    if (f.repeat === 'weekly') rule.byDay = WEEKDAYS.filter((d) => f.byDay.includes(d)).map((day) => ({ '@type': 'NDay', day }));
    if (f.ends === 'after') rule.count = Math.max(1, Math.min(999, Math.round(f.count)));
    if (f.ends === 'on' && f.until) rule.until = f.allDay ? `${f.until}T00:00:00` : `${f.until}T23:59:59`;
    ev.recurrenceRules = [rule];
  }
  // rappels : les rappels « minutes avant » viennent du formulaire, les autres (absolus, après la fin) sont gardés
  const kept = Object.entries(base?.alerts ?? {}).filter(([, a]) => {
    const t = a.trigger as { '@type': string; relativeTo?: string };
    return t['@type'] !== 'OffsetTrigger' || t.relativeTo === 'end';
  });
  const alerts: Record<string, Alert> = Object.fromEntries(kept);
  // rappel inchangé : même clé et même objet (pas de différence inutile dans le patch)
  const previous = new Map(
    Object.entries(base?.alerts ?? {}).flatMap(([k, a]) => {
      const t = a.trigger as { '@type': string; offset?: string; relativeTo?: string };
      return t['@type'] === 'OffsetTrigger' && t.relativeTo !== 'end' ? [[Math.round(-durationSeconds(t.offset) / 60), [k, a] as [string, Alert]]] : [];
    }),
  );
  [...new Set(f.reminders)].forEach((m, i) => {
    const hit = previous.get(m);
    if (hit) alerts[hit[0]] = hit[1];
    else alerts[`r${i + 1}`] = { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: formatDuration(-m * 60) }, action: 'display' };
  });
  if (Object.keys(alerts).length) ev.alerts = alerts;
  else delete ev.alerts;
  // lieu : un seul lieu édité, les autres propriétés du premier lieu conservées
  const loc = f.location.trim();
  const firstLoc = Object.entries(base?.locations ?? {})[0];
  if (loc) ev.locations = { [firstLoc?.[0] ?? 'l1']: { ...(firstLoc?.[1] ?? {}), '@type': 'Location', name: loc } };
  else delete ev.locations;
  const desc = f.description.trim();
  if (desc) ev.description = f.description;
  else delete ev.description;
  // « occupé » est la valeur par défaut : on ne l'écrit que si elle était déjà là ou si l'on choisit « libre »
  if (!f.busy) ev.freeBusyStatus = 'free';
  else if (base?.freeBusyStatus) ev.freeBusyStatus = 'busy';
  else delete ev.freeBusyStatus;
  // participants : on garde les fiches existantes (statut, nom…) des adresses restantes
  const wanted = [...new Set(f.participants.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  const existing = Object.entries(base?.participants ?? {});
  const byEmail = new Map(existing.map(([k, p]) => [participantEmail(p) ?? '', [k, p] as [string, Participant]]));
  const mine = me.toLowerCase();
  if (wanted.length) {
    const out: Record<string, Participant> = {};
    const owner = existing.find(([, p]) => p.roles?.owner);
    if (owner) out[owner[0]] = owner[1];
    else out.owner = { '@type': 'Participant', calendarAddress: `mailto:${mine}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' };
    let n = 0;
    for (const a of wanted) {
      if (a === mine && !owner) continue;
      const hit = byEmail.get(a);
      if (hit && !hit[1].roles?.owner) out[hit[0]] = hit[1];
      else if (!hit) out[`p${Date.now().toString(36)}${n++}`] = { '@type': 'Participant', calendarAddress: `mailto:${a}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true };
    }
    ev.participants = out;
    if (!ev.organizerCalendarAddress) {
      const o = Object.values(out).find((p) => p.roles?.owner);
      if (o?.calendarAddress) ev.organizerCalendarAddress = o.calendarAddress;
    }
  } else if (existing.some(([, p]) => !p.roles?.owner)) {
    delete ev.participants;
    delete ev.organizerCalendarAddress;
  }
  return ev;
}

/** Décalage d'un événement (déplacement) : nouveau début local dans son fuseau, même durée. */
export function shiftedStart(start: string, deltaMinutes: number): string {
  const ms = Date.parse(`${start}Z`) + deltaMinutes * 60_000;
  return new Date(ms).toISOString().slice(0, 19);
}
