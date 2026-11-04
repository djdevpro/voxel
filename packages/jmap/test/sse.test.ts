/**
 * Analyseur SSE du push JMAP.
 * Lancer depuis la racine du dépôt : npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSseParser, type SseEvent } from '../src/sse.ts';

const STATE = JSON.stringify({ '@type': 'StateChange', changed: { a1: { Email: 's2' } } });
const STREAM = `: commentaire\r\nevent: ping\r\ndata: {"interval":30}\r\n\r\nevent: state\r\nid: 42\r\ndata: ${STATE}\r\n\r\nevent: ping\ndata: {}\n\n`;

function feed(chunks: string[]): SseEvent[] {
  const p = createSseParser();
  return chunks.flatMap((c) => p.push(c));
}

test('flux entier : ping et state reconnus, id transmis', () => {
  const evs = feed([STREAM]);
  assert.deepEqual(
    evs.map((e) => e.event),
    ['ping', 'state', 'ping'],
  );
  const state = evs.find((e) => e.event === 'state')!;
  assert.equal(state.id, '42');
  assert.deepEqual(JSON.parse(state.data), JSON.parse(STATE));
});

test('flux découpé en morceaux arbitraires : même résultat', () => {
  const whole = feed([STREAM]);
  for (let seed = 1; seed <= 50; seed++) {
    const chunks: string[] = [];
    let i = 0;
    let x = seed;
    while (i < STREAM.length) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const n = 1 + (x % 7);
      chunks.push(STREAM.slice(i, i + n));
      i += n;
    }
    assert.deepEqual(feed(chunks), whole, `découpage ${seed}`);
  }
  // un caractère à la fois (coupe aussi les \r\n)
  assert.deepEqual(feed([...STREAM]), whole);
});

test('ping ignoré par le filtre du client, state transmis', () => {
  const received: unknown[] = [];
  for (const ev of feed([STREAM])) {
    if (ev.event === 'ping') continue;
    const d = JSON.parse(ev.data) as { '@type'?: string };
    if (d['@type'] === 'StateChange') received.push(d);
  }
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], JSON.parse(STATE));
});

test('data sur plusieurs lignes et événement sans nom', () => {
  const evs = feed(['data: a\ndata: b\n\n']);
  assert.deepEqual(evs, [{ event: 'message', data: 'a\nb' }]);
});

test('événement incomplet non émis', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('event: state\ndata: {}\n'), []);
  assert.equal(p.push('\n').length, 1);
});
