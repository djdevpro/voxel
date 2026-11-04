/**
 * Intégration du lot B3 contre la boîte de test dédiée : passerelle IMAP + CalDAV du même
 * serveur (`X-Voxel-CalDav`), ignorée sans VOXEL_TEST_USER / VOXEL_TEST_PASSWORD / VOXEL_TEST_IMAP / VOXEL_TEST_SMTP.
 * Lancer depuis la racine :
 *   node --env-file=.env.test.local --import tsx --test apps/server/test/integration-b3.test.ts
 * URL CalDAV : VOXEL_TEST_CALDAV, sinon découverte (`/.well-known/caldav` du domaine de la boîte).
 * Crée, modifie et supprime des événements dans l'agenda par défaut ; tout ce qui porte un uid `voxel-test-` est
 * supprimé à la fin. Seul participant : la boîte de test. Le mot de passe n'est jamais affiché.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-b3-'));

const { USER, PASS, IMAP, SMTP } = {
  USER: process.env.VOXEL_TEST_USER,
  PASS: process.env.VOXEL_TEST_PASSWORD,
  IMAP: process.env.VOXEL_TEST_IMAP,
  SMTP: process.env.VOXEL_TEST_SMTP,
};
const skip = !USER || !PASS || !IMAP || !SMTP ? 'VOXEL_TEST_* non définies' : false;

const { createImapBackend } = await import('../src/imap/index.js');
const { parseEndpoint } = await import('../src/routes/imap.js');
const { discoverCalDav } = await import('../src/discovery.js');
const { DavClient } = await import('../src/carddav/dav.js');
type Backend = ReturnType<typeof createImapBackend>;

let backend: Backend;
let davUrl: string;
const TAG = `voxel-test-${Date.now().toString(36)}`;
const SELF = process.env.VOXEL_TEST_USER ?? '';
const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:calendars:parse'];

const kv = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k) };
};

async function api(calls: Array<[string, Record<string, unknown>]>) {
  const r = await backend.api({ using, methodCalls: calls.map(([n, a], i) => [n, { accountId: 'a', ...a }, `c${i}`]) });
  return r.methodResponses.map(([name, body]) => {
    if (name === 'error') throw new Error(`${calls[0]![0]} : ${JSON.stringify(body)}`);
    return body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  });
}

/** Supprime directement en CalDAV tout événement de test restant (uid `voxel-test-`). */
async function cleanup(): Promise<number> {
  const dav = new DavClient(new URL(davUrl), USER!, PASS!);
  let left = 0;
  for (const cal of await dav.discoverCalendars()) {
    const members = await dav.listMembers(cal.href);
    if (!members.length) continue;
    for (const m of await dav.multiget(cal.href, members.map((x) => x.href), 'cal')) {
      if (/UID:voxel-test-/i.test(m.data) || /SUMMARY:Voxel Test/.test(m.data)) {
        await dav.delete(m.href, m.etag || null);
        left++;
      }
    }
  }
  return left;
}

before(async () => {
  if (skip) return;
  const domain = USER!.split('@')[1]!;
  davUrl = process.env.VOXEL_TEST_CALDAV || (await discoverCalDav(domain, parseEndpoint('imap', IMAP)!.host)) || '';
  assert.ok(davUrl, 'CalDAV introuvable par la découverte');
  console.log(`CalDAV découvert : ${new URL(davUrl).host}${new URL(davUrl).pathname}`);
  backend = createImapBackend(
    { email: USER!, username: USER!, auth: { password: PASS! }, imap: parseEndpoint('imap', IMAP)!, smtp: parseEndpoint('smtp', SMTP)!, caldav: davUrl },
    kv(),
  );
  await backend.verify();
  await backend.probe?.();
});

after(async () => {
  if (skip) return;
  await cleanup().catch((e) => console.warn('nettoyage :', (e as Error).message));
  assert.equal(await cleanup(), 0, 'événements de test restants');
  await backend?.close();
});

test('session : calendars et calendars:parse annoncés après vérification CalDAV', { skip }, async () => {
  const s = await backend.session();
  assert.ok('urn:ietf:params:jmap:calendars' in s.capabilities);
  assert.ok('urn:ietf:params:jmap:calendars:parse' in s.capabilities);
  assert.equal(s.primaryAccounts['urn:ietf:params:jmap:calendars'], 'a');
});

