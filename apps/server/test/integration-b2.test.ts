/**
 * Intégration du lot B2 contre la boîte de test dédiée : passerelle IMAP + CardDAV du même
 * serveur (`X-Voxel-CardDav`), ignorée sans VOXEL_TEST_USER / VOXEL_TEST_PASSWORD / VOXEL_TEST_IMAP / VOXEL_TEST_SMTP.
 * Lancer depuis la racine :
 *   node --env-file=.env.test.local --import tsx --test apps/server/test/integration-b2.test.ts
 * URL CardDAV : VOXEL_TEST_CARDDAV, sinon découverte (`/.well-known/carddav` du domaine de la boîte).
 * Crée, modifie et supprime des fiches dans le carnet par défaut ; tout ce qui porte un uid `voxel-test-` est
 * supprimé à la fin. Le mot de passe n'est jamais affiché.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-b2-'));

const { USER, PASS, IMAP, SMTP } = {
  USER: process.env.VOXEL_TEST_USER,
  PASS: process.env.VOXEL_TEST_PASSWORD,
  IMAP: process.env.VOXEL_TEST_IMAP,
  SMTP: process.env.VOXEL_TEST_SMTP,
};
const skip = !USER || !PASS || !IMAP || !SMTP ? 'VOXEL_TEST_* non définies' : false;

const { createImapBackend } = await import('../src/imap/index.js');
const { parseEndpoint } = await import('../src/routes/imap.js');
const { discoverCardDav } = await import('../src/discovery.js');
const { DavClient } = await import('../src/carddav/dav.js');
type Backend = ReturnType<typeof createImapBackend>;

let backend: Backend;
let davUrl: string;
const TAG = `voxel-test-${Date.now().toString(36)}`;
const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts', 'urn:ietf:params:jmap:contacts:parse'];

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

/** Supprime directement en CardDAV toute fiche de test restante (uid `voxel-test-`). */
async function cleanup() {
  const dav = new DavClient(new URL(davUrl), USER!, PASS!);
  for (const book of await dav.discoverBooks()) {
    const members = await dav.listMembers(book.href);
    if (!members.length) continue;
    for (const m of await dav.multiget(book.href, members.map((x) => x.href))) {
      if (/UID:(urn:uuid:)?voxel-test-/i.test(m.data) || /FN:Voxel Test /.test(m.data)) await dav.delete(m.href, m.etag || null);
    }
  }
}

before(async () => {
  if (skip) return;
  const domain = USER!.split('@')[1]!;
  davUrl = process.env.VOXEL_TEST_CARDDAV || (await discoverCardDav(domain, parseEndpoint('imap', IMAP)!.host)) || '';
  assert.ok(davUrl, 'CardDAV introuvable par la découverte');
  console.log(`CardDAV découvert : ${new URL(davUrl).host}${new URL(davUrl).pathname}`);
  backend = createImapBackend(
    { email: USER!, username: USER!, auth: { password: PASS! }, imap: parseEndpoint('imap', IMAP)!, smtp: parseEndpoint('smtp', SMTP)!, carddav: davUrl },
    kv(),
  );
  await backend.verify();
  await backend.probe?.();
});

after(async () => {
  if (skip) return;
  await cleanup().catch((e) => console.warn('nettoyage :', (e as Error).message));
  await backend?.close();
});

test('session : contacts et contacts:parse annoncés après vérification CardDAV', { skip }, async () => {
  const s = await backend.session();
  assert.ok('urn:ietf:params:jmap:contacts' in s.capabilities);
  assert.ok('urn:ietf:params:jmap:contacts:parse' in s.capabilities);
  assert.equal(s.primaryAccounts['urn:ietf:params:jmap:contacts'], 'a');
});

test('passerelle HTTP : X-Voxel-CardDav → session avec contacts, puis /imap/api ContactCard/get', { skip }, async () => {
  const { createApp } = await import('../src/app.js');
  const app = createApp();
  const headers = {
    authorization: `Basic ${Buffer.from(`${USER}:${PASS}`, 'utf8').toString('base64')}`,
    'x-voxel-imap': IMAP!,
    'x-voxel-smtp': SMTP!,
    'x-voxel-carddav': davUrl,
  };
  const s = await app.request('http://voxel.localhost/imap/session', { headers });
  assert.equal(s.status, 200);
  const session = (await s.json()) as { capabilities: Record<string, unknown> };
  assert.ok('urn:ietf:params:jmap:contacts' in session.capabilities);
  const r = await app.request('http://voxel.localhost/imap/api', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ using, methodCalls: [['AddressBook/get', { accountId: 'a', ids: null }, 'b'], ['ContactCard/get', { accountId: 'a', ids: [] }, 'g']] }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { methodResponses: Array<[string, Record<string, unknown>, string]> };
  assert.deepEqual(body.methodResponses.map((m) => m[0]), ['AddressBook/get', 'ContactCard/get']);
  const { closeAllBackends } = await import('../src/backend/pool.js');
  await closeAllBackends();
});

