/**
 * Façade CalDAV → JMAP for Calendars (draft-ietf-jmap-calendars) pour les boîtes IMAP de la passerelle.
 *
 * - `Calendar/get|changes`, `CalendarEvent/get|changes|query|set|parse` (`Calendar/set` non pris en charge :
 *   la capacité annonce `mayCreateCalendar: false`). Même client WebDAV que les contacts (`carddav/dav.ts`).
 * - Une ressource CalDAV (un VCALENDAR, une série et ses exceptions) = un événement JMAP ; conversion iCalendar ↔
 *   JSCalendar par `@voxel/jmap/ical` (propriétés inconnues gardées dans `iCalendar.properties`).
 * - Sans état : identifiants dérivés du chemin (`k…` agenda, `e…` événement) ; `state` en base64url opaque
 *   (jeton `sync-collection` par agenda, sinon empreinte de l'ETag de chaque ressource), comme les contacts.
 * - `CalendarEvent/query` : `inCalendar`, `after` / `before` (REPORT `calendar-query` avec `time-range`, puis
 *   développement des récurrences en mémoire), `text`, `title`, `description`, `location`, `uid` ;
 *   `expandRecurrences: true` → une entrée par occurrence (id `<événement>_<AAAAMMJJTHHMMSS>`), lisible par
 *   `CalendarEvent/get` (avec `recurrenceId` et `baseEventId`) ; modifier ou supprimer une occurrence ajoute une
 *   exception (`recurrenceOverrides`) à la série.
 * - Pas d'iTIP : `sendSchedulingMessages` est ignoré (aucune invitation envoyée par la passerelle).
 * - Conflit d'ETag (412) → `stateMismatch`.
 */
import { applyEventPatch, eventSearchText, eventLocation, newEventUid, cleanParsedEvent, parseUtc, eventSpan, type CalendarEventCreate } from '@voxel/jmap/jscalendar';
import { eventToIcs, parseIcs } from '@voxel/jmap/ical';
import { expandEvent, occurrenceOf } from '@voxel/jmap/recurrence';
import { hashOf, isObject, MethodError, SetError } from '../imap/util.js';
import { DavClient, type DavBook, type DavFetch, type DavMember } from '../carddav/dav.js';

export const CAP_CALENDARS = 'urn:ietf:params:jmap:calendars';
export const CAP_CALENDARS_PARSE = 'urn:ietf:params:jmap:calendars:parse';
const PROBE_MS = 5_000;
const CALS_TTL = 30_000;
const SNAPSHOT_TTL = 3_000;
const MAX_CACHE = 5_000;
const MAX_STATE_ENTRIES = 20_000;
const MAX_ICS = 5 * 1024 * 1024;
const MAX_EXPANDED = 5_000;
const CONTENT_TYPE = 'text/calendar; charset=utf-8';

export interface CalDavFacadeOptions {
  serviceUrl: URL;
  username: string;
  password: string;
  loadUpload: (blobId: string) => Promise<Buffer | null>;
  fetch?: DavFetch;
}

interface CalEntry {
  id: string;
  cal: DavBook;
  members: DavMember[];
}

interface EncodedState {
  v: 1;
  b: Record<string, { t?: string; e?: Record<string, string> }>;
}

