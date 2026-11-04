/**
 * Tests d'intégration du lot A1 contre la boîte de test dédiée, ignorés sans
 * VOXEL_TEST_JMAP_URL / VOXEL_TEST_USER / VOXEL_TEST_PASSWORD. Lancer depuis la racine :
 *   node --env-file=.env.test.local --test packages/jmap/test/integration.test.ts
 * Chaque test nettoie ses objets (scripts Sieve, dossiers, messages). Le mot de passe n'est jamais affiché.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  buildManagedScript,
  CAP,
  EMPTY_MANAGED,
  JmapClient,
  MANAGED_SCRIPT_NAME,
  parseManagedScript,
  parseSynced,
  patchSynced,
  pickQuota,
  type SieveAccountCapability,
} from '../src/index.ts';

const URL_ = process.env.VOXEL_TEST_JMAP_URL;
const USER = process.env.VOXEL_TEST_USER;
const PASS = process.env.VOXEL_TEST_PASSWORD;
const skip = !URL_ || !USER || !PASS ? 'VOXEL_TEST_* non définies' : false;

let c: JmapClient;
let aid: string;
let sieveCap: SieveAccountCapability;

before(async () => {
  if (skip) return;
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  c = new JmapClient({ sessionUrl: URL_!, headers: { Authorization: auth } });
  aid = await c.accountId();
  sieveCap = (await c.accountCapability<SieveAccountCapability>(CAP.sieve, aid))!;
});

/** Ramène le compte à zéro script géré (désactivation puis destruction). */
async function cleanupScripts() {
  const r = await c.call('SieveScript/get', { accountId: aid, ids: null });
  const ours = r.list.filter((s) => s.name === MANAGED_SCRIPT_NAME || s.name?.startsWith('voxel-test-'));
  if (!ours.length) return;
  if (ours.some((s) => s.isActive)) await c.call('SieveScript/set', { accountId: aid, onSuccessDeactivateScript: true });
  await c.call('SieveScript/set', { accountId: aid, destroy: ours.map((s) => s.id) });
}

after(async () => {
  if (skip) return;
  await cleanupScripts().catch(() => undefined);
});

test('session : capacités sieve et quota annoncées', { skip }, () => {
  assert.ok(sieveCap.sieveExtensions.includes('vacation'));
  assert.ok(sieveCap.sieveExtensions.includes('mailboxid'));
  assert.ok((sieveCap.maxSizeScript ?? 0) > 0);
});

test('script géré complet : validé par le serveur, créé, activé, relu, supprimé', { skip }, async () => {
  const mb = await c.call('Mailbox/get', { accountId: aid, ids: null });
  const junk = mb.list.find((m) => m.role === 'junk')!;
  const inbox = mb.list.find((m) => m.role === 'inbox')!;
  const state = {
    blocklist: { addresses: ['voxel-test-block@example.com'], domains: ['voxel-test.example'] },
    // répondeur désactivé : jamais de réponse automatique depuis les tests
    vacation: { enabled: false, subject: 'Absent', text: 'Retour lundi', days: 3, start: '2026-12-20' },
    filters: [
      {
        id: 'f1',
        name: 'Test',
        enabled: true,
        match: 'any' as const,
        conditions: [
          { field: 'subject' as const, op: 'startsWith' as const, value: '[voxel-test]' },
          { field: 'size' as const, op: 'over' as const, value: '5M' },
        ],
        actions: [{ type: 'move' as const, mailboxId: inbox.id }, { type: 'markRead' as const }, { type: 'keyword' as const, keyword: '$voxel-test' }],
      },
    ],
  };
  const script = buildManagedScript(state, {
    extensions: sieveCap.sieveExtensions,
    junkName: junk.name,
    junkId: junk.id,
    mailboxes: { [inbox.id]: inbox.name },
    vacationAddresses: [USER!],
    maxSize: sieveCap.maxSizeScript ?? null,
  });
  // variante avec le répondeur activé : seulement validée, jamais enregistrée
  const withVacation = buildManagedScript({ ...state, vacation: { ...state.vacation, enabled: true, end: '2027-01-03' } }, {
    extensions: sieveCap.sieveExtensions,
    junkName: junk.name,
    junkId: junk.id,
    mailboxes: { [inbox.id]: inbox.name },
    vacationAddresses: [USER!],
  });
  for (const text of [script, withVacation]) {
    const up = await c.upload(aid, new TextEncoder().encode(text), 'application/sieve');
    const v = await c.call('SieveScript/validate', { accountId: aid, blobId: up.blobId });
    assert.equal(v.error, null, `validate : ${JSON.stringify(v.error)}`);
  }
  // un script invalide est refusé
  const bad = await c.upload(aid, new TextEncoder().encode('if nope {'), 'application/sieve');
  const vb = await c.call('SieveScript/validate', { accountId: aid, blobId: bad.blobId });
  assert.ok(vb.error, 'script invalide refusé');

  await cleanupScripts();
  const up = await c.upload(aid, new TextEncoder().encode(script), 'application/sieve');
  const r = await c.call('SieveScript/set', { accountId: aid, create: { voxel: { name: MANAGED_SCRIPT_NAME, blobId: up.blobId } }, onSuccessActivateScript: '#voxel' });
  assert.ok(r.created?.voxel, JSON.stringify(r.notCreated));
  const list = await c.call('SieveScript/get', { accountId: aid, ids: null });
  const ours = list.list.find((s) => s.name === MANAGED_SCRIPT_NAME)!;
  assert.equal(ours.isActive, true);
  const text = await (await c.download(aid, ours.blobId, 'voxel.sieve')).text();
  assert.deepEqual(parseManagedScript(text), { ...state, filters: state.filters.map((f) => ({ ...f })) });

  // mise à jour (liste vide) puis nettoyage
  const up2 = await c.upload(aid, new TextEncoder().encode(buildManagedScript(EMPTY_MANAGED, { extensions: sieveCap.sieveExtensions })), 'application/sieve');
  const r2 = await c.call('SieveScript/set', { accountId: aid, update: { [ours.id]: { blobId: up2.blobId } } });
  assert.ok(r2.updated && ours.id in r2.updated, JSON.stringify(r2.notUpdated));
  // un script actif ne peut pas être détruit
  const r3 = await c.call('SieveScript/set', { accountId: aid, destroy: [ours.id] });
  assert.equal(r3.notDestroyed?.[ours.id]?.type, 'scriptIsActive');
  await cleanupScripts();
  const end = await c.call('SieveScript/get', { accountId: aid, ids: null });
  assert.ok(!end.list.some((s) => s.name === MANAGED_SCRIPT_NAME));
});

