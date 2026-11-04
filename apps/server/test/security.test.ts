/**
 * Non-régression sécurité (revue SEC-01…SEC-14), sans réseau ni serveur mail.
 * Lancer depuis la racine du dépôt : npx tsx --test apps/server/test/security.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

if (!process.env.VOXEL_DATA_DIR) process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-sec-'));
delete process.env.VOXEL_ALLOW_PRIVATE_HOSTS;

const ng = await import('../src/netguard.js');
const { safeMimeType, blobHeaders } = await import('../src/routes/imap.js');
const rl = await import('../src/ratelimit.js');
const { fingerprint } = await import('../src/backend/pool.js');

test('SEC-03 : IPv6 mappées ou embarquant une IPv4 privée refusées', () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '::7f00:1', '::ffff:0:7f00:1', '64:ff9b::a00:1',
    '2002:a00:1::1', '2001::1', 'fec0::1', 'fe80::1', 'fd00::1', '::1', '::', '100::1', 'pas-une-ip']) {
    assert.equal(ng.isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(ng.isPrivateIp(ip), false, ip);
});

test('SEC-03 : assertPublicHost refuse les littéraux IPv6 mappés', async () => {
  for (const h of ['[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '127.0.0.1', 'localhost', 'redis']) {
    await assert.rejects(ng.assertPublicHost(h), ng.BlockedHostError, h);
  }
});

test('SEC-02 : safeFetch refuse http et les hôtes privés', async () => {
  await assert.rejects(ng.safeFetch('http://example.com/'), ng.BlockedHostError);
  await assert.rejects(ng.safeFetch('https://[::ffff:127.0.0.1]:8443/'), ng.BlockedHostError);
});

test('SEC-06 : ports IMAP/SMTP restreints', () => {
  assert.equal(ng.isAllowedPort('imap', 993), true);
  assert.equal(ng.isAllowedPort('imap', 6379), false);
  assert.equal(ng.isAllowedPort('smtp', 587), true);
  assert.equal(ng.isAllowedPort('smtp', 22), false);
  assert.equal(ng.isAllowedPort('smtp', 25), false);
});

test('SEC-04 : type MIME jamais reflété, CSP sandbox sur tous les blobs', () => {
  assert.equal(safeMimeType('application/pdf,text/html'), 'application/octet-stream');
  const h = blobHeaders('application/pdf,text/html', 'x', true);
  assert.equal(h['Content-Type'], 'application/octet-stream');
  assert.match(h['Content-Disposition']!, /^attachment/);
  assert.match(h['Content-Security-Policy']!, /sandbox/);
  assert.match(blobHeaders('text/html', 'x.html', true)['Content-Disposition']!, /^attachment/);
  const pdf = blobHeaders('application/pdf', 'x.pdf', true);
  assert.match(pdf['Content-Disposition']!, /^inline/);
  assert.match(pdf['Content-Security-Policy']!, /sandbox/);
});

test('SEC-08 : 10 échecs de connexion par adresse et par IP', () => {
  rl.resetRateLimits();
  const ip = '8.8.4.4';
  for (let i = 0; i < 10; i++) {
    rl.assertNotLimited('login', ip, `p${i}@example.com`);
    rl.recordAttempt('login', ip, `p${i}@example.com`);
  }
  assert.throws(() => rl.assertNotLimited('login', ip, 'p10@example.com'));
});

test('IP non routable (passerelle Docker) : clé partagée au seuil large, limite par adresse conservée', () => {
  rl.resetRateLimits();
  for (let i = 0; i < 12; i++) rl.recordAttempt('login', '172.18.0.1', `g${i}@example.com`);
  rl.assertNotLimited('login', '172.18.0.1', 'autre@example.com');
  for (let i = 0; i < 10; i++) rl.recordAttempt('login', 'fd00::1', 'cible@example.com');
  assert.throws(() => rl.assertNotLimited('login', '172.18.0.1', 'cible@example.com'));
});

test('SEC-01 : empreinte du pool stable et distincte selon les hôtes et le mot de passe', () => {
  const t = { username: 'a@b.fr', password: 'x', imap: { host: 'imap.b.fr', port: 993, secure: true }, smtp: { host: 'smtp.b.fr', port: 465, secure: true } };
  assert.equal(fingerprint(t), fingerprint({ ...t, imap: { ...t.imap, host: 'IMAP.b.fr' } }));
  assert.notEqual(fingerprint(t), fingerprint({ ...t, imap: { ...t.imap, host: 'evil.example' } }));
  assert.notEqual(fingerprint(t), fingerprint({ ...t, password: 'y' }));
});
