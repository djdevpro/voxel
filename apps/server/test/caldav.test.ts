/**
 * Lot B3 : client CalDAV (même client WebDAV que les contacts) et façade CalDAV → JMAP Calendars
 * contre un faux serveur CalDAV en mémoire (avec et sans `sync-collection`), plus la validation de `X-Voxel-CalDav`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DavClient, type DavFetch } from '../src/carddav/dav.js';
import { CalDavFacade } from '../src/caldav/facade.js';

function fakeCalDav(opts: { sync: boolean }) {
  const origin = 'https://cal.example.com';
  const cals = new Map<string, { name: string; color: string; items: Map<string, { etag: string; data: string }> }>();
  cals.set('/dav/cal/u/default/', { name: 'Agenda', color: '#FF0000FF', items: new Map() });
  cals.set('/dav/cal/u/work/', { name: 'Travail', color: '', items: new Map() });
  const log: Array<{ v: number; href: string; cal: string; deleted: boolean }> = [];
  let version = 1;
  let etagN = 100;
  const calls: string[] = [];
  const bump = (cal: string, href: string, deleted: boolean) => {
    version++;
    log.push({ v: version, href, cal, deleted });
  };
  const ms = (inner: string, token?: string) =>
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${inner}${token ? `<D:sync-token>${token}</D:sync-token>` : ''}</D:multistatus>`;
  const ok = (href: string, props: string) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const auth = `Basic ${Buffer.from('u:p').toString('base64')}`;

  const handle: DavFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push(`${method} ${u.pathname}${body.includes('calendar-query') ? ' query' : ''}`);
    if (headers.get('authorization') !== auth) return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
    const path = decodeURIComponent(u.pathname);
    if (path === '/.well-known/caldav') return new Response('', { status: 301, headers: { Location: '/dav/cal/' } });
    if (method === 'PROPFIND' && path === '/dav/cal/') return new Response(ms(ok('/dav/cal/', '<D:current-user-principal><D:href>/dav/principals/u/</D:href></D:current-user-principal>')), { status: 207 });
    if (method === 'PROPFIND' && path === '/dav/principals/u/') return new Response(ms(ok('/dav/principals/u/', '<C:calendar-home-set><D:href>/dav/cal/u/</D:href></C:calendar-home-set>')), { status: 207 });
    if (method === 'PROPFIND' && path === '/dav/cal/u/') {
      let inner = ok('/dav/cal/u/', '<D:resourcetype><D:collection/></D:resourcetype>');
      for (const [href, c] of cals) {
        inner += ok(
          href,
          `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>${c.name}</D:displayname>${c.color ? `<A:calendar-color>${c.color}</A:calendar-color>` : ''}${opts.sync ? `<D:sync-token>tok-${version}</D:sync-token><D:supported-report-set><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>` : ''}<D:current-user-privilege-set><D:privilege><D:all/></D:privilege></D:current-user-privilege-set>`,
        );
      }
      return new Response(ms(inner), { status: 207 });
    }
    const calHref = [...cals.keys()].find((b) => path.startsWith(b));
    const cal = calHref ? cals.get(calHref)! : undefined;
    if (!cal || !calHref) return new Response('', { status: 404 });
    if (method === 'PROPFIND' && path === calHref) {
      let inner = ok(calHref, '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>');
      for (const [name, it] of cal.items) inner += ok(calHref + encodeURIComponent(name), `<D:getetag>${xml(it.etag)}</D:getetag><D:resourcetype/>`);
      return new Response(ms(inner), { status: 207 });
    }
    if (method === 'REPORT' && body.includes('sync-collection')) {
      if (!opts.sync) return new Response('', { status: 403 });
      const tok = body.match(/<d:sync-token>([^<]*)</)?.[1] ?? '';
      const since = tok ? Number(tok.replace('tok-', '')) : 0;
      let inner = '';
      const seen = new Set<string>();
      for (const e of [...log].reverse()) {
        if (e.v <= since || e.cal !== calHref || seen.has(e.href)) continue;
        seen.add(e.href);
        const name = e.href.slice(calHref.length);
        const it = cal.items.get(name);
        inner += it && !e.deleted ? ok(calHref + encodeURIComponent(name), `<D:getetag>${xml(it.etag)}</D:getetag>`) : `<D:response><D:href>${calHref + encodeURIComponent(name)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
      }
      return new Response(ms(inner, `tok-${version}`), { status: 207 });
    }
    if (method === 'REPORT' && body.includes('calendar-query')) {
      // le faux serveur ne filtre pas la plage : la façade refait le tri en mémoire
      let inner = '';
      for (const [name, it] of cal.items) inner += ok(calHref + encodeURIComponent(name), `<D:getetag>${xml(it.etag)}</D:getetag>`);
      return new Response(ms(inner), { status: 207 });
    }
    if (method === 'REPORT' && body.includes('calendar-multiget')) {
      let inner = '';
      for (const m of body.matchAll(/<d:href>([^<]+)<\/d:href>/g)) {
        const name = decodeURIComponent(m[1]!).slice(calHref.length);
        const it = cal.items.get(name);
        inner += it ? ok(m[1]!, `<D:getetag>${xml(it.etag)}</D:getetag><C:calendar-data><![CDATA[${it.data}]]></C:calendar-data>`) : `<D:response><D:href>${m[1]}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
      }
      return new Response(ms(inner), { status: 207 });
    }
    const name = path.slice(calHref.length);
    const cur = cal.items.get(name);
    if (method === 'PUT') {
      assert.match(headers.get('content-type') ?? '', /^text\/calendar/);
      if (headers.get('if-none-match') === '*' && cur) return new Response('', { status: 412 });
      const im = headers.get('if-match');
      if (im && (!cur || cur.etag !== im)) return new Response('', { status: 412 });
      const etag = `"${++etagN}"`;
      cal.items.set(name, { etag, data: body });
      bump(calHref, calHref + name, false);
      return new Response(cur ? null : '', { status: cur ? 204 : 201, headers: { ETag: etag } });
    }
    if (method === 'DELETE') {
      if (!cur) return new Response('', { status: 404 });
      const im = headers.get('if-match');
      if (im && cur.etag !== im) return new Response('', { status: 412 });
      cal.items.delete(name);
      bump(calHref, calHref + name, true);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  const fetch: DavFetch = async (url, init) => {
    let cur = url;
    for (let i = 0; i < 5; i++) {
      const res = await handle(cur, init);
      const loc = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !loc) return res;
      cur = new URL(loc, cur).href;
    }
    throw new Error('too many redirects');
  };
  const touch = (calHref: string, name: string, data: string) => {
    cals.get(calHref)!.items.set(name, { etag: `"${++etagN}"`, data });
    bump(calHref, calHref + name, false);
  };
  return { origin, fetch, cals, touch, calls };
}

const ics = (uid: string, title: string, extra = '') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART;TZID=Europe/Paris:20261110T090000\r\nDTEND;TZID=Europe/Paris:20261110T100000\r\nSUMMARY:${title}\r\n${extra}X-CUSTOM:garde-moi\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

function facade(fake: ReturnType<typeof fakeCalDav>, uploads = new Map<string, Buffer>()) {
  return new CalDavFacade({ serviceUrl: new URL(`${fake.origin}/.well-known/caldav`), username: 'u', password: 'p', loadUpload: async (id) => uploads.get(id) ?? null, fetch: fake.fetch });
}
const resolveId = (id: string) => id;

test('client CalDAV : découverte des agendas (principal → calendar-home-set), couleur, identifiants refusés', async () => {
  const fake = fakeCalDav({ sync: true });
  const list = await new DavClient(new URL(`${fake.origin}/dav/cal/`), 'u', 'p', fake.fetch).discoverCalendars();
  assert.deepEqual(
    list.map((c) => [c.name, c.color, c.supportsSync, c.mayWrite]),
    [
      ['Agenda', '#ff0000', true, true],
      ['Travail', null, true, true],
    ],
  );
  await assert.rejects(new DavClient(new URL(`${fake.origin}/dav/cal/`), 'u', 'mauvais', fake.fetch).discoverCalendars(), /authentication/);
});

for (const sync of [true, false]) {
  test(`façade CalDAV (${sync ? 'sync-collection' : 'ETag'}) : agendas, créer, lire, plage, occurrences, modifier, changes, supprimer`, async () => {
    const fake = fakeCalDav({ sync });
    const f = facade(fake);
    assert.equal(await f.probe(), true);
    const cap = f.sessionCapability()!;
    assert.ok('urn:ietf:params:jmap:calendars' in cap.core);
    const cals = await f.calendarGet({ ids: null });
    const list = cals.list as Array<{ id: string; name: string; color: string | null; isDefault: boolean }>;
    assert.deepEqual(list.map((c) => [c.name, c.color, c.isDefault]), [['Agenda', '#ff0000', true], ['Travail', null, false]]);
    const [def, work] = list;

    const s0 = (await f.get({ ids: [] })).state as string;
    const created: Record<string, string> = {};
    const r = await f.set(
      {
        create: {
          a: {
            calendarIds: { [def!.id]: true },
            uid: 'serie-1',
            title: 'Réunion',
            start: '2026-11-10T09:00:00',
            timeZone: 'Europe/Paris',
            duration: 'PT1H',
            recurrenceRules: [{ frequency: 'weekly', byDay: [{ day: 'tu' }, { day: 'th' }], count: 6 }],
            recurrenceOverrides: { '2026-11-17T09:00:00': { excluded: true } },
            alerts: { a: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' } } },
            sendSchedulingMessagesIgnored: undefined,
          },
          b: { calendarIds: { [work!.id]: true }, title: 'Journée', start: '2026-12-01T00:00:00', showWithoutTime: true, duration: 'P1D' },
          bad: { title: 'sans début' },
        },
      },
      resolveId,
      (cid, id) => (created[cid] = id),
    );
    assert.ok(r.notCreated && 'bad' in (r.notCreated as object));
    const idA = created.a!;
    const idB = created.b!;
    assert.match([...fake.cals.get('/dav/cal/u/default/')!.items.values()][0]!.data, /RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=TU,TH|RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6/);

    // un autre client ajoute un événement avec une propriété inconnue
    fake.touch('/dav/cal/u/default/', 'externe.ics', ics('ext-1', 'Externe'));
    f.close(); // instantané DAV gardé 3 s : on force la relecture
    const all = await f.get({ ids: null });
    const evs = all.list as Array<Record<string, unknown>>;
    assert.equal(evs.length, 3);
    const ext = evs.find((e) => e.uid === 'ext-1')!;
    assert.deepEqual((ext.iCalendar as { properties: unknown[] }).properties, [['x-custom', {}, 'unknown', 'garde-moi']]);
    assert.equal(ext.timeZone, 'Europe/Paris');

    // plage et filtres
    const q = await f.query({ filter: { after: '2026-11-11T00:00:00Z', before: '2026-11-20T00:00:00Z' } });
    assert.deepEqual(q.ids, [idA]);
    const qc = await f.query({ filter: { inCalendar: work!.id } });
    assert.deepEqual(qc.ids, [idB]);
    const qt = await f.query({ filter: { text: 'reunion' } });
    assert.deepEqual(qt.ids, [idA]);
    // développement : occurrences dans la plage (17 exclu), ids lisibles par get
    const qe = await f.query({ filter: { inCalendar: def!.id, after: '2026-11-09T00:00:00Z', before: '2026-11-20T00:00:00Z' }, expandRecurrences: true });
    const occIds = qe.ids as string[];
    assert.equal(occIds.length, 4); // 10 (série), 10 externe, 12, 19
    const occ = await f.get({ ids: occIds.filter((i) => i.includes('_')) });
    assert.deepEqual((occ.list as Array<{ recurrenceId: string; baseEventId: string }>).map((o) => [o.recurrenceId, o.baseEventId]), [
      ['2026-11-10T09:00:00', idA],
      ['2026-11-12T09:00:00', idA],
      ['2026-11-19T09:00:00', idA],
    ]);

    // « cet événement » par l'id d'occurrence, puis suppression d'une occurrence
    const occ12 = occIds.find((i) => i.endsWith('_20261112T090000'))!;
    const occ19 = occIds.find((i) => i.endsWith('_20261119T090000'))!;
    const u1 = await f.set({ update: { [occ12]: { title: 'Déplacée', start: '2026-11-12T11:00:00' } }, destroy: [occ19], sendSchedulingMessages: true }, resolveId, () => undefined);
    assert.equal(u1.notUpdated, null);
    assert.deepEqual(u1.destroyed, [occ19]);
    const a2 = ((await f.get({ ids: [idA] })).list as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(a2.recurrenceOverrides, { '2026-11-17T09:00:00': { excluded: true }, '2026-11-12T09:00:00': { title: 'Déplacée', start: '2026-11-12T11:00:00' }, '2026-11-19T09:00:00': { excluded: true } });
    assert.equal(a2.sequence, 2);
    const data = [...fake.cals.get('/dav/cal/u/default/')!.items.values()].map((x) => x.data).join('');
    assert.match(data, /RECURRENCE-ID;TZID=Europe\/Paris:20261112T090000/);

    // toute la série : patch ; changement d'agenda (nouvel id)
    const u2 = await f.set({ update: { [idA]: { title: 'Réunion 2', [`calendarIds/${def!.id}`]: null, [`calendarIds/${work!.id}`]: true } } }, resolveId, () => undefined);
    const moved = (u2.updated as Record<string, { id: string }>)[idA]!.id;
    assert.notEqual(moved, idA);
    assert.equal(fake.cals.get('/dav/cal/u/work/')!.items.size, 2);

    const extId = ext.id as string;

    // changes depuis l'état initial
    const ch = await f.changes({ sinceState: s0 });
    const touched = [...(ch.created as string[]), ...(ch.updated as string[])];
    for (const id of [moved, idB, extId]) assert.ok(touched.includes(id), id);
    // créé puis déplacé depuis s0 : sync-collection le signale supprimé ; par ETag, il n'a jamais existé pour s0
    if (sync) assert.ok((ch.destroyed as string[]).includes(idA));
    else assert.ok(!touched.includes(idA));

    // suppression
    const d = await f.set({ destroy: [moved, idB, extId] }, resolveId, () => undefined);
    assert.deepEqual(d.destroyed, [moved, idB, extId]);
    assert.equal(fake.cals.get('/dav/cal/u/default/')!.items.size + fake.cals.get('/dav/cal/u/work/')!.items.size, 0);
    const ch2 = await f.changes({ sinceState: ch.newState });
    assert.deepEqual([...(ch2.destroyed as string[])].sort(), [moved, idB, extId].sort());
  });
}

test('façade CalDAV : conflit d’ETag → stateMismatch', async () => {
  const fake = fakeCalDav({ sync: false });
  const f = facade(fake);
  await f.probe();
  fake.touch('/dav/cal/u/default/', 'x.ics', ics('x', 'X'));
  const id = ((await f.get({ ids: null })).list as Array<{ id: string }>)[0]!.id;
  // la façade lit l'état DAV au début de set : on simule une écriture concurrente entre la lecture et le PUT
  const orig = fake.fetch;
  let once = false;
  const racing: typeof orig = async (url, init) => {
    if (!once && (init.method ?? '').toUpperCase() === 'PUT') {
      once = true;
      fake.touch('/dav/cal/u/default/', 'x.ics', ics('x', 'X concurrent'));
    }
    return orig(url, init);
  };
  const f2 = new CalDavFacade({ serviceUrl: new URL(`${fake.origin}/.well-known/caldav`), username: 'u', password: 'p', loadUpload: async () => null, fetch: racing });
  await f2.probe();
  const r = await f2.set({ update: { [id]: { title: 'Y' } } }, resolveId, () => undefined);
  assert.equal((r.notUpdated as Record<string, { type: string }>)[id]!.type, 'stateMismatch');
});

test('façade CalDAV : CalendarEvent/parse (tous les VEVENT), sans état', async () => {
  const fake = fakeCalDav({ sync: true });
  const uploads = new Map<string, Buffer>([
    ['b1', Buffer.from(`${ics('p1', 'Un').replace('END:VCALENDAR\r\n', '')}BEGIN:VEVENT\r\nUID:p2\r\nDTSTART;VALUE=DATE:20261121\r\nSUMMARY:Deux\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)],
    ['b2', Buffer.from('pas un ics')],
  ]);
  const f = facade(fake, uploads);
  await f.probe();
  const r = await f.parse({ blobIds: ['b1', 'b2', 'b3'] });
  const p = (r.parsed as Record<string, Array<{ uid: string; title: string }>>).b1!;
  assert.deepEqual(p.map((e) => [e.uid, e.title]), [['p1', 'Un'], ['p2', 'Deux']]);
  assert.deepEqual(r.notParsable, ['b2']);
  assert.deepEqual(r.notFound, ['b3']);
  // aucun appel d'écriture vers le serveur DAV
  assert.ok(!fake.calls.some((c) => c.startsWith('PUT') || c.startsWith('DELETE')));
});
