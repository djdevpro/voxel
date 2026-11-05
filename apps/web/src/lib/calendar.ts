/**
 * Agenda : cache Dexie (`calendars`, `events`) par boîte. Les événements des plages consultées sont
 * lus par `CalendarEvent/query` (`after` / `before`) puis `CalendarEvent/get`, et tenus à jour par
 * `CalendarEvent/changes` ; les récurrences sont développées ici (`@voxel/jmap/recurrence`, Stalwart ne les développe
 * pas correctement, voir `jscalendar.ts`). Modifications par `CalendarEvent/set` via l'`outbox` (type `event`).
 *
 * Boîtes JMAP : Stalwart (JMAP for Calendars). Boîtes IMAP : façade CalDAV de la passerelle (même API, sans iTIP).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CAP,
  applyEventPatch,
  cleanParsedEvent,
  eventPatch,
  eventSpan,
  findParticipant,
  fromServerEvent,
  formatUtc,
  newEventUid,
  type Calendar,
  type CalendarEvent,
  type CalendarEventCreate,
  type CalendarsAccountCapability,
  type ParticipationStatus,
} from '@voxel/jmap';
import { expandEvent, occurrenceOf, type Occurrence } from '@voxel/jmap/recurrence';
import { db, getState, setState, type CalendarRow, type EventRow } from './db';
import { jmap } from './jmap';
import { isOffline, runCalls } from './outbox';
import { fetchBlob } from './blobs';
import type { Account } from './api';
import { peekSession } from './accounts';
import { isDesktop, saveFile } from './platform';

const LOCAL = 'local-';
const GET_CHUNK = 200;
const SET_CHUNK = 100;
/** Fin « infinie » d'une série sans fin (index Dexie numérique). */
const FAR = 8.64e15;
/** Couleur par défaut d'un agenda sans couleur. */
export const DEFAULT_CALENDAR_COLOR = '#5b7cfa';

// ------------------------------------------------------------------ lignes du cache

/** Bornes d'une série entière (ms) : du premier début à la dernière fin, `FAR` si elle ne finit pas. */
export function seriesBounds(ev: CalendarEventCreate): { start: number; end: number } {
  const span = eventSpan(ev);
  const rules = ev.recurrenceRules ?? [];
  const overrides = Object.keys(ev.recurrenceOverrides ?? {});
  if (!rules.length && !overrides.length) return span;
  if (rules.some((r) => !r.count && !r.until)) return { start: span.start, end: FAR };
  let start = span.start;
  let end = span.end;
  // série bornée : développement complet (borné par COUNT / UNTIL), exceptions déplacées comprises
  for (const o of expandEvent(ev, span.start - 366 * 86_400_000, span.start + 200 * 366 * 86_400_000)) {
    start = Math.min(start, o.start);
    end = Math.max(end, o.end);
  }
  return { start, end };
}

export function rowOf(accountId: string, ev: CalendarEvent): EventRow {
  const b = seriesBounds(ev);
  return {
    accountId,
    id: ev.id,
    ...(ev.uid ? { uid: ev.uid } : {}),
    event: ev,
    calendarIds: Object.entries(ev.calendarIds ?? {})
      .filter(([, on]) => on)
      .map(([k]) => k),
    start: b.start,
    end: b.end,
  };
}

/** Compte JMAP de l'agenda, si la session de la boîte annonce la capacité. */
async function calendarsAccount(accountId: string): Promise<string | null> {
  const c = jmap(accountId);
  let s;
  try {
    s = await c.getSession();
  } catch (e) {
    // réseau coupé sans que le navigateur le sache : session en cache (les écritures partent dans l'outbox)
    s = peekSession(accountId);
    if (!s) throw e;
  }
  if (!(CAP.calendars in s.capabilities)) return null;
  return s.primaryAccounts?.[CAP.calendars] ?? Object.keys(s.accounts ?? {})[0] ?? null;
}

export function calendarsCapability(accountId: string): CalendarsAccountCapability | undefined {
  return jmap(accountId).accountCapability<CalendarsAccountCapability>(CAP.calendars);
}

// ------------------------------------------------------------------ synchronisation

