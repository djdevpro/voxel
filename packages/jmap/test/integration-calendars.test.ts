/**
 * Intégration du lot A3 contre la boîte de test dédiée (JMAP for Calendars de Stalwart),
 * ignorée sans VOXEL_TEST_JMAP_URL / VOXEL_TEST_USER / VOXEL_TEST_PASSWORD. Lancer depuis la racine :
 *   node --env-file=.env.test.local --test packages/jmap/test/integration-calendars.test.ts
 * Crée un agenda `voxel-test-…` et des événements, les modifie, les relit, puis supprime tout.
 * Seul participant utilisé : la boîte de test elle-même (aucune invitation vers une autre adresse).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CAP, JmapClient, cleanParsedEvent, newEventUid, type CalendarEvent, type CalendarEventCreate } from '../src/index.ts';
import { eventToIcs, parseIcs } from '../src/ical.ts';
import { expandEvent } from '../src/recurrence.ts';

const URL_ = process.env.VOXEL_TEST_JMAP_URL;
const USER = process.env.VOXEL_TEST_USER;
const PASS = process.env.VOXEL_TEST_PASSWORD;
const skip = !URL_ || !USER || !PASS ? 'VOXEL_TEST_* non définies' : false;
const TAG = `voxel-test-${Date.now().toString(36)}`;
const SELF = process.env.VOXEL_TEST_USER ?? '';

let c: JmapClient;
let aid: string;

before(async () => {
  if (skip) return;
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  c = new JmapClient({ sessionUrl: URL_!, headers: { Authorization: auth } });
  aid = await c.accountId(CAP.calendars);
});

/** Supprime les événements et agendas de test restants. */
async function cleanup() {
  const evs = await c.call('CalendarEvent/get', { accountId: aid, ids: null, properties: ['uid', 'title'] });
  const ours = evs.list.filter((x) => x.uid?.startsWith('voxel-test-') || x.title?.startsWith('Voxel Test'));
  if (ours.length) await c.call('CalendarEvent/set', { accountId: aid, destroy: ours.map((x) => x.id) });
  const cals = await c.call('Calendar/get', { accountId: aid, ids: null });
  const test = cals.list.filter((b) => b.name.startsWith('voxel-test-'));
  if (test.length) await c.call('Calendar/set', { accountId: aid, destroy: test.map((b) => b.id), onDestroyRemoveEvents: true });
}

after(async () => {
  if (skip) return;
  await cleanup().catch((e) => console.warn('nettoyage :', (e as Error).message));
  const left = await c.call('CalendarEvent/get', { accountId: aid, ids: null, properties: ['uid'] });
  assert.equal(left.list.filter((x) => x.uid?.startsWith('voxel-test-')).length, 0, 'événements de test restants');
});

test('session : calendars et calendars:parse annoncés', { skip }, async () => {
  const s = await c.getSession();
  assert.ok(CAP.calendars in s.capabilities);
  assert.ok(CAP.calendarsParse in s.capabilities);
});