const calIdOf = (href: string) => `k${hashOf(`cal:${href}`, 12)}`;
const eventIdOf = (href: string) => `e${hashOf(`event:${href}`, 16)}`;
const etagKey = (etag: string) => hashOf(etag, 8);
/** Id d'une occurrence développée : `<id>_<AAAAMMJJTHHMMSS>`. */
const occurrenceId = (id: string, rid: string) => `${id}_${rid.replace(/[-:]/g, '')}`;
function splitOccurrenceId(id: string): { id: string; rid: string } | null {
  const m = /^(e[A-Za-z0-9_-]{16})_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(id);
  return m ? { id: m[1]!, rid: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}` } : null;
}

function encodeState(s: EncodedState): string {
  return `d${Buffer.from(JSON.stringify(s)).toString('base64url')}`;
}

function decodeState(raw: unknown): EncodedState | null {
  if (typeof raw !== 'string' || !raw.startsWith('d')) return null;
  try {
    const s = JSON.parse(Buffer.from(raw.slice(1), 'base64url').toString('utf8')) as EncodedState;
    return s && s.v === 1 && isObject(s.b) ? s : null;
  } catch {
    return null;
  }
}

function fileNameFor(uid: string): string {
  const base = uid
    .replace(/^urn:uuid:/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 120);
  return `${base || hashOf(uid, 16)}.ics`;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Bornes `after` / `before` d'un filtre (UTC, ou date locale dans `timeZone`). */
function bound(v: unknown): number | null {
  return typeof v === 'string' && v ? parseUtc(v) : null;
}

/** Filtre `CalendarEvent/query` (conditions et opérateurs) sur un événement, hors bornes de dates. */
function matches(ev: CalendarEventCreate & { calendarIds?: Record<string, boolean> }, f: unknown): boolean {
  if (!isObject(f)) return true;
  if (typeof f.operator === 'string' && Array.isArray(f.conditions)) {
    const subs = f.conditions as unknown[];
    if (f.operator === 'AND') return subs.every((x) => matches(ev, x));
    if (f.operator === 'OR') return subs.some((x) => matches(ev, x));
    if (f.operator === 'NOT') return !subs.some((x) => matches(ev, x));
    return false;
  }
  if (typeof f.inCalendar === 'string' && !ev.calendarIds?.[f.inCalendar]) return false;
  if (typeof f.uid === 'string' && ev.uid !== f.uid) return false;
  if (typeof f.text === 'string' && !eventSearchText(ev).includes(fold(f.text))) return false;
  if (typeof f.title === 'string' && !fold(ev.title ?? '').includes(fold(f.title))) return false;
  if (typeof f.description === 'string' && !fold(ev.description ?? '').includes(fold(f.description))) return false;
  if (typeof f.location === 'string' && !fold(eventLocation(ev)).includes(fold(f.location))) return false;
  return true;
}

/** Bornes de dates d'un filtre (seulement au premier niveau ou dans un AND). */
function rangeOf(f: unknown): { after: number | null; before: number | null } {
  if (!isObject(f)) return { after: null, before: null };
  if (f.operator === 'AND' && Array.isArray(f.conditions)) {
    let after: number | null = null;
    let before: number | null = null;
    for (const c of f.conditions) {
      const r = rangeOf(c);
      if (r.after !== null) after = Math.max(after ?? r.after, r.after);
      if (r.before !== null) before = Math.min(before ?? r.before, r.before);
    }
    return { after, before };
  }
  return { after: bound(f.after), before: bound(f.before) };
}

export class CalDavFacade {
  private readonly dav: DavClient;
  private cals: { at: number; list: DavBook[] } | null = null;
  private snap: { at: number; list: CalEntry[] } | null = null;
  private readonly events = new Map<string, { etag: string; ev: CalendarEventCreate }>();
  available: boolean | null = null;

  constructor(private readonly opts: CalDavFacadeOptions) {
    this.dav = new DavClient(opts.serviceUrl, opts.username, opts.password, opts.fetch);
  }

  async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const list = await this.dav.discoverCalendars({ timeoutMs: PROBE_MS, signal: AbortSignal.timeout(PROBE_MS) });
      this.cals = { at: Date.now(), list };
      this.available = list.length > 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  sessionCapability(): { core: Record<string, Record<string, unknown>>; account: Record<string, Record<string, unknown>> } | null {
    if (!this.available) return null;
    return {
      core: { [CAP_CALENDARS]: {}, [CAP_CALENDARS_PARSE]: {} },
      account: {
        [CAP_CALENDARS]: { maxCalendarsPerEvent: 1, mayCreateCalendar: false, maxExpandedQueryDuration: 'P400D', maxParticipantsPerEvent: null },
        [CAP_CALENDARS_PARSE]: {},
      },
    };
  }

  // ---------------------------------------------------------------- lecture DAV

  private async listCals(fresh = false): Promise<DavBook[]> {
    if (!fresh && this.cals && Date.now() - this.cals.at < CALS_TTL) return this.cals.list;
    const list = await this.dav.discoverCalendars();
    this.cals = { at: Date.now(), list };
    return list;
  }

  private async snapshot(fresh = false): Promise<CalEntry[]> {
    if (!fresh && this.snap && Date.now() - this.snap.at < SNAPSHOT_TTL) return this.snap.list;
    const cals = await this.listCals(fresh);
    const list = await Promise.all(cals.map(async (cal) => ({ id: calIdOf(cal.href), cal, members: await this.dav.listMembers(cal.href) })));
    this.snap = { at: Date.now(), list };
    return list;
  }

  private invalidate(): void {
    this.snap = null;
    if (this.cals) this.cals.at = 0;
  }

  private remember(href: string, etag: string, ev: CalendarEventCreate): void {
    if (this.events.size >= MAX_CACHE) this.events.delete(this.events.keys().next().value!);
    this.events.set(href, { etag, ev });
  }

  /** Événements des ressources demandées : cache si l'ETag n'a pas changé, sinon `calendar-multiget`. */
  private async loadEvents(entry: CalEntry, members: DavMember[]): Promise<Map<string, CalendarEventCreate>> {
    const out = new Map<string, CalendarEventCreate>();
    const missing: string[] = [];
    for (const m of members) {
      const hit = this.events.get(m.href);
      if (hit && hit.etag === m.etag) out.set(m.href, hit.ev);
      else missing.push(m.href);
    }
    if (missing.length) {
      for (const r of await this.dav.multiget(entry.cal.href, missing, 'cal')) {
        let ev: CalendarEventCreate | undefined;
        try {
          ev = parseIcs(r.data).events[0];
        } catch {
          continue; // iCalendar illisible : ignoré
        }
        if (!ev) continue;
        const etag = r.etag || members.find((m) => m.href === r.href)?.etag || '';
        this.remember(r.href, etag, ev);
        out.set(r.href, ev);
      }
    }
    return out;
  }

  private stateOf(list: CalEntry[]): string {
    const b: EncodedState['b'] = {};
    let n = 0;
    for (const e of list) {
      if (e.cal.supportsSync && e.cal.syncToken) b[e.id] = { t: e.cal.syncToken };
      else {
        b[e.id] = { e: Object.fromEntries(e.members.map((m) => [eventIdOf(m.href), etagKey(m.etag)])) };
        n += e.members.length;
      }
    }
    if (n > MAX_STATE_ENTRIES) return `h${hashOf(JSON.stringify(b), 20)}`;
    return encodeState({ v: 1, b });
  }

  private static pick(obj: Record<string, unknown>, props: Set<string> | null): Record<string, unknown> {
    return props ? Object.fromEntries(Object.entries(obj).filter(([k]) => props.has(k))) : obj;
  }

  private static jmapEvent(id: string, calId: string, ev: CalendarEventCreate): Record<string, unknown> {
    return { ...ev, id, calendarIds: { [calId]: true }, baseEventId: null };
  }

  private async eventsOf(list: CalEntry[], ids: string[] | null): Promise<Array<{ id: string; href: string; etag: string; entry: CalEntry; ev: Record<string, unknown> }>> {
    const want = ids ? new Set(ids) : null;
    const out: Array<{ id: string; href: string; etag: string; entry: CalEntry; ev: Record<string, unknown> }> = [];
    for (const entry of list) {
      const members = want ? entry.members.filter((m) => want.has(eventIdOf(m.href))) : entry.members;
      if (!members.length) continue;
      const loaded = await this.loadEvents(entry, members);
      for (const m of members) {
        const ev = loaded.get(m.href);
        if (!ev) continue;
        const id = eventIdOf(m.href);
        out.push({ id, href: m.href, etag: m.etag, entry, ev: CalDavFacade.jmapEvent(id, entry.id, ev) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Calendar

  private static calsState(list: Array<{ id: string; cal: DavBook }>): string {
    const rows = list.map((e) => [e.id, hashOf(JSON.stringify([e.cal.name, e.cal.description, e.cal.mayWrite, e.cal.color]), 8)]);
    return `a${Buffer.from(JSON.stringify(rows)).toString('base64url')}`;
  }

  private static calJson(e: { id: string; cal: DavBook }, i: number): Record<string, unknown> {
    return {
      id: e.id,
      name: e.cal.name,
      description: e.cal.description,
      color: e.cal.color ?? null,
      sortOrder: i,
      isDefault: i === 0,
      isSubscribed: true,
      isVisible: true,
      includeInAvailability: 'all',
      timeZone: null,
      shareWith: null,
      myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: e.cal.mayWrite, mayWriteOwn: e.cal.mayWrite, mayUpdatePrivate: e.cal.mayWrite, mayRSVP: e.cal.mayWrite, mayShare: false, mayDelete: false },
    };
  }

  async calendarGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cals = (await this.listCals()).map((cal) => ({ id: calIdOf(cal.href), cal }));
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    const props = Array.isArray(args.properties) ? new Set(['id', ...(args.properties as string[])]) : null;
    const all = cals.map((c, i) => CalDavFacade.calJson(c, i));
    return {
      state: CalDavFacade.calsState(cals),
      list: (ids ? all.filter((c) => ids.includes(c.id as string)) : all).map((c) => CalDavFacade.pick(c, props)),
      notFound: ids ? ids.filter((id) => !cals.some((c) => c.id === id)) : [],
    };
  }

  async calendarChanges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const since = typeof args.sinceState === 'string' && args.sinceState.startsWith('a') ? args.sinceState : null;
    let old: Array<[string, string]>;
    try {
      old = since ? (JSON.parse(Buffer.from(since.slice(1), 'base64url').toString('utf8')) as Array<[string, string]>) : [];
      if (!since || !Array.isArray(old)) throw new Error('bad state');
    } catch {
      throw new MethodError('cannotCalculateChanges');
    }
    const cals = (await this.listCals(true)).map((cal) => ({ id: calIdOf(cal.href), cal }));
    const nowState = CalDavFacade.calsState(cals);
    const now = new Map(JSON.parse(Buffer.from(nowState.slice(1), 'base64url').toString('utf8')) as Array<[string, string]>);
    const before = new Map(old);
    return {
      oldState: since,
      newState: nowState,
      hasMoreChanges: false,
      created: [...now.keys()].filter((id) => !before.has(id)),
      updated: [...now.keys()].filter((id) => before.has(id) && before.get(id) !== now.get(id)),
      destroyed: [...before.keys()].filter((id) => !now.has(id)),
    };
  }

  // ---------------------------------------------------------------- CalendarEvent

  async get(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.snapshot();
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    const props = Array.isArray(args.properties) ? new Set(['id', ...(args.properties as string[])]) : null;
    // occurrences développées : on lit leur série
    const occ = new Map<string, { id: string; rid: string }>();
    const baseIds = ids?.map((id) => {
      const o = splitOccurrenceId(id);
      if (o) occ.set(id, o);
      return o ? o.id : id;
    });
    const found = await this.eventsOf(list, baseIds ? [...new Set(baseIds)] : null);
    const byId = new Map(found.map((f) => [f.id, f]));
    const out: Array<Record<string, unknown>> = [];
    const notFound: string[] = [];
    for (const id of ids ?? found.map((f) => f.id)) {
      const o = occ.get(id);
      if (!o) {
        const f = byId.get(id);
        if (f) out.push(CalDavFacade.pick(f.ev, props));
        else notFound.push(id);
        continue;
      }
      const f = byId.get(o.id);
      const inst = f ? occurrenceOf(f.ev as CalendarEventCreate, o.rid) : null;
      if (!f || !inst) {
        notFound.push(id);
        continue;
      }
      out.push(CalDavFacade.pick({ ...inst, id, calendarIds: f.ev.calendarIds, baseEventId: o.id, recurrenceId: o.rid }, props));
    }
    return { state: this.stateOf(list), list: out, notFound: ids ? notFound : [] };
  }

  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.snapshot();
    const { after, before } = rangeOf(args.filter);
    let entries = list;
    // plage : on ne lit que les ressources que le serveur trouve dans la plage (calendar-query + time-range)
    if (after !== null || before !== null) {
      entries = await Promise.all(
        list.map(async (e) => {
          const hits = await this.dav.calendarQuery(e.cal.href, { ...(after !== null ? { start: new Date(after) } : {}), ...(before !== null ? { end: new Date(before) } : {}) });
          const keep = new Set(hits.map((h) => h.href));
          return { ...e, members: e.members.filter((m) => keep.has(m.href)) };
        }),
      );
    }
    const all = await this.eventsOf(entries, null);
    // borne absente : 50 ans de part et d'autre (dates valides pour le calcul des fuseaux)
    const from = after ?? Date.now() - 50 * 365.25 * 86_400_000;
    const to = before ?? Date.now() + 50 * 365.25 * 86_400_000;
    const ranged = after !== null || before !== null;
    type Row = { id: string; start: number };
    let rows: Row[] = [];
    for (const f of all) {
      const ev = f.ev as CalendarEventCreate & { calendarIds?: Record<string, boolean> };
      if (!matches(ev, args.filter)) continue;
      if (args.expandRecurrences === true) {
        if (after === null || before === null) throw new MethodError('cannotExpand', 'expandRecurrences needs after and before');
        for (const o of expandEvent(ev, from, to)) {
          rows.push({ id: o.recurrenceId ? occurrenceId(f.id, o.recurrenceId) : f.id, start: o.start });
          if (rows.length > MAX_EXPANDED) throw new MethodError('tooManyResults' as string, 'too many occurrences');
        }
      } else if (ranged) {
        const occ = expandEvent(ev, from, to, { maxResults: 1 });
        if (!occ.length) continue;
        rows.push({ id: f.id, start: occ[0]!.start });
      } else rows.push({ id: f.id, start: eventSpan(ev).start });
    }
    const sort = Array.isArray(args.sort) ? (args.sort as Array<{ property?: string; isAscending?: boolean }>)[0] : undefined;
    rows = rows.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    if (sort?.isAscending === false) rows.reverse();
    const position = typeof args.position === 'number' ? Math.max(0, args.position) : 0;
    const limit = typeof args.limit === 'number' ? Math.max(0, args.limit) : rows.length;
    return {
      queryState: this.stateOf(list),
      canCalculateChanges: false,
      position,
      ids: rows.slice(position, position + limit).map((r) => r.id),
      ...(args.calculateTotal ? { total: rows.length } : {}),
    };
  }

  async changes(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const old = decodeState(args.sinceState);
    if (!old) throw new MethodError('cannotCalculateChanges');
    const cals = await this.listCals(true);
    const created: string[] = [];
    const updated: string[] = [];
    const destroyed: string[] = [];
    const next: EncodedState = { v: 1, b: {} };
    for (const cal of cals) {
      const id = calIdOf(cal.href);
      const prev = old.b[id];
      if (prev?.t && cal.supportsSync) {
        const r = await this.dav.syncCollection(cal.href, prev.t);
        if ('invalidToken' in r) throw new MethodError('cannotCalculateChanges');
        for (const m of r.changed) updated.push(eventIdOf(m.href));
        for (const h of r.removed) destroyed.push(eventIdOf(h));
        next.b[id] = { t: r.token ?? cal.syncToken ?? prev.t };
        continue;
      }
      const members = await this.dav.listMembers(cal.href);
      const now = Object.fromEntries(members.map((m) => [eventIdOf(m.href), etagKey(m.etag)]));
      const before = prev?.e ?? {};
      for (const [eid, tag] of Object.entries(now)) {
        if (!(eid in before)) created.push(eid);
        else if (before[eid] !== tag) updated.push(eid);
      }
      for (const eid of Object.keys(before)) if (!(eid in now)) destroyed.push(eid);
      if (cal.supportsSync && cal.syncToken) next.b[id] = { t: cal.syncToken };
      else next.b[id] = { e: now };
    }
    for (const [cid, prev] of Object.entries(old.b)) {
      if (cals.some((c) => calIdOf(c.href) === cid)) continue;
      if (!prev.e) throw new MethodError('cannotCalculateChanges');
      destroyed.push(...Object.keys(prev.e));
    }
    this.snap = null;
    return {
      oldState: args.sinceState,
      newState: encodeState(next),
      hasMoreChanges: false,
      created,
      updated: updated.filter((id) => !created.includes(id)),
      destroyed,
      updatedProperties: null,
    };
  }

  async set(args: Record<string, unknown>, resolveId: (id: string) => string, onCreated: (cid: string, id: string) => void): Promise<Record<string, unknown>> {
    const before = await this.snapshot(true);
    const oldState = this.stateOf(before);
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    const byCal = new Map(before.map((e) => [e.id, e]));
    const locate = (id: string) => {
      for (const e of before) {
        const m = e.members.find((x) => eventIdOf(x.href) === id);
        if (m) return { entry: e, member: m };
      }
      return null;
    };
    const targetCal = (ids: unknown): CalEntry => {
      if (ids === undefined || ids === null) {
        const def = before.find((e) => e.cal.mayWrite) ?? before[0];
        if (!def) throw new SetError('invalidProperties', 'no calendar', ['calendarIds']);
        return def;
      }
      if (!isObject(ids)) throw new SetError('invalidProperties', 'calendarIds must be an object', ['calendarIds']);
      const on = Object.entries(ids)
        .filter(([, v]) => v === true)
        .map(([k]) => resolveId(k));
      if (on.length !== 1) throw new SetError('invalidProperties', 'exactly one calendar is supported', ['calendarIds']);
      const e = byCal.get(on[0]!);
      if (!e) throw new SetError('invalidProperties', 'unknown calendar', ['calendarIds']);
      if (!e.cal.mayWrite) throw new SetError('forbidden', 'calendar is read-only', ['calendarIds']);
      return e;
    };
    const strip = (ev: Record<string, unknown>): CalendarEventCreate => {
      const { id: _i, calendarIds: _c, baseEventId: _b, method: _m, ...rest } = ev;
      void _i;
      void _c;
      void _b;
      void _m;
      return rest as CalendarEventCreate;
    };
    const createIn = async (entry: CalEntry, raw: Record<string, unknown>): Promise<{ href: string; etag: string | null; ev: CalendarEventCreate }> => {
      const ev = strip(raw);
      ev.uid = typeof ev.uid === 'string' && ev.uid ? ev.uid : newEventUid();
      ev['@type'] = 'Event';
      const text = eventToIcs(ev);
      let name = fileNameFor(ev.uid);
      for (let attempt = 0; attempt < 3; attempt++) {
        const href = this.dav.resolve(encodeURIComponent(name), entry.cal.href).href;
        const r = await this.dav.put(href, text, null, CONTENT_TYPE);
        if (r !== 'conflict') return { href, etag: r.etag, ev };
        name = `${hashOf(`${ev.uid}:${Date.now()}:${attempt}`, 12)}.ics`;
      }
      throw new SetError('alreadyExists', 'could not create the event');
    };
    const writeBack = async (loc: { entry: CalEntry; member: DavMember }, ev: CalendarEventCreate) => {
      const now = new Date().toISOString().slice(0, 19) + 'Z';
      const next = { ...ev, updated: now, sequence: (ev.sequence ?? 0) + 1 };
      const r = await this.dav.put(loc.member.href, eventToIcs(next), loc.member.etag || null, CONTENT_TYPE);
      if (r === 'conflict') throw new SetError('stateMismatch', 'the event was changed on the server (ETag)');
      if (r.etag) this.remember(loc.member.href, r.etag, next);
      else this.events.delete(loc.member.href);
      // plusieurs écritures sur la même ressource dans un même appel : l'ETag suivant doit être le nouveau
      loc.member.etag = r.etag ?? (await this.dav.listMembers(loc.entry.cal.href)).find((m) => m.href === loc.member.href)?.etag ?? '';
    };

    for (const [cid, raw] of Object.entries(isObject(args.create) ? args.create : {})) {
      try {
        if (!isObject(raw)) throw new SetError('invalidProperties');
        if ('id' in raw) throw new SetError('invalidProperties', 'id is server-set', ['id']);
        if (typeof raw.start !== 'string') throw new SetError('invalidProperties', 'start is required', ['start']);
        const entry = targetCal(raw.calendarIds);
        const r = await createIn(entry, raw);
        const id = eventIdOf(r.href);
        if (r.etag) this.remember(r.href, r.etag, r.ev);
        onCreated(cid, id);
        created[cid] = { id, uid: r.ev.uid, calendarIds: { [entry.id]: true } };
      } catch (e) {
        if (!(e instanceof SetError)) throw e;
        notCreated[cid] = e.toJSON();
      }
    }

    for (const [rawId, patch] of Object.entries(isObject(args.update) ? args.update : {})) {
      const id = resolveId(rawId);
      try {
        if (!isObject(patch)) throw new SetError('invalidPatch');
        const occ = splitOccurrenceId(id);
        const loc = locate(occ ? occ.id : id);
        if (!loc) throw new SetError('notFound');
        const current = (await this.eventsOf([{ ...loc.entry, members: [loc.member] }], null))[0];
        if (!current) throw new SetError('notFound');
        if ('id' in patch || 'uid' in patch) throw new SetError('invalidProperties', 'id and uid are immutable', ['id' in patch ? 'id' : 'uid']);
        let next: Record<string, unknown>;
        try {
          if (occ) {
            // une occurrence : le patch devient une exception de la série
            const base = current.ev as CalendarEventCreate;
            const prev = base.recurrenceOverrides?.[occ.rid] ?? {};
            const merged = { ...prev };
            for (const [k, v] of Object.entries(patch)) {
              if (k === 'calendarIds') continue;
              merged[k] = v;
            }
            next = applyEventPatch(current.ev, { [`recurrenceOverrides/${occ.rid}`]: merged });
          } else next = applyEventPatch(current.ev, patch);
        } catch {
          throw new SetError('invalidPatch');
        }
        const dest = targetCal(next.calendarIds);
        if (dest.id === loc.entry.id) {
          await writeBack(loc, strip(next));
          updated[id] = null;
        } else {
          // changement d'agenda : écriture dans le nouvel agenda, puis suppression de l'ancienne ressource
          const r = await createIn(dest, next);
          const del = await this.dav.delete(loc.member.href, loc.member.etag || null);
          if (del === 'conflict') {
            await this.dav.delete(r.href, r.etag).catch(() => undefined);
            throw new SetError('stateMismatch', 'the event was changed on the server (ETag)');
          }
          this.events.delete(loc.member.href);
          if (r.etag) this.remember(r.href, r.etag, r.ev);
          updated[id] = { id: eventIdOf(r.href) };
        }
      } catch (e) {
        if (!(e instanceof SetError)) throw e;
        notUpdated[id] = e.toJSON();
      }
    }

    for (const rawId of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) {
      const id = resolveId(rawId);
      try {
        const occ = splitOccurrenceId(id);
        const loc = locate(occ ? occ.id : id);
        if (!loc) throw new SetError('notFound');
        if (occ) {
          // supprimer une occurrence : exception `excluded`
          const current = (await this.eventsOf([{ ...loc.entry, members: [loc.member] }], null))[0];
          if (!current) throw new SetError('notFound');
          await writeBack(loc, strip(applyEventPatch(current.ev, { [`recurrenceOverrides/${occ.rid}`]: { excluded: true } })));
        } else {
          const r = await this.dav.delete(loc.member.href, loc.member.etag || null);
          if (r === 'conflict') throw new SetError('stateMismatch', 'the event was changed on the server (ETag)');
          this.events.delete(loc.member.href);
        }
        destroyed.push(id);
      } catch (e) {
        if (!(e instanceof SetError)) throw e;
        notDestroyed[id] = e.toJSON();
      }
    }

    this.invalidate();
    const changed = Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0;
    const newState = changed ? this.stateOf(await this.snapshot(true)) : oldState;
    return {
      oldState,
      newState,
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }

  /** `CalendarEvent/parse` : fichiers `.ics` téléversés → événements (tableau par blob, comme Stalwart). */
  async parse(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(args.blobIds) ? (args.blobIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const props = Array.isArray(args.properties) ? new Set(args.properties as string[]) : null;
    const parsed: Record<string, unknown> = {};
    const notParsable: string[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const buf = await this.opts.loadUpload(id);
      if (!buf) {
        notFound.push(id);
        continue;
      }
      if (buf.length > MAX_ICS) {
        notParsable.push(id);
        continue;
      }
      let events: CalendarEventCreate[] = [];
      try {
        events = parseIcs(buf.toString('utf8')).events;
      } catch {
        events = [];
      }
      if (!events.length) {
        notParsable.push(id);
        continue;
      }
      parsed[id] = events.map((e) => CalDavFacade.pick(cleanParsedEvent(e as Record<string, unknown>) as Record<string, unknown>, props));
    }
    return {
      parsed: Object.keys(parsed).length ? parsed : null,
      notParsable: notParsable.length ? notParsable : null,
      notFound: notFound.length ? notFound : null,
    };
  }

  close(): void {
    this.events.clear();
    this.snap = null;
  }
}
