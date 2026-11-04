/**
 * Intégration du lot A2 contre la boîte de test dédiée (JMAP for Contacts de Stalwart),
 * ignorée sans VOXEL_TEST_JMAP_URL / VOXEL_TEST_USER / VOXEL_TEST_PASSWORD. Lancer depuis la racine :
 *   node --env-file=.env.test.local --test packages/jmap/test/integration-contacts.test.ts
 * Crée un carnet `voxel-test-…`, des fiches et un groupe, les modifie, les déplace puis supprime tout.
 * Le mot de passe n'est jamais affiché.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CAP, JmapClient, newCardUid, splitVcards, type ContactCardCreate } from '../src/index.ts';
import { cardToVcard, vcardToCard } from '../src/vcard.ts';

const URL_ = process.env.VOXEL_TEST_JMAP_URL;
const USER = process.env.VOXEL_TEST_USER;
const PASS = process.env.VOXEL_TEST_PASSWORD;
const skip = !URL_ || !USER || !PASS ? 'VOXEL_TEST_* non définies' : false;
const TAG = `voxel-test-${Date.now().toString(36)}`;

let c: JmapClient;
let aid: string;

before(async () => {
  if (skip) return;
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  c = new JmapClient({ sessionUrl: URL_!, headers: { Authorization: auth } });
  aid = await c.accountId(CAP.contacts);
});

/** Supprime les fiches et carnets de test restants. */
async function cleanup() {
  const cards = await c.call('ContactCard/get', { accountId: aid, ids: null, properties: ['uid', 'name'] });
  const ours = cards.list.filter((x) => x.uid?.includes('voxel-test-') || x.name?.full?.startsWith('Voxel Test '));
  if (ours.length) await c.call('ContactCard/set', { accountId: aid, destroy: ours.map((x) => x.id) });
  const books = await c.call('AddressBook/get', { accountId: aid, ids: null });
  const test = books.list.filter((b) => b.name.startsWith('voxel-test-'));
  if (test.length) await c.call('AddressBook/set', { accountId: aid, destroy: test.map((b) => b.id), onDestroyRemoveContents: true });
}

after(async () => {
  if (skip) return;
  await cleanup().catch((e) => console.warn('nettoyage :', (e as Error).message));
});

test('session : contacts et contacts:parse annoncés', { skip }, async () => {
  const s = await c.getSession();
  assert.ok(CAP.contacts in s.capabilities);
  assert.ok(CAP.contactsParse in s.capabilities);
});

test('carnets et fiches : créer, lire, chercher, grouper, modifier, déplacer, changes, supprimer', { skip }, async () => {
  const b0 = await c.call('AddressBook/get', { accountId: aid, ids: null });
  const def = b0.list.find((b) => b.isDefault) ?? b0.list[0]!;
  const cs0 = (await c.call('ContactCard/get', { accountId: aid, ids: [] })).state;

  const nb = await c.call('AddressBook/set', { accountId: aid, create: { nb: { name: `${TAG}-carnet` } } });
  const bookId = nb.created!.nb!.id;
  const abCh = await c.call('AddressBook/changes', { accountId: aid, sinceState: b0.state });
  assert.ok(abCh.created.includes(bookId));

  const uidA = newCardUid();
  const uidB = newCardUid();
  const set1 = await c.call('ContactCard/set', {
    accountId: aid,
    create: {
      a: { addressBookIds: { [def.id]: true }, uid: uidA, name: { full: 'Voxel Test Alice' }, emails: { e: { address: `${TAG}-a@example.com` } } },
      b: { addressBookIds: { [def.id]: true }, uid: uidB, name: { full: 'Voxel Test Bruno' }, emails: { e: { address: `${TAG}-b@example.com` } } },
      g: { addressBookIds: { [def.id]: true }, uid: newCardUid(), kind: 'group', name: { full: 'Voxel Test Groupe' }, members: { [uidA]: true } },
    },
  });
  assert.equal(set1.notCreated ?? null, null, JSON.stringify(set1.notCreated));
  const idA = set1.created!.a!.id;
  const idB = set1.created!.b!.id;
  const idG = set1.created!.g!.id;

  // recherche par texte et par adresse
  const q = await c.call('ContactCard/query', { accountId: aid, filter: { text: `${TAG}-b` } });
  assert.deepEqual(q.ids, [idB]);
  const qe = await c.call('ContactCard/query', { accountId: aid, filter: { email: `${TAG}-a@example.com` } });
  assert.deepEqual(qe.ids, [idA]);

  // membres : ajout par chemin (uid avec « : », pas de « / ») ; nom modifié
  const upd = await c.call('ContactCard/set', { accountId: aid, update: { [idG]: { [`members/${uidB}`]: true, 'name/full': 'Voxel Test Groupe 2' } } });
  assert.equal(upd.notUpdated ?? null, null);
  const g = await c.call('ContactCard/get', { accountId: aid, ids: [idG] });
  assert.deepEqual(Object.keys(g.list[0]!.members ?? {}).sort(), [uidA, uidB].sort());

  // déplacement d'un carnet à l'autre
  const mv = await c.call('ContactCard/set', { accountId: aid, update: { [idA]: { addressBookIds: { [bookId]: true } } } });
  assert.equal(mv.notUpdated ?? null, null);
  const inBook = await c.call('ContactCard/query', { accountId: aid, filter: { inAddressBook: bookId } });
  assert.deepEqual(inBook.ids, [idA]);

  const ch = await c.allChanges('ContactCard', aid, cs0);
  for (const id of [idA, idB, idG]) assert.ok([...ch.created, ...ch.updated].includes(id));

  // export vCard d'une fiche lue, réimportée par ContactCard/parse
  const full = await c.call('ContactCard/get', { accountId: aid, ids: [idB] });
  const vcf = cardToVcard(full.list[0]!);
  assert.equal(vcardToCard(vcf).name?.full, 'Voxel Test Bruno');

  // import : un blob par vCard (Stalwart ne lit que la première d'un blob)
  const file = `${vcf}BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Voxel Test Import\r\nEMAIL:${TAG}-i@example.com\r\nX-FOO:bar\r\nEND:VCARD\r\n`;
  const parts = splitVcards(file);
  assert.equal(parts.length, 2);
  const blobs = await Promise.all(parts.map((p) => c.upload(aid, new TextEncoder().encode(p), 'text/vcard')));
  const parsed = await c.call('ContactCard/parse', { accountId: aid, blobIds: blobs.map((b) => b.blobId) });
  const second = parsed.parsed?.[blobs[1]!.blobId] as ContactCardCreate;
  assert.equal(second.name?.full, 'Voxel Test Import');
  assert.ok((second.vCard?.properties ?? []).some((p) => p[0] === 'x-foo'));
  const imp = await c.call('ContactCard/set', { accountId: aid, create: { i: { ...second, addressBookIds: { [def.id]: true }, uid: `urn:uuid:${TAG}-import` } } });
  assert.equal(imp.notCreated ?? null, null, JSON.stringify(imp.notCreated));

  // suppression et changes
  const before = (await c.call('ContactCard/get', { accountId: aid, ids: [] })).state;
  await c.call('ContactCard/set', { accountId: aid, destroy: [idA, idB, idG, imp.created!.i!.id] });
  const ch2 = await c.allChanges('ContactCard', aid, before);
  for (const id of [idA, idB, idG]) assert.ok(ch2.destroyed.includes(id));
  await c.call('AddressBook/set', { accountId: aid, destroy: [bookId], onDestroyRemoveContents: true });
});
