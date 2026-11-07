/**
 * Pièces jointes volumineuses (src/files) : expéditeur vérifié par son serveur JMAP, compte créé à la première
 * utilisation, espace de 1 Go, envoi direct ou relayé, lien de téléchargement, suppression et nettoyage.
 * Un faux serveur JMAP et un faux S3 (PUT en HTTP local, moteur en mémoire) remplacent les vrais.
 * Lancer depuis la racine du dépôt : npx tsx --test apps/server/test/files.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'voxel-files-'));
process.env.VOXEL_DATA_DIR = dir;
process.env.VOXEL_WEB_DIST = join(dir, 'no-dist');
process.env.VOXEL_ALLOW_PRIVATE_HOSTS = '1';

const { createApp } = await import('../src/app.js');
const { createFiles } = await import('../src/files/index.js');
const { FilesStore } = await import('../src/files/store.js');
const { readFilesSettings } = await import('../src/files/settings.js');
const { resetSenderCache } = await import('../src/files/identity.js');
const { resetRateLimits } = await import('../src/ratelimit.js');
const { S3Error } = await import('../src/vendor/ud-s3/errors.js');

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

// ---------------------------------------------------------------- faux serveur JMAP : deux comptes

const users: Record<string, string> = { 'alice@example.com': 'secret', 'bob@example.com': 'hunter2' };
let sessionCalls = 0;
const jmapServer = createServer((req, res) => {
  sessionCalls += 1;
  const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
  const [user, pass] = m ? Buffer.from(m[1]!, 'base64').toString('utf8').split(':') : [];
  if (req.url !== '/session' || !user || users[user] !== pass) {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ username: user, accounts: {} }));
});
const jmapUrl = await listen(jmapServer);

// ---------------------------------------------------------------- faux S3 : PUT reçus en HTTP, moteur en mémoire

const objects = new Map<string, Buffer>();
const s3Server = createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url!, 'http://x').pathname.slice('/put/'.length));
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method !== 'PUT' || Number(req.headers['content-length']) !== body.length || req.headers['transfer-encoding']) {
      res.writeHead(400).end();
      return;
    }
    objects.set(key, body);
    res.writeHead(200, { etag: '"e"' }).end();
  });
});
const s3Url = await listen(s3Server);

const engine = {
  async presignPut(input: { key: string; contentLength: number }) {
    return { url: `${s3Url}/put/${encodeURIComponent(input.key)}`, method: 'PUT' as const, headers: { 'content-type': 'application/octet-stream' }, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  },
  async presignGet(input: { key: string; filename?: string }) {
    return { url: `${s3Url}/get/${encodeURIComponent(input.key)}?name=${encodeURIComponent(input.filename ?? '')}`, method: 'GET' as const, headers: {} };
  },
  async headObject(input: { key: string }) {
    const body = objects.get(input.key);
    if (!body) throw new S3Error({ code: 'key_not_found' });
    return { key: input.key, size: body.length, lastModified: new Date().toISOString(), etag: 'e', metadata: {} };
  },
  async deleteObject(input: { key: string }) {
    objects.delete(input.key);
  },
  async deleteObjects(input: { keys: Array<{ key: string }> }) {
    for (const k of input.keys) objects.delete(k.key);
    return { deleted: input.keys.map((k) => k.key), errors: [] };
  },
};

const configFile = join(dir, 'config.json');
writeFileSync(configFile, JSON.stringify({ jmap: { 'example.com': `${jmapUrl}/session` } }));
const settings = readFilesSettings({
  VOXEL_S3_BUCKET: 'mail',
  VOXEL_S3_ENDPOINT: 'http://127.0.0.1:9',
  VOXEL_S3_ACCESS_KEY_ID: 'id',
  VOXEL_S3_SECRET_ACCESS_KEY: 'secret',
  VOXEL_S3_QUOTA_BYTES: '1000',
  VOXEL_CONFIG_FILE: configFile,
});
assert.ok(settings);
const store = new FilesStore(join(dir, 'files.sqlite'));
const files = createFiles(settings, { store, engine });
const app = createApp(files);

after(() => {
  jmapServer.close();
  s3Server.close();
  files.close();
});

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
const alice = { authorization: basic('alice@example.com', 'secret'), 'x-voxel-email': 'alice@example.com' };
const bob = { authorization: basic('bob@example.com', 'hunter2'), 'x-voxel-email': 'bob@example.com' };

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await app.request(`http://voxel.localhost${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* corps texte ou vide */
  }
  return { status: res.status, json, text, headers: res.headers };
}

