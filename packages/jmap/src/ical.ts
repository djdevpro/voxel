/**
 * Conversion iCalendar (RFC 5545) ↔ JSCalendar (RFC 8984), selon la correspondance de l'IETF
 * (draft-ietf-calext-jscalendar-icalendar), analyse et écriture par `ical.js` (jCal).
 *
 * Utilisée par le webmail (export `.ics`, carte d'invitation) et par la passerelle (façade CalDAV → JMAP).
 *
 * Correspondances : UID → uid ; SUMMARY → title ; DESCRIPTION → description ; DTSTART (TZID, DATE, UTC)
 * → start + timeZone (+ showWithoutTime) ; DTEND / DURATION → duration ; RRULE / EXRULE → recurrenceRules /
 * excludedRecurrenceRules ; EXDATE → recurrenceOverrides `{ excluded: true }` ; RDATE → recurrenceOverrides `{}` ;
 * VEVENT avec RECURRENCE-ID → recurrenceOverrides (patch par rapport à la série) ; LOCATION → locations ;
 * ORGANIZER / ATTENDEE → participants (CN, PARTSTAT, ROLE, RSVP, CUTYPE) + organizerCalendarAddress ;
 * VALARM → alerts (TRIGGER relatif, RELATED=END, absolu ; ACTION) ; TRANSP → freeBusyStatus ; STATUS → status ;
 * CLASS → privacy ; PRIORITY, COLOR, CATEGORIES → keywords, SEQUENCE, CREATED, DTSTAMP / LAST-MODIFIED → updated.
 *
 * Les propriétés sans équivalent (X-…, URL, GEO, ATTACH, CONFERENCE…) sont gardées en jCal dans
 * `iCalendar.properties` (forme de Stalwart) et réécrites à l'aller-retour. Fuseaux : un TZID IANA est gardé
 * tel quel ; un TZID inconnu de `Intl` (ex. Windows) est résolu par son `X-LIC-LOCATION`, une petite table,
 * sinon converti en UTC par le VTIMEZONE du fichier. À l'écriture, un VTIMEZONE est produit pour chaque
 * fuseau utilisé, à partir des transitions données par `Intl`.
 */
import ICAL from 'ical.js';
import {
  addDaysLocal,
  dayOf,
  durationSeconds,
  endLocal,
  formatDuration,
  formatUtc,
  isKnownTimeZone,
  newEventUid,
  parseDuration,
  parseLocal,
  tzOffsetMs,
  utcToZoned,
  zonedToUtc,
  type Alert,
  type CalendarEventCreate,
  type JCalProp,
  type LocalDateTime,
  type Participant,
  type ParticipationStatus,
  type RecurrenceRule,
} from './jscalendar.ts';
import { occurrenceOf, ruleDates, ruleToRrule, rruleToRule } from './recurrence.ts';

type JComp = [string, JCalProp[], JComp[]];

const KNOWN = new Set([
  'uid', 'dtstamp', 'dtstart', 'dtend', 'duration', 'summary', 'description', 'location', 'rrule', 'exrule', 'exdate', 'rdate',
  'recurrence-id', 'organizer', 'attendee', 'transp', 'status', 'sequence', 'created', 'last-modified', 'categories', 'class',
  'priority', 'color',
]);

/** Fuseaux Windows courants (Outlook, Exchange) → IANA. */
const WINDOWS_TZ: Record<string, string> = {
  'romance standard time': 'Europe/Paris',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'morocco standard time': 'Africa/Casablanca',
  'w. central africa standard time': 'Africa/Lagos',
  'egypt standard time': 'Africa/Cairo',
  'arab standard time': 'Asia/Riyadh',
  'arabian standard time': 'Asia/Dubai',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'tokyo standard time': 'Asia/Tokyo',
  'china standard time': 'Asia/Shanghai',
  'india standard time': 'Asia/Kolkata',
  'utc': 'Etc/UTC',
};

const lc = (s: unknown) => String(s ?? '').toLowerCase();
const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);

// ------------------------------------------------------------------ fuseaux du fichier

interface TzContext {
  /** TZID → fuseau IANA, ou `null` (converti par le VTIMEZONE du fichier). */
  map: Map<string, string | null>;
  zones: Map<string, ICAL.Timezone>;
}

