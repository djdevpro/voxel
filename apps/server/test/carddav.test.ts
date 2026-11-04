/**
 * Lot B2 : client WebDAV et façade CardDAV → JMAP Contacts contre un faux serveur DAV en mémoire
 * (avec et sans `sync-collection`), plus la validation de `X-Voxel-CardDav`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DavClient, parseDavUrl, parseMultistatus, type DavFetch } from '../src/carddav/dav.js';
import { applyPatch, CardDavFacade } from '../src/carddav/facade.js';

// ------------------------------------------------------------------ faux serveur DAV

interface FakeOptions {
  sync: boolean;
  /** Nom d'utilisateur et mot de passe acceptés. */
  user?: string;
  pass?: string;
}

function fakeDav(opts: FakeOptions) {
  const origin = 'https://dav.example.com';
  const books = new Map<string, { name: string; items: Map<string, { etag: string; data: string }>; ctag: number }>();
  books.set('/dav/card/u/default/', { name: 'Contacts', items: new Map(), ctag: 1 });
  books.set('/dav/card/u/work/', { name: 'Travail', items: new Map(), ctag: 1 });
  // journal de synchronisation : n° de version → href modifié ou supprimé
  const log: Array<{ v: number; href: string; book: string; deleted: boolean }> = [];
  let version = 1;
  let etagN = 100;
  const calls: string[] = [];
  const bump = (book: string, href: string, deleted: boolean) => {
    version++;
    log.push({ v: version, href, book, deleted });
    books.get(book)!.ctag++;
  };
  const ms = (inner: string, token?: string) =>
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav" xmlns:C="http://calendarserver.org/ns/">${inner}${token ? `<D:sync-token>${token}</D:sync-token>` : ''}</D:multistatus>`;
  const ok = (href: string, props: string) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const reports = () =>
    `<D:supported-report-set>${opts.sync ? '<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>' : ''}<D:supported-report><D:report><B:addressbook-multiget/></D:report></D:supported-report></D:supported-report-set>`;
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const auth = `Basic ${Buffer.from(`${opts.user ?? 'u'}:${opts.pass ?? 'p'}`).toString('base64')}`;

  const handle: DavFetch = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push(`${method} ${u.pathname}`);
    if (headers.get('authorization') !== auth) return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
    const path = decodeURIComponent(u.pathname);
    if (method === 'PROPFIND' && path === '/.well-known/carddav') return new Response('', { status: 301, headers: { Location: '/dav/card/' } });
    if (method === 'PROPFIND' && path === '/dav/card/') {
      return new Response(ms(ok('/dav/card/', '<D:current-user-principal><D:href>/dav/principals/u/</D:href></D:current-user-principal>')), { status: 207 });
    }
    if (method === 'PROPFIND' && path === '/dav/principals/u/') {
      return new Response(ms(ok('/dav/principals/u/', '<B:addressbook-home-set><D:href>/dav/card/u/</D:href></B:addressbook-home-set>')), { status: 207 });
    }
    if (method === 'PROPFIND' && path === '/dav/card/u/') {
      let inner = ok('/dav/card/u/', '<D:resourcetype><D:collection/></D:resourcetype>');
      for (const [href, b] of books) {
        inner += ok(
          href,
          `<D:resourcetype><D:collection/><B:addressbook/></D:resourcetype><D:displayname>${b.name}</D:displayname><C:getctag>"${b.ctag}"</C:getctag>${opts.sync ? `<D:sync-token>tok-${version}</D:sync-token>` : ''}${reports()}<D:current-user-privilege-set><D:privilege><D:all/></D:privilege></D:current-user-privilege-set>`,
        );
      }
      return new Response(ms(inner), { status: 207 });
    }
    const bookHref = [...books.keys()].find((b) => path.startsWith(b));
    const book = bookHref ? books.get(bookHref)! : undefined;
    if (!book || !bookHref) return new Response('', { status: 404 });
    if (method === 'PROPFIND' && path === bookHref) {
      let inner = ok(bookHref, '<D:resourcetype><D:collection/><B:addressbook/></D:resourcetype>');
      for (const [name, it] of book.items) inner += ok(bookHref + encodeURIComponent(name), `<D:getetag>${xml(it.etag)}</D:getetag><D:resourcetype/>`);
      return new Response(ms(inner), { status: 207 });
    }
    if (method === 'REPORT' && body.includes('sync-collection')) {
      if (!opts.sync) return new Response('', { status: 403 });
      const tok = body.match(/<d:sync-token>([^<]*)</)?.[1] ?? '';
      const since = tok ? Number(tok.replace('tok-', '')) : 0;
      if (tok && !/^tok-\d+$/.test(tok)) return new Response('<error><valid-sync-token/></error>', { status: 403 });
      let inner = '';
      const seen = new Set<string>();
      for (const e of [...log].reverse()) {
        if (e.v <= since || e.book !== bookHref || seen.has(e.href)) continue;
        seen.add(e.href);
        const name = e.href.slice(bookHref.length);
        const it = book.items.get(name);
        inner += it && !e.deleted ? ok(bookHref + encodeURIComponent(name), `<D:getetag>${xml(it.etag)}</D:getetag>`) : `<D:response><D:href>${bookHref + encodeURIComponent(name)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
      }
      if (!tok) for (const [name, it] of book.items) if (!seen.has(bookHref + name)) inner += ok(bookHref + encodeURIComponent(name), `<D:getetag>${xml(it.etag)}</D:getetag>`);
      return new Response(ms(inner, `tok-${version}`), { status: 207 });
    }
    if (method === 'REPORT' && body.includes('addressbook-multiget')) {
      let inner = '';
      for (const m of body.matchAll(/<d:href>([^<]+)<\/d:href>/g)) {
        const name = decodeURIComponent(m[1]!).slice(bookHref.length);
        const it = book.items.get(name);
        inner += it
          ? ok(m[1]!, `<D:getetag>${xml(it.etag)}</D:getetag><B:address-data><![CDATA[${it.data}]]></B:address-data>`)
          : `<D:response><D:href>${m[1]}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
      }
      return new Response(ms(inner), { status: 207 });
    }
    const name = path.slice(bookHref.length);
    const cur = book.items.get(name);
    if (method === 'PUT') {
      if (headers.get('if-none-match') === '*' && cur) return new Response('', { status: 412 });
      const im = headers.get('if-match');
      if (im && (!cur || cur.etag !== im)) return new Response('', { status: 412 });
      const etag = `"${++etagN}"`;
      book.items.set(name, { etag, data: body });
      bump(bookHref, bookHref + name, false);
      return new Response(cur ? null : '', { status: cur ? 204 : 201, headers: { ETag: etag } });
    }
    if (method === 'DELETE') {
      if (!cur) return new Response('', { status: 404 });
      const im = headers.get('if-match');
      if (im && cur.etag !== im) return new Response('', { status: 412 });
      book.items.delete(name);
      bump(bookHref, bookHref + name, true);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };
  // comme safeFetch : redirections suivies (même méthode pour 301/307 hors POST)
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

  /** Modification « par un autre client » (change l'ETag). */
  const touch = (bookHref: string, name: string, data: string) => {
    const book = books.get(bookHref)!;
    book.items.set(name, { etag: `"${++etagN}"`, data });
    bump(bookHref, bookHref + name, false);
  };
  return { origin, fetch, books, touch, calls };
}