test('carnets, création, lecture, recherche, modification, groupe, changes, parse, suppression', { skip }, async () => {
  const [books] = await api([['AddressBook/get', { ids: null }]]);
  assert.ok(books!.list.length >= 1);
  const book = books!.list.find((b: { isDefault: boolean }) => b.isDefault) ?? books!.list[0];
  console.log(`carnets : ${books!.list.length}`);
  const [g0] = await api([['ContactCard/get', { ids: [] }]]);
  const state0 = g0!.state as string;

  const [s1] = await api([
    [
      'ContactCard/set',
      {
        create: {
          a: {
            addressBookIds: { [book.id]: true },
            uid: `${TAG}-a`,
            name: { full: 'Voxel Test Alice', components: [{ kind: 'given', value: 'Alice' }, { kind: 'surname', value: 'Test' }] },
            emails: { e1: { address: `${TAG}-alice@example.com`, contexts: { work: true } } },
            phones: { p1: { number: '+33 6 00 00 00 00', features: { mobile: true } } },
            vCard: { properties: [['x-voxel-test', {}, 'unknown', 'conserve']] },
          },
          b: { addressBookIds: { [book.id]: true }, uid: `${TAG}-b`, name: { full: 'Voxel Test Bruno' }, emails: { e1: { address: `${TAG}-bruno@example.com` } } },
        },
      },
    ],
  ]);
  assert.equal(s1!.notCreated, null, JSON.stringify(s1!.notCreated));
  const idA = s1!.created.a.id as string;
  const idB = s1!.created.b.id as string;

  const [g1] = await api([['ContactCard/get', { ids: [idA, idB] }]]);
  const alice = g1!.list.find((c: { id: string }) => c.id === idA);
  assert.equal(alice.name.full, 'Voxel Test Alice');
  assert.equal(Object.values(alice.emails as Record<string, { address: string }>)[0]!.address, `${TAG}-alice@example.com`);
  assert.ok((alice.vCard?.properties ?? []).some((p: unknown[]) => p[0] === 'x-voxel-test' && p[3] === 'conserve'), 'propriété inconnue perdue');

  const [q] = await api([['ContactCard/query', { filter: { text: `${TAG}-bruno` } }]]);
  assert.deepEqual(q!.ids, [idB]);

  // groupe : membres par uid
  const [s2] = await api([['ContactCard/set', { create: { g: { addressBookIds: { [book.id]: true }, uid: `${TAG}-g`, kind: 'group', name: { full: 'Voxel Test Groupe' }, members: { [`${TAG}-a`]: true } } } }]]);
  const idG = s2!.created.g.id as string;
  const [s3] = await api([['ContactCard/set', { update: { [idG]: { [`members/${TAG}-b`]: true }, [idA]: { 'name/full': 'Voxel Test Alice Modifiée' } } }]]);
  assert.equal(s3!.notUpdated, null, JSON.stringify(s3!.notUpdated));
  const [g2] = await api([['ContactCard/get', { ids: [idG, idA] }]]);
  const group = g2!.list.find((c: { id: string }) => c.id === idG);
  assert.equal(group.kind, 'group');
  assert.deepEqual(Object.keys(group.members).sort(), [`${TAG}-a`, `${TAG}-b`].sort());
  assert.equal(g2!.list.find((c: { id: string }) => c.id === idA).name.full, 'Voxel Test Alice Modifiée');

  // changes depuis l'état initial
  const [ch] = await api([['ContactCard/changes', { sinceState: state0 }]]);
  const seen = [...ch!.created, ...ch!.updated];
  for (const id of [idA, idB, idG]) assert.ok(seen.includes(id), `changes sans ${id}`);

  // conflit d'ETag (412) vu par le client DAV
  const dav = new DavClient(new URL(davUrl), USER!, PASS!);
  const bookHref = (await dav.discoverBooks()).find((b) => b.name === book.name)!.href;
  const mine = (await dav.listMembers(bookHref)).find((m) => m.href.includes(`${TAG}-b`))!;
  assert.equal(await dav.put(mine.href, 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:x\r\nFN:x\r\nEND:VCARD\r\n', '"etag-perime"'), 'conflict');

  // parse d'un fichier de deux vCard téléversé
  const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Voxel Test Import 1\r\nEMAIL:${TAG}-i1@example.com\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Voxel Test Import 2\r\nEND:VCARD\r\n`;
  const up = await backend.upload('a', new Blob([vcf]).stream() as ReadableStream<Uint8Array>, 'text/vcard');
  const [p] = await api([['ContactCard/parse', { blobIds: [up.blobId] }]]);
  assert.equal((p!.parsed[up.blobId] as unknown[]).length, 2);

  // suppression, puis changes
  const [g3] = await api([['ContactCard/get', { ids: [] }]]);
  const [s4] = await api([['ContactCard/set', { destroy: [idA, idB, idG] }]]);
  assert.deepEqual([...s4!.destroyed].sort(), [idA, idB, idG].sort());
  const [ch2] = await api([['ContactCard/changes', { sinceState: g3!.state }]]);
  for (const id of [idA, idB, idG]) assert.ok(ch2!.destroyed.includes(id), `destruction de ${id} absente de changes`);
});
