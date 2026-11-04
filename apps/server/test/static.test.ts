/**
 * Repli SPA de src/static.ts contre un faux dist (aucun réseau).
 * Lancer depuis la racine du dépôt : npx tsx --test apps/server/test/static.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const base = mkdtempSync(join(tmpdir(), 'voxel-static-'));
const dist = join(base, 'dist');
mkdirSync(join(dist, 'assets'), { recursive: true });
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>INDEX</title>');
writeFileSync(join(dist, 'assets', 'app-123.js'), 'console.log("app")');
writeFileSync(join(dist, 'sw.js'), '/* sw */');
writeFileSync(join(dist, 'manifest.webmanifest'), '{}');
writeFileSync(join(base, 'secret.txt'), 'SECRET');
process.env.VOXEL_WEB_DIST = dist;
process.env.VOXEL_DATA_DIR = join(base, 'data');

const { Hono } = await import('hono');
const { serveWeb } = await import('../src/static.js');

const app = new Hono();
app.get('/healthz', (c) => c.text('ok'));
app.all('/imap/*', (c) => c.json({ error: 'not_found' }, 404));
app.notFound((c) => serveWeb(c) ?? c.text('Not found', 404));

const NAV = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'sec-fetch-mode': 'navigate' };
const SCRIPT = { accept: '*/*', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' };

async function get(path: string, headers: Record<string, string> = NAV) {
  const res = await app.request(`http://voxel.localhost${path}`, { headers });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), cache: res.headers.get('cache-control') };
}

test('les navigations reçoivent index.html, même avec des points ou un @', async () => {
  for (const p of [
    '/',
    '/login',
    '/all/inbox',
    '/m/alice%40example.com/inbox',
    '/m/alice@example.com/inbox',
    '/m/alice@example.com',
    '/m/alice@example.com/inbox/t/abc',
    '/m/alice@example.com/f-a.b/t/T1.2?msg=E.3',
    '/all/inbox/t/alice@example.com/abc',
    '/compose?mailto=mailto%3Aalice%40example.com',
  ]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /INDEX/, p);
    assert.match(r.type, /text\/html/, p);
    assert.equal(r.cache, 'no-cache', p);
  }
});

test('sans Sec-Fetch-Mode, Accept text/html suffit ; sans rien, une URL sans extension connue reçoit aussi l’appli', async () => {
  assert.match((await get('/m/a@b.fr/inbox', { accept: 'text/html' })).body, /INDEX/);
  assert.match((await get('/m/a@b.fr', {})).body, /INDEX/);
});

test('les fichiers présents sont servis tels quels', async () => {
  const js = await get('/assets/app-123.js', SCRIPT);
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);
  assert.match(js.cache ?? '', /immutable/);
  assert.equal((await get('/sw.js', SCRIPT)).body, '/* sw */');
  assert.equal((await get('/index.html')).status, 200);
});

test('un asset manquant reste en 404 (navigation comprise), un fichier racine manquant aussi hors navigation', async () => {
  assert.equal((await get('/assets/missing-1.js', SCRIPT)).status, 404);
  assert.equal((await get('/assets/missing-1.js')).status, 404);
  assert.equal((await get('/assets/sub/x.css', SCRIPT)).status, 404);
  assert.equal((await get('/favicon.ico', { accept: 'image/*', 'sec-fetch-mode': 'no-cors' })).status, 404);
  assert.equal((await get('/workbox-abc.js', SCRIPT)).status, 404);
});

test('aucune remontée de chemin hors du dist', async () => {
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/x/%00']) {
    const r = await get(p);
    assert.doesNotMatch(r.body, /SECRET/, p);
    const s = await get(p, SCRIPT);
    assert.doesNotMatch(s.body, /SECRET/, p);
  }
});

test('/imap et /healthz ne tombent jamais sur index.html', async () => {
  assert.equal((await get('/imap/unknown')).status, 404);
  assert.doesNotMatch((await get('/imap/unknown')).body, /INDEX/);
  assert.doesNotMatch((await get('/imap')).body, /INDEX/);
  assert.equal((await get('/healthz')).body, 'ok');
  assert.doesNotMatch((await get('/healthz/x')).body, /INDEX/);
});

test('encodage invalide : navigation → appli, sinon 404 ; POST jamais servi', async () => {
  assert.match((await get('/m/%E0%A4%A/inbox')).body, /INDEX/);
  assert.equal((await get('/m/%E0%A4%A/inbox', SCRIPT)).status, 404);
  const res = await app.request('http://voxel.localhost/m/a@b.fr/inbox', { method: 'POST' });
  assert.equal(res.status, 404);
});
