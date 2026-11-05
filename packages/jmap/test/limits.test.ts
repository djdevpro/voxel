/**
 * Limites de session (`limits.ts`) et leur respect par `JmapClient`, contre un faux serveur JMAP.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS, evalPointer, JmapClient, JmapError, limitsOf, type Invocation, type JmapRequest, type Session } from '../src/index.ts';

const BASE = 'https://jmap.test';
const EMAILS = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'];

function sessionWith(core: Record<string, unknown>): Session {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': core, 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:submission': {} },
    accounts: { A: { name: 'test', isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'A' },
    username: 'test',
    apiUrl: `${BASE}/api`,
    downloadUrl: `${BASE}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${BASE}/upload/{accountId}/`,
    eventSourceUrl: `${BASE}/events`,
    state: 's1',
  } as Session;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Faux serveur : session, API (Email/query, Email/get, Thread/get, Email/set, EmailSubmission/set) et téléversement.
 * Résout les références `#…` dans la requête, compte les requêtes en vol et mémorise chaque corps envoyé.
 * `tooLarge` : `Email/get` dont les `ids` viennent d'une référence et dépassent ce nombre → `requestTooLarge`.
 */
function fakeServer(core: Record<string, unknown> = {}, opts: { tooLarge?: number } = {}) {
  const session = sessionWith(core);
  const bodies: JmapRequest[] = [];
  const stats = { fetches: 0, inFlight: 0, maxInFlight: 0, uploads: 0, uploadsInFlight: 0, maxUploadsInFlight: 0 };
  let state = 0;
  let nextId = 0;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const handle = (name: string, args: Record<string, unknown>, id: string, viaRef: boolean, created: Record<string, string>): Invocation => {
    switch (name) {
      case 'Email/query':
        return [name, { accountId: 'A', ids: EMAILS, queryState: 'q', position: 0 }, id];
      case 'Email/get': {
        const ids = args.ids as string[];
        if (opts.tooLarge !== undefined && viaRef && ids.length > opts.tooLarge) return ['error', { type: 'requestTooLarge' }, id];
        const known = ids.filter((x) => EMAILS.includes(x));
        return [name, { accountId: 'A', state: `st${state++}`, list: known.map((x) => ({ id: x, threadId: `t${x}` })), notFound: ids.filter((x) => !EMAILS.includes(x)) }, id];
      }
      case 'Thread/get': {
        const ids = args.ids as string[];
        return [name, { accountId: 'A', state: 'th', list: ids.map((x) => ({ id: x, emailIds: [x.slice(1)] })), notFound: [] }, id];
      }
      case 'Email/set': {
        const out: Record<string, Record<string, unknown>> = {};
        for (const cid of Object.keys((args.create ?? {}) as object)) {
          const nid = `m${nextId++}`;
          created[cid] = nid;
          out[cid] = { id: nid };
        }
        const updated = Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null]));
        return [name, { accountId: 'A', oldState: `s${state}`, newState: `s${++state}`, created: Object.keys(out).length ? out : null, updated, destroyed: null }, id];
      }
      case 'EmailSubmission/set': {
        const out: Record<string, unknown> = {};
        for (const [cid, v] of Object.entries((args.create ?? {}) as Record<string, { emailId: string }>)) {
          const emailId = v.emailId.startsWith('#') ? created[v.emailId.slice(1)] : v.emailId;
          out[cid] = { id: `sub${nextId++}`, emailId };
        }
        return [name, { accountId: 'A', oldState: 'x', newState: 'y', created: out }, id];
      }
    }
    return ['error', { type: 'unknownMethod' }, id];
  };
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    stats.fetches++;
    const u = new URL(url);
    if (u.pathname === '/session') return json(session);
    if (u.pathname.startsWith('/upload/')) {
      stats.uploads++;
      stats.maxUploadsInFlight = Math.max(stats.maxUploadsInFlight, ++stats.uploadsInFlight);
      await tick();
      stats.uploadsInFlight--;
      return json({ accountId: 'A', blobId: `b${stats.uploads}`, type: 'application/octet-stream', size: 1 });
    }
    const req = JSON.parse(init!.body as string) as JmapRequest;
    bodies.push(req);
    stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
    await tick();
    const created: Record<string, string> = { ...req.createdIds };
    const out: Invocation[] = [];
    for (const [name, args0, id] of req.methodCalls) {
      const args = { ...args0 };
      let bad = false;
      let viaRef = false;
      for (const k of Object.keys(args).filter((x) => x.startsWith('#'))) {
        const ref = args[k] as { resultOf: string; name: string; path: string };
        const target = out.find((o) => o[2] === ref.resultOf && o[0] === ref.name);
        try {
          if (!target) throw new Error('ref');
          args[k.slice(1)] = evalPointer(target[1], ref.path);
          delete args[k];
          if (k === '#ids') viaRef = true;
        } catch {
          bad = true;
        }
      }
      out.push(bad ? ['error', { type: 'invalidResultReference' }, id] : handle(name, args, id, viaRef, created));
    }
    stats.inFlight--;
    return json({ methodResponses: out, sessionState: 's1', ...(req.createdIds ? { createdIds: created } : {}) });
  };
  return { fetch, bodies, stats, session };
}

