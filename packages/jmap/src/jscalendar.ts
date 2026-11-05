/**
 * Agendas et événements JSCalendar (RFC 8984) tels qu'échangés par JMAP for Calendars
 * (draft-ietf-jmap-calendars, tel qu'implémenté par Stalwart), et fonctions pures communes au webmail et à
 * la passerelle : dates locales et fuseaux (par `Intl`, sans base de fuseaux embarquée), durées, patchs.
 *
 * Module autonome (aucun import) : la passerelle (`apps/server`) l'importe tel quel.
 *
 * Écarts constatés avec Stalwart v1.0.1 (2026-11-03, boîte de test, voir `test/integration-calendars.test.ts`) :
 * - les participants portent `calendarAddress` (`mailto:…`, version récente du brouillon) et non `email` ;
 *   l'organisateur est `organizerCalendarAddress` + un participant `roles.owner` ;
 * - les propriétés iCalendar sans équivalent sont gardées en jCal dans `iCalendar.properties`
 *   (`[nom, paramètres, type, valeur]`), renvoyées par `CalendarEvent/get` seulement si on les demande
 *   explicitement (`properties: [..., 'iCalendar']`) ; une propriété de fournisseur (`exemple.com:x`) est acceptée ;
 * - `CalendarEvent/parse` renvoie un TABLEAU d'événements par blob (tous les VEVENT), avec `method` et des
 *   propriétés `null` (`id`, `calendarIds`, `isDraft`…) qu'il faut retirer avant `CalendarEvent/set`
 *   (`method` est refusé : « immutable ») ;
 * - filtre `inCalendar` (un seul agenda) ; `inCalendars` → `unsupportedFilter` ; `after` / `before` acceptés ;
 * - `expandRecurrences: true` est accepté (`canCalculateChanges: false`, ids synthétiques, `baseEventId`) mais
 *   ne renvoie que la première occurrence et les exceptions, pas celles produites par la règle : le webmail
 *   développe donc les récurrences lui-même (`recurrence.ts`) ;
 * - `CalendarEvent/get` avec une liste `properties` explicite omet `recurrenceRules` (même demandé) : le
 *   webmail lit les événements avec `properties: null` (sans `iCalendar`, que le serveur garde de toute façon) ;
 * - `Calendar/set` : `color` accepté ; `sendSchedulingMessages: true` accepté sur `CalendarEvent/set`.
 * - JSCalendar 2.0 : une seule règle `recurrenceRule` ; `recurrenceRules` est gardé sans effet sur CalDAV (Cyrus 3.13 le refuse) : voir `fromServerEvent` et `toServerEventSet`.
 */

export type LocalDateTime = string; // AAAA-MM-JJTHH:MM:SS, sans fuseau
export type UTCDateTime = string; // AAAA-MM-JJTHH:MM:SSZ
export type Duration = string; // ISO 8601 (P1DT2H, -PT15M, P1W)

export interface CalendarRights {
  mayReadFreeBusy?: boolean;
  mayReadItems?: boolean;
  mayWriteAll?: boolean;
  mayWriteOwn?: boolean;
  mayUpdatePrivate?: boolean;
  mayRSVP?: boolean;
  mayShare?: boolean;
  mayDelete?: boolean;
}

export interface Calendar {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sortOrder?: number;
  isSubscribed?: boolean;
  isVisible?: boolean;
  isDefault?: boolean;
  includeInAvailability?: 'all' | 'attending' | 'none';
  timeZone?: string | null;
  myRights?: CalendarRights;
  [k: string]: unknown;
}

export interface NDay {
  '@type'?: 'NDay';
  day: 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su';
  nthOfPeriod?: number;
}