test('façade CalDAV : créer, lire, plage, occurrences, exception, changes, supprimer (vrai serveur)', { skip }, async () => {
  const [cals, ev0] = await api([['Calendar/get', { ids: null }], ['CalendarEvent/get', { ids: [] }]]);
  const cal = (cals!.list as Array<{ id: string; name: string; isDefault: boolean }>).find((c) => c.isDefault)!;
  assert.ok(cal);
  const s0 = ev0!.state as string;

  const [set1] = await api([
    [
      'CalendarEvent/set',
      {
        create: {
          s: {
            calendarIds: { [cal.id]: true },
            uid: `${TAG}-serie`,
            title: 'Voxel Test série B3',
            start: '2026-11-10T09:00:00',
            timeZone: 'Europe/Paris',
            duration: 'PT1H',
            recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'tu' }, { '@type': 'NDay', day: 'th' }], count: 6 }],
            recurrenceOverrides: { '2026-11-17T09:00:00': { excluded: true } },
            alerts: { a: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } },
            participants: { o: { '@type': 'Participant', calendarAddress: `mailto:${SELF}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' } },
            iCalendar: { name: 'vevent', properties: [['x-voxel-test', {}, 'unknown', 'garde-moi']] },
          },
        },
      },
    ],
  ]);
  assert.equal(set1!.notCreated, null, JSON.stringify(set1!.notCreated));
  const id = set1!.created.s.id as string;

  // relu par CalDAV : fuseau, règle, exclusion, alarme, propriété inconnue
  const [g] = await api([['CalendarEvent/get', { ids: [id] }]]);
  const ev = g!.list[0];
  assert.equal(ev.timeZone, 'Europe/Paris');
  assert.equal(ev.recurrenceRules[0].count, 6);
  assert.deepEqual(ev.recurrenceOverrides, { '2026-11-17T09:00:00': { excluded: true } });
  assert.equal(Object.values(ev.alerts as object).length, 1);
  assert.ok((ev.iCalendar.properties as unknown[][]).some((p) => p[0] === 'x-voxel-test' && p[3] === 'garde-moi'));

  // plage (calendar-query + time-range du serveur) et occurrences développées
  const [q] = await api([['CalendarEvent/query', { filter: { inCalendar: cal.id, after: '2026-11-09T00:00:00Z', before: '2026-11-20T00:00:00Z' } }]]);
  assert.ok((q!.ids as string[]).includes(id));
  const [qe] = await api([['CalendarEvent/query', { filter: { inCalendar: cal.id, after: '2026-11-09T00:00:00Z', before: '2026-11-20T00:00:00Z', text: 'série B3' }, expandRecurrences: true }]]);
  const occIds = qe!.ids as string[];
  // l'id de l'événement (empreinte base64url) peut lui-même contenir « _ » : on coupe au dernier
  assert.deepEqual(occIds.map((x) => x.slice(x.lastIndexOf('_') + 1)), ['20261110T090000', '20261112T090000', '20261119T090000']);

  // « cet événement » : exception sur une occurrence ; sendSchedulingMessages ignoré (pas d'iTIP)
  const [u] = await api([['CalendarEvent/set', { update: { [occIds[1]!]: { title: 'Voxel Test déplacé', start: '2026-11-12T11:00:00' } }, sendSchedulingMessages: true }]]);
  assert.equal(u!.notUpdated, null, JSON.stringify(u!.notUpdated));
  const [g2] = await api([['CalendarEvent/get', { ids: [id, occIds[1]!] }]]);
  assert.equal(g2!.list[0].recurrenceOverrides['2026-11-12T09:00:00'].title, 'Voxel Test déplacé');
  assert.equal(g2!.list[1].start, '2026-11-12T11:00:00');
  assert.equal(g2!.list[1].baseEventId, id);

  // changes, puis suppression
  const [ch] = await api([['CalendarEvent/changes', { sinceState: s0 }]]);
  assert.ok([...(ch!.created as string[]), ...(ch!.updated as string[])].includes(id));
  const [d] = await api([['CalendarEvent/set', { destroy: [id] }]]);
  assert.deepEqual(d!.destroyed, [id]);
  const [ch2] = await api([['CalendarEvent/changes', { sinceState: ch!.newState }]]);
  assert.ok((ch2!.destroyed as string[]).includes(id));
});

test('passerelle HTTP : X-Voxel-CalDav → session avec agenda, puis /imap/api Calendar/get', { skip }, async () => {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const headers = {
    authorization: `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`,
    'x-voxel-imap': IMAP!,
    'x-voxel-smtp': SMTP!,
    'x-voxel-caldav': davUrl,
  };
  const s = await app.request('http://voxel.localhost/imap/session', { headers });
  assert.equal(s.status, 200);
  const session = (await s.json()) as { capabilities: Record<string, unknown> };
  assert.ok('urn:ietf:params:jmap:calendars' in session.capabilities);
  const r = await app.request('http://voxel.localhost/imap/api', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ using, methodCalls: [['Calendar/get', { accountId: 'a', ids: null }, 'c'], ['CalendarEvent/get', { accountId: 'a', ids: [] }, 'g']] }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { methodResponses: Array<[string, Record<string, unknown>, string]> };
  assert.deepEqual(body.methodResponses.map((m) => m[0]), ['Calendar/get', 'CalendarEvent/get']);
  const { closeAllBackends } = await import('../src/backend/pool.js');
  await closeAllBackends();
});