const client = (srv: ReturnType<typeof fakeServer>, initial = false) =>
  new JmapClient({ sessionUrl: `${BASE}/session`, fetch: srv.fetch, ...(initial ? { initialSession: srv.session } : {}) });

const isLimit = (limit: string) => (e: unknown) => e instanceof JmapError && e.type === 'urn:ietf:params:jmap:error:limit' && (e.body as { limit: string }).limit === limit;

test('limitsOf : valeurs par défaut sans limites, et pour les champs invalides', () => {
  assert.deepEqual(limitsOf(undefined), DEFAULT_LIMITS);
  assert.deepEqual(limitsOf(sessionWith({})), DEFAULT_LIMITS);
  assert.deepEqual(limitsOf(sessionWith({ maxCallsInRequest: 0, maxObjectsInGet: -1, maxObjectsInSet: '16', maxSizeUpload: 7 })), { ...DEFAULT_LIMITS, maxSizeUpload: 7 });
});

test('maxConcurrentRequests : jamais plus de 2 requêtes en vol', async () => {
  const srv = fakeServer({ maxConcurrentRequests: 2 });
  const c = client(srv);
  await Promise.all(Array.from({ length: 10 }, () => c.call('Email/query', { accountId: 'A' })));
  assert.equal(srv.bodies.length, 10);
  assert.equal(srv.stats.maxInFlight, 2);
});

test('maxCallsInRequest : chaîne de références en 2 requêtes, ids littéraux dans la seconde', async () => {
  const srv = fakeServer({ maxCallsInRequest: 2 });
  const b = client(srv).batch();
  const q = b.call('Email/query', { accountId: 'A' });
  const g1 = b.call('Email/get', { accountId: 'A', '#ids': q.ref('/ids'), properties: ['threadId'] });
  const t = b.call('Thread/get', { accountId: 'A', '#ids': g1.ref('/list/*/threadId') });
  const g2 = b.call('Email/get', { accountId: 'A', '#ids': t.ref('/list/*/emailIds') });
  await b.send();
  assert.equal(srv.bodies.length, 2);
  const second = srv.bodies[1]!.methodCalls;
  assert.equal(second[0]![0], 'Thread/get');
  assert.deepEqual(second[0]![1].ids, EMAILS.map((x) => `t${x}`));
  assert.deepEqual(q.result.ids, EMAILS);
  assert.equal(g1.result.list.length, 7);
  assert.equal(t.result.list.length, 7);
  assert.deepEqual(g2.result.list.map((e) => e.id), EMAILS);
});

test('maxObjectsInGet : Email/get de 8 ids en 3 sous-appels réunis', async () => {
  const srv = fakeServer({ maxObjectsInGet: 3 });
  const r = await client(srv).call('Email/get', { accountId: 'A', ids: [...EMAILS, 'zz'] });
  assert.equal(srv.bodies.length, 1);
  const calls = srv.bodies[0]!.methodCalls;
  assert.deepEqual(calls.map((c) => c[2]), ['c0~0', 'c0~1', 'c0~2']);
  assert.ok(calls.every((c) => (c[1].ids as string[]).length <= 3));
  assert.deepEqual(r.list.map((e) => e.id), EMAILS);
  assert.deepEqual(r.notFound, ['zz']);
});

test('maxObjectsInSet : Email/set de 7 mises à jour en tranches, ifInState sur la première', async () => {
  const srv = fakeServer({ maxObjectsInSet: 3 });
  const update = Object.fromEntries(EMAILS.map((id) => [id, { 'keywords/$seen': true }]));
  const r = await client(srv).call('Email/set', { accountId: 'A', ifInState: 's0', update });
  const calls = srv.bodies.flatMap((b) => b.methodCalls);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => Object.keys(c[1].update as object).length), [3, 3, 1]);
  assert.deepEqual(calls.map((c) => 'ifInState' in c[1]), [true, false, false]);
  assert.deepEqual(Object.keys(r.updated ?? {}).sort(), EMAILS);
  assert.equal(r.oldState, 's0');
  assert.equal(r.newState, 's3');
});