export interface RecurrenceRule {
  '@type'?: 'RecurrenceRule';
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily' | 'hourly' | 'minutely' | 'secondly';
  interval?: number;
  rscale?: string;
  skip?: 'omit' | 'backward' | 'forward';
  firstDayOfWeek?: NDay['day'];
  byDay?: NDay[];
  byMonthDay?: number[];
  byMonth?: string[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  bySetPosition?: number[];
  count?: number;
  until?: LocalDateTime;
}

export interface OffsetTrigger {
  '@type': 'OffsetTrigger';
  offset: Duration;
  relativeTo?: 'start' | 'end';
}
export interface AbsoluteTrigger {
  '@type': 'AbsoluteTrigger';
  when: UTCDateTime;
}

export interface Alert {
  '@type'?: 'Alert';
  trigger: OffsetTrigger | AbsoluteTrigger | { '@type': string; [k: string]: unknown };
  action?: 'display' | 'email';
  acknowledged?: UTCDateTime;
  [k: string]: unknown;
}

export interface EventLocation {
  '@type'?: 'Location';
  name?: string;
  description?: string;
  [k: string]: unknown;
}

export type ParticipationStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated';

export interface Participant {
  '@type'?: 'Participant';
  name?: string;
  /** Adresse e-mail (RFC 8984). */
  email?: string;
  /** `mailto:…` (brouillon JMAP Calendars, forme utilisée par Stalwart). */
  calendarAddress?: string;
  kind?: 'individual' | 'group' | 'location' | 'resource' | (string & {});
  roles?: Record<string, boolean>;
  participationStatus?: ParticipationStatus;
  expectReply?: boolean;
  [k: string]: unknown;
}

/** Propriétés iCalendar conservées (jCal) pour l'aller-retour. */
export type JCalProp = [string, Record<string, unknown>, string, ...unknown[]];

export interface CalendarEventCreate {
  '@type'?: 'Event';
  uid?: string;
  calendarIds?: Record<string, boolean>;
  title?: string;
  description?: string;
  start?: LocalDateTime;
  timeZone?: string | null;
  duration?: Duration;
  showWithoutTime?: boolean;
  status?: 'confirmed' | 'cancelled' | 'tentative';
  freeBusyStatus?: 'free' | 'busy';
  privacy?: 'public' | 'private' | 'secret';
  priority?: number;
  color?: string;
  keywords?: Record<string, boolean>;
  locations?: Record<string, EventLocation>;
  participants?: Record<string, Participant>;
  organizerCalendarAddress?: string;
  alerts?: Record<string, Alert>;
  useDefaultAlerts?: boolean;
  recurrenceRules?: RecurrenceRule[] | null;
  excludedRecurrenceRules?: RecurrenceRule[] | null;
  recurrenceOverrides?: Record<LocalDateTime, Record<string, unknown>> | null;
  recurrenceId?: LocalDateTime | null;
  recurrenceIdTimeZone?: string | null;
  sequence?: number;
  created?: UTCDateTime;
  updated?: UTCDateTime;
  method?: string;
  iCalendar?: { name?: string; properties?: JCalProp[]; convertedProperties?: Record<string, unknown> } | null;
  [k: string]: unknown;
}

export interface CalendarEvent extends CalendarEventCreate {
  id: string;
  baseEventId?: string | null;
}

export interface CalendarEventFilterCondition {
  inCalendar?: string;
  after?: UTCDateTime | LocalDateTime;
  before?: UTCDateTime | LocalDateTime;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  owner?: string;
  attendee?: string;
  uid?: string;
}

export interface CalendarsAccountCapability {
  maxCalendarsPerEvent?: number | null;
  minDateTime?: string;
  maxDateTime?: string;
  maxExpandedQueryDuration?: string;
  maxParticipantsPerEvent?: number | null;
  mayCreateCalendar?: boolean;
}

// ------------------------------------------------------------------ identifiants

/** Nouvel `uid` d'événement (UUID). */
export function newEventUid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ------------------------------------------------------------------ dates locales

export interface LocalParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

export function parseLocal(s: string): LocalParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) throw new RangeError(`bad LocalDateTime ${s}`);
  return { y: +m[1]!, m: +m[2]!, d: +m[3]!, hh: +(m[4] ?? 0), mm: +(m[5] ?? 0), ss: +(m[6] ?? 0) };
}

export function formatLocal(p: LocalParts): LocalDateTime {
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
}

/** Normalise des composantes qui débordent (jour 32, heure 25…) par l'arithmétique UTC. */
function normalize(p: LocalParts): LocalParts {
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds() };
}

export function addDaysLocal(s: LocalDateTime, days: number): LocalDateTime {
  const p = parseLocal(s);
  return formatLocal(normalize({ ...p, d: p.d + days }));
}

