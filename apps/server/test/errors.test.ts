/**
 * Erreurs de backend → codes API stables (src/http.ts handleError), jamais de pile renvoyée au client.
 * Lancer depuis la racine du dépôt : npx tsx --test apps/server/test/errors.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.VOXEL_DATA_DIR = mkdtempSync(join(tmpdir(), 'voxel-errors-'));

const { Hono } = await import('hono');
const { handleError } = await import('../src/http.js');
const { BackendAuthError, BackendUnavailableError } = await import('../src/backend/types.js');
const { BlobNotFoundError, BlobTooLargeError } = await import('../src/imap/index.js');

const app = new Hono();
app.onError(handleError);
const errors: Record<string, () => Error> = {
  blob: () => new BlobNotFoundError('mabc-1-2'),
  big: () => new BlobTooLargeError(),
  auth: () => new BackendAuthError('IMAP LOGIN failed: [AUTHENTICATIONFAILED] secret detail'),
  down: () => new BackendUnavailableError('connect ECONNREFUSED 10.0.0.1:993'),
  boom: () => new TypeError('Cannot read properties of undefined'),
};
app.get('/:kind', (c) => {
  throw errors[c.req.param('kind')]!();
});

const cases: Array<[string, number, string]> = [
  ['blob', 404, 'not_found'],
  ['big', 413, 'validation'],
  ['auth', 401, 'upstream_auth'],
  ['down', 502, 'upstream_unreachable'],
  ['boom', 500, 'internal'],
];

for (const [kind, status, code] of cases) {
  test(`${kind} → ${status} ${code}`, async () => {
    const warn = console.warn;
    const error = console.error;
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
      const res = await app.request(`http://x/${kind}`);
      assert.equal(res.status, status);
      const text = await res.text();
      const body = JSON.parse(text) as { error: string; message: string };
      assert.equal(body.error, code);
      assert.doesNotMatch(text, /\n\s+at |\.ts:\d+|secret detail|ECONNREFUSED|Cannot read/);
    } finally {
      console.warn = warn;
      console.error = error;
    }
  });
}
