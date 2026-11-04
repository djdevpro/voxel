/**
 * Tests d'intégration du lot C contre la boîte de test dédiée (JMAP, Stalwart), ignorés sans
 * VOXEL_TEST_JMAP_URL / VOXEL_TEST_USER / VOXEL_TEST_PASSWORD. Lancer depuis la racine :
 *   node --env-file=.env.test.local --test packages/jmap/test/integration-c.test.ts
 * Tout reste dans la boîte de test : dossier `voxel-test-c-*` supprimé avec ses messages, accusé de lecture
 * envoyé à la boîte elle-même puis supprimé, abonnement push de test (URL de notre domaine) détruit.
 * Le mot de passe n'est jamais affiché.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  binaryToBytes,
  buildEmail,
  buildMdn,
  bytesToBinary,
  CAP,
  JmapClient,
  mboxEntry,
  priorityHeaders,
  priorityOf,
  PRIORITY_PROPERTIES,
  splitMbox,
  type WebPushVapidCapability,
} from '../src/index.ts';

const URL_ = process.env.VOXEL_TEST_JMAP_URL;
const USER = process.env.VOXEL_TEST_USER;
const PASS = process.env.VOXEL_TEST_PASSWORD;
const skip = !URL_ || !USER || !PASS ? 'VOXEL_TEST_* non définies' : false;
const RUN = Math.random().toString(36).slice(2, 8);
// adresse sans service push (le serveur JMAP lui-même) : l'abonnement est créé puis supprimé, jamais vérifié
const PUSH_URL = `${new URL(process.env.VOXEL_TEST_JMAP_URL ?? 'https://mail.example.com').origin}/__push-test`;

let c: JmapClient;
let aid: string;
let folderId: string | null = null;
let inboxId: string;
const extraEmails: string[] = [];

before(async () => {
  if (skip) return;
  const auth = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
  c = new JmapClient({ sessionUrl: URL_!, headers: { Authorization: auth } });
  aid = await c.accountId();
  const mb = await c.call('Mailbox/get', { accountId: aid, ids: null, properties: ['id', 'name', 'role'] });
  inboxId = mb.list.find((m) => m.role === 'inbox')!.id;
  const r = await c.call('Mailbox/set', { accountId: aid, create: { f: { name: `voxel-test-c-${RUN}`, parentId: null } } });
  folderId = (r.created?.f?.id as string) ?? null;
  assert.ok(folderId, 'dossier de test');
});

after(async () => {
  if (skip) return;
  if (extraEmails.length) await c.call('Email/set', { accountId: aid, destroy: extraEmails }).catch(() => undefined);
  if (folderId) await c.call('Mailbox/set', { accountId: aid, destroy: [folderId], onDestroyRemoveEmails: true }).catch(() => undefined);
  // aucun abonnement push de test ne doit rester
  const subs = await c.call('PushSubscription/get', { ids: null }).catch(() => null);
  const ours = subs?.list.filter((s) => s.deviceClientId.startsWith('voxel-test-')).map((s) => s.id) ?? [];
  if (ours.length) await c.call('PushSubscription/set', { destroy: ours }).catch(() => undefined);
});

async function upload(raw: string): Promise<string> {
  return (await c.upload(aid, new Blob([binaryToBytes(raw)], { type: 'message/rfc822' }), 'message/rfc822')).blobId;
}

function sampleEml(subject: string, extra: Record<string, string> = {}): string {
  const head = Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return `From: Test <${USER}>\r\nTo: ${USER}\r\nSubject: ${subject}\r\nDate: Tue, 03 Nov 2026 10:00:00 +0000\r\nMessage-ID: <${subject}@voxel-test>\r\n${head}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nBonjour \xc3\xa9t\xc3\xa9\r\nFrom the start\r\n`;
}

test('Web Push : clé VAPID annoncée, PushSubscription/set|get|destroy, code de vérification contrôlé', { skip }, async () => {
  const session = await c.getSession();
  const cap = session.capabilities[CAP.webpush] as WebPushVapidCapability | undefined;
  assert.ok(cap?.applicationServerKey && /^[A-Za-z0-9_-]{80,}$/.test(cap.applicationServerKey));
  const r = await c.call('PushSubscription/set', {
    create: { p: { deviceClientId: `voxel-test-${RUN}`, url: PUSH_URL, types: ['EmailDelivery'] } },
  });
  const id = r.created?.p?.id;
  assert.ok(id, JSON.stringify(r.notCreated));
  assert.ok(r.created?.p?.expires);
  const g = await c.call('PushSubscription/get', { ids: [id] });
  assert.equal(g.list[0]?.deviceClientId, `voxel-test-${RUN}`);
  assert.deepEqual(g.list[0]?.types, ['EmailDelivery']);
  assert.equal(g.list[0]?.verificationCode, null);
  // l'URL de test répond 404 : le code envoyé ne nous parvient pas ; un code faux est refusé
  const u = await c.call('PushSubscription/set', { update: { [id]: { verificationCode: 'faux' } } });
  assert.equal(u.notUpdated?.[id]?.type, 'invalidProperties');
  // prolongation de l'expiration (renouvellement côté appli)
  const exp = new Date(Date.now() + 3 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const u2 = await c.call('PushSubscription/set', { update: { [id]: { expires: exp } } });
  assert.ok(u2.updated && id in u2.updated, JSON.stringify(u2.notUpdated));
  const d = await c.call('PushSubscription/set', { destroy: [id] });
  assert.deepEqual(d.destroyed, [id]);
  const g2 = await c.call('PushSubscription/get', { ids: null });
  assert.ok(!g2.list.some((s) => s.id === id));
});

test('Email/import d’un .eml (priorité, accusé demandé), export brut puis mbox réimporté', { skip }, async () => {
  const raw = sampleEml(`voxel-c-${RUN}-1`, { ...priorityHeaders('high'), 'Disposition-Notification-To': USER! });
  const blobId = await upload(raw);
  const r = await c.call('Email/import', {
    accountId: aid,
    emails: { i: { blobId, mailboxIds: { [folderId!]: true }, keywords: { $seen: true }, receivedAt: '2026-11-03T10:00:00Z' } },
  });
  const created = r.created?.i;
  assert.ok(created?.id, JSON.stringify(r.notCreated));
  const g = await c.call('Email/get', {
    accountId: aid,
    ids: [created.id!],
    properties: ['id', 'blobId', 'subject', 'receivedAt', 'keywords', 'header:Disposition-Notification-To:asAddresses', ...PRIORITY_PROPERTIES],
  });
  const e = g.list[0]!;
  assert.equal(e.subject, `voxel-c-${RUN}-1`);
  assert.equal(e.receivedAt, '2026-11-03T10:00:00Z');
  assert.equal(e.keywords.$seen, true);
  assert.equal(priorityOf(e as unknown as Record<string, unknown>), 'high');
  assert.deepEqual(e['header:Disposition-Notification-To:asAddresses'], [{ name: null, email: USER }]);

  // export : le blob du message est le message brut, octet pour octet
  const back = bytesToBinary(new Uint8Array(await (await c.download(aid, e.blobId, 'm.eml', 'message/rfc822')).arrayBuffer()));
  assert.equal(back, raw);
  // mbox : écriture puis découpe, réimport dans le même dossier
  const raw2 = sampleEml(`voxel-c-${RUN}-2`);
  const mbox = mboxEntry(back, { sender: USER, date: new Date() }) + mboxEntry(raw2);
  const parts = splitMbox(mbox);
  assert.deepEqual(parts, [raw, raw2]);
  const ids = await Promise.all(parts.map(upload));
  const r2 = await c.call('Email/import', {
    accountId: aid,
    emails: Object.fromEntries(ids.map((b, i) => [`m${i}`, { blobId: b, mailboxIds: { [folderId!]: true }, keywords: {} }])),
  });
  assert.equal(Object.keys(r2.created ?? {}).length, 2, JSON.stringify(r2.notCreated));
  const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: folderId! } });
  assert.equal(q.ids.length, 3);
});

test('transfert en pièce jointe : message/rfc822 attaché par son blobId', { skip }, async () => {
  const blobId = await upload(sampleEml(`voxel-c-${RUN}-fwd`));
  const imp = await c.call('Email/import', { accountId: aid, emails: { i: { blobId, mailboxIds: { [folderId!]: true }, keywords: {} } } });
  const orig = imp.created!.i!;
  const email = buildEmail({
    mailboxIds: { [folderId!]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: null, email: USER! }],
    to: [{ name: null, email: USER! }],
    subject: `Fwd: voxel-c-${RUN}-fwd`,
    html: '<p>voir pièce jointe</p>',
    attachments: [{ blobId: orig.blobId!, name: `voxel-c-${RUN}-fwd.eml`, type: 'message/rfc822', size: orig.size ?? 0 }],
    extraHeaders: priorityHeaders('low'),
  });
  const r = await c.call('Email/set', { accountId: aid, create: { f: email } });
  const id = r.created?.f?.id as string;
  assert.ok(id, JSON.stringify(r.notCreated));
  const g = await c.call('Email/get', { accountId: aid, ids: [id], properties: ['attachments', ...PRIORITY_PROPERTIES] });
  const att = g.list[0]!.attachments?.[0];
  assert.equal(att?.type, 'message/rfc822');
  assert.equal(priorityOf(g.list[0] as unknown as Record<string, unknown>), 'low');
});

test('accusé de lecture RFC 8098 : construit, importé, envoyé à la boîte de test elle-même, reçu', { skip }, async () => {
  const ids = await c.call('Identity/get', { accountId: aid, ids: null });
  const identity = ids.list.find((i) => i.email.toLowerCase() === USER!.toLowerCase()) ?? ids.list[0]!;
  const original = `voxel-c-${RUN}-orig@voxel-test`;
  const raw = buildMdn({
    from: { name: identity.name, email: identity.email },
    to: { name: null, email: USER! },
    subject: `Lu : voxel-c-${RUN}`,
    text: 'Votre message a été affiché.',
    originalMessageId: original,
    finalRecipient: identity.email,
    mode: 'manual',
  });
  const blobId = await upload(raw);
  const methodCalls: Array<[string, Record<string, unknown>, string]> = [
    ['Email/import', { accountId: aid, emails: { mdn: { blobId, mailboxIds: { [folderId!]: true }, keywords: { $seen: true } } } }, 'a'],
    [
      'EmailSubmission/set',
      {
        accountId: aid,
        create: { s: { identityId: identity.id, emailId: '#mdn', envelope: { mailFrom: { email: identity.email, parameters: null }, rcptTo: [{ email: USER!, parameters: null }] } } },
      },
      'b',
    ],
  ];
  const r = (await c.rawRequest({ using: c.usingFor(methodCalls), methodCalls })).methodResponses;
  const sub = r[1]![1] as { created?: Record<string, { id: string }>; notCreated?: unknown };
  assert.ok(sub.created?.s?.id, JSON.stringify(sub.notCreated ?? r));
  // réception dans la boîte de test (même boîte) : attente bornée
  let got: string | undefined;
  for (let i = 0; i < 20 && !got; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const q = await c.call('Email/query', { accountId: aid, filter: { operator: 'AND', conditions: [{ inMailbox: inboxId }, { subject: `Lu : voxel-c-${RUN}` }] } });
    // (Stalwart : le filtre header In-Reply-To ne trouve rien, on cherche par l'objet)
    got = q.ids[0];
  }
  assert.ok(got, 'accusé reçu');
  extraEmails.push(got);
  const g = await c.call('Email/get', { accountId: aid, ids: [got], properties: ['header:Content-Type:asText', 'header:Auto-Submitted:asText', 'bodyStructure'], bodyProperties: ['type', 'partId'] });
  const e = g.list[0]! as unknown as Record<string, unknown>;
  assert.match(String(e['header:Content-Type:asText']), /multipart\/report;\s*report-type=disposition-notification/);
  assert.equal(e['header:Auto-Submitted:asText'], 'auto-replied');
  const types = ((e.bodyStructure as { subParts?: Array<{ type: string }> }).subParts ?? []).map((p) => p.type);
  assert.deepEqual(types, ['text/plain', 'message/disposition-notification']);
});
