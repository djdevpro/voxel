/**
 * Import et export mbox (`transfer.ts`) et nouvelles tentatives du client sur 429, contre un faux serveur JMAP.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  binaryToBytes,
  bytesToBinary,
  exportMessages,
  importMessages,
  JmapClient,
  JmapError,
  mboxEntry,
  rawMessageId,
  readMessages,
  retryAfterMs,
  splitMbox,
} from '../src/index.ts';

const BASE = 'https://jmap.test';
const session = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxSizeUpload: 50_000_000, maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500 }, 'urn:ietf:params:jmap:mail': {} },
  accounts: { A: { name: 'test', isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A' },
  username: 'test',
  apiUrl: `${BASE}/api`,
  downloadUrl: `${BASE}/download/{accountId}/{blobId}/{name}?type={type}`,
  uploadUrl: `${BASE}/upload/{accountId}/`,
  eventSourceUrl: `${BASE}/events`,
  state: 's1',
};

interface Stored {
  id: string;
  blobId: string;
  mailboxId: string;
  messageId: string[] | null;
  receivedAt: string;
}

/** Faux serveur : session, API (Email/query, Email/get, Email/import), téléversement et téléchargement. */
function fakeServer(hooks: { upload?: (n: number) => Response | undefined; api?: (n: number) => Response | undefined; download?: (n: number) => Response | undefined } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const emails: Stored[] = [];
  const counts = { upload: 0, api: 0, download: 0, imports: [] as number[] };
  const put = (raw: string, mailboxId: string, receivedAt: string) => {
    const blobId = `b${blobs.size}`;
    blobs.set(blobId, binaryToBytes(raw));
    const id = rawMessageId(raw);
    emails.push({ id: `e${emails.length}`, blobId, mailboxId, messageId: id ? [id] : null, receivedAt });
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === '/session') return json(session);
    if (u.pathname.startsWith('/upload/')) {
      const hooked = hooks.upload?.(++counts.upload);
      if (hooked) return hooked;
      const blobId = `b${blobs.size}`;
      blobs.set(blobId, new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer()));
      return json({ accountId: 'A', blobId, type: 'message/rfc822', size: blobs.get(blobId)!.length }, 201);
    }
    if (u.pathname.startsWith('/download/')) {
      const hooked = hooks.download?.(++counts.download);
      if (hooked) return hooked;
      const data = blobs.get(u.pathname.split('/')[3]!);
      return data ? new Response(data as BodyInit) : new Response('', { status: 404 });
    }
    const hooked = hooks.api?.(++counts.api);
    if (hooked) return hooked;
    const req = JSON.parse(String(init!.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    const responses: [string, Record<string, unknown>, string][] = [];
    for (const [name, args, callId] of req.methodCalls) {
      const ref = args['#ids'] as { resultOf: string } | undefined;
      const ids = ref ? (responses.find((r) => r[2] === ref.resultOf)![1].ids as string[]) : (args.ids as string[] | null);
      if (name === 'Email/query') {
        const filter = args.filter as { inMailbox: string };
        let list = emails.filter((e) => e.mailboxId === filter.inMailbox);
        if (args.sort) list = [...list].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
        const position = Number(args.position ?? 0);
        const limit = Number(args.limit ?? 500);
        responses.push([name, { ids: list.slice(position, position + limit).map((e) => e.id), position, total: list.length }, callId]);
      } else if (name === 'Email/get') {
        const list = emails.filter((e) => ids?.includes(e.id)).map((e) => ({ id: e.id, blobId: e.blobId, messageId: e.messageId, receivedAt: e.receivedAt, from: null }));
        responses.push([name, { accountId: 'A', state: 's', list, notFound: [] }, callId]);
      } else if (name === 'Email/import') {
        const entries = Object.entries(args.emails as Record<string, { blobId: string; mailboxIds: Record<string, boolean>; receivedAt?: string }>);
        counts.imports.push(entries.length);
        const created: Record<string, unknown> = {};
        for (const [cid, m] of entries) {
          put(bytesToBinary(blobs.get(m.blobId)!), Object.keys(m.mailboxIds)[0]!, m.receivedAt ?? new Date().toISOString());
          created[cid] = { id: emails.at(-1)!.id };
        }
        responses.push([name, { accountId: 'A', created, notCreated: null }, callId]);
      } else responses.push(['error', { type: 'unknownMethod' }, callId]);
    }
    return json({ methodResponses: responses, sessionState: 's1' });
  };
  return { fetch, emails, counts, put };
}

const client = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => new JmapClient({ sessionUrl: `${BASE}/session`, fetch });

function message(i: number, id = `m${i}@example.test`): string {
  const date = new Date(Date.UTC(2021, 0, 1) + i * 60_000).toUTCString().replace('GMT', '+0000');
  return bytesToBinary(new TextEncoder().encode(`From: a@example.test\r\nSubject: n${i}\r\nDate: ${date}\r\nMessage-ID: <${id}>\r\n\r\nFrom the start, é ${i}\r\n`));
}

const mbox = (raws: string[]) => new Blob([binaryToBytes(raws.map((r) => mboxEntry(r, { sender: 'a@example.test' })).join(''))]);

test('retryAfterMs : secondes ou date HTTP', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(retryAfterMs(new Date(Date.now() + 10_000).toUTCString(), Date.now()) !== undefined, true);
  assert.equal(retryAfterMs('n/a'), undefined);
  assert.equal(retryAfterMs(null), undefined);
});