const syncing = new Map<string, Promise<void>>();
/** Plages déjà lues pendant cette session (par boîte), clé `début:fin`. */
const loadedRanges = new Map<string, Set<string>>();

async function syncCalendarsList(accountId: string, aid: string) {
  const r = await jmap(accountId).call('Calendar/get', { accountId: aid, ids: null });
  await db.transaction('rw', db.calendars, async () => {
    await db.calendars.where('accountId').equals(accountId).delete();
    await db.calendars.bulkPut(r.list.map((calendar) => ({ accountId, id: calendar.id, calendar })));
  });
}

async function getEvents(accountId: string, aid: string, ids: string[]): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  // propriétés par défaut : avec une liste explicite, Stalwart omet `recurrenceRules`
  for (let i = 0; i < ids.length; i += GET_CHUNK) out.push(...(await jmap(accountId).call('CalendarEvent/get', { accountId: aid, ids: ids.slice(i, i + GET_CHUNK) })).list.map(fromServerEvent));
  return out;
}

async function putEvents(accountId: string, list: CalendarEvent[]) {
  if (!list.length) return;
  await db.transaction('rw', db.events, async () => {
    await db.events.bulkPut(list.map((ev) => rowOf(accountId, ev)));
    // événements créés hors ligne désormais connus du serveur (même uid) : la copie locale disparaît
    const uids = new Set(list.map((e) => e.uid).filter(Boolean));
    if (uids.size) await db.events.where('accountId').equals(accountId).filter((x) => x.id.startsWith(LOCAL) && !!x.uid && uids.has(x.uid)).delete();
  });
}

async function resetEvents(accountId: string, aid: string) {
  const r = await jmap(accountId).call('CalendarEvent/get', { accountId: aid, ids: [] });
  await db.events.where('accountId').equals(accountId).filter((x) => !x.id.startsWith(LOCAL)).delete();
  loadedRanges.delete(accountId);
  await setState(accountId, 'CalendarEvent', r.state);
  window.dispatchEvent(new CustomEvent('voxel:calendar-reset', { detail: accountId }));
}

async function syncOnce(accountId: string) {
  const aid = await calendarsAccount(accountId);
  if (!aid) return;
  await syncCalendarsList(accountId, aid);
  const since = await getState(accountId, 'CalendarEvent');
  if (!since) return resetEvents(accountId, aid);
  let changes;
  try {
    changes = await jmap(accountId).allChanges('CalendarEvent', aid, since);
  } catch {
    return resetEvents(accountId, aid); // cannotCalculateChanges : on relit les plages affichées
  }
  if (changes.hasMoreChanges) return resetEvents(accountId, aid);
  const want = [...new Set([...changes.created, ...changes.updated])];
  const fetched = await getEvents(accountId, aid, want);
  if (changes.destroyed.length) await db.events.bulkDelete(changes.destroyed.map((id) => [accountId, id] as [string, string]));
  await putEvents(accountId, fetched);
  await setState(accountId, 'CalendarEvent', changes.newState);
}

/** Synchronise agendas et événements en cache d'une boîte (sans effet hors ligne ou sans capacité). */
export function syncCalendar(accountId: string): Promise<void> {
  if (isOffline()) return Promise.resolve();
  const running = syncing.get(accountId);
  if (running) return running;
  const p = syncOnce(accountId)
    .catch(() => undefined)
    .finally(() => syncing.delete(accountId));
  syncing.set(accountId, p);
  return p;
}

/**
 * Lit les événements d'une plage (`CalendarEvent/query` + `get`), une fois par session et par plage ; le reste
 * vient de `…/changes`. Hors ligne : le cache Dexie suffit.
 */
