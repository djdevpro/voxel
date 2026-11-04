/**
 * Passerelle IMAP : en-têtes absents ou invalides → 401 / 400, sans aucun appel réseau.
 * Lancer depuis la racine du dépôt : npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-gw-'));
process.env.VOXEL_WEB_DIST = join(process.env.VOXEL_DATA_DIR, 'no-dist');
delete process.env.VOXEL_ALLOW_PRIVATE_HOSTS;

// Tout appel réseau sortant (fetch) fait échouer le test.
let network = 0;
globalThis.fetch = (async () => {
  network++;
  throw new Error('network call during test');
}) as typeof fetch;

const { createApp } = await import('../src/app.js');
const { poolSize } = await import('../src/backend/pool.js');
const app = createApp();

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
const IMAP = 'imap.example.com:993:ssl';
const SMTP = 'smtp.example.com:465:ssl';

async function call(path: string, headers: Record<string, string>) {
  const res = await app.request(`http://voxel.localhost${path}`, { headers });
  return { status: res.status, body: (await res.json()) as { error?: string }, auth: res.headers.get('www-authenticate') };
}

test('GET /imap/session sans en-têtes → 401 invalid_credentials, sans WWW-Authenticate', async () => {
  const r = await call('/imap/session', {});
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'invalid_credentials');
  assert.equal(r.auth, null);
});

test('Authorization mal formé → 401', async () => {
  for (const a of ['Bearer abc', 'Basic !!!', `Basic ${Buffer.from('sansdeuxpoints').toString('base64')}`, basic('', 'x'), basic('a@b.fr', '')]) {
    const r = await call('/imap/session', { authorization: a, 'x-voxel-imap': IMAP, 'x-voxel-smtp': SMTP });
    assert.equal(r.status, 401, a);
  }
});

test('X-Voxel-Imap / X-Voxel-Smtp absents ou invalides → 400 validation', async () => {
  const auth = basic('a@example.com', 'secret');
  const bad: Array<Record<string, string>> = [
    {},
    { 'x-voxel-imap': IMAP },
    { 'x-voxel-imap': 'imap.example.com:993', 'x-voxel-smtp': SMTP },
    { 'x-voxel-imap': 'imap.example.com:993:plain', 'x-voxel-smtp': SMTP },
    { 'x-voxel-imap': 'imap.example.com:6379:ssl', 'x-voxel-smtp': SMTP },
    { 'x-voxel-imap': IMAP, 'x-voxel-smtp': 'smtp.example.com:25:starttls' },
    { 'x-voxel-imap': 'imap example.com:993:ssl', 'x-voxel-smtp': SMTP },
  ];
  for (const h of bad) {
    for (const path of ['/imap/session', '/imap/events']) {
      const r = await call(path, { authorization: auth, ...h });
      assert.equal(r.status, 400, `${path} ${JSON.stringify(h)}`);
      assert.equal(r.body.error, 'validation');
    }
  }
});

test('X-Voxel-Sieve invalide (format, sécurité, port autre que 4190) → 400 validation', async () => {
  const auth = basic('a@example.com', 'secret');
  for (const sieve of ['sieve.example.com:4190', 'sieve.example.com:4190:plain', 'sieve.example.com:22:starttls', 'sieve example.com:4190:ssl']) {
    const r = await call('/imap/session', { authorization: auth, 'x-voxel-imap': IMAP, 'x-voxel-smtp': SMTP, 'x-voxel-sieve': sieve });
    assert.equal(r.status, 400, sieve);
    assert.equal(r.body.error, 'validation');
  }
});

test('X-Voxel-CardDav invalide (http, autre port, identifiants dans l\'URL) → 400 validation', async () => {
  const auth = basic('a@example.com', 'secret');
  for (const dav of ['http://dav.example.com/dav/', 'https://dav.example.com:8443/dav/', 'https://u:p@dav.example.com/dav/', 'dav.example.com']) {
    const r = await call('/imap/session', { authorization: auth, 'x-voxel-imap': IMAP, 'x-voxel-smtp': SMTP, 'x-voxel-carddav': dav });
    assert.equal(r.status, 400, dav);
    assert.equal(r.body.error, 'validation');
  }
});

test('X-Voxel-CalDav invalide (http, autre port, identifiants dans l\'URL) → 400 validation', async () => {
  const auth = basic('a@example.com', 'secret');
  for (const dav of ['http://dav.example.com/dav/cal/', 'https://dav.example.com:8443/dav/', 'https://u:p@dav.example.com/dav/', 'dav.example.com']) {
    const r = await call('/imap/session', { authorization: auth, 'x-voxel-imap': IMAP, 'x-voxel-smtp': SMTP, 'x-voxel-caldav': dav });
    assert.equal(r.status, 400, dav);
    assert.equal(r.body.error, 'validation');
  }
});

test('aucun appel réseau ni façade ouverte', () => {
  assert.equal(network, 0);
  assert.equal(poolSize(), 0);
});

test('/healthz → ok, avec les en-têtes de sécurité', async () => {
  const res = await app.request('http://voxel.localhost/healthz');
  assert.equal(await res.text(), 'ok');
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
  assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(\)/);
});
