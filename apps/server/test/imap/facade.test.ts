/**
 * Test d'intégration de la façade IMAP/SMTP → JMAP contre le vrai serveur (Stalwart, IMAP 993 / SMTP 465).
 * Lancer depuis la racine du dépôt : npx tsx --test apps/server/test/imap/facade.test.ts
 * Deux boîtes de test du même serveur : VOXEL_TEST_IMAP_HOST, VOXEL_TEST_SENDER et VOXEL_TEST_RECIPIENT ; mots de passe lus
 * dans .env.local (VOXEL_TEST_n=email:motdepasse), jamais affichés.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { BackendAuthError, type ImapConfig, type JmapInvocation, type KvStore, type MailBackend } from '../../src/backend/types.js';
import { createImapBackend } from '../../src/imap/index.js';

// ------------------------------------------------------------------ configuration

const HOST = process.env.VOXEL_TEST_IMAP_HOST ?? '';
const SENDER = process.env.VOXEL_TEST_SENDER ?? '';
const RECIPIENT = process.env.VOXEL_TEST_RECIPIENT ?? '';
const RUN = Math.random().toString(36).slice(2, 8);
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];

function findEnvFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.env.local');
    if (existsSync(p)) return p;
    dir = resolve(dir, '..');
  }
  throw new Error('.env.local introuvable');
}

const creds = new Map<string, string>();
for (const line of readFileSync(findEnvFile(), 'utf8').split(/\r?\n/)) {
  const m = /^VOXEL_TEST_\d+=([^:]+):(.*)$/.exec(line.trim());
  if (m) creds.set(m[1]!.toLowerCase(), m[2]!);
}

if (!process.env.VOXEL_DATA_DIR) process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-facade-'));

function memKv(): KvStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) };
}

function cfgFor(email: string, password = creds.get(email) ?? ''): ImapConfig {
  return {
    email,
    username: email,
    auth: { password },
    imap: { host: HOST, port: 993, secure: true },
    smtp: { host: HOST, port: 465, secure: true },
  };
}

const timings: Record<string, number> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = Math.round(performance.now() - t0);
  }
}

type Calls = Array<[string, Record<string, unknown>, string]>;

async function api(b: MailBackend, calls: Calls): Promise<JmapInvocation[]> {
  const r = await b.api({ using: USING, methodCalls: calls });
  return r.methodResponses;
}

function pick(res: JmapInvocation[], callId: string, name?: string): Record<string, unknown> {
  const r = res.find(([n, , id]) => id === callId && (!name || n === name));
  assert.ok(r, `réponse ${callId} absente : ${JSON.stringify(res).slice(0, 500)}`);
  if (r[0] === 'error' && name !== 'error') assert.fail(`erreur JMAP pour ${callId} : ${JSON.stringify(r[1])}`);
  return r[1];
}

async function one(b: MailBackend, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return pick(await api(b, [[name, { accountId: 'a', ...args }, 'x']]), 'x', name);
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 60_000, every = 1_500): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`délai dépassé : ${label}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// ------------------------------------------------------------------ état partagé

let sender: MailBackend;
let recipient: MailBackend;
const kvSender = memKv();
let roles: Record<string, string> = {};
const seedIds: string[] = [];
let folderB = '';
const cleanup = { senderDestroy: new Set<string>(), recipientTrash: new Set<string>(), folders: new Set<string>() };

before(async () => {
  assert.ok(creds.get(SENDER) && creds.get(RECIPIENT), 'identifiants de test manquants dans .env.local');
  sender = createImapBackend(cfgFor(SENDER), kvSender);
  recipient = createImapBackend(cfgFor(RECIPIENT), memKv());
});

after(async () => {
  // nettoyage : messages et dossiers créés, reçus mis à la corbeille
  try {
    const ids = [...cleanup.senderDestroy];
    if (ids.length) await one(sender, 'Email/set', { destroy: ids });
    for (const id of cleanup.folders) await one(sender, 'Mailbox/set', { destroy: [id], onDestroyRemoveEmails: true });
    if (cleanup.recipientTrash.size) {
      const mb = (await one(recipient, 'Mailbox/get', { ids: null })).list as Array<{ id: string; role: string | null }>;
      const trash = mb.find((m) => m.role === 'trash')!.id;
      const update: Record<string, unknown> = {};
      for (const id of cleanup.recipientTrash) update[id] = { mailboxIds: { [trash]: true } };
      await one(recipient, 'Email/set', { update });
    }
  } finally {
    await sender?.close();
    await recipient?.close();
    console.log(`\n[Voxel test] temps mesurés (ms) : ${JSON.stringify(timings)}`);
  }
});

// ------------------------------------------------------------------ tests

test('session() et verify()', async () => {
  const s = await sender.session();
  assert.equal(s.primaryAccounts['urn:ietf:params:jmap:mail'], 'a');
  assert.ok(s.capabilities['urn:ietf:params:jmap:submission']);
  assert.ok(!s.capabilities['urn:ietf:params:jmap:vacationresponse']);
  await timed('verify', () => sender.verify());
});

test('verify() avec un mauvais mot de passe → BackendAuthError', async () => {
  const bad = createImapBackend(cfgFor(SENDER, `wrong-${RUN}`), memKv());
  try {
    await assert.rejects(() => bad.verify(), (e: unknown) => e instanceof BackendAuthError);
  } finally {
    await bad.close();
  }
});

test('erreurs JMAP standard', async () => {
  const res = await api(sender, [
    ['VacationResponse/get', { accountId: 'a', ids: null }, 'v'],
    ['Email/get', { accountId: 'a', '#ids': { resultOf: 'nope', name: 'Email/query', path: '/ids' } }, 'r'],
    ['Email/changes', { accountId: 'a', sinceState: 'old' }, 'c'],
    ['Email/get', { accountId: 'zz', ids: [] }, 'z'],
  ]);
  assert.equal((pick(res, 'v', 'error') as { type: string }).type, 'unknownMethod');
  assert.equal((pick(res, 'r', 'error') as { type: string }).type, 'invalidResultReference');
  assert.equal((pick(res, 'c', 'error') as { type: string }).type, 'cannotCalculateChanges');
  assert.equal((pick(res, 'z', 'error') as { type: string }).type, 'accountNotFound');
  // état inchangé → changements vides
  const st = (await one(sender, 'Email/get', { ids: [] })).state as string;
  const ch = await one(sender, 'Email/changes', { sinceState: st });
  assert.deepEqual(ch.created, []);
});

test('Mailbox/get (rôles) et Mailbox/set create → rename → destroy', async () => {
  const r = await timed('Mailbox/get', () => one(sender, 'Mailbox/get', { ids: null }));
  const list = r.list as Array<{ id: string; name: string; role: string | null; totalEmails: number }>;
  for (const m of list) if (m.role) roles[m.role] = m.id;
  for (const role of ['inbox', 'sent', 'drafts', 'trash', 'junk']) assert.ok(roles[role], `rôle ${role} absent`);
  assert.equal(list.filter((m) => m.role === 'inbox').length, 1);

  const name = '[Voxel test] dossier';
  const c = await one(sender, 'Mailbox/set', { create: { n: { name, parentId: null, isSubscribed: true } } });
  const id = (c.created as Record<string, { id: string }>).n!.id;
  assert.ok(id);
  cleanup.folders.add(id);
  const u = await one(sender, 'Mailbox/set', { update: { [id]: { name: `${name} renommé` } } });
  assert.ok(u.updated && id in (u.updated as object), JSON.stringify(u.notUpdated));
  const g = await one(sender, 'Mailbox/get', { ids: [id] });
  assert.equal((g.list as Array<{ name: string }>)[0]?.name, `${name} renommé`);
  const d = await one(sender, 'Mailbox/set', { destroy: [id] });
  assert.deepEqual(d.destroyed, [id]);
  cleanup.folders.delete(id);
  const g2 = await one(sender, 'Mailbox/get', { ids: [id] });
  assert.deepEqual(g2.notFound, [id]);

  // dossier de travail pour les déplacements
  const b = await one(sender, 'Mailbox/set', { create: { b: { name: `[Voxel test] B ${RUN}`, parentId: null } } });
  folderB = (b.created as Record<string, { id: string }>).b!.id;
  cleanup.folders.add(folderB);
});

const ATTACH = Buffer.from(`[Voxel test] pièce jointe ${RUN}\n`.repeat(20), 'utf8');

test('dépôt de messages de test (Email/set create dans INBOX)', async () => {
  const up = await sender.upload('a', new Blob([ATTACH]).stream() as ReadableStream<Uint8Array>, 'text/plain');
  const base = Date.now() - 3 * 60_000;
  const mk = (n: number, extra: Record<string, unknown> = {}) => ({
    mailboxIds: { [roles.inbox!]: true },
    keywords: n === 2 ? {} : { $seen: true },
    from: [{ name: `Seed ${n}`, email: `seed${n}.${RUN}@example.test` }],
    to: [{ name: null, email: SENDER }],
    subject: `[Voxel test] seed ${n} ${RUN}`,
    receivedAt: new Date(base + n * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    bodyValues: { t: { value: `Texte du message ${n} ${RUN}` }, h: { value: `<p>HTML du <b>message ${n}</b> ${RUN}</p>` } },
    textBody: [{ partId: 't', type: 'text/plain' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
    ...extra,
  });
  const r = await one(sender, 'Email/set', {
    create: {
      s1: mk(1),
      s2: mk(2),
      s3: mk(3, { attachments: [{ blobId: up.blobId, name: `note-${RUN}.txt`, type: 'text/plain', disposition: 'attachment' }] }),
    },
  });
  const created = r.created as Record<string, { id: string; threadId: string }>;
  assert.ok(created?.s1 && created.s2 && created.s3, JSON.stringify(r.notCreated));
  seedIds.push(created.s1.id, created.s2.id, created.s3.id);
  seedIds.forEach((id) => cleanup.senderDestroy.add(id));
});

test('Email/query + Email/get + Thread/get chaînés (tri, pagination, filtres)', async () => {
  // le lot exact du front (fetchThreadPage)
  const page = (position: number, limit: number) =>
    api(sender, [
      ['Email/query', { accountId: 'a', filter: { inMailbox: roles.inbox }, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position, limit, calculateTotal: true }, 'q'],
      ['Email/get', { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'from', 'to', 'cc', 'subject', 'sentAt', 'hasAttachment', 'preview'] }, 'g'],
      ['Thread/get', { accountId: 'a', '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Email/get', { accountId: 'a', '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt'] }, 'm'],
    ]);
  // mesures réalistes : nouvelle instance (aucun cache), comme un front qui ouvre la boîte
  {
    const fresh = createImapBackend(cfgFor(SENDER), kvSender);
    try {
      await timed('Mailbox/get (nouvelle connexion)', () => one(fresh, 'Mailbox/get', { ids: null }));
      const frontPage = (b: MailBackend) =>
        api(b, [
          ['Email/query', { accountId: 'a', filter: { inMailbox: roles.inbox }, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position: 0, limit: 50, calculateTotal: true }, 'q'],
          ['Email/get', { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'from', 'to', 'cc', 'subject', 'sentAt', 'hasAttachment', 'preview'] }, 'g'],
          ['Thread/get', { accountId: 'a', '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
          ['Email/get', { accountId: 'a', '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt'] }, 'm'],
        ]);
      const fp = await timed('liste première page INBOX (50, sans cache)', () => frontPage(fresh));
      const n = (pick(fp, 'q', 'Email/query') as { ids: string[] }).ids.length;
      timings['liste première page : nombre de fils'] = n;
      const head = (pick(fp, 'g', 'Email/get') as { list: Array<{ id: string; threadId: string }> }).list.find((e) => e.id === seedIds[2])!;
      await timed('ouverture d’un mail (Thread/get + Email/get complet, sans cache)', () =>
        api(fresh, [
          ['Thread/get', { accountId: 'a', ids: [head.threadId] }, 't'],
          ['Email/get', { accountId: 'a', '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'subject', 'from', 'to', 'bodyValues', 'textBody', 'htmlBody', 'attachments', 'messageId', 'references', 'header:List-Unsubscribe:asURLs'], fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1_500_000 }, 'g'],
        ]),
      );
      // Sent et autres dossiers : liste « Envoyés »
      await timed('liste Envoyés (50, sans cache)', () =>
        api(fresh, [['Email/query', { accountId: 'a', filter: { inMailbox: roles.sent }, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, limit: 50, calculateTotal: true }, 'q'], ['Email/get', { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'preview', 'threadId'] }, 'g']]),
      );
    } finally {
      await fresh.close();
    }
  }
  const p1 = await timed('liste première page (2, instance déjà utilisée)', () => page(0, 2));
  await timed('liste première page (2, cache chaud)', () => page(0, 2));
  const q1 = pick(p1, 'q', 'Email/query') as { ids: string[]; total: number };
  const g1 = pick(p1, 'g', 'Email/get') as { list: Array<{ id: string; receivedAt: string; threadId: string; preview: string; subject: string }> };
  const t1 = pick(p1, 't', 'Thread/get') as { list: Array<{ id: string; emailIds: string[] }> };
  const m1 = pick(p1, 'm', 'Email/get') as { list: Array<{ id: string }> };
  assert.equal(q1.ids.length, 2);
  assert.ok(q1.total >= 3);
  assert.equal(g1.list.length, 2);
  assert.ok(g1.list[0]!.receivedAt >= g1.list[1]!.receivedAt, 'tri receivedAt desc');
  assert.equal(t1.list.length, 2);
  for (const t of t1.list) assert.ok(t.emailIds.length >= 1);
  assert.ok(m1.list.length >= 2);
  // les seeds sont les plus récents : seed 3 en tête, aperçu présent
  assert.equal(g1.list[0]!.id, seedIds[2]);
  assert.match(g1.list[0]!.preview, new RegExp(`message 3 ${RUN}`));
  const p2 = await page(2, 2);
  const q2 = pick(p2, 'q', 'Email/query') as { ids: string[]; position: number };
  assert.equal(q2.position, 2);
  assert.ok(q2.ids.every((id) => !q1.ids.includes(id)), 'pages disjointes');
  const g2 = pick(p2, 'g', 'Email/get') as { list: Array<{ receivedAt: string }> };
  if (g2.list[0]) assert.ok(g1.list[1]!.receivedAt >= g2.list[0].receivedAt);

  // filtres (l'index plein texte du serveur peut être légèrement en retard : on réessaie)
  const q = async (filter: unknown) => (await one(sender, 'Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], calculateTotal: true })).ids as string[];
  const byText = await waitFor('filtre text', async () => {
    const ids = await q({ operator: 'AND', conditions: [{ inMailboxOtherThan: [roles.trash, roles.junk] }, { text: RUN }] });
    return ids.length >= 3 ? ids : null;
  }, 30_000);
  assert.deepEqual([...byText].sort(), [...seedIds].sort());
  const byFrom = await waitFor('filtre from', async () => {
    const ids = await q({ from: `seed1.${RUN}@example.test` });
    return ids.length ? ids : null;
  }, 30_000);
  assert.deepEqual(byFrom, [seedIds[0]]);
  const unread = await q({ operator: 'AND', conditions: [{ inMailbox: roles.inbox }, { notKeyword: '$seen' }, { text: RUN }] });
  assert.deepEqual(unread, [seedIds[1]]);
  const ored = await q({ operator: 'AND', conditions: [{ inMailbox: roles.inbox }, { operator: 'OR', conditions: [{ from: `seed1.${RUN}@example.test` }, { from: `seed2.${RUN}@example.test` }] }] });
  assert.deepEqual([...ored].sort(), [seedIds[0], seedIds[1]].sort());
  const notted = await q({ operator: 'AND', conditions: [{ inMailbox: roles.inbox }, { text: RUN }, { operator: 'NOT', conditions: [{ hasKeyword: '$seen' }] }] });
  assert.deepEqual(notted, [seedIds[1]]);
});

test('Email/get renvoie toujours id, même absent de properties (RFC 8620 §5.1)', async () => {
  const r = (await one(sender, 'Email/get', { ids: [seedIds[0]], properties: ['subject', 'mailboxIds'] })) as { list: Array<{ id?: string; subject?: string }> };
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].id, seedIds[0]);
  assert.ok(typeof r.list[0].subject === 'string');
});

test('Email/get : bodyValues HTML et texte, pièces jointes, download', async () => {
  const props = ['id', 'threadId', 'subject', 'from', 'messageId', 'bodyValues', 'textBody', 'htmlBody', 'attachments', 'hasAttachment', 'header:List-Unsubscribe:asURLs', 'bodyStructure'];
  const res = await timed('ouverture d’un mail (Thread/get + Email/get complet)', () =>
    api(sender, [
      ['Email/get', { accountId: 'a', ids: [seedIds[2]], properties: ['threadId'] }, 'h'],
      ['Thread/get', { accountId: 'a', '#ids': { resultOf: 'h', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Email/get', { accountId: 'a', '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: props, fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1_500_000 }, 'g'],
    ]),
  );
  const e = (pick(res, 'g', 'Email/get') as { list: Array<Record<string, any>> }).list.find((x) => x.id === seedIds[2])!;
  assert.ok(e, 'message 3 trouvé via Thread/get');
  assert.equal(e.subject, `[Voxel test] seed 3 ${RUN}`);
  assert.equal(e.hasAttachment, true);
  const html = e.htmlBody.find((p: any) => p.type === 'text/html');
  const text = e.textBody.find((p: any) => p.type === 'text/plain');
  assert.ok(html && text, 'parties texte et HTML');
  assert.match(e.bodyValues[html.partId].value, new RegExp(`<b>message 3</b> ${RUN}`));
  assert.match(e.bodyValues[text.partId].value, new RegExp(`Texte du message 3 ${RUN}`));
  assert.equal(e.attachments.length, 1);
  assert.equal(e.attachments[0].name, `note-${RUN}.txt`);
  assert.equal(e['header:List-Unsubscribe:asURLs'], null);
  assert.equal(e.bodyStructure.type, 'multipart/mixed');
  const dl = await sender.download('a', e.attachments[0].blobId, 'note.txt');
  const buf = Buffer.from(await new Response(dl.body).arrayBuffer());
  assert.ok(buf.equals(ATTACH), 'pièce jointe identique');
  // troncature
  const tr = await one(sender, 'Email/get', { ids: [seedIds[2]], properties: ['bodyValues'], fetchHTMLBodyValues: true, maxBodyValueBytes: 10 });
  const bv = Object.values((tr.list as Array<{ bodyValues: Record<string, { value: string; isTruncated: boolean }> }>)[0]!.bodyValues)[0]!;
  assert.equal(bv.isTruncated, true);
  // source complète
  const src = await sender.download('a', seedIds[2]!, 'msg.eml');
  const raw = Buffer.from(await new Response(src.body).arrayBuffer()).toString('utf8');
  assert.match(raw, /Subject: \[Voxel test\] seed 3/);
});

test('Email/set : mots-clés, déplacement aller-retour, destroy', async () => {
  const id = seedIds[0]!;
  const kw = async (eid: string) => ((await one(sender, 'Email/get', { ids: [eid], properties: ['keywords', 'mailboxIds'] })).list as Array<{ keywords: Record<string, boolean>; mailboxIds: Record<string, boolean> }>)[0]!;
  let r = await one(sender, 'Email/set', { update: { [id]: { 'keywords/$seen': null, 'keywords/$flagged': true } } });
  assert.ok(r.updated && id in (r.updated as object), JSON.stringify(r.notUpdated));
  let k = await kw(id);
  assert.equal(k.keywords.$seen, undefined);
  assert.equal(k.keywords.$flagged, true);
  r = await one(sender, 'Email/set', { update: { [id]: { 'keywords/$seen': true, 'keywords/$flagged': null } } });
  k = await kw(id);
  assert.equal(k.keywords.$seen, true);
  assert.equal(k.keywords.$flagged, undefined);

  // aller : INBOX → B (patch du front)
  r = await one(sender, 'Email/set', { update: { [id]: { [`mailboxIds/${roles.inbox}`]: null, [`mailboxIds/${folderB}`]: true } } });
  assert.ok(r.updated && id in (r.updated as object), JSON.stringify(r.notUpdated));
  const inB = (await one(sender, 'Email/query', { filter: { inMailbox: folderB } })).ids as string[];
  assert.equal(inB.length, 1);
  const moved = await kw(id); // l'ancien id suit le message (alias)
  assert.deepEqual(moved.mailboxIds, { [folderB]: true });
  // retour : remplacement complet de mailboxIds (annulation du front) avec l'ancien id
  r = await one(sender, 'Email/set', { update: { [id]: { mailboxIds: { [roles.inbox!]: true } } } });
  assert.ok(r.updated && id in (r.updated as object), JSON.stringify(r.notUpdated));
  assert.equal(((await one(sender, 'Email/query', { filter: { inMailbox: folderB } })).ids as string[]).length, 0);
  const back = (await one(sender, 'Email/get', { ids: [id], properties: ['id', 'mailboxIds', 'subject'] })).list as Array<{ id: string; mailboxIds: Record<string, boolean>; subject: string }>;
  assert.deepEqual(back[0]!.mailboxIds, { [roles.inbox!]: true });
  assert.equal(back[0]!.subject, `[Voxel test] seed 1 ${RUN}`);
  cleanup.senderDestroy.delete(id);
  cleanup.senderDestroy.add(back[0]!.id);
  seedIds[0] = back[0]!.id;

  // destroy
  const d = await one(sender, 'Email/set', { destroy: [seedIds[1]] });
  assert.deepEqual(d.destroyed, [seedIds[1]]);
  cleanup.senderDestroy.delete(seedIds[1]!);
  const g = await one(sender, 'Email/get', { ids: [seedIds[1]], properties: ['id'] });
  assert.deepEqual(g.notFound, [seedIds[1]]);
});

test('Identity/get puis Identity/set d’une signature', async () => {
  const g = await one(sender, 'Identity/get', { ids: null });
  const list = g.list as Array<{ id: string; email: string; textSignature: string; htmlSignature: string; mayDelete: boolean }>;
  assert.ok(list.length >= 1);
  const def = list.find((i) => i.email === SENDER)!;
  assert.ok(def);
  const initial = { textSignature: def.textSignature, htmlSignature: def.htmlSignature };
  const sig = { textSignature: `[Voxel test] signature ${RUN}`, htmlSignature: `<p>[Voxel test] signature <b>${RUN}</b></p>` };
  const u = await one(sender, 'Identity/set', { update: { [def.id]: sig } });
  assert.ok(u.updated && def.id in (u.updated as object));
  const g2 = await one(sender, 'Identity/get', { ids: [def.id] });
  const after = (g2.list as Array<typeof def>)[0]!;
  assert.equal(after.textSignature, sig.textSignature);
  assert.equal(after.htmlSignature, sig.htmlSignature);
  // une nouvelle instance (même KvStore) relit la même signature
  const again = createImapBackend(cfgFor(SENDER), kvSender);
  const g3 = await one(again, 'Identity/get', { ids: [def.id] });
  assert.equal((g3.list as Array<typeof def>)[0]!.textSignature, sig.textSignature);
  await again.close();
  await one(sender, 'Identity/set', { update: { [def.id]: initial } });
  const g4 = await one(sender, 'Identity/get', { ids: [def.id] });
  assert.equal((g4.list as Array<typeof def>)[0]!.textSignature, initial.textSignature);
  const del = await one(sender, 'Identity/set', { destroy: [def.id] });
  assert.equal((del.notDestroyed as Record<string, { type: string }>)[def.id]!.type, 'forbidden');
});

test('upload → brouillon avec PJ → EmailSubmission/set → réception chez recipient + copie dans Envoyés', async () => {
  const content = Buffer.from(`[Voxel test] PJ envoyée ${RUN} ${'x'.repeat(300)}`, 'utf8');
  const up = await sender.upload('a', new Blob([content]).stream() as ReadableStream<Uint8Array>, 'text/plain');
  assert.equal(up.size, content.length);
  const identity = ((await one(sender, 'Identity/get', { ids: null })).list as Array<{ id: string; email: string }>).find((i) => i.email === SENDER)!;
  const subject = `[Voxel test] facade IMAP ${RUN}`;
  const drafts = roles.drafts!;
  const sent = roles.sent!;
  const email = {
    mailboxIds: { [drafts]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: 'Sender', email: SENDER }],
    to: [{ name: 'Recipient', email: RECIPIENT }],
    subject,
    bodyValues: { text: { value: `Bonjour, test de la façade IMAP ${RUN}.` }, html: { value: `<p>Bonjour, test de la <b>façade IMAP</b> ${RUN}.</p>` } },
    textBody: [{ partId: 'text', type: 'text/plain' }],
    htmlBody: [{ partId: 'html', type: 'text/html' }],
    attachments: [{ blobId: up.blobId, name: `envoi-${RUN}.txt`, type: 'text/plain', size: up.size, disposition: 'attachment' }],
  };
  // même forme que le front (send.ts) : Email/set create + EmailSubmission/set + onSuccessUpdateEmail
  const res = await timed('envoi (APPEND brouillon + SMTP + déplacement)', () =>
    api(sender, [
      ['Email/set', { accountId: 'a', create: { msg: email } }, 'o0'],
      [
        'EmailSubmission/set',
        {
          accountId: 'a',
          create: { sub: { identityId: identity.id, emailId: '#msg', envelope: { mailFrom: { email: SENDER, parameters: null }, rcptTo: [{ email: RECIPIENT }] } } },
          onSuccessUpdateEmail: { '#sub': { 'keywords/$draft': null, [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true } },
        },
        'o1',
      ],
    ]),
  );
  const setRes = pick(res, 'o0', 'Email/set') as { created: Record<string, { id: string }> };
  const draftId = setRes.created.msg!.id;
  const subRes = pick(res, 'o1', 'EmailSubmission/set') as { created: Record<string, { id: string }>; notCreated: unknown };
  assert.ok(subRes.created?.sub?.id, JSON.stringify(subRes.notCreated));
  const implicit = res.filter(([n, , id]) => n === 'Email/set' && id === 'o1');
  assert.equal(implicit.length, 1, 'Email/set implicite présent');
  assert.ok((implicit[0]![1] as { updated: Record<string, unknown> }).updated?.[draftId] === null);

  // brouillon retiré des Brouillons, copie dans Envoyés (sans $draft)
  const inDrafts = (await one(sender, 'Email/query', { filter: { inMailbox: drafts } })).ids as string[];
  assert.ok(!inDrafts.includes(draftId));
  const sentCopy = (await one(sender, 'Email/get', { ids: [draftId], properties: ['id', 'mailboxIds', 'keywords', 'subject'] })).list as Array<{ id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean>; subject: string }>;
  assert.deepEqual(sentCopy[0]!.mailboxIds, { [sent]: true });
  assert.equal(sentCopy[0]!.keywords.$draft, undefined);
  assert.equal(sentCopy[0]!.subject, subject);
  cleanup.senderDestroy.add(sentCopy[0]!.id);

  // réception chez recipient (via la façade sur sa boîte)
  const t0 = Date.now();
  const yRoles = Object.fromEntries(((await one(recipient, 'Mailbox/get', { ids: null })).list as Array<{ id: string; role: string | null }>).filter((m) => m.role).map((m) => [m.role, m.id]));
  const received = await waitFor('réception chez recipient', async () => {
    const r = await api(recipient, [
      ['Email/query', { accountId: 'a', filter: { inMailbox: yRoles.inbox }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 15 }, 'q'],
      ['Email/get', { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'attachments', 'from'] }, 'g'],
    ]);
    const list = (pick(r, 'g', 'Email/get') as { list: Array<{ id: string; subject: string; attachments: Array<{ blobId: string; name: string }> }> }).list;
    return list.find((e) => e.subject === subject);
  }, 90_000, 2_000);
  timings['délai de réception chez recipient'] = Date.now() - t0;
  cleanup.recipientTrash.add(received.id);
  assert.equal(received.attachments.length, 1);
  assert.equal(received.attachments[0]!.name, `envoi-${RUN}.txt`);
  const dl = await recipient.download('a', received.attachments[0]!.blobId, 'x.txt');
  const got = Buffer.from(await new Response(dl.body).arrayBuffer());
  assert.ok(got.equals(content), 'pièce jointe reçue identique');
});

test('events() : un StateChange arrive quand un mail est déposé dans INBOX', async () => {
  const ac = new AbortController();
  const it = sender.events(['*'], ac.signal)[Symbol.asyncIterator]();
  // laisse le temps à la connexion IDLE et à l'état de référence
  await new Promise((r) => setTimeout(r, 3_000));
  // dépôt par une autre instance (comme un autre client) → détecté par IDLE
  const other = createImapBackend(cfgFor(SENDER), memKv());
  const otherRoles = Object.fromEntries(((await one(other, 'Mailbox/get', { ids: null })).list as Array<{ id: string; role: string | null }>).filter((m) => m.role).map((m) => [m.role, m.id]));
  const t0 = Date.now();
  const c = await one(other, 'Email/set', {
    create: {
      e: {
        mailboxIds: { [otherRoles.inbox]: true },
        from: [{ name: 'Push', email: `push.${RUN}@example.test` }],
        subject: `[Voxel test] push ${RUN}`,
        bodyValues: { t: { value: 'push' } },
        textBody: [{ partId: 't', type: 'text/plain' }],
      },
    },
  });
  const createdId = (c.created as Record<string, { id: string }>).e!.id;
  await other.close();
  try {
    const ev = await Promise.race([
      (async () => {
        for (;;) {
          const n = await it.next();
          if (n.done) return null;
          if (n.value.type === 'state') return n.value;
        }
      })(),
      new Promise<null>((r) => setTimeout(() => r(null), 30_000).unref()),
    ]);
    assert.ok(ev, 'StateChange reçu');
    const changed = (ev!.data as { changed: Record<string, Record<string, string>> }).changed.a!;
    assert.ok(changed.Email, JSON.stringify(ev));
    timings['délai push (APPEND externe → StateChange)'] = Date.now() - t0;
  } finally {
    ac.abort();
    await it.return?.();
    // l'id de l'autre instance désigne le même message (même dossier/UID) mais l'id de dossier dépend du KvStore
    const r = await api(sender, [['Email/query', { accountId: 'a', filter: { inMailbox: roles.inbox }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 10 }, 'q'], ['Email/get', { accountId: 'a', '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, 'g']]);
    const own = (pick(r, 'g', 'Email/get').list as Array<{ id: string; subject: string }>).filter((e) => e.subject === `[Voxel test] push ${RUN}`).map((e) => e.id);
    own.forEach((id) => cleanup.senderDestroy.add(id));
    void createdId;
  }
});

test('Email/changes : journal des créations / mots-clés / suppressions faites par un autre client', async () => {
  // Abonné au push (comme le front) : le journal suit les relevés IDLE / périodiques.
  const ac = new AbortController();
  const it = sender.events(['*'], ac.signal)[Symbol.asyncIterator]();
  const drain = (async () => {
    for (;;) {
      const n = await it.next();
      if (n.done) return;
    }
  })();
  await new Promise((r) => setTimeout(r, 3_000));
  // autre client sur la même boîte (même KvStore ⇒ mêmes ids de dossier, comme deux sessions du serveur)
  const other = createImapBackend(cfgFor(SENDER), kvSender);
  const changesSince = async (since: string, want: (c: { created: string[]; updated: string[]; destroyed: string[]; newState: string }) => boolean, label: string) =>
    waitFor(label, async () => {
      const res = await api(sender, [['Email/changes', { accountId: 'a', sinceState: since, maxChanges: 500 }, 'c']]);
      const [name, body] = res[0]!;
      assert.notEqual(name, 'error', `${label} : ${JSON.stringify(body)}`);
      const c = body as { created: string[]; updated: string[]; destroyed: string[]; newState: string };
      return want(c) ? c : null;
    }, 45_000, 2_000);
  try {
    const s0 = (await one(sender, 'Email/get', { ids: [] })).state as string;
    const t0 = Date.now();
    const cr = await one(other, 'Email/set', {
      create: {
        e: {
          mailboxIds: { [roles.inbox!]: true },
          from: [{ name: 'Journal', email: `journal.${RUN}@example.test` }],
          subject: `[Voxel test] journal ${RUN}`,
          bodyValues: { t: { value: 'journal' } },
          textBody: [{ partId: 't', type: 'text/plain' }],
        },
      },
    });
    const id = (cr.created as Record<string, { id: string }>).e!.id;
    cleanup.senderDestroy.add(id);
    const c1 = await changesSince(s0, (c) => c.created.includes(id), 'création visible dans Email/changes');
    timings['journal : APPEND externe → Email/changes.created'] = Date.now() - t0;
    assert.ok(!c1.updated.includes(id) && !c1.destroyed.includes(id), JSON.stringify(c1));
    // ce que ferait useSync.ts : Email/get des créés → en Réception et non lu ⇒ notification
    const g = (await one(sender, 'Email/get', { ids: c1.created, properties: ['id', 'mailboxIds', 'keywords', 'subject'] })).list as Array<{ id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }>;
    const mine = g.find((e) => e.id === id);
    assert.ok(mine && mine.mailboxIds[roles.inbox!] && !mine.keywords.$seen, JSON.stringify(g));

    const s1 = c1.newState;
    await one(other, 'Email/set', { update: { [id]: { 'keywords/$seen': true } } });
    const c2 = await changesSince(s1, (c) => c.updated.includes(id), 'mot-clé visible dans Email/changes.updated');
    assert.ok(!c2.created.includes(id) && !c2.destroyed.includes(id), JSON.stringify(c2));

    const s2 = c2.newState;
    await one(other, 'Email/set', { destroy: [id] });
    cleanup.senderDestroy.delete(id);
    const c3 = await changesSince(s2, (c) => c.destroyed.includes(id), 'suppression visible dans Email/changes.destroyed');
    assert.ok(!c3.created.includes(id), JSON.stringify(c3));

    // fenêtre complète : créé puis détruit ⇒ n'apparaît nulle part
    const all = await changesSince(s0, () => true, 'fusion depuis s0');
    assert.ok(!all.created.includes(id) && !all.updated.includes(id) && !all.destroyed.includes(id), JSON.stringify(all));

    // après « redémarrage » (nouvelle instance, journal vide) : cannotCalculateChanges
    const fresh = createImapBackend(cfgFor(SENDER), kvSender);
    try {
      const r = await api(fresh, [['Email/changes', { accountId: 'a', sinceState: s1 }, 'c']]);
      assert.equal(r[0]![0], 'error');
      assert.equal((r[0]![1] as { type: string }).type, 'cannotCalculateChanges');
    } finally {
      await fresh.close();
    }
  } finally {
    ac.abort();
    await it.return?.();
    await drain.catch(() => undefined);
    await other.close();
  }
});

test('méthodes annexes : Core/echo, Mailbox/query, SearchSnippet/get, Email/queryChanges, Identity create/destroy, EmailSubmission/get', async () => {
  const echo = await api(sender, [['Core/echo', { hello: RUN }, 'e']]);
  assert.deepEqual(pick(echo, 'e', 'Core/echo'), { hello: RUN });
  const mq = await one(sender, 'Mailbox/query', { filter: { role: 'inbox' } });
  assert.deepEqual(mq.ids, [roles.inbox]);
  const sn = await one(sender, 'SearchSnippet/get', { filter: { text: RUN }, emailIds: [seedIds[2]] });
  assert.match(String((sn.list as Array<{ preview: string }>)[0]!.preview), new RegExp(RUN));
  const q = await one(sender, 'Email/query', { filter: { inMailbox: roles.inbox }, limit: 5 });
  const qc = await one(sender, 'Email/queryChanges', { filter: { inMailbox: roles.inbox }, sinceQueryState: q.queryState });
  assert.deepEqual(qc.added, []);
  const c = await one(sender, 'Identity/set', { create: { n: { name: 'Voxel test', email: SENDER, textSignature: `[Voxel test] ${RUN}` } } });
  const nid = (c.created as Record<string, { id: string }>).n!.id;
  const d = await one(sender, 'Identity/set', { destroy: [nid] });
  assert.deepEqual(d.destroyed, [nid]);
  const sg = await one(sender, 'EmailSubmission/get', { ids: ['nope'] });
  assert.deepEqual(sg.notFound, ['nope']);
  // blob inconnu, partie invalide
  await assert.rejects(() => sender.download('a', `${seedIds[2]}.../etc`, 'x'));
});