function tzContext(root: JComp): TzContext {
  const ctx: TzContext = { map: new Map(), zones: new Map() };
  for (const c of root[2] ?? []) {
    if (lc(c[0]) !== 'vtimezone') continue;
    const tzid = String(c[1].find((p) => lc(p[0]) === 'tzid')?.[3] ?? '');
    if (!tzid) continue;
    const lic = c[1].find((p) => lc(p[0]) === 'x-lic-location')?.[3];
    const iana = resolveTzid(tzid) ?? (typeof lic === 'string' && isKnownTimeZone(lic) ? lic : null);
    ctx.map.set(tzid, iana);
    if (!iana) {
      try {
        ctx.zones.set(tzid, ICAL.Timezone.fromData({ component: new ICAL.Component(c as unknown as unknown[]), tzid }));
      } catch {
        /* VTIMEZONE illisible : heure flottante */
      }
    }
  }
  return ctx;
}

function resolveTzid(tzid: string): string | null {
  const t = tzid.replace(/^\/+/, '').replace(/^(?:[a-z0-9.]+\/)*(?=[A-Z][a-z]+\/[A-Z])/, '');
  if (isKnownTimeZone(t)) return t;
  const w = WINDOWS_TZ[lc(tzid).replace(/^\(.*?\)\s*/, '')];
  return w ?? null;
}

interface TimeValue {
  local: LocalDateTime;
  tz: string | null;
  isDate: boolean;
}

/** Valeur d'heure jCal (DTSTART, EXDATE…) → date locale + fuseau. */
function readTime(params: Record<string, unknown>, type: string, value: unknown, ctx: TzContext): TimeValue | null {
  if (typeof value !== 'string') return null;
  if (type === 'date' || /^\d{4}-\d{2}-\d{2}$/.test(value)) return { local: `${value.slice(0, 10)}T00:00:00`, tz: null, isDate: true };
  const v = value.slice(0, 19);
  if (/Z$/i.test(value)) return { local: v, tz: 'Etc/UTC', isDate: false };
  const tzid = typeof params.tzid === 'string' ? params.tzid : null;
  if (!tzid) return { local: v, tz: null, isDate: false };
  const known = ctx.map.has(tzid) ? ctx.map.get(tzid)! : resolveTzid(tzid);
  if (known) return { local: v, tz: known, isDate: false };
  const zone = ctx.zones.get(tzid);
  if (zone) {
    const p = parseLocal(v);
    const t = ICAL.Time.fromData({ year: p.y, month: p.m, day: p.d, hour: p.hh, minute: p.mm, second: p.ss }, zone);
    return { local: utcToZoned(t.toUnixTime() * 1000, 'Etc/UTC'), tz: 'Etc/UTC', isDate: false };
  }
  return { local: v, tz: null, isDate: false };
}

/** Exprime une heure lue dans le repère (fuseau, date seule) de la série. */
function toSeriesLocal(t: TimeValue, seriesTz: string | null, seriesIsDate: boolean): LocalDateTime {
  if (seriesIsDate) return `${dayOf(t.local)}T00:00:00`;
  if (t.isDate) return `${dayOf(t.local)}T00:00:00`;
  if (t.tz === seriesTz || (!t.tz && !seriesTz)) return t.local;
  return utcToZoned(zonedToUtc(t.local, t.tz), seriesTz);
}

// ------------------------------------------------------------------ iCalendar → JSCalendar

const PARTSTAT: Record<string, ParticipationStatus> = {
  'needs-action': 'needs-action',
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  delegated: 'delegated',
};

function addressOf(v: unknown): string {
  return String(v ?? '').trim();
}

function participantOf(params: Record<string, unknown>, value: unknown, organizer: boolean): Participant {
  const p: Participant = { '@type': 'Participant', calendarAddress: addressOf(value) };
  const cn = first(params.cn as string | string[] | undefined);
  if (cn) p.name = String(cn);
  const roles: Record<string, boolean> = {};
  if (organizer) roles.owner = true;
  else {
    const role = lc(first(params.role as string | undefined) ?? 'req-participant');
    if (role === 'chair') roles.chair = true;
    if (role === 'opt-participant') roles.optional = true;
    if (role === 'non-participant') roles.informational = true;
    else roles.attendee = true;
    const ps = PARTSTAT[lc(first(params.partstat as string | undefined) ?? 'needs-action')];
    if (ps) p.participationStatus = ps;
    if (lc(first(params.rsvp as string | undefined)) === 'true') p.expectReply = true;
  }
  p.roles = roles;
  const cu = lc(first(params.cutype as string | undefined));
  if (cu && cu !== 'individual') p.kind = cu === 'room' ? 'location' : (cu as Participant['kind']);
  return p;
}

