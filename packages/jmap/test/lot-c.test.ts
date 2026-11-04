/**
 * Tests du lot C : accusé de lecture RFC 8098, mbox, priorité, réponses types.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asctime,
  binaryToBytes,
  buildMdn,
  bytesToBinary,
  encodeWord,
  looksLikeMbox,
  MboxSplitter,
  mboxEntry,
  mdnDisposition,
  parsePriority,
  parseTemplates,
  priorityHeaders,
  priorityOf,
  rawMessageDate,
  rfc5322Date,
  splitMbox,
} from '../src/index.ts';

// ------------------------------------------------------------------ accusé de lecture

const mdnBase = {
  from: { name: 'Zoé Dupont', email: 'zoe@example.org' },
  to: { name: null, email: 'alice@example.com' },
  subject: 'Lu : Réunion',
  text: 'Votre message a été affiché.\nÀ bientôt',
  originalMessageId: 'abc@example.com',
  finalRecipient: 'zoe@example.org',
  mode: 'manual' as const,
  date: new Date(Date.UTC(2026, 10, 3, 10, 0, 0)),
  uid: 'u1',
};

test('MDN : en-têtes et structure multipart/report (RFC 8098)', () => {
  const raw = buildMdn(mdnBase);
  const [head, ...rest] = raw.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  assert.match(head!, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.org>\r\n/);
  assert.match(head!, /\r\nTo: alice@example\.com\r\n/);
  assert.match(head!, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(head!, /\r\nDate: Tue, 03 Nov 2026 10:00:00 \+0000\r\n/);
  assert.match(head!, /\r\nMessage-ID: <u1@example\.org>\r\n/);
  assert.match(head!, /\r\nIn-Reply-To: <abc@example\.com>\r\n/);
  assert.match(head!, /\r\nContent-Type: multipart\/report; report-type=disposition-notification; boundary="voxel-mdn-u1"$/);
  // deux parties : texte lisible puis message/disposition-notification, et la fin
  assert.equal(body.split('--voxel-mdn-u1\r\n').length, 3);
  assert.ok(body.endsWith('--voxel-mdn-u1--\r\n'));
  assert.match(body, /Content-Type: message\/disposition-notification\r\n\r\nReporting-UA: Voxel\r\nFinal-Recipient: rfc822;zoe@example\.org\r\nOriginal-Message-ID: <abc@example\.com>\r\nDisposition: manual-action\/MDN-sent-manually; displayed\r\n/);
  // texte décodé
  const b64 = /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n\r\n--/.exec(body)![1]!.replace(/\r\n/g, '');
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), mdnBase.text);
  // lignes CRLF partout, aucune ligne de plus de 998 octets
  assert.ok(!/[^\r]\n/.test(raw));
  assert.ok(raw.split('\r\n').every((l) => l.length <= 998));
});

test('MDN : mode automatique et sans Message-ID d’origine', () => {
  const raw = buildMdn({ ...mdnBase, mode: 'automatic', originalMessageId: null });
  assert.match(raw, /Disposition: automatic-action\/MDN-sent-automatically; displayed/);
  assert.match(raw, /Auto-Submitted: auto-generated/);
  assert.ok(!raw.includes('Original-Message-ID'));
  assert.ok(!raw.includes('In-Reply-To'));
  assert.equal(mdnDisposition('manual'), 'manual-action/MDN-sent-manually; displayed');
});

test('MIME : mot encodé et date', () => {
  assert.equal(encodeWord('Hello'), 'Hello');
  assert.equal(encodeWord('é'), '=?UTF-8?B?w6k=?=');
  assert.equal(rfc5322Date(new Date(Date.UTC(2026, 0, 5, 7, 8, 9))), 'Mon, 05 Jan 2026 07:08:09 +0000');
});

// ------------------------------------------------------------------ mbox

test('mbox : écriture (mboxrd) puis relecture identique', () => {
  const m1 = 'From: a@b.c\r\nSubject: un\r\n\r\nLigne\r\nFrom here on\r\n>From quoted\r\n';
  const m2 = 'From: d@e.f\r\nSubject: deux\r\n\r\ncorps sans fin de ligne';
  const d = new Date(Date.UTC(2026, 10, 3, 9, 5, 1));
  const mbox = mboxEntry(m1, { sender: 'a@b.c', date: d }) + mboxEntry(m2, { date: d });
  assert.ok(mbox.startsWith('From a@b.c Tue Nov  3 09:05:01 2026\n'));
  assert.ok(mbox.includes('\n>From here on\n>>From quoted\n'));
  assert.ok(mbox.includes('\nFrom MAILER-DAEMON Tue Nov  3 09:05:01 2026\n'));
  assert.ok(looksLikeMbox(mbox));
  const back = splitMbox(mbox);
  assert.equal(back.length, 2);
  assert.equal(back[0], m1);
  assert.equal(back[1], `${m2}\r\n`);
});

test('mbox : découpe incrémentale par morceaux arbitraires, CRLF accepté', () => {
  const msgs = Array.from({ length: 5 }, (_, i) => `Subject: m${i}\r\n\r\ncorps ${i}\r\nFrom inside ${i}\r\n`);
  const mbox = msgs.map((m) => mboxEntry(m, { date: new Date(0) })).join('').replace(/\n/g, '\r\n');
  for (const size of [1, 3, 7, 64, 100000]) {
    const s = new MboxSplitter();
    const out: string[] = [];
    for (let i = 0; i < mbox.length; i += size) out.push(...s.push(mbox.slice(i, i + size)));
    out.push(...s.end());
    assert.deepEqual(out, msgs, `morceaux de ${size}`);
  }
});

test('mbox : octets 8 bits conservés, texte avant le premier séparateur ignoré', () => {
  const bytes = new Uint8Array([0xc3, 0xa9, 0xff, 0x00, 0x41]);
  assert.deepEqual(binaryToBytes(bytesToBinary(bytes)), bytes);
  assert.deepEqual(splitMbox('junk\n\nFrom x Thu Jan  1 00:00:00 1970\nSubject: a\n\nb\n'), ['Subject: a\r\n\r\nb\r\n']);
  assert.equal(asctime(new Date(Date.UTC(2026, 10, 13, 0, 0, 0))), 'Fri Nov 13 00:00:00 2026');
  assert.ok(!looksLikeMbox('Subject: a\n'));
});

test('mbox : date d’un message brut pour receivedAt', () => {
  assert.equal(rawMessageDate('Subject: a\r\nDate: Tue, 03 Nov 2026 11:00:00 +0100 (CET)\r\n\r\nDate: faux'), '2026-11-03T10:00:00Z');
  assert.equal(rawMessageDate('Date:\r\n  Wed, 4 Nov 2026 08:00:00 GMT\r\n\r\n'), '2026-11-04T08:00:00Z');
  assert.equal(rawMessageDate('Subject: sans date\r\n\r\n'), undefined);
});

// ------------------------------------------------------------------ priorité

test('priorité : en-têtes à l’envoi et lecture', () => {
  assert.deepEqual(priorityHeaders('high'), { 'X-Priority': '1 (Highest)', Importance: 'high' });
  assert.deepEqual(priorityHeaders('low'), { 'X-Priority': '5 (Lowest)', Importance: 'low' });
  assert.deepEqual(priorityHeaders('normal'), {});
  assert.equal(parsePriority('1 (Highest)'), 'high');
  assert.equal(parsePriority('2'), 'high');
  assert.equal(parsePriority('3 (Normal)', 'high'), 'normal');
  assert.equal(parsePriority(' 5'), 'low');
  assert.equal(parsePriority(null, 'High'), 'high');
  assert.equal(parsePriority(null, 'low'), 'low');
  assert.equal(parsePriority(null, null, 'urgent'), 'high');
  assert.equal(parsePriority(undefined), 'normal');
  assert.equal(priorityOf({ 'header:X-Priority:asText': '1', 'header:Importance:asText': null }), 'high');
  assert.equal(priorityOf(null), 'normal');
});

// ------------------------------------------------------------------ réponses types

test('réponses types : lecture tolérante, doublons et entrées invalides ignorés, tri', () => {
  const list = parseTemplates([
    { id: 'b', name: 'Relance', html: '<p>r</p>', subject: '' },
    { id: 'a', name: 'Accusé', html: '<p>a</p>', subject: 'Bien reçu' },
    { id: 'a', name: 'Doublon', html: '' },
    { id: 'c', name: 3, html: '' },
    null,
  ], 'fr');
  assert.deepEqual(list, [
    { id: 'a', name: 'Accusé', html: '<p>a</p>', subject: 'Bien reçu' },
    { id: 'b', name: 'Relance', html: '<p>r</p>' },
  ]);
  assert.deepEqual(parseTemplates('x'), []);
});
