/**
 * Intégration du lot C contre la boîte de test dédiée, par la passerelle IMAP, ignorée sans
 * VOXEL_TEST_USER / VOXEL_TEST_PASSWORD / VOXEL_TEST_IMAP / VOXEL_TEST_SMTP. Lancer depuis la racine :
 *   node --env-file=.env.test.local --import tsx --test apps/server/test/integration-c.test.ts
 * `Email/import` de la façade (APPEND) et accusé de lecture envoyé à la boîte de test elle-même ; dossier de
 * test et accusé reçu supprimés à la fin.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildMdn, priorityHeaders } from '@voxel/jmap';

process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-c-'));

const { USER, PASS, IMAP, SMTP } = {
  USER: process.env.VOXEL_TEST_USER,
  PASS: process.env.VOXEL_TEST_PASSWORD,
  IMAP: process.env.VOXEL_TEST_IMAP,
  SMTP: process.env.VOXEL_TEST_SMTP,
};
const skip = !USER || !PASS || !IMAP || !SMTP ? 'VOXEL_TEST_* non définies' : false;
const RUN = Math.random().toString(36).slice(2, 8);
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];

const { createImapBackend } = await import('../src/imap/index.js');
const { parseEndpoint } = await import('../src/routes/imap.js');
const { streamFromBuffer } = await import('../src/imap/util.js');
type Backend = ReturnType<typeof createImapBackend>;
let backend: Backend | null = null;
let folderId: string | null = null;
const toDestroy: string[] = [];

const kv = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k) };
};

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await backend!.api({ using: USING, methodCalls: [[name, { accountId: 'a', ...args }, 'x']] });
  const [n, body] = r.methodResponses[0]!;
  assert.notEqual(n, 'error', JSON.stringify(body));
  return body;
}

async function upload(raw: string): Promise<string> {
  const r = await backend!.upload('a', streamFromBuffer(Buffer.from(raw, 'binary')), 'message/rfc822');
  return r.blobId;
}

after(async () => {
  if (!backend) return;
  if (toDestroy.length) await call('Email/set', { destroy: toDestroy }).catch(() => undefined);
  if (folderId) await call('Mailbox/set', { destroy: [folderId], onDestroyRemoveEmails: true }).catch(() => undefined);
  await backend.close();
});

test('passerelle : Email/import (APPEND) d’un .eml avec priorité, relu avec ses en-têtes', { skip }, async () => {
  backend = createImapBackend(
    { email: USER!, username: USER!, auth: { password: PASS! }, imap: parseEndpoint('imap', IMAP)!, smtp: parseEndpoint('smtp', SMTP)! },
    kv(),
  );
  await backend.verify();
  const mb = await call('Mailbox/set', { create: { f: { name: `voxel-test-c-${RUN}`, parentId: null } } });
  folderId = ((mb.created as Record<string, { id: string }>)?.f?.id) ?? null;
  assert.ok(folderId, JSON.stringify(mb));
  const head = Object.entries(priorityHeaders('high')).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const raw = `From: ${USER}\r\nTo: ${USER}\r\nSubject: voxel-c-${RUN}-gw\r\nDate: Tue, 03 Nov 2026 10:00:00 +0000\r\nMessage-ID: <voxel-c-${RUN}-gw@voxel-test>\r\n${head}Disposition-Notification-To: ${USER}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBonjour\r\n`;
  const blobId = await upload(raw);
  const r = await call('Email/import', { emails: { i: { blobId, mailboxIds: { [folderId]: true }, keywords: { $seen: true }, receivedAt: '2026-11-03T10:00:00Z' } } });
  const id = (r.created as Record<string, { id: string }> | null)?.i?.id;
  assert.ok(id, JSON.stringify(r.notCreated));
  const g = await call('Email/get', {
    ids: [id],
    properties: ['subject', 'keywords', 'receivedAt', 'mailboxIds', 'header:X-Priority:asText', 'header:Importance:asText', 'header:Disposition-Notification-To:asAddresses'],
  });
  const e = (g.list as Array<Record<string, unknown>>)[0]!;
  assert.equal(e.subject, `voxel-c-${RUN}-gw`);
  assert.equal((e.keywords as Record<string, boolean>).$seen, true);
  assert.equal(e.receivedAt, '2026-11-03T10:00:00Z');
  assert.equal(e['header:X-Priority:asText'], '1 (Highest)');
  assert.equal(e['header:Importance:asText'], 'high');
  assert.deepEqual(e['header:Disposition-Notification-To:asAddresses'], [{ name: null, email: USER }]);
  // blob invalide : refusé proprement
  const bad = await call('Email/import', { emails: { z: { blobId: 'inexistant', mailboxIds: { [folderId]: true } } } });
  assert.equal((bad.notCreated as Record<string, { type: string }>).z!.type, 'blobNotFound');
});

test('passerelle : accusé de lecture importé puis envoyé (SMTP) à la boîte de test elle-même', { skip }, async () => {
  assert.ok(backend && folderId);
  const ids = await call('Identity/get', { ids: null });
  const identity = (ids.list as Array<{ id: string; email: string; name: string }>)[0]!;
  const raw = buildMdn({
    from: { name: identity.name, email: identity.email },
    to: { name: null, email: USER! },
    subject: `Lu : voxel-c-${RUN}-gw`,
    text: 'Votre message a été affiché.',
    originalMessageId: `voxel-c-${RUN}-gw@voxel-test`,
    finalRecipient: identity.email,
    mode: 'automatic',
  });
  const blobId = await upload(raw);
  const r = await backend.api({
    using: USING,
    methodCalls: [
      ['Email/import', { accountId: 'a', emails: { mdn: { blobId, mailboxIds: { [folderId]: true }, keywords: { $seen: true } } } }, 'a'],
      ['EmailSubmission/set', { accountId: 'a', create: { s: { identityId: identity.id, emailId: '#mdn', envelope: { mailFrom: { email: identity.email, parameters: null }, rcptTo: [{ email: USER!, parameters: null }] } } } }, 'b'],
    ],
  });
  const sub = r.methodResponses.find(([n]) => n === 'EmailSubmission/set')![1] as { created?: Record<string, unknown>; notCreated?: unknown };
  assert.ok(sub.created?.s, JSON.stringify(r.methodResponses));
  const mbs = await call('Mailbox/get', { ids: null, properties: ['id', 'role'] });
  const inbox = (mbs.list as Array<{ id: string; role: string | null }>).find((m) => m.role === 'inbox')!.id;
  let got: string | undefined;
  for (let i = 0; i < 20 && !got; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const q = await call('Email/query', { filter: { operator: 'AND', conditions: [{ inMailbox: inbox }, { subject: `Lu : voxel-c-${RUN}-gw` }] } });
    got = (q.ids as string[])[0];
  }
  assert.ok(got, 'accusé reçu');
  toDestroy.push(got);
  const g = await call('Email/get', { ids: [got], properties: ['header:Content-Type:asText'] });
  assert.match(String((g.list as Array<Record<string, unknown>>)[0]!['header:Content-Type:asText']), /multipart\/report;\s*report-type=disposition-notification/);
});