test('agendas et événements : créer, lire, chercher, modifier, développer, changes, supprimer', { skip }, async () => {
  const c0 = await c.call('Calendar/get', { accountId: aid, ids: null });
  const es0 = (await c.call('CalendarEvent/get', { accountId: aid, ids: [] })).state;
  const nc = await c.call('Calendar/set', { accountId: aid, create: { c: { name: `${TAG}-agenda`, color: '#3366ff' } } });
  const calId = nc.created!.c!.id;
  const cch = await c.allChanges('Calendar', aid, c0.state);
  assert.ok(cch.created.includes(calId));
  const got = await c.call('Calendar/get', { accountId: aid, ids: [calId] });
  assert.equal(got.list[0]!.color, '#3366ff');

  const uid = `${TAG}-serie`;
  const serie: CalendarEventCreate = {
    '@type': 'Event',
    calendarIds: { [calId]: true },
    uid,
    title: 'Voxel Test série',
    start: '2026-11-10T09:00:00',
    timeZone: 'Europe/Paris',
    duration: 'PT1H',
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'tu' }, { '@type': 'NDay', day: 'th' }], count: 6 }],
    recurrenceOverrides: { '2026-11-12T09:00:00': { title: 'Voxel Test déplacé', start: '2026-11-12T11:00:00' }, '2026-11-17T09:00:00': { excluded: true } },
    alerts: { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } },
    locations: { l1: { '@type': 'Location', name: 'Salle 1' } },
    participants: { o: { '@type': 'Participant', calendarAddress: `mailto:${SELF}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' } },
    freeBusyStatus: 'busy',
    iCalendar: { name: 'vevent', properties: [['x-voxel-test', {}, 'unknown', 'garde-moi']] },
  };
  const set1 = await c.call('CalendarEvent/set', {
    accountId: aid,
    create: { s: serie, d: { calendarIds: { [calId]: true }, uid: `${TAG}-jour`, title: 'Voxel Test journée', start: '2026-11-11T00:00:00', showWithoutTime: true, duration: 'P1D' } },
  });
  assert.equal(set1.notCreated ?? null, null, JSON.stringify(set1.notCreated));
  const idS = set1.created!.s!.id;
  const idD = set1.created!.d!.id;

  // relecture : propriétés par défaut (une liste explicite omet `recurrenceRules`), `iCalendar` seulement si demandé
  const ev = (await c.call('CalendarEvent/get', { accountId: aid, ids: [idS] })).list[0]! as CalendarEvent;
  assert.equal(ev.timeZone, 'Europe/Paris');
  assert.equal(ev.recurrenceRules?.[0]?.count, 6);
  const withIcal = (await c.call('CalendarEvent/get', { accountId: aid, ids: [idS], properties: ['iCalendar', 'recurrenceRules'] })).list[0]!;
  assert.deepEqual(withIcal.iCalendar?.properties?.[0], ['x-voxel-test', {}, 'unknown', 'garde-moi']);
  // écart Stalwart : `recurrenceRules` absent quand il est demandé explicitement
  assert.equal(withIcal.recurrenceRules, undefined);
  assert.equal(Object.values(ev.participants ?? {})[0]?.calendarAddress, `mailto:${SELF}`);

  // plage : la série et la journée ; filtre par agenda (inCalendar), par texte
  const q = await c.call('CalendarEvent/query', { accountId: aid, filter: { inCalendar: calId, after: '2026-11-09T00:00:00Z', before: '2026-11-20T00:00:00Z' } });
  assert.deepEqual([...q.ids].sort(), [idS, idD].sort());
  const qt = await c.call('CalendarEvent/query', { accountId: aid, filter: { inCalendar: calId, text: 'journée' } });
  assert.deepEqual(qt.ids, [idD]);

  // développement côté client (celui du serveur omet des occurrences, voir jscalendar.ts)
  const occ = expandEvent(ev, Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-20T00:00:00Z'));
  assert.deepEqual(occ.map((o) => o.recurrenceId), ['2026-11-10T09:00:00', '2026-11-12T09:00:00', '2026-11-19T09:00:00']);
  const ex = await c.call('CalendarEvent/query', { accountId: aid, filter: { inCalendar: calId, after: '2026-11-09T00:00:00Z', before: '2026-11-20T00:00:00Z' }, expandRecurrences: true });
  // écart Stalwart : expandRecurrences accepté mais n'ajoute pas les occurrences produites par la règle
  assert.ok(ex.ids.length >= 1 && ex.ids.length < 4, `expandRecurrences : ${ex.ids.length} ids`);

  // « cet événement » : exception ajoutée par chemin ; « toute la série » : titre
  const upd = await c.call('CalendarEvent/set', {
    accountId: aid,
    update: { [idS]: { 'recurrenceOverrides/2026-11-19T09:00:00': { start: '2026-11-19T15:00:00' }, title: 'Voxel Test série 2' } },
  });
  assert.equal(upd.notUpdated ?? null, null, JSON.stringify(upd.notUpdated));
  // réponse à soi-même : statut de participation avec envoi par le serveur (seule adresse : la boîte de test)
  const rsvp = await c.call('CalendarEvent/set', { accountId: aid, update: { [idS]: { 'participants/o/participationStatus': 'tentative' } }, sendSchedulingMessages: true });
  assert.equal(rsvp.notUpdated ?? null, null, JSON.stringify(rsvp.notUpdated));
  const after1 = (await c.call('CalendarEvent/get', { accountId: aid, ids: [idS] })).list[0]!;
  assert.equal(after1.title, 'Voxel Test série 2');
  assert.equal(after1.recurrenceOverrides?.['2026-11-19T09:00:00']?.start, '2026-11-19T15:00:00');
  assert.equal(after1.participants?.o?.participationStatus, 'tentative');

  const ch = await c.allChanges('CalendarEvent', aid, es0);
  for (const id of [idS, idD]) assert.ok([...ch.created, ...ch.updated].includes(id));

  // export .ics côté client puis import par CalendarEvent/parse (tous les VEVENT d'un blob)
  const ics = eventToIcs({ ...after1, uid: `${TAG}-import` });
  assert.equal(parseIcs(ics).events[0]!.uid, `${TAG}-import`);
  const blob = await c.upload(aid, new TextEncoder().encode(ics), 'text/calendar');
  const parsed = await c.call('CalendarEvent/parse', { accountId: aid, blobIds: [blob.blobId] });
  const raw = parsed.parsed?.[blob.blobId];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  assert.equal(list.length, 1);
  const imp = cleanParsedEvent(list[0] as Record<string, unknown>);
  assert.equal(imp.uid, `${TAG}-import`);
  assert.ok(imp.recurrenceOverrides?.['2026-11-17T09:00:00']?.excluded);
  const created = await c.call('CalendarEvent/set', { accountId: aid, create: { i: { ...imp, calendarIds: { [calId]: true } } } });
  assert.equal(created.notCreated ?? null, null, JSON.stringify(created.notCreated));

  // suppression et changes
  const st = (await c.call('CalendarEvent/get', { accountId: aid, ids: [] })).state;
  await c.call('CalendarEvent/set', { accountId: aid, destroy: [idS, idD, created.created!.i!.id] });
  const ch2 = await c.allChanges('CalendarEvent', aid, st);
  for (const id of [idS, idD]) assert.ok(ch2.destroyed.includes(id));
  await c.call('Calendar/set', { accountId: aid, destroy: [calId], onDestroyRemoveEvents: true });
  void newEventUid;
});