test('client : un 429 bref est renvoyé, un 429 long revient à l’appelant avec son délai', async () => {
  const s = fakeServer({
    api: (n) => (n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : undefined),
    upload: () => new Response(JSON.stringify({ title: 'Quota exceeded' }), { status: 429, headers: { 'retry-after': '3600' } }),
  });
  const c = client(s.fetch);
  const q = await c.call('Email/query', { accountId: 'A', filter: { inMailbox: 'X' } });
  assert.deepEqual(q.ids, []);
  assert.equal(s.counts.api, 2);
  const err = await c.upload('A', new Blob(['x']), 'message/rfc822').catch((e: unknown) => e);
  assert.ok(err instanceof JmapError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 3600);
  assert.deepEqual(err.body, { title: 'Quota exceeded' });
  assert.equal(s.counts.upload, 1);
});

test('client : un 503 est renvoyé pour une lecture, jamais pour un envoi', async () => {
  const s = fakeServer({
    api: (n) => (n === 1 ? new Response('', { status: 503, headers: { 'retry-after': '0' } }) : undefined),
    download: (n) => (n === 1 ? new Response('', { status: 503, headers: { 'retry-after': '0' } }) : undefined),
  });
  s.put(message(1), 'X', '2021-01-01T00:00:00Z');
  const c = client(s.fetch);
  await assert.rejects(c.call('Email/query', { accountId: 'A', filter: { inMailbox: 'X' } }), (e: JmapError) => e.status === 503);
  assert.equal((await (await c.download('A', 'b0', 'm.eml')).arrayBuffer()).byteLength > 0, true);
  assert.equal(s.counts.download, 2);
});

test('import : lots, doublons ignorés, pause sur quota puis reprise sans perte', async () => {
  const raws = Array.from({ length: 60 }, (_, i) => message(i));
  const s = fakeServer({ upload: (n) => (n === 15 ? new Response(JSON.stringify({ title: 'Quota exceeded', detail: 'blob upload quota' }), { status: 429, headers: { 'retry-after': '3600' } }) : undefined) });
  for (let i = 0; i < 10; i++) s.put(raws[i]!, 'INBOX', '2021-01-01T00:00:00Z');
  const waits: number[] = [];
  const paused: number[] = [];
  const r = await importMessages(client(s.fetch), {
    accountId: 'A',
    mailboxId: 'INBOX',
    messages: readMessages(mbox([...raws, raws[20]!]), 'archive.mbox'),
    onWait: (until, c) => paused.push(c.imported, Math.round((until.getTime() - Date.now()) / 1000)),
    sleep: async (ms) => void waits.push(ms),
  });
  assert.deepEqual({ imported: r.imported, skipped: r.skipped, failed: r.failed, aborted: r.aborted }, { imported: 50, skipped: 11, failed: 0, aborted: false });
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! >= 3_600_000 && waits[0]! <= 3_602_000, `attente ${waits[0]}`);
  // avant la pause, les 14 messages déjà téléversés sont importés
  assert.deepEqual(paused, [14, 3601]);
  assert.ok(s.counts.imports.every((n) => n <= 25));
  const ids = s.emails.filter((e) => e.mailboxId === 'INBOX').map((e) => e.messageId![0]!);
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
});

test('import : relancé, il ignore tout ce qui est déjà là', async () => {
  const raws = Array.from({ length: 30 }, (_, i) => message(i));
  const s = fakeServer();
  const c = client(s.fetch);
  const first = await importMessages(c, { accountId: 'A', mailboxId: 'INBOX', messages: readMessages(mbox(raws), 'a.mbox') });
  const again = await importMessages(c, { accountId: 'A', mailboxId: 'INBOX', messages: readMessages(mbox(raws), 'a.mbox') });
  assert.equal(first.imported, 30);
  assert.deepEqual({ imported: again.imported, skipped: again.skipped }, { imported: 0, skipped: 30 });
  assert.equal(s.emails.length, 30);
});

test('import : annulé pendant la pause, il s’arrête', async () => {
  const raws = Array.from({ length: 10 }, (_, i) => message(i));
  const s = fakeServer({ upload: (n) => (n === 4 ? new Response('{}', { status: 429, headers: { 'retry-after': '600' } }) : undefined) });
  const ctrl = new AbortController();
  const r = await importMessages(client(s.fetch), {
    accountId: 'A',
    mailboxId: 'INBOX',
    messages: readMessages(mbox(raws), 'a.mbox'),
    signal: ctrl.signal,
    onWait: () => ctrl.abort(),
    sleep: async (_ms, signal) => {
      if (signal?.aborted) throw signal.reason;
    },
  });
  assert.equal(r.aborted, true);
  assert.equal(r.imported, 3);
  assert.equal(r.failed, 0);
});

test('export : du plus ancien au plus récent, octet pour octet', async () => {
  const raws = Array.from({ length: 7 }, (_, i) => message(i));
  const s = fakeServer({ download: (n) => (n === 3 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : undefined) });
  [6, 2, 0, 5, 1, 4, 3].forEach((i) => s.put(raws[i]!, 'INBOX', new Date(Date.UTC(2021, 0, 1, 0, i)).toISOString()));
  const chunks: Uint8Array[] = [];
  const progress: [number, number][] = [];
  const r = await exportMessages(client(s.fetch), { accountId: 'A', mailboxId: 'INBOX', write: async (c) => void chunks.push(c), onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(r.exported, 7);
  assert.deepEqual(progress.at(-1), [7, 7]);
  assert.deepEqual(splitMbox(bytesToBinary(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()))), raws);
});