export async function loadRange(accountId: string, from: number, to: number, force = false): Promise<void> {
  if (isOffline()) return;
  const key = `${from}:${to}`;
  const seen = loadedRanges.get(accountId) ?? new Set<string>();
  if (!force && seen.has(key)) return;
  const aid = await calendarsAccount(accountId);
  if (!aid) return;
  await syncing.get(accountId);
  const b = jmap(accountId).batch();
  const q = b.call('CalendarEvent/query', { accountId: aid, filter: { after: formatUtc(from), before: formatUtc(to) } });
  const g = b.call('CalendarEvent/get', { accountId: aid, '#ids': q.ref('/ids') });
  await b.send();
  const got = await g.result;
  const ids = new Set(got.list.map((e) => e.id));
  // événements de la plage disparus côté serveur (sans passer par …/changes) : retirés du cache
  const stale = await db.events
    .where('accountId')
    .equals(accountId)
    .filter((r) => !r.id.startsWith(LOCAL) && r.start < to && r.end > from && !ids.has(r.id))
    .primaryKeys();
  const inRange = (await q.result).ids.length;
  if (stale.length && inRange === got.list.length) await db.events.bulkDelete(stale);
  await putEvents(accountId, got.list.map(fromServerEvent));
  if (!(await getState(accountId, 'CalendarEvent'))) await setState(accountId, 'CalendarEvent', got.state);
  seen.add(key);
  loadedRanges.set(accountId, seen);
}

// ------------------------------------------------------------------ lecture (hooks)

export function useCalendars(accountIds: string[]): CalendarRow[] | undefined {
  const key = accountIds.join(',');
  return useLiveQuery(
    async () => {
      if (!accountIds.length) return [];
      try {
        const rows = await db.calendars.where('accountId').anyOf(accountIds).toArray();
        const order = new Map(accountIds.map((a, i) => [a, i]));
        return rows.sort(
          (a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0) || (a.calendar.sortOrder ?? 0) - (b.calendar.sortOrder ?? 0) || a.calendar.name.localeCompare(b.calendar.name),
        );
      } catch {
        return [];
      }
    },
    [key],
  );
}

/** Occurrence affichée : événement développé, avec sa boîte, son agenda et sa couleur. */
export interface Occ extends Occurrence {
  key: string;
  accountId: string;
  calendarId: string;
  color: string;
  allDay: boolean;
  /** Série (événement maître) : sert aux modifications. */
  base: CalendarEvent;
  pending: boolean;
}

export const calKey = (accountId: string, calendarId: string) => `${accountId}:${calendarId}`;

/** Occurrences des boîtes données qui touchent [from, to[, agendas masqués exclus, triées. */
export function useOccurrences(accountIds: string[], from: number, to: number, hidden: Set<string>): Occ[] | undefined {
  const key = `${accountIds.join(',')}|${from}|${to}|${[...hidden].sort().join(',')}`;
  return useLiveQuery(
    async () => {
      if (!accountIds.length) return [];
      try {
        const accounts = new Set(accountIds);
        const [rows, cals] = await Promise.all([
          db.events
            .where('start')
            .below(to)
            .filter((r) => accounts.has(r.accountId) && r.end > from)
            .toArray(),
          db.calendars.where('accountId').anyOf(accountIds).toArray(),
        ]);
        const colors = new Map(cals.map((c) => [calKey(c.accountId, c.id), c.calendar.color || DEFAULT_CALENDAR_COLOR]));
        return occurrencesOf(rows, from, to, hidden, colors);
      } catch {
        return [];
      }
    },
    [key],
  );
}