/** Un VEVENT → événement JSCalendar (sans regroupement des exceptions). */
function veventToEvent(comp: JComp, ctx: TzContext): { ev: CalendarEventCreate; recurrenceId: TimeValue | null } {
  const ev: CalendarEventCreate = { '@type': 'Event' };
  const unknown: JCalProp[] = [];
  let start: TimeValue | null = null;
  let end: TimeValue | null = null;
  let duration: string | null = null;
  let recurrenceId: TimeValue | null = null;
  const exdates: TimeValue[] = [];
  const rdates: TimeValue[] = [];
  const rrules: string[] = [];
  const exrules: string[] = [];
  const participants: Record<string, Participant> = {};
  let n = 0;
  for (const p of comp[1]) {
    const [rawName, params = {}, type, ...values] = p;
    const name = lc(rawName);
    const value = values[0];
    switch (name) {
      case 'uid':
        ev.uid = String(value);
        break;
      case 'summary':
        ev.title = String(value ?? '');
        break;
      case 'description':
        ev.description = String(value ?? '');
        break;
      case 'location':
        if (value) (ev.locations ??= {})[`l${Object.keys(ev.locations ?? {}).length + 1}`] = { '@type': 'Location', name: String(value) };
        break;
      case 'dtstart':
        start = readTime(params, type, value, ctx);
        break;
      case 'dtend':
        end = readTime(params, type, value, ctx);
        break;
      case 'duration':
        duration = String(value);
        break;
      case 'recurrence-id':
        recurrenceId = readTime(params, type, value, ctx);
        break;
      case 'rrule':
        rrules.push(typeof value === 'string' ? value : ICAL.Recur.fromData(value as never).toString());
        break;
      case 'exrule':
        exrules.push(typeof value === 'string' ? value : ICAL.Recur.fromData(value as never).toString());
        break;
      case 'exdate':
        for (const v of values) {
          const t = readTime(params, type, v, ctx);
          if (t) exdates.push(t);
        }
        break;
      case 'rdate':
        for (const v of values) {
          const raw = typeof v === 'string' ? v : Array.isArray(v) ? v[0] : null;
          const t = readTime(params, type === 'period' ? 'date-time' : type, raw, ctx);
          if (t) rdates.push(t);
        }
        break;
      case 'organizer': {
        const addr = addressOf(value);
        ev.organizerCalendarAddress = addr;
        const existing = Object.values(participants).find((x) => lc(x.calendarAddress) === lc(addr));
        if (existing) existing.roles = { ...existing.roles, owner: true };
        else participants[`p${++n}`] = participantOf(params, value, true);
        break;
      }
      case 'attendee': {
        const addr = addressOf(value);
        const att = participantOf(params, value, false);
        const existing = Object.values(participants).find((x) => lc(x.calendarAddress) === lc(addr));
        if (existing) Object.assign(existing, { ...att, name: existing.name ?? att.name, roles: { ...existing.roles, ...att.roles } });
        else participants[`p${++n}`] = att;
        break;
      }
      case 'transp':
        ev.freeBusyStatus = lc(value) === 'transparent' ? 'free' : 'busy';
        break;
      case 'status': {
        const s = lc(value);
        if (s === 'confirmed' || s === 'cancelled' || s === 'tentative') ev.status = s;
        break;
      }
      case 'class': {
        const c = lc(value);
        ev.privacy = c === 'private' ? 'private' : c === 'confidential' ? 'secret' : 'public';
        break;
      }
      case 'priority': {
        const pr = Number(value);
        if (Number.isInteger(pr) && pr >= 0 && pr <= 9) ev.priority = pr;
        break;
      }
      case 'color':
        ev.color = String(value);
        break;
      case 'categories':
        for (const v of values) if (v) (ev.keywords ??= {})[String(v)] = true;
        break;
      case 'sequence':
        ev.sequence = Number(value) || 0;
        break;
      case 'created':
        if (typeof value === 'string') ev.created = `${value.slice(0, 19)}Z`;
        break;
      case 'last-modified':
        if (typeof value === 'string') ev.updated = `${value.slice(0, 19)}Z`;
        break;
      case 'dtstamp':
        if (typeof value === 'string' && !ev.updated) ev.updated = `${value.slice(0, 19)}Z`;
        break;
      default:
        unknown.push(p.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...x } : x)) as JCalProp);
    }
  }
  ev.uid ??= newEventUid();
  if (start) {
    ev.start = start.local;
    if (start.isDate) ev.showWithoutTime = true;
    else ev.timeZone = start.tz;
    if (ev.timeZone === null) delete ev.timeZone;
    if (duration) ev.duration = formatDuration(durationSeconds(duration));
    else if (end) {
      if (start.isDate) {
        const days = Math.round((Date.parse(`${dayOf(end.local)}T00:00:00Z`) - Date.parse(`${dayOf(start.local)}T00:00:00Z`)) / 86_400_000);
        ev.duration = `P${Math.max(days, 1)}D`;
      } else if (end.tz === start.tz || (!end.tz && !start.tz)) {
        const secs = (Date.parse(`${end.local}Z`) - Date.parse(`${start.local}Z`)) / 1000;
        ev.duration = formatDuration(Math.max(secs, 0));
      } else ev.duration = formatDuration(Math.max(0, (zonedToUtc(end.local, end.tz) - zonedToUtc(start.local, start.tz)) / 1000));
    } else ev.duration = start.isDate ? 'P1D' : 'PT0S';
    const seriesTz = start.isDate ? null : start.tz;
    const untilToLocal = (raw: string): LocalDateTime => {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw.replace(/[-:]/g, ''));
      if (!m) return start!.local;
      const local = `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
      if (start!.isDate) return `${local.slice(0, 10)}T00:00:00`;
      return m[7] ? utcToZoned(Date.parse(`${local}Z`), seriesTz) : local;
    };
    if (rrules.length) ev.recurrenceRules = rrules.map((r) => rruleToRule(r, untilToLocal));
    if (exrules.length) ev.excludedRecurrenceRules = exrules.map((r) => rruleToRule(r, untilToLocal));
    for (const t of exdates) (ev.recurrenceOverrides ??= {})[toSeriesLocal(t, seriesTz, start.isDate)] = { excluded: true };
    for (const t of rdates) {
      const k = toSeriesLocal(t, seriesTz, start.isDate);
      if (!ev.recurrenceOverrides?.[k]) (ev.recurrenceOverrides ??= {})[k] = {};
    }
  }
  if (Object.keys(participants).length) ev.participants = participants;
  const alerts: Record<string, Alert> = {};
  for (const sub of comp[2] ?? []) {
    if (lc(sub[0]) !== 'valarm') continue;
    const a = valarmToAlert(sub);
    if (a) alerts[`a${Object.keys(alerts).length + 1}`] = a;
  }
  if (Object.keys(alerts).length) ev.alerts = alerts;
  if (unknown.length) ev.iCalendar = { name: 'vevent', properties: unknown };
  return { ev, recurrenceId };
}

function valarmToAlert(comp: JComp): Alert | null {
  let trigger: Alert['trigger'] | null = null;
  let action: Alert['action'] = 'display';
  let acknowledged: string | undefined;
  for (const [rawName, params = {}, type, value] of comp[1]) {
    const name = lc(rawName);
    if (name === 'trigger') {
      if (type === 'date-time' && typeof value === 'string') trigger = { '@type': 'AbsoluteTrigger', when: `${value.slice(0, 19)}Z` };
      else if (typeof value === 'string') {
        trigger = { '@type': 'OffsetTrigger', offset: formatDuration(durationSeconds(value)) };
        if (lc(params.related) === 'end') trigger.relativeTo = 'end';
      }
    } else if (name === 'action') action = lc(value) === 'email' ? 'email' : 'display';
    else if (name === 'acknowledged' && typeof value === 'string') acknowledged = `${value.slice(0, 19)}Z`;
  }
  if (!trigger) return null;
  return { '@type': 'Alert', trigger, action, ...(acknowledged ? { acknowledged } : {}) };
}

/** Patch d'une exception par rapport à sa série (propriétés de premier niveau). */
function overridePatch(master: CalendarEventCreate, inst: CalendarEventCreate, recurrenceId: LocalDateTime): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const skip = new Set(['uid', '@type', 'recurrenceRules', 'excludedRecurrenceRules', 'recurrenceOverrides', 'recurrenceId', 'sequence', 'updated', 'created']);
  const base: Record<string, unknown> = { ...master, start: recurrenceId };
  for (const k of new Set([...Object.keys(base), ...Object.keys(inst)])) {
    if (skip.has(k)) continue;
    const a = base[k];
    const b = (inst as Record<string, unknown>)[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    // absentes d'une exception, ces propriétés sont héritées de la série (clients qui ne les répètent pas)
    if (b === undefined && INHERITED.has(k)) continue;
    patch[k] = b === undefined ? null : b;
  }
  return patch;
}

const INHERITED = new Set(['alerts', 'iCalendar', 'freeBusyStatus', 'participants', 'organizerCalendarAddress', 'privacy', 'color', 'keywords', 'status']);

export interface ParsedIcs {
  /** METHOD du VCALENDAR (`request`, `reply`, `cancel`…), en minuscules. */
  method: string | null;
  events: CalendarEventCreate[];
}

/** Fichier `.ics` (un ou plusieurs VCALENDAR) → événements JSCalendar (exceptions regroupées dans leur série). */
export function parseIcs(text: string): ParsedIcs {
  const parsed = ICAL.parse(text) as unknown[];
  const roots = (Array.isArray(parsed[0]) ? parsed : [parsed]) as JComp[];
  let method: string | null = null;
  const masters = new Map<string, CalendarEventCreate>();
  const order: string[] = [];
  const orphans: Array<{ ev: CalendarEventCreate; rid: TimeValue }> = [];
  const pending: Array<{ ev: CalendarEventCreate; rid: TimeValue }> = [];
  for (const root of roots) {
    if (!Array.isArray(root) || lc(root[0]) !== 'vcalendar') continue;
    const m = root[1].find((p) => lc(p[0]) === 'method')?.[3];
    if (typeof m === 'string' && !method) method = m.toLowerCase();
    const ctx = tzContext(root);
    for (const c of root[2] ?? []) {
      if (lc(c[0]) !== 'vevent') continue;
      const { ev, recurrenceId } = veventToEvent(c, ctx);
      if (recurrenceId) pending.push({ ev, rid: recurrenceId });
      else if (ev.uid && !masters.has(ev.uid)) {
        masters.set(ev.uid, ev);
        order.push(ev.uid);
      }
    }
  }
  for (const { ev, rid } of pending) {
    const master = ev.uid ? masters.get(ev.uid) : undefined;
    if (!master || !master.start) {
      orphans.push({ ev, rid });
      continue;
    }
    const key = toSeriesLocal(rid, master.showWithoutTime ? null : (master.timeZone ?? null), !!master.showWithoutTime);
    // l'exception est exprimée dans le fuseau de la série
    const inst: CalendarEventCreate = { ...ev };
    if (inst.start && !master.showWithoutTime && (inst.timeZone ?? null) !== (master.timeZone ?? null)) {
      inst.start = utcToZoned(zonedToUtc(inst.start, inst.timeZone), master.timeZone);
      inst.timeZone = master.timeZone ?? null;
      if (inst.timeZone === null) delete inst.timeZone;
    }
    (master.recurrenceOverrides ??= {})[key] = overridePatch(master, inst, key);
  }
  const events = order.map((u) => masters.get(u)!);
  // exception sans sa série (invitation à une seule occurrence) : événement autonome, `recurrenceId` gardé
  for (const { ev, rid } of orphans) events.push({ ...ev, recurrenceId: rid.local, ...(rid.tz ? { recurrenceIdTimeZone: rid.tz } : {}) });
  return { method, events };
}

// ------------------------------------------------------------------ JSCalendar → iCalendar

const compact = (local: string) => local.replace(/[-:]/g, '');
const PARTSTAT_OUT: Record<string, string> = { 'needs-action': 'NEEDS-ACTION', accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE', delegated: 'DELEGATED' };

function timeProp(name: string, local: LocalDateTime, tz: string | null | undefined, isDate: boolean): JCalProp {
  if (isDate) return [name, {}, 'date', dayOf(local)];
  if (tz && /^(etc\/)?(utc|gmt)$/i.test(tz)) return [name, {}, 'date-time', `${local.slice(0, 19)}Z`];
  if (tz) return [name, { tzid: tz }, 'date-time', local.slice(0, 19)];
  return [name, {}, 'date-time', local.slice(0, 19)];
}

function utcStamp(iso?: string): string {
  return `${(iso ?? formatUtc(Date.now())).slice(0, 19)}Z`;
}

function addressValue(p: Participant): string | null {
  if (p.calendarAddress) return p.calendarAddress;
  return p.email ? `mailto:${p.email}` : null;
}

function alertToValarm(a: Alert, title: string): JComp {
  const props: JCalProp[] = [['action', {}, 'text', a.action === 'email' ? 'EMAIL' : 'DISPLAY']];
  const t = a.trigger as { '@type': string; offset?: string; relativeTo?: string; when?: string };
  if (t['@type'] === 'AbsoluteTrigger' && t.when) props.push(['trigger', { value: 'DATE-TIME' }, 'date-time', utcStamp(t.when)]);
  else props.push(['trigger', t.relativeTo === 'end' ? { related: 'END' } : {}, 'duration', t.offset ?? '-PT0S']);
  props.push(['description', {}, 'text', title || 'Reminder']);
  if (a.acknowledged) props.push(['acknowledged', {}, 'date-time', utcStamp(a.acknowledged)]);
  return ['valarm', props, []];
}

/** Un événement (ou une occurrence) → propriétés et sous-composants d'un VEVENT. */
function eventToVevent(ev: CalendarEventCreate, opts: { recurrenceId?: LocalDateTime; seriesTz?: string | null; seriesIsDate?: boolean }): JComp {
  const props: JCalProp[] = [];
  const isDate = !!ev.showWithoutTime;
  const tz = isDate ? null : (ev.timeZone ?? null);
  props.push(['uid', {}, 'text', ev.uid ?? newEventUid()]);
  props.push(['dtstamp', {}, 'date-time', utcStamp(ev.updated)]);
  if (ev.created) props.push(['created', {}, 'date-time', utcStamp(ev.created)]);
  if (ev.updated) props.push(['last-modified', {}, 'date-time', utcStamp(ev.updated)]);
  if (opts.recurrenceId) props.push(timeProp('recurrence-id', opts.recurrenceId, opts.seriesTz, !!opts.seriesIsDate));
  const start = ev.start ?? utcToZoned(Date.now(), tz);
  props.push(timeProp('dtstart', start, tz, isDate));
  const dur = parseDuration(ev.duration);
  if (isDate) props.push(timeProp('dtend', addDaysLocal(start, Math.max(1, dur.weeks * 7 + dur.days)), null, true));
  else if (ev.duration && !dur.neg) props.push(timeProp('dtend', endLocal(start, ev.duration), tz, false));
  if (ev.title) props.push(['summary', {}, 'text', ev.title]);
  if (ev.description) props.push(['description', {}, 'text', ev.description]);
  const loc = Object.values(ev.locations ?? {})
    .map((l) => l.name)
    .filter(Boolean)
    .join(', ');
  if (loc) props.push(['location', {}, 'text', loc]);
  if (!opts.recurrenceId) {
    const untilOf = (r: RecurrenceRule) => {
      if (!r.until) return undefined;
      if (isDate) return compact(dayOf(r.until));
      if (tz) return `${compact(formatUtc(zonedToUtc(r.until, tz)).slice(0, 19))}Z`;
      return compact(r.until.slice(0, 19));
    };
    for (const r of ev.recurrenceRules ?? []) props.push(['rrule', {}, 'recur', ICAL.Recur.fromString(ruleToRrule(r, untilOf(r))).toJSON() as never]);
    for (const r of ev.excludedRecurrenceRules ?? []) props.push(['exrule', {}, 'recur', ICAL.Recur.fromString(ruleToRrule(r, untilOf(r))).toJSON() as never]);
    const overrides = ev.recurrenceOverrides ?? {};
    const keys = Object.keys(overrides).sort();
    const excluded = keys.filter((k) => overrides[k]?.excluded);
    if (excluded.length) for (const k of excluded) props.push(timeProp('exdate', k, tz, isDate));
    // dates ajoutées (RDATE) : clés que les règles ne produisent pas
    if (keys.length) {
      const last = keys[keys.length - 1]!;
      const generated = new Set<string>([start]);
      for (const r of ev.recurrenceRules ?? []) for (const d of ruleDates(r, start, last, isDate)) generated.add(d);
      for (const k of keys) if (!overrides[k]?.excluded && !generated.has(k)) props.push(timeProp('rdate', k, tz, isDate));
    }
  }
  const owner = Object.values(ev.participants ?? {}).find((p) => p.roles?.owner);
  const orgAddr = (owner && addressValue(owner)) || ev.organizerCalendarAddress;
  if (orgAddr) props.push(['organizer', owner?.name ? { cn: owner.name } : {}, 'cal-address', orgAddr]);
  for (const p of Object.values(ev.participants ?? {})) {
    const addr = addressValue(p);
    if (!addr) continue;
    const r = p.roles ?? {};
    if (r.owner && !r.attendee && !r.chair && !r.optional) continue;
    const params: Record<string, unknown> = {};
    if (p.name) params.cn = p.name;
    params.role = r.chair ? 'CHAIR' : r.optional ? 'OPT-PARTICIPANT' : r.informational ? 'NON-PARTICIPANT' : 'REQ-PARTICIPANT';
    params.partstat = PARTSTAT_OUT[p.participationStatus ?? 'needs-action'] ?? 'NEEDS-ACTION';
    if (p.expectReply) params.rsvp = 'TRUE';
    if (p.kind && p.kind !== 'individual') params.cutype = p.kind === 'location' ? 'ROOM' : String(p.kind).toUpperCase();
    props.push(['attendee', params, 'cal-address', addr]);
  }
  if (ev.freeBusyStatus === 'free') props.push(['transp', {}, 'text', 'TRANSPARENT']);
  else if (ev.freeBusyStatus === 'busy') props.push(['transp', {}, 'text', 'OPAQUE']);
  if (ev.status) props.push(['status', {}, 'text', ev.status.toUpperCase()]);
  if (ev.privacy && ev.privacy !== 'public') props.push(['class', {}, 'text', ev.privacy === 'secret' ? 'CONFIDENTIAL' : 'PRIVATE']);
  if (typeof ev.priority === 'number' && ev.priority > 0) props.push(['priority', {}, 'integer', ev.priority]);
  if (ev.color) props.push(['color', {}, 'text', ev.color]);
  const kw = Object.entries(ev.keywords ?? {})
    .filter(([, on]) => on)
    .map(([k]) => k);
  if (kw.length) props.push(['categories', {}, 'text', ...kw]);
  if (ev.sequence) props.push(['sequence', {}, 'integer', ev.sequence]);
  for (const p of ev.iCalendar?.properties ?? []) {
    if (!Array.isArray(p) || KNOWN.has(lc(p[0]))) continue;
    props.push(p.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...x } : x)) as JCalProp);
  }
  const subs: JComp[] = Object.values(ev.alerts ?? {}).map((a) => alertToValarm(a, ev.title ?? ''));
  return ['vevent', props, subs];
}

/** VTIMEZONE d'un fuseau IANA pour les années données, à partir des transitions vues par `Intl`. */
export function buildVtimezone(tz: string, fromYear: number, toYear: number): JComp {
  const subs: JComp[] = [];
  const fmtOffset = (ms: number) => {
    const m = Math.round(ms / 60000);
    const s = m < 0 ? '-' : '+';
    const a = Math.abs(m);
    return `${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  };
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  let prev = tzOffsetMs(tz, start);
  const offsets: number[] = [prev];
  const transitions: Array<{ at: number; from: number; to: number }> = [];
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    const o = tzOffsetMs(tz, t);
    if (o !== prev) {
      // recherche dichotomique de l'instant exact (à la minute)
      let lo = t - 86_400_000;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (tzOffsetMs(tz, mid) === prev) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, from: prev, to: o });
      offsets.push(o);
      prev = o;
    }
  }
  const std = Math.min(...offsets);
  if (!transitions.length) {
    subs.push(['standard', [['dtstart', {}, 'date-time', '1970-01-01T00:00:00'], ['tzoffsetfrom', {}, 'utc-offset', fmtOffset(prev)], ['tzoffsetto', {}, 'utc-offset', fmtOffset(prev)]], []]);
  } else {
    for (const tr of transitions) {
      const local = new Date(tr.at + tr.from).toISOString().slice(0, 19);
      subs.push([
        tr.to > std ? 'daylight' : 'standard',
        [['dtstart', {}, 'date-time', local], ['tzoffsetfrom', {}, 'utc-offset', fmtOffset(tr.from)], ['tzoffsetto', {}, 'utc-offset', fmtOffset(tr.to)]],
        [],
      ]);
    }
  }
  return ['vtimezone', [['tzid', {}, 'text', tz], ['x-lic-location', {}, 'unknown', tz]], subs];
}