test('quota : Quota/get répond (liste éventuellement vide)', { skip }, async () => {
  const r = await c.call('Quota/get', { accountId: aid, ids: null });
  assert.ok(Array.isArray(r.list));
  assert.equal(typeof r.state, 'string');
  const q = pickQuota(r.list);
  if (q) assert.equal(typeof q.used, 'number');
});

test('dossiers : imbriquer, déplacer, abonnement, ordre, vider, supprimer', { skip }, async () => {
  const r = await c.call('Mailbox/set', {
    accountId: aid,
    create: {
      a: { name: 'voxel-test-parent', parentId: null, isSubscribed: true },
      b: { name: 'voxel-test-child', parentId: null, isSubscribed: true },
    },
  });
  const a = r.created?.a?.id as string;
  const b = r.created?.b?.id as string;
  assert.ok(a && b, JSON.stringify(r.notCreated));
  try {
    const u = await c.call('Mailbox/set', { accountId: aid, update: { [b]: { parentId: a, isSubscribed: false, sortOrder: 5 } } });
    assert.ok(u.updated && b in u.updated, JSON.stringify(u.notUpdated));
    const g = await c.call('Mailbox/get', { accountId: aid, ids: [b] });
    assert.equal(g.list[0]!.parentId, a);
    assert.equal(g.list[0]!.isSubscribed, false);
    assert.equal(g.list[0]!.sortOrder, 5, 'sortOrder accepté par le serveur');
    // vider : un message importé puis détruit par lots
    const raw = `From: ${process.env.VOXEL_TEST_USER}\r\nTo: ${process.env.VOXEL_TEST_USER}\r\nSubject: voxel-test vider\r\n\r\nx\r\n`;
    const blob = await c.upload(aid, new TextEncoder().encode(raw), 'message/rfc822');
    const imp = await c.call('Email/import', { accountId: aid, emails: { e: { blobId: blob.blobId, mailboxIds: { [b]: true } } } });
    assert.ok(imp.created?.e, JSON.stringify(imp.notCreated));
    const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: b }, limit: 500 });
    assert.equal(q.ids.length, 1);
    const d = await c.call('Email/set', { accountId: aid, destroy: q.ids });
    assert.deepEqual(d.destroyed, q.ids);
  } finally {
    const del = await c.call('Mailbox/set', { accountId: aid, destroy: [b, a], onDestroyRemoveEmails: true });
    assert.deepEqual([...(del.destroyed ?? [])].sort(), [a, b].sort(), JSON.stringify(del.notDestroyed));
  }
});

test('réglages synchronisés : dossier caché, un seul message, remplacement atomique', { skip }, async () => {
  const name = '.voxel-test';
  const r = await c.call('Mailbox/set', { accountId: aid, create: { h: { name, parentId: null, isSubscribed: false } } });
  const folder = r.created?.h?.id as string;
  assert.ok(folder, JSON.stringify(r.notCreated));
  try {
    const write = async (doc: unknown, old: string[]) => {
      const blob = await c.upload(aid, new TextEncoder().encode(JSON.stringify(doc)), 'application/json');
      const s = await c.call('Email/set', {
        accountId: aid,
        create: {
          n: {
            mailboxIds: { [folder]: true },
            keywords: { $seen: true },
            from: [{ name: null, email: USER! }],
            subject: 'Voxel — réglages',
            bodyValues: { t: { value: 'Ne pas supprimer : réglages du webmail Voxel' } },
            textBody: [{ partId: 't', type: 'text/plain' }],
            attachments: [{ blobId: blob.blobId, type: 'application/json', name: 'settings.json', disposition: 'attachment' }],
          },
        },
        destroy: old,
      });
      assert.ok(s.created?.n, JSON.stringify(s.notCreated));
      return s.created!.n!.id as string;
    };
    const id1 = await write(patchSynced({ version: 1, entries: {} }, { color: 'red' }, '2026-11-03T10:00:00Z'), []);
    const id2 = await write(patchSynced({ version: 1, entries: {} }, { color: 'blue' }, '2026-11-03T11:00:00Z'), [id1]);
    const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: folder } });
    assert.deepEqual(q.ids, [id2]);
    const g = await c.call('Email/get', { accountId: aid, ids: [id2], properties: ['attachments'] });
    const att = g.list[0]!.attachments!.find((x) => x.name === 'settings.json')!;
    const doc = parseSynced(await (await c.download(aid, att.blobId!, 'settings.json')).text());
    assert.equal(doc!.entries.color!.value, 'blue');
  } finally {
    await c.call('Mailbox/set', { accountId: aid, destroy: [folder], onDestroyRemoveEmails: true });
  }
});