export function occurrencesOf(rows: EventRow[], from: number, to: number, hidden: Set<string>, colors: Map<string, string>): Occ[] {
  const out: Occ[] = [];
  for (const r of rows) {
    const calendarId = r.calendarIds[0] ?? '';
    if (hidden.has(calKey(r.accountId, calendarId))) continue;
    if (r.event.status === 'cancelled') continue;
    let occ: Occurrence[];
    try {
      occ = expandEvent(r.event, from, to, { maxResults: 2000 });
    } catch {
      continue; // règle illisible : ignorée
    }
    for (const o of occ) {
      out.push({
        ...o,
        key: `${r.accountId}:${r.id}:${o.recurrenceId ?? ''}`,
        accountId: r.accountId,
        calendarId,
        color: (r.event.color as string | undefined) || colors.get(calKey(r.accountId, calendarId)) || DEFAULT_CALENDAR_COLOR,
        allDay: !!o.event.showWithoutTime,
        base: r.event,
        pending: r.id.startsWith(LOCAL),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.key.localeCompare(b.key));
}

/** Événements en cache d'un agenda (export). */
export async function eventsOfCalendar(accountId: string, calendarId: string): Promise<CalendarEvent[]> {
  return (await db.events.where('accountId').equals(accountId).filter((r) => r.calendarIds.includes(calendarId)).toArray()).map((r) => r.event);
}

// ------------------------------------------------------------------ modifications

async function afterWrite(accountId: string, queued: boolean) {
  if (!queued) await syncCalendar(accountId);
}

/** Envoyer les invitations par le serveur : boîte JMAP, et d'autres participants que soi. */
function wantsScheduling(account: Account | undefined, ev: CalendarEventCreate): boolean {
  if (!account || account.protocol !== 'jmap') return false;
  const me = account.email.toLowerCase();
  return Object.values(ev.participants ?? {}).some((p) => {
    const a = (p.email ?? p.calendarAddress?.replace(/^mailto:/i, '') ?? '').toLowerCase();
    return a && a !== me;
  });
}

/** Crée un événement (uid fixé ici) ; visible tout de suite, même hors ligne. */
export async function createEvent(account: Account, calendarId: string, ev: CalendarEventCreate): Promise<{ id: string; queued: boolean }> {
  const accountId = account.id;
  const aid = (await calendarsAccount(accountId)) ?? '';
  const create: CalendarEventCreate = { '@type': 'Event', ...ev, uid: ev.uid || newEventUid(), calendarIds: { [calendarId]: true } };
  delete (create as { id?: string }).id;
  const localId = `${LOCAL}${crypto.randomUUID()}`;
  await db.events.put(rowOf(accountId, { ...create, id: localId } as CalendarEvent));
  try {
    const r = await runCalls(accountId, [['CalendarEvent/set', { accountId: aid, create: { e0: create }, ...(wantsScheduling(account, create) ? { sendSchedulingMessages: true } : {}) }]], { kind: 'event', label: create.title ?? '' });
    if (r.queued) return { id: localId, queued: true };
    const body = r.responses?.[0]?.[1] as { created?: Record<string, { id: string }> } | undefined;
    const id = body?.created?.e0?.id ?? localId;
    await db.events.delete([accountId, localId]);
    await afterWrite(accountId, false);
    return { id, queued: false };
  } catch (e) {
    await db.events.delete([accountId, localId]);
    throw e;
  }
}

/** Applique un patch JMAP à un événement (mise à jour immédiate du cache, retour arrière en cas d'erreur). */
export async function patchEvent(account: Account, base: CalendarEvent, patch: Record<string, unknown>, label?: string): Promise<{ queued: boolean }> {
  if (!Object.keys(patch).length) return { queued: false };
  if (base.id.startsWith(LOCAL)) throw new Error('pending');
  const accountId = account.id;
  const aid = (await calendarsAccount(accountId)) ?? '';
  const old = await db.events.get([accountId, base.id]);
  const next = applyEventPatch(base as unknown as Record<string, unknown>, patch) as unknown as CalendarEvent;
  await db.events.put(rowOf(accountId, next));
  try {
    const r = await runCalls(
      accountId,
      [['CalendarEvent/set', { accountId: aid, update: { [base.id]: patch }, ...(wantsScheduling(account, next) ? { sendSchedulingMessages: true } : {}) }]],
      { kind: 'event', label: label ?? next.title ?? '' },
    );
    await afterWrite(accountId, r.queued);
    return { queued: r.queued };
  } catch (e) {
    if (old) await db.events.put(old);
    throw e;
  }
}

/** Remplace toute la série par `after` (patch des propriétés changées). */
export function updateSeries(account: Account, base: CalendarEvent, after: CalendarEventCreate): Promise<{ queued: boolean }> {
  return patchEvent(account, base, eventPatch(base as Record<string, unknown>, { ...after, id: base.id } as Record<string, unknown>));
}

/** Modifie une seule occurrence : exception `recurrenceOverrides/<recurrenceId>`. */
export function updateOccurrence(account: Account, base: CalendarEvent, recurrenceId: string, after: CalendarEventCreate): Promise<{ queued: boolean }> {
  const inst = occurrenceOf(base, recurrenceId) ?? {};
  const diff = eventPatch(inst as Record<string, unknown>, after as Record<string, unknown>);
  delete diff.recurrenceId;
  delete diff.calendarIds;
  for (const k of ['recurrenceRules', 'excludedRecurrenceRules', 'recurrenceOverrides']) delete diff[k];
  const merged = { ...(base.recurrenceOverrides?.[recurrenceId] ?? {}), ...diff };
  for (const [k, v] of Object.entries(merged)) if (v === null && !(k in (base as object))) delete merged[k];
  return patchEvent(account, base, { [`recurrenceOverrides/${recurrenceId}`]: merged });
}

/** Supprime un événement (série entière). */
export async function deleteEvent(account: Account, ev: CalendarEvent): Promise<{ queued: boolean }> {
  const accountId = account.id;
  const aid = (await calendarsAccount(accountId)) ?? '';
  const old = await db.events.get([accountId, ev.id]);
  await db.events.delete([accountId, ev.id]);
  if (ev.id.startsWith(LOCAL)) return { queued: false };
  try {
    const r = await runCalls(accountId, [['CalendarEvent/set', { accountId: aid, destroy: [ev.id], ...(wantsScheduling(account, ev) ? { sendSchedulingMessages: true } : {}) }]], { kind: 'event', label: ev.title ?? '' });
    await afterWrite(accountId, r.queued);
    return { queued: r.queued };
  } catch (e) {
    if (old) await db.events.put(old);
    throw e;
  }
}

/** Supprime une occurrence : exception `excluded`. */
export function deleteOccurrence(account: Account, base: CalendarEvent, recurrenceId: string): Promise<{ queued: boolean }> {
  return patchEvent(account, base, { [`recurrenceOverrides/${recurrenceId}`]: { excluded: true } });
}

/** Crée un agenda (boîtes JMAP qui le permettent). */
export async function createCalendar(accountId: string, name: string, color: string): Promise<void> {
  const aid = (await calendarsAccount(accountId)) ?? '';
  await runCalls(accountId, [['Calendar/set', { accountId: aid, create: { c0: { name, color, isSubscribed: true, isVisible: true } as Partial<Calendar> } }]], { kind: 'event', label: name });
  await syncCalendar(accountId);
}

// ------------------------------------------------------------------ import / export

export const MAX_ICS_BYTES = 10 * 1024 * 1024;

export interface IcsImportItem {
  event: CalendarEventCreate;
  /** Événement existant de la même boîte avec le même `uid`. */
  duplicate?: EventRow;
}

/**
 * Lit un fichier `.ics` : par le serveur (`CalendarEvent/parse`, un blob, tous les VEVENT) si la boîte l'annonce,
 * sinon côté client ; doublons repérés par `uid` dans la boîte.
 */
export async function parseIcsForImport(accountId: string, text: string): Promise<{ items: IcsImportItem[] }> {
  const aid = await calendarsAccount(accountId);
  if (!aid) throw new Error('calendar unavailable');
  let events: CalendarEventCreate[] = [];
  const c = jmap(accountId);
  if (CAP.calendarsParse in (await c.getSession()).capabilities && !isOffline()) {
    try {
      const blob = await c.upload(aid, new TextEncoder().encode(text), 'text/calendar');
      const r = await c.call('CalendarEvent/parse', { accountId: aid, blobIds: [blob.blobId] });
      const v = r.parsed?.[blob.blobId];
      events = (Array.isArray(v) ? v : v ? [v] : []).map((e) => cleanParsedEvent(fromServerEvent(e as Record<string, unknown>)));
    } catch {
      events = [];
    }
  }
  if (!events.length) {
    const { parseIcs } = await import('@voxel/jmap/ical');
    events = parseIcs(text).events;
  }
  const existing = await db.events.where('accountId').equals(accountId).toArray();
  const byUid = new Map(existing.filter((r) => r.uid).map((r) => [r.uid!, r]));
  return { items: events.map((event) => (event.uid && byUid.has(event.uid) ? { event, duplicate: byUid.get(event.uid)! } : { event })) };
}

export type IcsDuplicateAction = 'skip' | 'replace' | 'both';

export async function importEvents(account: Account, calendarId: string, items: Array<IcsImportItem & { action: IcsDuplicateAction }>): Promise<{ created: number; replaced: number; skipped: number; queued: boolean }> {
  const accountId = account.id;
  const aid = (await calendarsAccount(accountId)) ?? '';
  const creates: Record<string, CalendarEventCreate> = {};
  const updates: Record<string, Record<string, unknown>> = {};
  let skipped = 0;
  items.forEach((it, i) => {
    if (it.duplicate && it.action === 'skip') {
      skipped++;
      return;
    }
    const clean = cleanParsedEvent(it.event as Record<string, unknown>);
    if (it.duplicate && it.action === 'replace' && !it.duplicate.id.startsWith(LOCAL)) {
      const { uid: _u, ...rest } = clean;
      void _u;
      updates[it.duplicate.id] = eventPatch(it.duplicate.event as Record<string, unknown>, { ...rest, calendarIds: it.duplicate.event.calendarIds } as Record<string, unknown>);
      return;
    }
    creates[`i${i}`] = { ...clean, uid: it.duplicate ? newEventUid() : clean.uid || newEventUid(), calendarIds: { [calendarId]: true } };
  });
  let queued = false;
  const ck = Object.keys(creates);
  for (let i = 0; i < ck.length; i += SET_CHUNK) {
    const part = Object.fromEntries(ck.slice(i, i + SET_CHUNK).map((k) => [k, creates[k]!]));
    const r = await runCalls(accountId, [['CalendarEvent/set', { accountId: aid, create: part }]], { kind: 'event', label: `ics (${Object.keys(part).length})` });
    queued ||= r.queued;
  }
  const uk = Object.keys(updates).filter((k) => Object.keys(updates[k]!).length);
  for (let i = 0; i < uk.length; i += SET_CHUNK) {
    const part = Object.fromEntries(uk.slice(i, i + SET_CHUNK).map((k) => [k, updates[k]!]));
    const r = await runCalls(accountId, [['CalendarEvent/set', { accountId: aid, update: part }]], { kind: 'event', label: `ics (${Object.keys(part).length})` });
    queued ||= r.queued;
  }
  if (!queued) {
    await syncCalendar(accountId);
    loadedRanges.delete(accountId);
  }
  return { created: ck.length, replaced: uk.length, skipped, queued };
}

async function download(text: string, fileName: string, type: string) {
  const blob = new Blob([text], { type });
  if (isDesktop) {
    await saveFile(fileName, blob);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Exporte des événements en `.ics` (sérialisation côté client) et lance le téléchargement. */
export async function exportEvents(events: CalendarEvent[], fileName: string): Promise<void> {
  const { eventsToIcs } = await import('@voxel/jmap/ical');
  const clean = events.map((e) => {
    const { id: _i, calendarIds: _c, baseEventId: _b, ...rest } = e;
    void _i;
    void _c;
    void _b;
    return rest;
  });
  await download(eventsToIcs(clean), fileName.replace(/[\\/:*?"<>|]+/g, '-') || 'calendar.ics', 'text/calendar;charset=utf-8');
}

// ------------------------------------------------------------------ invitations reçues

export interface Invitation {
  method: string | null;
  event: CalendarEventCreate;
}

/**
 * Lit la partie `text/calendar` d'un message : `CalendarEvent/parse` sur son blob (boîte JMAP qui l'annonce),
 * sinon analyse côté client du texte téléchargé.
 */
export async function readInvitation(account: Account, jmapAccountId: string, blobId: string): Promise<Invitation | null> {
  const c = jmap(account.id);
  if (account.capabilities.calendarsParse && account.protocol === 'jmap') {
    try {
      const aid = (await calendarsAccount(account.id)) ?? jmapAccountId;
      const r = await c.call('CalendarEvent/parse', { accountId: aid, blobIds: [blobId] });
      const v = r.parsed?.[blobId];
      const list = Array.isArray(v) ? v : v ? [v] : [];
      if (list[0]) {
        const raw = list[0] as Record<string, unknown>;
        return { method: typeof raw.method === 'string' ? raw.method.toLowerCase() : null, event: cleanParsedEvent(fromServerEvent(raw)) };
      }
    } catch {
      /* repli côté client */
    }
  }
  const blob = await fetchBlob(account.id, jmapAccountId, blobId, 'invite.ics', 'text/calendar');
  if (blob.size > MAX_ICS_BYTES) return null;
  const { parseIcs } = await import('@voxel/jmap/ical');
  const p = parseIcs(await blob.text());
  return p.events[0] ? { method: p.method, event: p.events[0] } : null;
}

/** Événement déjà dans l'agenda de la boîte (même `uid`). */
export function useEventByUid(accountId: string | undefined, uid: string | undefined): EventRow | null | undefined {
  return useLiveQuery(async () => {
    if (!accountId || !uid) return null;
    try {
      return (await db.events.where('uid').equals(uid).filter((r) => r.accountId === accountId).first()) ?? null;
    } catch {
      return null;
    }
  }, [accountId, uid]);
}

/** Événements de la boîte qui chevauchent [start, end[ (conflit d'une invitation), hors `uid` donné. */
export async function conflictsOf(accountId: string, start: number, end: number, uid?: string): Promise<Occ[]> {
  const rows = await db.events.where('start').below(end).filter((r) => r.accountId === accountId && r.end > start && r.uid !== uid).toArray();
  return occurrencesOf(rows, start, end, new Set(), new Map()).filter((o) => !o.allDay && o.event.freeBusyStatus !== 'free');
}

/**
 * Répond à une invitation : ajoute l'événement à l'agenda par défaut (ou met à jour celui qui a le même `uid`)
 * avec le statut de participation, et demande au serveur d'envoyer la réponse (`sendSchedulingMessages`) pour
 * une boîte JMAP ; si le serveur refuse, l'événement est seulement ajouté (`sent: false`).
 */
export async function respondToInvitation(account: Account, inv: Invitation, status: ParticipationStatus | null): Promise<{ sent: boolean; queued: boolean }> {
  const accountId = account.id;
  const aid = (await calendarsAccount(accountId)) ?? '';
  const me = findParticipant(inv.event, account.email);
  const existing = inv.event.uid ? await db.events.where('uid').equals(inv.event.uid).filter((r) => r.accountId === accountId && !r.id.startsWith(LOCAL)).first() : undefined;
  const schedule = account.protocol === 'jmap' && !!status && !!me;
  const run = async (sendScheduling: boolean) => {
    if (existing) {
      const patch: Record<string, unknown> = {};
      const mine = findParticipant(existing.event, account.email);
      if (status && mine) patch[`participants/${mine[0]}/participationStatus`] = status;
      // nouvelle version de l'invitation (heure, titre…) : on reprend ses champs
      for (const k of ['title', 'description', 'start', 'timeZone', 'duration', 'showWithoutTime', 'locations', 'recurrenceRules', 'recurrenceOverrides'] as const) {
        if (inv.event[k] !== undefined && JSON.stringify(inv.event[k]) !== JSON.stringify(existing.event[k])) patch[k] = inv.event[k];
      }
      if (!Object.keys(patch).length) return { queued: false };
      return runCalls(accountId, [['CalendarEvent/set', { accountId: aid, update: { [existing.id]: patch }, ...(sendScheduling ? { sendSchedulingMessages: true } : {}) }]], { kind: 'event', label: inv.event.title ?? '' });
    }
    const cals = await db.calendars.where('accountId').equals(accountId).toArray();
    const cal = cals.find((c) => c.calendar.isDefault) ?? cals.find((c) => c.calendar.myRights?.mayWriteAll !== false) ?? cals[0];
    if (!cal) throw new Error('no calendar');
    const ev: CalendarEventCreate = { ...cleanParsedEvent(inv.event as Record<string, unknown>), calendarIds: { [cal.id]: true } };
    if (status && me) ev.participants = { ...ev.participants, [me[0]]: { ...me[1], participationStatus: status } };
    return runCalls(accountId, [['CalendarEvent/set', { accountId: aid, create: { inv: ev }, ...(sendScheduling ? { sendSchedulingMessages: true } : {}) }]], { kind: 'event', label: inv.event.title ?? '' });
  };
  let sent = false;
  let r: { queued: boolean };
  if (schedule) {
    try {
      r = await run(true);
      sent = !r.queued;
    } catch {
      r = await run(false);
    }
  } else r = await run(false);
  await afterWrite(accountId, r.queued);
  return { sent, queued: r.queued };
}
