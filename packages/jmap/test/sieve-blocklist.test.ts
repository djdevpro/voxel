/**
 * Liste de blocage Sieve.
 * Lancer depuis la racine du dépôt : npx tsx --test packages/jmap/test/sieve-blocklist.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blocklistActivation,
  BlocklistError,
  buildBlocklistScript,
  isFreemailDomain,
  normalizeAddress,
  normalizeDomain,
  parseBlocklistScript,
} from '../src/sieve-blocklist.ts';

const ALL = ['fileinto', 'imap4flags', 'special-use', 'mailboxid', 'vacation'];
const opts = { junkName: 'Junk Mail', junkId: 'mb7', extensions: ALL };

test('normalizeAddress : valides', () => {
  assert.equal(normalizeAddress('  A@B.fr '), 'a@b.fr');
  assert.equal(normalizeAddress('x.y+z@sub.example.com'), 'x.y+z@sub.example.com');
});

test('normalizeAddress : invalides', () => {
  for (const s of ['', 'a@b', 'ab.fr', 'a b@c.fr', 'a"b@c.fr', 'a\\b@c.fr', 'a@@b.fr', `${'a'.repeat(250)}@b.fr`]) assert.equal(normalizeAddress(s), null, s);
});

test('normalizeDomain : valides et préfixes retirés', () => {
  assert.equal(normalizeDomain(' Pickartz.NET '), 'pickartz.net');
  assert.equal(normalizeDomain('@pickartz.net'), 'pickartz.net');
  assert.equal(normalizeDomain('*.pickartz.net'), 'pickartz.net');
  assert.equal(normalizeDomain('a.b.co'), 'a.b.co');
});

test('normalizeDomain : invalides', () => {
  for (const s of ['', 'localhost', 'a@b.fr', 'exa mple.com', 'x.c', 'ex_ample.com', '.com']) assert.equal(normalizeDomain(s), null, s);
});

test('freemail', () => {
  assert.ok(isFreemailDomain('gmail.com'));
  assert.ok(isFreemailDomain('Orange.fr'));
  assert.ok(isFreemailDomain('bbox.fr'));
  assert.ok(!isFreemailDomain('pickartz.net'));
  assert.ok(!isFreemailDomain('example.org'));
});

test('script identique à l’exemple attendu', () => {
  const expected = [
    'require ["fileinto", "imap4flags", "special-use"];',
    '# Voxel : liste de blocage geree par le webmail, ne pas modifier a la main.',
    '# voxel-blocklist v1 {"addresses":["a@b.fr"],"domains":["pickartz.net"]}',
    'if anyof (address :is :all "from" ["a@b.fr"], address :is :domain "from" ["pickartz.net"], address :matches :domain "from" ["*.pickartz.net"]) {',
    '  addflag "$junk";',
    '  fileinto :specialuse "\\\\Junk" "Junk Mail";',
    '  stop;',
    '}',
    '',
  ].join('\n');
  const got = buildBlocklistScript({ addresses: ['a@b.fr'], domains: ['pickartz.net'] }, { ...opts, extensions: ['fileinto', 'imap4flags', 'special-use'] });
  assert.equal(got, expected);
});

test('sans special-use, avec mailboxid', () => {
  const s = buildBlocklistScript({ addresses: ['a@b.fr'], domains: [] }, { ...opts, extensions: ['fileinto', 'imap4flags', 'mailboxid'] });
  assert.match(s, /^require \["fileinto", "imap4flags", "mailboxid"\];/);
  assert.match(s, / {2}fileinto :mailboxid "mb7" "Junk Mail";/);
});

test('sans imap4flags : pas de addflag', () => {
  const s = buildBlocklistScript({ addresses: ['a@b.fr'], domains: [] }, { ...opts, extensions: ['fileinto', 'special-use'] });
  assert.match(s, /^require \["fileinto", "special-use"\];/);
  assert.ok(!s.includes('addflag'));
});

test('aucune extension : fileinto simple', () => {
  const s = buildBlocklistScript({ addresses: ['a@b.fr'], domains: [] }, { ...opts, extensions: [] });
  assert.match(s, /^require \["fileinto"\];/);
  assert.ok(s.includes('\n  fileinto "Junk Mail";\n'));
  assert.ok(!s.includes('addflag') && !s.includes(':specialuse') && !s.includes(':mailboxid'));
});

test('liste vide : commentaires et require seulement', () => {
  const s = buildBlocklistScript({ addresses: [], domains: [] }, opts);
  assert.equal(
    s,
    'require ["fileinto"];\n# Voxel : liste de blocage geree par le webmail, ne pas modifier a la main.\n# voxel-blocklist v1 {"addresses":[],"domains":[]}\n',
  );
});

test('domaines seuls', () => {
  const s = buildBlocklistScript({ addresses: [], domains: ['B.com', 'a.com', 'b.com'] }, opts);
  assert.ok(s.includes('if anyof (address :is :domain "from" ["a.com", "b.com"], address :matches :domain "from" ["*.a.com", "*.b.com"]) {'));
  assert.ok(!s.includes(':all'));
});

test('échappement d’un guillemet et d’un antislash dans le nom du dossier', () => {
  const s = buildBlocklistScript({ addresses: ['a@b.fr'], domains: [] }, { ...opts, junkName: 'Mon "spam" \\ x' });
  assert.ok(s.includes(' "Mon \\"spam\\" \\\\ x";'));
});

test('aller-retour build → parse (trié, minuscules, sans doublon)', () => {
  const list = { addresses: ['Z@b.fr', 'a@b.fr', 'a@b.fr'], domains: ['pickartz.net', '*.x.org'] };
  assert.deepEqual(parseBlocklistScript(buildBlocklistScript(list, opts)), { addresses: ['a@b.fr', 'z@b.fr'], domains: ['pickartz.net', 'x.org'] });
});

test('parse : sans marqueur ou JSON cassé → null', () => {
  assert.equal(parseBlocklistScript('require ["fileinto"];\n'), null);
  assert.equal(parseBlocklistScript('# voxel-blocklist v1 {"addresses":[\n'), null);
  assert.equal(parseBlocklistScript('# voxel-blocklist v1 {"addresses":"x","domains":[]}\n'), null);
});

test('plus de 1000 entrées → erreur', () => {
  const addresses = Array.from({ length: 1001 }, (_, i) => `u${i}@b.fr`);
  assert.throws(() => buildBlocklistScript({ addresses, domains: [] }, opts), (e) => e instanceof BlocklistError && e.code === 'too_many');
  assert.doesNotThrow(() => buildBlocklistScript({ addresses: addresses.slice(1), domains: [] }, opts));
});

// Règle d'activation, avec un « client » simulé (liste renvoyée par SieveScript/get)
test('activation : aucun script → on active', () => {
  assert.deepEqual(blocklistActivation([]), { ours: null, active: false, activeOther: null, canActivate: true });
});

test('activation : notre script actif', () => {
  assert.deepEqual(blocklistActivation([{ id: 's1', name: 'voxel', isActive: true }]), { ours: 's1', active: true, activeOther: null, canActivate: true });
});

test('activation : « vacation » actif → pas d’activation (sauf répondeur coupé)', () => {
  const scripts = [
    { id: 's1', name: 'voxel', isActive: false },
    { id: 'v', name: 'vacation', isActive: true },
  ];
  assert.equal(blocklistActivation(scripts).canActivate, false);
  assert.equal(blocklistActivation(scripts).activeOther, 'vacation');
  assert.equal(blocklistActivation(scripts, true).canActivate, false);
  assert.equal(blocklistActivation(scripts, false).canActivate, true);
});

test('activation : script étranger actif → jamais remplacé', () => {
  const r = blocklistActivation(
    [
      { id: 's1', name: 'voxel', isActive: false },
      { id: 'x', name: 'mes-filtres', isActive: true },
    ],
    false,
  );
  assert.equal(r.canActivate, false);
  assert.equal(r.activeOther, 'mes-filtres');
});