interface Created {
  id: string;
  upload: { url: string; headers: Record<string, string> };
  account: { created: boolean; used: number; quota: number };
}

async function upload(who: Record<string, string>, name: string, size: number): Promise<Created> {
  const r = await call('POST', '/files/uploads', who, { name, size, type: 'application/pdf' });
  assert.equal(r.status, 201, r.text);
  const created = r.json as unknown as Created;
  const put = await fetch(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: Buffer.alloc(size, 7) });
  assert.equal(put.status, 200);
  return created;
}

test('sans VOXEL_S3_BUCKET : fonction absente', async () => {
  assert.equal(readFilesSettings({}), null);
  const res = await createApp(createFiles(null)).request('http://voxel.localhost/files/config');
  assert.deepEqual(await res.json(), { enabled: false });
});

test('configuration publique : seuil, espace et durée des liens', async () => {
  const r = await call('GET', '/files/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { enabled: true, threshold: 1024 ** 2, quota: 1000, linkDays: 30 });
});

test('expéditeur : identifiants requis, refusés, ou adresse hors des serveurs de confiance', async () => {
  resetRateLimits();
  assert.equal((await call('GET', '/files/account', { 'x-voxel-email': 'alice@example.com' })).json.error, 'invalid_credentials');
  const wrong = await call('GET', '/files/account', { authorization: basic('alice@example.com', 'nope'), 'x-voxel-email': 'alice@example.com' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'upstream_auth');
  const other = await call('GET', '/files/account', { authorization: basic('carol@other.org', 'x'), 'x-voxel-email': 'carol@other.org' });
  assert.equal(other.status, 403);
  assert.equal(other.json.error, 'forbidden');
  assert.equal((await call('GET', '/files/account', { authorization: alice.authorization })).json.error, 'validation');
});

test('premier envoi : compte créé, taille réservée, lien ouvert après confirmation', async () => {
  resetSenderCache();
  const before = await call('GET', '/files/account', alice);
  assert.equal(before.status, 200);
  assert.equal(before.json.exists, false);
  assert.equal(before.json.used, 0);

  const first = await upload(alice, 'rapport annuel.pdf', 300);
  assert.equal(first.account.created, true);
  assert.equal(first.account.used, 300);
  assert.match(first.id, /^[A-Za-z0-9_-]{22}$/);

  const done = await call('POST', `/files/uploads/${first.id}/complete`, alice);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.url, `/f/${first.id}/rapport%20annuel.pdf`);
  assert.equal(done.json.size, 300);
  const days = (Date.parse(done.json.expiresAt as string) - Date.now()) / 86400_000;
  assert.ok(days > 29.9 && days <= 30);

  const link = await call('GET', done.json.url as string);
  assert.equal(link.status, 302);
  assert.match(link.headers.get('location') ?? '', /\/get\/.+name=rapport%20annuel\.pdf$/);
  assert.equal(link.headers.get('cache-control'), 'no-store');

  const account = await call('GET', '/files/account', alice);
  assert.equal(account.json.exists, true);
  assert.equal(account.json.used, 300);

  const second = await upload(alice, 'b.pdf', 100);
  assert.equal(second.account.created, false);
  assert.equal(second.account.used, 400);
});

test('vérification gardée en mémoire : une seule session JMAP pour plusieurs appels', async () => {
  resetSenderCache();
  const n = sessionCalls;
  await call('GET', '/files/account', bob);
  await call('GET', '/files/account', bob);
  await call('GET', '/files/config');
  assert.equal(sessionCalls - n, 1);
});

test('espace plein : refus avec l’espace utilisé et la limite', async () => {
  const used = Number((await call('GET', '/files/account', alice)).json.used);
  const r = await call('POST', '/files/uploads', alice, { name: 'big.zip', size: 1000 - used + 1, type: 'application/zip' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'quota_exceeded');
  assert.equal(r.json.used, String(used));
  assert.equal(r.json.quota, '1000');
  // l'espace d'un autre compte n'est pas touché
  const other = await call('POST', '/files/uploads', bob, { name: 'ok.zip', size: 900, type: 'application/zip' });
  assert.equal(other.status, 201);
  await call('DELETE', `/files/${(other.json as unknown as Created).id}`, bob);
});

test('fichiers d’un autre compte : introuvables', async () => {
  const mine = await upload(alice, 'perso.pdf', 10);
  assert.equal((await call('POST', `/files/uploads/${mine.id}/complete`, bob)).status, 404);
  assert.equal((await call('DELETE', `/files/${mine.id}`, bob)).status, 404);
  assert.equal((await call('POST', `/files/uploads/${mine.id}/complete`, alice)).status, 200);
});

test('confirmation sans fichier reçu, ou de mauvaise taille', async () => {
  const r = await call('POST', '/files/uploads', alice, { name: 'x.bin', size: 20, type: 'application/octet-stream' });
  const id = (r.json as unknown as Created).id;
  assert.equal((await call('POST', `/files/uploads/${id}/complete`, alice)).status, 404);
  const key = store.file(id)!.object_key;
  objects.set(key, Buffer.alloc(5));
  const bad = await call('POST', `/files/uploads/${id}/complete`, alice);
  assert.equal(bad.status, 400);
  assert.equal(objects.has(key), false);
  assert.equal(store.file(id), undefined);
});

test('relais : le serveur écrit dans S3 avec la longueur exacte', async () => {
  const r = await call('POST', '/files/uploads', alice, { name: 'relais.txt', size: 12, type: 'text/plain' });
  const id = (r.json as unknown as Created).id;
  const short = await app.request(`http://voxel.localhost/files/uploads/${id}/data`, { method: 'PUT', headers: { ...alice, 'content-length': '3' }, body: 'abc' });
  assert.equal(short.status, 400);
  const res = await app.request(`http://voxel.localhost/files/uploads/${id}/data`, { method: 'PUT', headers: { ...alice, 'content-length': '12' }, body: 'hello relais' });
  assert.equal(res.status, 204);
  assert.equal(objects.get(store.file(id)!.object_key)?.toString(), 'hello relais');
  assert.equal((await call('POST', `/files/uploads/${id}/complete`, alice)).status, 200);
});

test('suppression : objet retiré, espace libéré, lien mort', async () => {
  const f = await upload(alice, 'retire.pdf', 50);
  const done = await call('POST', `/files/uploads/${f.id}/complete`, alice);
  const usedBefore = Number((await call('GET', '/files/account', alice)).json.used);
  assert.equal((await call('DELETE', `/files/${f.id}`, alice)).status, 204);
  assert.equal(Number((await call('GET', '/files/account', alice)).json.used), usedBefore - 50);
  const link = await call('GET', done.json.url as string);
  assert.equal(link.status, 404);
  assert.match(link.text, /no longer available/);
});

test('lien expiré : refusé, puis supprimé de S3 par le nettoyage', async () => {
  const f = await upload(alice, 'vieux.pdf', 30);
  const done = await call('POST', `/files/uploads/${f.id}/complete`, alice);
  const key = store.file(f.id)!.object_key;
  store.expire(f.id, Date.now() - 1);
  assert.equal((await call('GET', done.json.url as string)).status, 404);
  assert.ok((await files.sweep()) >= 1);
  assert.equal(objects.has(key), false);
  assert.equal(store.file(f.id), undefined);
});

test('liens : identifiant mal formé ou inconnu → 404 texte, sans appel au stockage', async () => {
  for (const path of ['/f/abc', '/f/AAAAAAAAAAAAAAAAAAAAAA/x.pdf', '/f/../../etc/passwd']) {
    const r = await call('GET', path);
    assert.equal(r.status, 404, path);
  }
});

test('nom de fichier nettoyé, taille invalide refusée', async () => {
  const r = await call('POST', '/files/uploads', alice, { name: '../\u0007secret/../x.pdf', size: 1, type: 'application/pdf' });
  assert.equal(r.status, 201);
  assert.equal(store.file((r.json as unknown as Created).id)!.name, '.._secret_.._x.pdf');
  for (const size of [0, -1, 1.5, 'abc']) {
    assert.equal((await call('POST', '/files/uploads', alice, { name: 'x', size, type: 'x/y' })).status, 400);
  }
});
