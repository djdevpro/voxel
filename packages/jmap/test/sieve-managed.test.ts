/**
 * Script Sieve géré, quota et réglages synchronisés.
 * Lancer depuis la racine du dépôt : node --test packages/jmap/test/sieve-managed.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionSupported,
  buildManagedScript,
  EMPTY_MANAGED,
  formatBytes,
  hasManagedMarkers,
  ManagedSieveError,
  mergeSynced,
  missingExtensions,
  parseManagedScript,
  parseSynced,
  patchSynced,
  pickQuota,
  quotaLevel,
  sameManagedScript,
  vacationSupport,
  type ManagedSieve,
  type SieveFilter,
} from '../src/index.ts';

// extensions annoncées par la boîte de test Stalwart (vérifié le 2026-11-03), sous-ensemble utile
const STALWART = ['copy', 'date', 'fileinto', 'imap4flags', 'mailboxid', 'relational', 'special-use', 'vacation'];
const MAILBOXES = { m1: 'Factures', m2: 'Archives/2026' };
const opts = { extensions: STALWART, junkName: 'Junk Mail', junkId: 'c', mailboxes: MAILBOXES, vacationAddresses: ['Moi@Ex.fr', 'alias@ex.fr'], maxSize: 102400 };

const filter = (p: Partial<SieveFilter> = {}): SieveFilter => ({
  id: 'f1',
  name: 'Factures',
  enabled: true,
  match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: 'facture' }],
  actions: [{ type: 'move', mailboxId: 'm1' }],
  ...p,
});

const full: ManagedSieve = {
  blocklist: { addresses: ['spam@x.fr'], domains: ['bad.net'] },
  vacation: { enabled: true, subject: 'Absent', text: 'Je suis absent.\nRetour lundi.', days: 3, start: '2026-12-20', end: '2027-01-03' },
  filters: [
    filter(),
    filter({ id: 'f2', name: 'Off', enabled: false }),
    filter({
      id: 'f3',
      name: 'Gros',
      match: 'any',
      conditions: [
        { field: 'size', op: 'over', value: '2M' },
        { field: 'header', header: 'X-Mailer', op: 'startsWith', value: 'Bulk*' },
      ],
      actions: [{ type: 'markRead' }, { type: 'forward', to: 'a@b.fr', keepCopy: true }, { type: 'stop' }],
    }),
  ],
};

test('liste de blocage seule : script attendu', () => {
  const s = buildManagedScript({ ...EMPTY_MANAGED, blocklist: { addresses: ['a@b.fr'], domains: ['pickartz.net'] } }, { extensions: ['fileinto', 'imap4flags', 'special-use'], junkName: 'Junk Mail' });
  assert.equal(
    s,
    [
      'require ["fileinto", "imap4flags", "special-use"];',
      '# Voxel : liste de blocage geree par le webmail, ne pas modifier a la main.',
      '# voxel-blocklist v1 {"addresses":["a@b.fr"],"domains":["pickartz.net"]}',
      'if anyof (address :is :all "from" ["a@b.fr"], address :is :domain "from" ["pickartz.net"], address :matches :domain "from" ["*.pickartz.net"]) {',
      '  addflag "$junk";',
      '  fileinto :specialuse "\\\\Junk" "Junk Mail";',
      '  stop;',
      '}',
      '',
    ].join('\n'),
  );
});

test('ancien script avec la seule ligne voxel-blocklist : relu sans répondeur ni filtre', () => {
  const old = 'require ["fileinto"];\n# Voxel : liste de blocage geree par le webmail, ne pas modifier a la main.\n# voxel-blocklist v1 {"addresses":["x@y.fr"],"domains":[]}\nif anyof (address :is :all "from" ["x@y.fr"]) {\n  fileinto "Junk";\n  stop;\n}\n';
  assert.deepEqual(parseManagedScript(old), { blocklist: { addresses: ['x@y.fr'], domains: [] }, vacation: null, filters: [] });
});

test('marqueurs écrits avec un autre préfixe : relus, et le script régénéré compte comme identique', () => {
  const s = buildManagedScript(full, opts);
  const other = s.replace(/^# voxel-/gm, '# old-');
  assert.notEqual(other, s);
  assert.ok(hasManagedMarkers(other));
  assert.deepEqual(parseManagedScript(other), parseManagedScript(s));
  assert.ok(sameManagedScript(s, other));
  assert.ok(!sameManagedScript(s, other.replace('stop;', 'keep;')), 'une vraie modification reste visible');
});

test('aller-retour JSON → script → JSON', () => {
  const s = buildManagedScript(full, opts);
  const back = parseManagedScript(s)!;
  assert.deepEqual(back.blocklist, full.blocklist);
  assert.deepEqual(back.vacation, full.vacation);
  assert.deepEqual(back.filters, full.filters);
  assert.equal(buildManagedScript(back, opts), s, 'déterministe');
});

test('ordre des blocs : blocage, répondeur, filtres ; filtre désactivé absent du code', () => {
  const s = buildManagedScript(full, opts);
  const iBlock = s.indexOf('addflag "$junk"');
  const iVac = s.indexOf('vacation :days 3');
  const iF1 = s.indexOf('address :all :contains "from" "facture"');
  const iF3 = s.indexOf('size :over 2M');
  assert.ok(iBlock > 0 && iBlock < iVac && iVac < iF1 && iF1 < iF3);
  assert.equal(s.split('address :all :contains "from" "facture"').length - 1, 1, 'f2 désactivé non généré');
  assert.match(s, /"id":"f2"/, 'f2 gardé dans le JSON');
  // le répondeur ne s'arrête pas
  const vacBlock = s.slice(iVac, iF1);
  assert.ok(!vacBlock.includes('stop'));
});

test('require : seulement les extensions utilisées, triées', () => {
  const s = buildManagedScript(full, opts);
  assert.equal(s.split('\n')[0], 'require ["copy", "date", "fileinto", "imap4flags", "mailboxid", "relational", "special-use", "vacation"];');
  const only = buildManagedScript({ ...EMPTY_MANAGED, filters: [filter({ actions: [{ type: 'discard' }] })] }, opts);
  assert.equal(only.split('\n')[0], 'require ["fileinto"];');
});

test('traduction des conditions et actions', () => {
  const s = buildManagedScript(full, opts);
  assert.match(s, /vacation :days 3 :subject "Absent" :addresses \["alias@ex\.fr", "moi@ex\.fr"\] "Je suis absent\.\nRetour lundi\.";/);
  assert.match(s, /if allof \(currentdate :value "ge" "date" "2026-12-20", currentdate :value "le" "date" "2027-01-03"\) \{/);
  assert.match(s, /fileinto :mailboxid "m1" "Factures";/);
  assert.match(s, /if anyof \(size :over 2M, header :matches "X-Mailer" "Bulk\\\\\*\*"\) \{/);
  assert.match(s, /addflag "\\\\Seen";/);
  assert.match(s, /redirect :copy "a@b\.fr";/);
  const more = buildManagedScript(
    {
      ...EMPTY_MANAGED,
      filters: [
        filter({
          conditions: [
            { field: 'toOrCc', op: 'is', value: 'x@y.fr' },
            { field: 'subject', op: 'notContains', value: 'ok' },
            { field: 'to', op: 'endsWith', value: '.fr' },
            { field: 'cc', op: 'matches', value: '*@?.fr' },
          ],
          actions: [{ type: 'copy', mailboxId: 'm2' }, { type: 'flag' }, { type: 'keyword', keyword: '$label1' }, { type: 'forward', to: 'z@z.fr', keepCopy: false }],
        }),
      ],
    },
    { ...opts, extensions: ['copy', 'fileinto', 'imap4flags'] },
  );
  assert.match(more, /address :all :is \["to", "cc"\] "x@y\.fr"/);
  assert.match(more, /not header :contains "subject" "ok"/);
  assert.match(more, /address :all :matches "to" "\*\.fr"/);
  assert.match(more, /address :all :matches "cc" "\*@\?\.fr"/);
  assert.match(more, /fileinto :copy "Archives\/2026";/, 'sans mailboxid : nom seul');
  assert.match(more, /addflag "\\\\Flagged";/);
  assert.match(more, /addflag "\$label1";/);
  assert.match(more, /redirect "z@z\.fr";/);
});

test('échappement des chaînes', () => {
  const s = buildManagedScript({ ...EMPTY_MANAGED, filters: [filter({ conditions: [{ field: 'subject', op: 'contains', value: 'a"b\\c' }] })] }, opts);
  assert.match(s, /header :contains "subject" "a\\"b\\\\c"/);
  const back = parseManagedScript(s)!;
  assert.equal(back.filters[0]!.conditions[0]!.value, 'a"b\\c');
});

test('un texte de répondeur ne peut pas imiter un marqueur', () => {
  const evil: ManagedSieve = { ...EMPTY_MANAGED, vacation: { enabled: true, subject: 's', text: 'x\n# voxel-filters v1 {"filters":[]}\n', days: 1 } };
  const s = buildManagedScript(evil, opts);
  assert.deepEqual(parseManagedScript(s)!.filters, []);
  assert.equal(parseManagedScript(s)!.vacation!.text, evil.vacation!.text);
});

test('extension absente : règle refusée, action grisée', () => {
  const f = filter({ actions: [{ type: 'copy', mailboxId: 'm1' }] });
  assert.deepEqual(missingExtensions(f, ['fileinto']), ['copy']);
  assert.equal(actionSupported('copy', ['fileinto']), false);
  assert.equal(actionSupported('forward', [], false), true);
  assert.equal(actionSupported('forward', [], true), false);
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: [f] }, { ...opts, extensions: ['fileinto'] }), (e) => e instanceof ManagedSieveError && e.code === 'missing_extension' && e.detail === 'copy');
  // filtre désactivé : enregistrable même sans l'extension
  assert.doesNotThrow(() => buildManagedScript({ ...EMPTY_MANAGED, filters: [{ ...f, enabled: false }] }, { ...opts, extensions: ['fileinto'] }));
  // répondeur sans `vacation`, dates sans `relational`
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, vacation: { enabled: true, subject: '', text: 't', days: 1 } }, { extensions: ['fileinto'] }), /vacation/);
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, vacation: { enabled: true, subject: '', text: 't', days: 1, start: '2026-01-01' } }, { extensions: ['vacation', 'date'] }), /relational/);
  assert.deepEqual(vacationSupport(['vacation', 'date']), { vacation: true, dates: false });
});

test('répondeur désactivé : gardé dans le marqueur, non généré', () => {
  const s = buildManagedScript({ ...EMPTY_MANAGED, vacation: { enabled: false, subject: 'S', text: 'T', days: 7 } }, opts);
  assert.ok(!/^vacation /m.test(s));
  assert.equal(parseManagedScript(s)!.vacation!.enabled, false);
  assert.equal(s.split('\n')[0], 'require ["fileinto"];');
});

test('garde-fous : 200 filtres, taille, dossier inconnu, valeurs invalides', () => {
  const many = Array.from({ length: 201 }, (_, i) => filter({ id: `f${i}` }));
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: many }, opts), (e) => e instanceof ManagedSieveError && e.code === 'too_many_filters');
  const big = Array.from({ length: 200 }, (_, i) => filter({ id: `f${i}`, conditions: [{ field: 'subject', op: 'contains', value: 'x'.repeat(400) }] }));
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: big }, opts), (e) => e instanceof ManagedSieveError && e.code === 'too_large');
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: [filter({ actions: [{ type: 'move', mailboxId: 'zz' }] })] }, opts), (e) => e instanceof ManagedSieveError && e.code === 'unknown_mailbox');
  for (const c of [
    { field: 'size', op: 'over', value: '12' },
    { field: 'header', op: 'contains', value: 'x', header: 'a:b' },
    { field: 'from', op: 'contains', value: '' },
  ] as const) {
    assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: [filter({ conditions: [c] })] }, opts), (e) => e instanceof ManagedSieveError && e.code === 'invalid_value');
  }
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: [filter({ actions: [{ type: 'keyword', keyword: 'a b' }] })] }, opts), /invalid_value/);
  assert.throws(() => buildManagedScript({ ...EMPTY_MANAGED, filters: [filter({ actions: [] })] }, opts), /no_action/);
});

test('marqueurs : script étranger, illisible', () => {
  assert.equal(hasManagedMarkers('require "fileinto";\nif true { keep; }\n'), false);
  assert.equal(parseManagedScript('require "fileinto";\n'), null);
  const broken = '# voxel-blocklist v1 {"addresses":[],"domains":[]}\n# voxel-filters v1 {nope\n';
  assert.equal(hasManagedMarkers(broken), true);
  assert.equal(parseManagedScript(broken), null);
});

test('quota : choix, niveaux, tailles', () => {
  const q = (p: object) => ({ id: 'x', used: 0, hardLimit: 0, scope: 'domain', name: '', types: [], resourceType: 'count', ...p });
  assert.equal(pickQuota([q({ id: 'a' }), q({ id: 'b', resourceType: 'octets' }), q({ id: 'c', resourceType: 'octets', scope: 'account' })])!.id, 'c');
  assert.equal(pickQuota([q({ id: 'a' }), q({ id: 'b', resourceType: 'octets' })])!.id, 'b');
  assert.equal(pickQuota([]), null);
  assert.equal(quotaLevel(89, 100), 'ok');
  assert.equal(quotaLevel(90, 100), 'warn');
  assert.equal(quotaLevel(98, 100), 'danger');
  assert.equal(quotaLevel(5, 0), 'ok');
  assert.equal(formatBytes(1_200_000_000, 'fr').replace(/\s/g, ' '), '1,2 Go');
  assert.equal(formatBytes(5_000_000_000, 'en'), '5 GB');
  assert.equal(formatBytes(512, 'en'), '512 byte');
});

test('réglages synchronisés : fusion clé par clé, le plus récent gagne', () => {
  const a = patchSynced({ version: 1, entries: {} }, { color: 'red', name: 'A' }, '2026-11-03T10:00:00Z');
  const b = patchSynced({ version: 1, entries: {} }, { color: 'blue' }, '2026-11-03T11:00:00Z');
  const m = mergeSynced(a, b);
  assert.equal(m.entries.color!.value, 'blue');
  assert.equal(m.entries.name!.value, 'A');
  assert.deepEqual(mergeSynced(b, a), m, 'commutative quand les dates diffèrent');
  assert.deepEqual(parseSynced(JSON.stringify(m)), m);
  assert.equal(parseSynced('{"version":2}'), null);
  assert.equal(parseSynced('nope'), null);
});