/** Événements → objet VCALENDAR (jCal) : série, exceptions (RECURRENCE-ID), VTIMEZONE. */
export function eventsToVcalendar(events: CalendarEventCreate[], opts: { method?: string; prodid?: string } = {}): JComp {
  const comps: JComp[] = [];
  const zones = new Map<string, { min: number; max: number }>();
  const noteZone = (tz: string | null | undefined, local: string | undefined) => {
    if (!tz || !local || /^(etc\/)?(utc|gmt)$/i.test(tz) || !isKnownTimeZone(tz)) return;
    const y = Number(local.slice(0, 4));
    const z = zones.get(tz) ?? { min: y, max: y };
    z.min = Math.min(z.min, y);
    z.max = Math.max(z.max, y);
    zones.set(tz, z);
  };
  for (const ev of events) {
    const isDate = !!ev.showWithoutTime;
    const tz = isDate ? null : (ev.timeZone ?? null);
    noteZone(tz, ev.start);
    if (ev.recurrenceRules?.length && ev.start) noteZone(tz, `${Number(ev.start.slice(0, 4)) + 2}`);
    comps.push(eventToVevent(ev, {}));
    for (const [rid, patch] of Object.entries(ev.recurrenceOverrides ?? {})) {
      if (patch?.excluded) continue;
      const realKeys = Object.keys(patch ?? {});
      if (!realKeys.length) continue; // RDATE simple
      const inst = occurrenceOf(ev, rid);
      if (!inst) continue;
      noteZone(inst.showWithoutTime ? null : inst.timeZone, inst.start);
      comps.push(eventToVevent({ ...inst, uid: ev.uid, sequence: ev.sequence } as CalendarEventCreate, { recurrenceId: rid, seriesTz: tz, seriesIsDate: isDate }));
    }
  }
  const tzComps = [...zones].map(([tz, r]) => buildVtimezone(tz, r.min - 1, r.max + 1));
  const props: JCalProp[] = [
    ['version', {}, 'text', '2.0'],
    ['prodid', {}, 'text', opts.prodid ?? '-//Voxel//Calendar//EN'],
    ['calscale', {}, 'text', 'GREGORIAN'],
  ];
  if (opts.method) props.push(['method', {}, 'text', opts.method.toUpperCase()]);
  return ['vcalendar', props, [...tzComps, ...comps]];
}

/** Événements → texte `.ics` (CRLF). */
export function eventsToIcs(events: CalendarEventCreate[], opts: { method?: string; prodid?: string } = {}): string {
  const text = new ICAL.Component(eventsToVcalendar(events, opts) as unknown as unknown[]).toString();
  return `${text.replace(/\r?\n/g, '\r\n').replace(/(\r\n)?$/, '')}\r\n`;
}

/** Un événement → objet CalDAV (un VCALENDAR avec la série et ses exceptions). */
export function eventToIcs(ev: CalendarEventCreate, opts: { method?: string } = {}): string {
  return eventsToIcs([ev], opts);
}

/** Décalage de rappel en minutes (`-PT15M` → 15), ou `null` pour un rappel absolu / relatif à la fin. */
export function alertMinutes(a: Alert): number | null {
  const t = a.trigger as { '@type': string; offset?: string; relativeTo?: string };
  if (t['@type'] !== 'OffsetTrigger' || t.relativeTo === 'end') return null;
  return Math.round(-durationSeconds(t.offset) / 60);
}