test('maxSizeRequest : lot coupé par la taille ; appel unique trop gros refusé sans fetch', async () => {
  const srv = fakeServer({ maxSizeRequest: 400 });
  const b = client(srv).batch();
  const hs = EMAILS.map((id) => b.call('Email/get', { accountId: 'A', ids: [id], properties: ['id', 'threadId', 'subject'] }));
  await b.send();
  assert.ok(srv.bodies.length > 1);
  assert.ok(srv.bodies.every((r) => new TextEncoder().encode(JSON.stringify(r)).length <= 400));
  assert.deepEqual(hs.map((h) => h.result.list[0]!.id), EMAILS);

  const srv2 = fakeServer({ maxSizeRequest: 400 });
  await assert.rejects(client(srv2, true).call('Email/get', { accountId: 'A', ids: ['e0'], properties: ['x'.repeat(1000)] }), isLimit('maxSizeRequest'));
  assert.equal(srv2.stats.fetches, 0);
});

test('maxSizeRequest : [Email/set, Email/get énorme] ne fait aucun post', async () => {
  const srv = fakeServer({ maxSizeRequest: 400 });
  const b = client(srv, true).batch();
  b.call('Email/set', { accountId: 'A', update: { e0: { 'keywords/$seen': true } } });
  b.call('Email/get', { accountId: 'A', ids: ['e0'], properties: ['x'.repeat(1000)] });
  await assert.rejects(b.send(), isLimit('maxSizeRequest'));
  assert.equal(srv.bodies.length, 0);
  assert.equal(srv.stats.fetches, 0);
});

test('repli requestTooLarge : Email/get #ids et Thread/get dépendant rejoués', async () => {
  const srv = fakeServer({}, { tooLarge: 3 });
  const b = client(srv).batch();
  const q = b.call('Email/query', { accountId: 'A' });
  const g = b.call('Email/get', { accountId: 'A', '#ids': q.ref('/ids'), properties: ['threadId'] });
  const t = b.call('Thread/get', { accountId: 'A', '#ids': g.ref('/list/*/threadId') });
  await b.send();
  assert.equal(srv.bodies.length, 2);
  assert.deepEqual(q.result.ids, EMAILS);
  assert.deepEqual(g.result.list.map((e) => e.id), EMAILS);
  assert.deepEqual(t.result.list.map((x) => x.id), EMAILS.map((x) => `t${x}`));
});

test('createdIds : la 2e requête porte les identifiants créés par la 1re', async () => {
  const srv = fakeServer({ maxCallsInRequest: 1 });
  const b = client(srv).batch();
  const set = b.call('Email/set', { accountId: 'A', create: { msg: { mailboxIds: { d: true }, subject: 'x' } } } as never);
  const sub = b.call('EmailSubmission/set', { accountId: 'A', create: { s: { emailId: '#msg', identityId: 'i' } } } as never);
  await b.send();
  assert.equal(srv.bodies.length, 2);
  assert.deepEqual(srv.bodies[1]!.createdIds, { msg: 'm0' });
  assert.ok(set.ok);
  assert.equal((sub.result.created as Record<string, { emailId: string }>).s!.emailId, 'm0');
});

test('upload : refus au-delà de maxSizeUpload, un seul envoi en vol avec maxConcurrentUpload 1', async () => {
  const srv = fakeServer({ maxSizeUpload: 50, maxConcurrentUpload: 1 });
  const c = client(srv);
  await assert.rejects(c.upload('A', new Uint8Array(100)), isLimit('maxSizeUpload'));
  assert.equal(srv.stats.uploads, 0);
  await Promise.all([1, 2, 3].map(() => c.upload('A', new Uint8Array(10))));
  assert.equal(srv.stats.uploads, 3);
  assert.equal(srv.stats.maxUploadsInFlight, 1);
});

test('evalPointer : `*` aplati, index hors limites, ~1', () => {
  assert.deepEqual(evalPointer({ list: [{ threadId: 'a' }, { threadId: 'b' }] }, '/list/*/threadId'), ['a', 'b']);
  assert.deepEqual(evalPointer({ list: [{ ids: ['x', 'y'] }, { ids: ['z'] }] }, '/list/*/ids'), ['x', 'y', 'z']);
  assert.throws(() => evalPointer({ list: [1] }, '/list/3'), (e: unknown) => e instanceof JmapError && e.type === 'invalidResultReference' && /index 3 out of range/.test(e.message));
  assert.equal(evalPointer({ 'a/b': 1 }, '/a~1b'), 1);
});