const vcard = (uid: string, fn: string, email: string) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fn}\r\nEMAIL;TYPE=INTERNET:${email}\r\nX-CUSTOM:garde-moi\r\nEND:VCARD\r\n`;

function facade(fake: ReturnType<typeof fakeDav>, uploads = new Map<string, Buffer>()) {
  return new CardDavFacade({
    serviceUrl: new URL(`${fake.origin}/.well-known/carddav`),
    username: 'u',
    password: 'p',
    loadUpload: async (id) => uploads.get(id) ?? null,
    fetch: fake.fetch,
  });
}

const resolveId = (id: string) => id;

// ------------------------------------------------------------------ tests

test('X-Voxel-CardDav : https et port 443 seulement, sans identifiants', () => {
  assert.equal(parseDavUrl('https://mail.example.com/dav/card/')?.href, 'https://mail.example.com/dav/card/');
  assert.equal(parseDavUrl('https://mail.example.com:443/.well-known/carddav')?.host, 'mail.example.com');
  assert.equal(parseDavUrl('http://mail.example.com/dav/'), null);
  assert.equal(parseDavUrl('https://mail.example.com:8443/dav/'), null);
  assert.equal(parseDavUrl('https://user:pw@mail.example.com/dav/'), null);
  assert.equal(parseDavUrl('pas une url'), null);
});

test('XML : multistatus, entités et CDATA, statut par réponse', () => {
  const r = parseMultistatus(
    '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav"><D:response><D:href>/a.vcf</D:href><D:propstat><D:prop><D:getetag>&quot;1&quot;</D:getetag><B:address-data><![CDATA[BEGIN:VCARD\nFN:a & b\nEND:VCARD]]></B:address-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response><D:response><D:href>/b.vcf</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response><D:sync-token>t1</D:sync-token></D:multistatus>',
  );
  assert.equal(r.syncToken, 't1');
  assert.equal(r.responses[0]!.props.getetag, '"1"');
  assert.match(String(r.responses[0]!.props['address-data']), /FN:a & b/);
  assert.equal('displayname' in r.responses[0]!.props, false);
  assert.equal(r.responses[1]!.status, 404);
});

test('client : découverte (well-known → principal → maison), identifiants refusés', async () => {
  const fake = fakeDav({ sync: true });
  const books = await new DavClient(new URL(`${fake.origin}/dav/card/`), 'u', 'p', fake.fetch).discoverBooks();
  assert.deepEqual(
    books.map((b) => [b.name, b.supportsSync, b.mayWrite]),
    [
      ['Contacts', true, true],
      ['Travail', true, true],
    ],
  );
  await assert.rejects(new DavClient(new URL(`${fake.origin}/dav/card/`), 'u', 'mauvais', fake.fetch).discoverBooks(), /authentication/);
  const bad = facade({ ...fakeDav({ sync: true, pass: 'autre' }) });
  assert.equal(await bad.probe(), false);
  assert.equal(bad.sessionCapability(), null);
});

for (const sync of [true, false]) {
  test(`façade (${sync ? 'sync-collection' : 'getctag + getetag'}) : get, query, set, conflits, déplacement, changes, parse`, async () => {
    const fake = fakeDav({ sync });
    fake.books.get('/dav/card/u/default/')!.items.set('alice.vcf', { etag: '"1"', data: vcard('alice-uid', 'Alice Martin', 'alice@example.com') });
    const uploads = new Map<string, Buffer>();
    const f = facade(fake, uploads);
    assert.equal(await f.probe(), true);
    assert.ok(f.sessionCapability()!.core['urn:ietf:params:jmap:contacts']);

    const ab = await f.addressBookGet({ ids: null });
    const [defBook, workBook] = ab.list as Array<{ id: string; name: string; isDefault: boolean }>;
    assert.equal(defBook!.name, 'Contacts');
    assert.equal(defBook!.isDefault, true);

    const g = await f.get({ ids: null });
    const state0 = g.state as string;
    const alice = (g.list as Array<Record<string, unknown>>)[0]!;
    assert.equal((alice.name as { full: string }).full, 'Alice Martin');
    assert.deepEqual(alice.addressBookIds, { [defBook!.id]: true });

    // création (uid fixé par la façade s'il manque)
    const created: Record<string, string> = {};
    const s1 = await f.set({ create: { n: { addressBookIds: { [defBook!.id]: true }, name: { full: 'Bruno Petit' }, emails: { e: { address: 'bruno@example.com' } } } } }, resolveId, (cid, id) => (created[cid] = id));
    const bruno = (s1.created as Record<string, { id: string; uid: string }>).n;
    assert.ok(bruno?.id && bruno.uid.startsWith('urn:uuid:'));
    assert.equal(created.n, bruno.id);

    // recherche « text » en mémoire, tri par nom
    const q = await f.query({ filter: { text: 'BRUNO' } });
    assert.deepEqual(q.ids, [bruno.id]);
    const all = await f.query({ filter: { inAddressBook: defBook!.id }, calculateTotal: true });
    assert.equal(all.total, 2);
    assert.deepEqual(all.ids, [alice.id, bruno.id]);

    // mise à jour par patch : la propriété inconnue X-CUSTOM est conservée
    const s2 = await f.set({ update: { [alice.id as string]: { 'name/full': 'Alice Durand', 'phones/p1': { number: '+33 6' } } } }, resolveId, () => undefined);
    assert.deepEqual(s2.updated, { [alice.id as string]: null });
    const stored = fake.books.get('/dav/card/u/default/')!.items.get('alice.vcf')!.data;
    assert.match(stored, /FN:Alice Durand/);
    assert.match(stored, /X-CUSTOM:garde-moi/);
    assert.match(stored, /VERSION:3\.0/);

    // conflit d'ETag : modifiée ailleurs après notre lecture → stateMismatch
    const before = await f.get({ ids: [alice.id as string] });
    void before;
    const realFetch = fake.fetch;
    let touched = false;
    const racing: typeof realFetch = async (url, init) => {
      if (!touched && init.method === 'PUT') {
        touched = true;
        fake.touch('/dav/card/u/default/', 'alice.vcf', vcard('alice-uid', 'Alice (ailleurs)', 'alice@example.com'));
      }
      return realFetch(url, init);
    };
    const f2 = new CardDavFacade({ serviceUrl: new URL(`${fake.origin}/.well-known/carddav`), username: 'u', password: 'p', loadUpload: async () => null, fetch: racing });
    await f2.probe();
    const s3 = await f2.set({ update: { [alice.id as string]: { 'name/full': 'Perdu' } } }, resolveId, () => undefined);
    assert.equal((s3.notUpdated as Record<string, { type: string }>)[alice.id as string]!.type, 'stateMismatch');

    // changes depuis l'état initial : Bruno créé (ou modifié avec sync-collection), Alice modifiée
    const ch = await f.changes({ sinceState: state0 });
    const touchedIds = [...(ch.created as string[]), ...(ch.updated as string[])].sort();
    assert.deepEqual(touchedIds, [alice.id, bruno.id].sort());
    assert.deepEqual(ch.destroyed, []);
    if (!sync) assert.deepEqual(ch.created, [bruno.id]);

    // déplacement vers « Travail » : nouvel id, ancien détruit pour changes
    const s4 = await f.set({ update: { [bruno.id]: { addressBookIds: { [workBook!.id]: true } } } }, resolveId, () => undefined);
    const movedId = (s4.updated as Record<string, { id: string }>)[bruno.id]!.id;
    assert.notEqual(movedId, bruno.id);
    assert.equal(fake.books.get('/dav/card/u/work/')!.items.size, 1);
    const ch2 = await f.changes({ sinceState: ch.newState });
    assert.ok((ch2.destroyed as string[]).includes(bruno.id));
    assert.ok([...(ch2.created as string[]), ...(ch2.updated as string[])].includes(movedId));

    // suppression ; état périmé → stateMismatch (ifInState)
    await assert.rejects(f.set({ ifInState: state0, destroy: [movedId] }, resolveId, () => undefined), /stateMismatch/);
    const s5 = await f.set({ destroy: [movedId, 'cinconnu'] }, resolveId, () => undefined);
    assert.deepEqual(s5.destroyed, [movedId]);
    assert.equal((s5.notDestroyed as Record<string, { type: string }>).cinconnu!.type, 'notFound');

    // parse : un fichier de deux vCard → tableau ; une seule → fiche ; texte → notParsable
    uploads.set('B1', Buffer.from(vcard('x1', 'Un', 'un@x.fr') + vcard('x2', 'Deux', 'deux@x.fr')));
    uploads.set('B2', Buffer.from(vcard('x3', 'Trois', 'trois@x.fr')));
    uploads.set('B3', Buffer.from('bonjour'));
    const p = await f.parse({ blobIds: ['B1', 'B2', 'B3', 'B4'] });
    const parsed = p.parsed as Record<string, unknown>;
    assert.equal((parsed.B1 as unknown[]).length, 2);
    assert.equal((parsed.B2 as { name: { full: string } }).name.full, 'Trois');
    assert.deepEqual(p.notParsable, ['B3']);
    assert.deepEqual(p.notFound, ['B4']);
  });
}

test('façade : un seul carnet par fiche, état invalide, changes des carnets', async () => {
  const fake = fakeDav({ sync: true });
  const f = facade(fake);
  await f.probe();
  const ab = (await f.addressBookGet({ ids: null })).list as Array<{ id: string }>;
  const s = await f.set({ create: { x: { addressBookIds: { [ab[0]!.id]: true, [ab[1]!.id]: true }, name: { full: 'X' } } } }, resolveId, () => undefined);
  assert.equal((s.notCreated as Record<string, { type: string }>).x!.type, 'invalidProperties');
  await assert.rejects(f.changes({ sinceState: 'nimporte' }), /cannotCalculateChanges/);
  const abState = (await f.addressBookGet({})).state as string;
  const abc = await f.addressBookChanges({ sinceState: abState });
  assert.deepEqual([abc.created, abc.updated, abc.destroyed], [[], [], []]);
});

test('patch JMAP : chemins, échappements, suppression, garde-fous', () => {
  const o = { name: { full: 'A' }, members: { 'urn:uuid:1': true } as Record<string, boolean> };
  const r = applyPatch(o, { 'name/full': 'B', 'members/urn:uuid:2': true, 'members/urn:uuid:1': null, 'emails/e~1x': { address: 'a@b' } });
  assert.deepEqual(r, { name: { full: 'B' }, members: { 'urn:uuid:2': true }, emails: { 'e/x': { address: 'a@b' } } });
  assert.deepEqual(o.members, { 'urn:uuid:1': true });
  assert.throws(() => applyPatch(o, { '__proto__/x': 1 }), /bad path/);
});
