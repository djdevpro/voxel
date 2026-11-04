/**
 * Intégration du lot B1 contre la boîte de test dédiée, par IMAP (la passerelle), ignorée sans
 * VOXEL_TEST_USER / VOXEL_TEST_PASSWORD / VOXEL_TEST_IMAP / VOXEL_TEST_SMTP. Lancer depuis la racine :
 *   node --env-file=.env.test.local --import tsx --test apps/server/test/integration-b1.test.ts
 * Le port ManageSieve (4190) du serveur n'est pas joignable d'ici : seul QUOTA est testé pour de vrai.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-b1-'));

const { USER, PASS, IMAP, SMTP } = {
  USER: process.env.VOXEL_TEST_USER,
  PASS: process.env.VOXEL_TEST_PASSWORD,
  IMAP: process.env.VOXEL_TEST_IMAP,
  SMTP: process.env.VOXEL_TEST_SMTP,
};
const skip = !USER || !PASS || !IMAP || !SMTP ? 'VOXEL_TEST_* non définies' : false;

const { createImapBackend } = await import('../src/imap/index.js');
const { parseEndpoint } = await import('../src/routes/imap.js');
type Backend = ReturnType<typeof createImapBackend>;
let backend: Backend | null = null;

after(async () => {
  await backend?.close();
});

const kv = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k) };
};

test('passerelle IMAP : QUOTA annoncé selon CAPABILITY, Quota/get répond ; pas de Sieve sans X-Voxel-Sieve', { skip }, async () => {
  backend = createImapBackend(
    { email: USER!, username: USER!, auth: { password: PASS! }, imap: parseEndpoint('imap', IMAP)!, smtp: parseEndpoint('smtp', SMTP)! },
    kv(),
  );
  await backend.verify();
  await backend.probe?.();
  const s = await backend.session();
  const hasQuota = 'urn:ietf:params:jmap:quota' in s.capabilities;
  assert.equal('urn:ietf:params:jmap:sieve' in s.capabilities, false);
  assert.equal('urn:ietf:params:jmap:vacationresponse' in s.capabilities, false);
  const r = await backend.api({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:quota', 'urn:ietf:params:jmap:sieve'],
    methodCalls: [
      ['Quota/get', { accountId: 'a', ids: null }, 'q'],
      ['SieveScript/get', { accountId: 'a', ids: null }, 's'],
    ],
  });
  const [q, sv] = r.methodResponses;
  if (hasQuota) {
    assert.equal(q![0], 'Quota/get', JSON.stringify(q));
    const list = (q![1] as { list: Array<{ resourceType: string; used: number; hardLimit: number }> }).list;
    for (const x of list) {
      assert.equal(x.resourceType, 'octets');
      assert.ok(x.hardLimit > 0 && x.used >= 0);
    }
    console.log(`QUOTA annoncé ; quotas renvoyés : ${list.length}`);
  } else {
    assert.equal(q![0], 'error');
    console.log('QUOTA non annoncé par ce serveur IMAP');
  }
  assert.equal(sv![0], 'error');
  assert.equal((sv![1] as { type: string }).type, 'unknownMethod');
});