export function addSecondsLocal(s: LocalDateTime, secs: number): LocalDateTime {
  const p = parseLocal(s);
  return formatLocal(normalize({ ...p, ss: p.ss + secs }));
}

/** Date du jour (AAAA-MM-JJ) d'une date locale. */
export const dayOf = (s: string) => s.slice(0, 10);

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Le fuseau IANA est-il connu de ce moteur (`Intl`) ? */
export function isKnownTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

const isUtcZone = (tz: string) => /^(utc|etc\/utc|gmt|etc\/gmt|z)$/i.test(tz);

/** Décalage (ms) du fuseau à un instant : heure locale − UTC. */
export function tzOffsetMs(tz: string, ms: number): number {
  if (isUtcZone(tz)) return 0;
  const parts = dtf(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Date locale dans un fuseau → instant UTC (ms). `tz` absent ou inconnu : heure locale de l'environnement
 * (événement « flottant »). Heure inexistante (passage à l'heure d'été) : décalée vers l'avant.
 */
export function zonedToUtc(local: LocalDateTime, tz?: string | null): number {
  const p = parseLocal(local);
  if (!tz || !isKnownTimeZone(tz)) return new Date(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss).getTime();
  const guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  let t = guess - tzOffsetMs(tz, guess);
  const o2 = tzOffsetMs(tz, t);
  if (guess - o2 !== t) {
    const t2 = guess - o2;
    // heure inexistante : on garde le plus tardif des deux candidats
    t = tzOffsetMs(tz, t2) === o2 ? t2 : Math.max(t, t2);
  }
  return t;
}

/** Instant UTC (ms) → date locale dans un fuseau (environnement si absent). */
export function utcToZoned(ms: number, tz?: string | null): LocalDateTime {
  if (!tz || !isKnownTimeZone(tz)) {
    const d = new Date(ms);
    return formatLocal({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes(), ss: d.getSeconds() });
  }
  const d = new Date(ms + tzOffsetMs(tz, ms));
  return formatLocal({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds() });
}

/** `2026-11-03T10:00:00Z` → ms ; date locale sans `Z` : heure de l'environnement. */
export function parseUtc(s: string): number {
  return /[zZ]$|[+-]\d{2}:\d{2}$/.test(s) ? Date.parse(s) : zonedToUtc(s, null);
}

export function formatUtc(ms: number): UTCDateTime {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

// ------------------------------------------------------------------ durées

export interface DurationParts {
  neg: boolean;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function parseDuration(s: string | null | undefined): DurationParts {
  const z = { neg: false, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  if (!s) return z;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return z;
  return { neg: m[1] === '-', weeks: +(m[2] ?? 0), days: +(m[3] ?? 0), hours: +(m[4] ?? 0), minutes: +(m[5] ?? 0), seconds: Math.round(+(m[6] ?? 0)) };
}

/** Durée → secondes signées (un jour = 86 400 s). */
export function durationSeconds(s: string | null | undefined): number {
  const d = parseDuration(s);
  const v = ((d.weeks * 7 + d.days) * 24 + d.hours) * 3600 + d.minutes * 60 + d.seconds;
  return d.neg ? -v : v;
}

/** Secondes → durée ISO (`P1DT2H`, `PT0S`). `days` : garder les jours (sinon tout en heures). */
export function formatDuration(totalSeconds: number, days = true): Duration {
  const neg = totalSeconds < 0;
  let s = Math.abs(Math.round(totalSeconds));
  const d = days ? Math.floor(s / 86400) : 0;
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let out = `${neg ? '-' : ''}P`;
  if (d) out += `${d}D`;
  if (h || m || s || !d) {
    out += 'T';
    if (h) out += `${h}H`;
    if (m) out += `${m}M`;
    if (s || (!h && !m)) out += `${s}S`;
  }
  return out;
}

/** Fin locale d'un événement : jours nominaux (heure murale conservée), puis le reste en temps écoulé. */
export function endLocal(start: LocalDateTime, duration: Duration | undefined): LocalDateTime {
  const d = parseDuration(duration);
  const sign = d.neg ? -1 : 1;
  const days = sign * (d.weeks * 7 + d.days);
  return addSecondsLocal(addDaysLocal(start, days), sign * (d.hours * 3600 + d.minutes * 60 + d.seconds));
}

/** Instants de début et de fin (ms) d'un événement (ou d'une occurrence), journée entière : heure de l'environnement. */
export function eventSpan(ev: Pick<CalendarEventCreate, 'start' | 'timeZone' | 'duration' | 'showWithoutTime'>): { start: number; end: number } {
  const startLocal = ev.start ?? '1970-01-01T00:00:00';
  const tz = ev.showWithoutTime ? null : (ev.timeZone ?? null);
  const s = zonedToUtc(startLocal, tz);
  const d = parseDuration(ev.duration);
  const nominal = d.weeks * 7 + d.days;
  const rest = d.hours * 3600 + d.minutes * 60 + d.seconds;
  const e = nominal ? zonedToUtc(addDaysLocal(startLocal, nominal), tz) + rest * 1000 : s + rest * 1000;
  return { start: s, end: Math.max(e, s) };
}

// ------------------------------------------------------------------ participants, texte

/** Adresse e-mail d'un participant (`email` ou `calendarAddress` en `mailto:`). */
export function participantEmail(p: Participant | undefined | null): string | null {
  if (!p) return null;
  if (p.email) return p.email.toLowerCase();
  const a = p.calendarAddress;
  if (a && /^mailto:/i.test(a)) return decodeURIComponent(a.slice(7)).toLowerCase();
  return null;
}

/** Participant d'une adresse (organisateur compris). */
export function findParticipant(ev: CalendarEventCreate, email: string): [string, Participant] | null {
  const want = email.toLowerCase();
  for (const [k, p] of Object.entries(ev.participants ?? {})) if (participantEmail(p) === want) return [k, p];
  return null;
}

/** Organisateur (`roles.owner`, sinon `organizerCalendarAddress`). */
export function organizerOf(ev: CalendarEventCreate): { name?: string; email: string } | null {
  for (const p of Object.values(ev.participants ?? {})) {
    if (p.roles?.owner) {
      const email = participantEmail(p);
      if (email) return { ...(p.name ? { name: p.name } : {}), email };
    }
  }
  const a = ev.organizerCalendarAddress;
  return a && /^mailto:/i.test(a) ? { email: decodeURIComponent(a.slice(7)).toLowerCase() } : null;
}

/** Texte de recherche : titre, description, lieux, participants, minuscules sans accents. */
export function eventSearchText(ev: CalendarEventCreate): string {
  const parts = [ev.title ?? '', ev.description ?? ''];
  for (const l of Object.values(ev.locations ?? {})) parts.push(l.name ?? '');
  for (const p of Object.values(ev.participants ?? {})) parts.push(p.name ?? '', participantEmail(p) ?? '');
  return parts
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function eventLocation(ev: CalendarEventCreate): string {
  return Object.values(ev.locations ?? {})
    .map((l) => l.name ?? '')
    .filter(Boolean)
    .join(', ');
}

// ------------------------------------------------------------------ patchs

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Applique un PatchObject JMAP (RFC 8620 §5.3 : chemins JSON Pointer sans « / » initial, `null` = suppression).
 * Sert aussi aux `recurrenceOverrides` (RFC 8984 §4.3.5).
 */
export function applyEventPatch<T extends Record<string, unknown>>(obj: T, patch: Record<string, unknown>): T {
  const out = structuredClone(obj) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!parts.length || parts.some((p) => p === '' || BAD_KEYS.has(p))) throw new Error(`invalidPatch ${path}`);
    let cur: Record<string, unknown> = out;
    for (const p of parts.slice(0, -1)) {
      const next = cur[p];
      if (next === undefined || next === null) cur[p] = {};
      else if (typeof next !== 'object' || Array.isArray(next)) throw new Error(`invalidPatch ${path}`);
      cur = cur[p] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    if (value === null) delete cur[last];
    else cur[last] = structuredClone(value);
  }
  return out as T;
}

/** Patch de premier niveau entre deux événements (propriétés remplacées en entier, `null` = supprimée). */
export function eventPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const skip = new Set(['id', 'uid', '@type', 'created', 'updated', 'sequence', 'baseEventId', 'method']);
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(k)) continue;
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    patch[k] = b === undefined ? null : b;
  }
  return patch;
}

/** Retire ce que `CalendarEvent/parse` renvoie mais que `CalendarEvent/set` refuse (`method`, valeurs `null`, `id`). */
export function cleanParsedEvent(ev: Record<string, unknown>): CalendarEventCreate {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (v === null || k === 'method' || k === 'id' || k === 'baseEventId' || k === 'calendarIds') continue;
    out[k] = v;
  }
  return out as CalendarEventCreate;
}

/** Règle avec ses `@type` (`RecurrenceRule`, `NDay` sur `byDay`), forme du modèle de l'interface. */
function typedRule(rule: unknown): unknown {
  if (!rule || typeof rule !== 'object') return rule;
  const r = rule as Record<string, unknown>;
  const out: Record<string, unknown> = { '@type': 'RecurrenceRule', ...r };
  if (Array.isArray(r.byDay)) out.byDay = r.byDay.map((d) => (d && typeof d === 'object' ? { '@type': 'NDay', ...d } : d));
  return out;
}

/** Règle sans aucune clé `@type`, forme JSCalendar 2.0 envoyée au serveur. */
function untypedRule(rule: unknown): unknown {
  if (!rule || typeof rule !== 'object') return rule;
  const { '@type': _t, ...r } = rule as Record<string, unknown>;
  if (Array.isArray(r.byDay)) {
    r.byDay = r.byDay.map((d) => {
      if (!d || typeof d !== 'object') return d;
      const { '@type': _d, ...rest } = d as Record<string, unknown>;
      return rest;
    });
  }
  return r;
}

/**
 * Événement lu d'un serveur → modèle de l'interface (RFC 8984). JSCalendar 2.0 (Stalwart, Cyrus 3.13) porte une
 * seule règle `recurrenceRule` : elle devient `recurrenceRules: [règle]`. Sans `recurrenceRule`, l'objet revient
 * tel quel (passerelle, ou événement écrit par une version précédente de Voxel). Pure et idempotente.
 */
export function fromServerEvent<T extends object>(ev: T): T {
  if (!Object.prototype.hasOwnProperty.call(ev, 'recurrenceRule')) return ev;
  // `recurrenceRule` fait foi : c'est lui que le serveur traduit en RRULE
  const { recurrenceRule: rule, recurrenceRules: _r, excludedRecurrenceRules: _x, ...rest } = ev as Record<string, unknown>;
  const out: Record<string, unknown> = rest;
  if (rule && typeof rule === 'object') out.recurrenceRules = [typedRule(rule)];
  return out as T;
}

/**
 * Arguments de `CalendarEvent/set` pour un compte JMAP (jamais pour la passerelle) : créations et patchs passent
 * en JSCalendar 2.0 (`recurrenceRule`, `version`). Renvoie une copie ; le reste des arguments passe tel quel.
 */
export function toServerEventSet<A extends Record<string, unknown>>(args: A): A {
  const out: Record<string, unknown> = { ...args };
  const create = args.create as Record<string, Record<string, unknown>> | null | undefined;
  if (create) {
    const c: Record<string, unknown> = {};
    for (const [id, ev] of Object.entries(create)) {
      const { recurrenceRules: rules, excludedRecurrenceRules: _x, ...rest } = ev;
      const e: Record<string, unknown> = { ...rest };
      if (e.version === undefined) e.version = '2.0';
      if (Array.isArray(rules) && rules.length > 0) e.recurrenceRule = untypedRule(rules[0]);
      c[id] = e;
    }
    out.create = c;
  }
  const update = args.update as Record<string, Record<string, unknown>> | null | undefined;
  if (update) {
    const u: Record<string, unknown> = {};
    for (const [id, patch] of Object.entries(update)) {
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'recurrenceRules') p.recurrenceRule = Array.isArray(v) && v.length > 0 ? untypedRule(v[0]) : null;
        else if (k === 'recurrenceRules/0') p.recurrenceRule = v == null ? null : untypedRule(v);
        else if (k.startsWith('recurrenceRules/0/')) p[`recurrenceRule/${k.slice('recurrenceRules/0/'.length)}`] = v;
        else if (k.startsWith('recurrenceRules/') || k === 'excludedRecurrenceRules' || k.startsWith('excludedRecurrenceRules/')) continue;
        else p[k] = v;
      }
      u[id] = p;
    }
    out.update = u;
  }
  return out as A;
}
