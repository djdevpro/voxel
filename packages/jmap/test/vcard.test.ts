/**
 * Conversion vCard ↔ JSContact (RFC 9555) et fonctions pures des contacts,
 * sur des jeux de vCard au format des exports d'Apple (iCloud), Google, Nextcloud et Thunderbird.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  cardDisplayName,
  cardEmails,
  cardSearchText,
  cardSortKey,
  expandGroup,
  indexLetter,
  sameUid,
  splitVcards,
  type ContactCard,
  type ContactCardCreate,
} from '../src/jscontact.ts';
import { cardToVcard, cardsToVcf, parseVcardDate, parseVcf, vcardToCard } from '../src/vcard.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const vals = <T>(o: Record<string, T> | undefined): T[] => Object.values(o ?? {});
const unknownNames = (c: ContactCardCreate) => (c.vCard?.properties ?? []).map((p) => p[0]);

/** Forme comparable d'une fiche : clés des tableaux associatifs ignorées, valeurs triées. */
function norm(c: ContactCardCreate): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && ['emails', 'phones', 'addresses', 'links', 'notes', 'media', 'nicknames', 'organizations', 'titles', 'anniversaries'].includes(k)) {
      out[k] = Object.values(v as object)
        .map((x) => JSON.stringify(x))
        .sort();
    } else if (k === 'vCard') {
      out[k] = ((v as { properties?: unknown[] }).properties ?? []).map((x) => JSON.stringify(x)).sort();
    } else out[k] = v;
  }
  return out;
}

function roundTrip(c: ContactCardCreate) {
  const again = vcardToCard(cardToVcard(c));
  assert.deepEqual(norm(again), norm(c));
}

test('Apple (iCloud, vCard 3.0) : étiquettes, préférence, date sans année, photo, groupe, propriétés inconnues', () => {
  const text = fixture('apple.vcf');
  assert.equal(splitVcards(text).length, 2);
  const { cards, invalid } = parseVcf(text);
  assert.equal(invalid, 0);
  const [claire, famille] = cards as [ContactCardCreate, ContactCardCreate];
  assert.equal(claire.name?.full, 'Claire Martin');
  assert.deepEqual(claire.name?.components, [
    { kind: 'surname', value: 'Martin' },
    { kind: 'given', value: 'Claire' },
  ]);
  const emails = vals(claire.emails);
  assert.deepEqual(emails.find((e) => e.address === 'claire.martin@example.com'), { address: 'claire.martin@example.com', pref: 1, label: 'Other' });
  assert.deepEqual(emails.find((e) => e.address === 'claire@example.org')?.contexts, { private: true });
  const mobile = vals(claire.phones).find((p) => p.features?.mobile);
  assert.equal(mobile?.number, '+33 6 12 34 56 78');
  assert.equal(mobile?.pref, 1);
  const adr = vals(claire.addresses)[0]!;
  assert.deepEqual(adr.components, [
    { kind: 'name', value: '12 rue de la Paix' },
    { kind: 'locality', value: 'Paris' },
    { kind: 'postcode', value: '75002' },
    { kind: 'country', value: 'France' },
  ]);
  assert.deepEqual(vals(claire.anniversaries)[0], { kind: 'birth', date: { '@type': 'PartialDate', month: 7, day: 14 } });
  assert.equal(vals(claire.links)[0]?.uri, 'https://claire.example.com');
  assert.equal(vals(claire.links)[0]?.label, 'HomePage');
  assert.equal(vals(claire.notes)[0]?.note, 'Rencontrée au salon, 2024.\nÀ rappeler.');
  assert.equal(vals(claire.media)[0]?.uri, 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD');
  assert.deepEqual(vals(claire.organizations)[0], { name: 'Société Exemple', units: [{ name: 'Ventes' }] });
  assert.equal(claire.uid, '4D2C1F3A-1B2C-4D5E-8F90-ABCDEF012345');
  // propriétés sans équivalent : conservées, avec la version d'origine
  assert.deepEqual(unknownNames(claire).sort(), ['version', 'x-abadr', 'x-socialprofile'].sort());
  assert.equal(famille.kind, 'group');
  assert.deepEqual(famille.members, { 'urn:uuid:4D2C1F3A-1B2C-4D5E-8F90-ABCDEF012345': true });
  assert.ok(sameUid('urn:uuid:4D2C1F3A-1B2C-4D5E-8F90-ABCDEF012345', claire.uid));
  // aller-retour sans perte, en 3.0
  const v = cardToVcard(claire);
  assert.match(v, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  assert.match(v, /X-SOCIALPROFILE;TYPE=linkedin:https:\/\/linkedin\.com\/in\/claire/i);
  assert.match(v, /BDAY;X-APPLE-OMIT-YEAR=1604(;VALUE=DATE)?:1604-?07-?14/i);
  assert.match(v, /item\d\.X-ABLABEL:Other/i);
  roundTrip(claire);
  roundTrip(famille);
  assert.match(cardToVcard(famille), /X-ADDRESSBOOKSERVER-KIND:group/i);
});

test('Google (vCard 3.0) : surnom, contextes, catégories, propriétés groupées inconnues', () => {
  const { cards } = parseVcf(fixture('google.vcf'));
  assert.equal(cards.length, 2);
  const [ahmed, bureau] = cards as [ContactCardCreate, ContactCardCreate];
  assert.equal(cardDisplayName({ ...ahmed }), 'Ahmed Benali');
  assert.deepEqual(vals(ahmed.nicknames), [{ name: 'Mido' }]);
  assert.deepEqual(cardEmails(ahmed), ['ahmed.benali@entreprise.example', 'ahmed@gmail.example']);
  assert.deepEqual(vals(ahmed.emails)[0]?.contexts, { work: true });
  assert.deepEqual(ahmed.keywords, { myContacts: true, Collègues: true });
  assert.deepEqual(vals(ahmed.anniversaries)[0]?.date, { '@type': 'PartialDate', year: 1985, month: 3, day: 21 });
  assert.equal(vals(ahmed.links)[0]?.uri, 'http://www.entreprise.example');
  // X-ABRELATEDNAMES et son étiquette (même groupe) restent ensemble
  assert.deepEqual(unknownNames(ahmed).sort(), ['version', 'x-abrelatednames', 'x-ablabel'].sort());
  roundTrip(ahmed);
  assert.equal(cardDisplayName(bureau), "Bureau d'accueil");
  roundTrip(bureau);
});

test('Nextcloud (Sabre, vCard 3.0) : REV, propriété X- conservée', () => {
  const [lucia] = parseVcf(fixture('nextcloud.vcf')).cards as [ContactCardCreate];
  assert.equal(lucia.prodId, '-//Sabre//Sabre VObject 4.5.4//EN');
  assert.equal(lucia.updated, '2025-01-02T10:11:12Z');
  assert.deepEqual(vals(lucia.phones)[0], { number: '+34 91 123 45 67', features: { voice: true }, contexts: { private: true } });
  assert.ok(unknownNames(lucia).includes('x-nc-custom'));
  assert.equal(cardSortKey(lucia), 'fernandez lucia');
  assert.equal(indexLetter(lucia), 'F');
  roundTrip(lucia);
});

test('Thunderbird (vCard 4.0) : PREF, tel: URI, nom complet, anniversaire de mariage, IMPP / GENDER / TZ conservés', () => {
  const [giulia] = parseVcf(fixture('thunderbird.vcf')).cards as [ContactCardCreate];
  assert.deepEqual(giulia.name?.components, [
    { kind: 'surname', value: 'Rossi' },
    { kind: 'given', value: 'Giulia' },
    { kind: 'given2', value: 'Maria' },
    { kind: 'title', value: 'Dott.' },
  ]);
  assert.equal(vals(giulia.emails).find((e) => e.pref === 1)?.address, 'giulia.rossi@example.it');
  assert.ok(vals(giulia.phones).some((p) => p.number === '+39-02-1234567' && p.contexts?.work));
  assert.deepEqual(
    vals(giulia.anniversaries).map((a) => a.kind),
    ['birth', 'wedding'],
  );
  assert.deepEqual(unknownNames(giulia).sort(), ['gender', 'impp', 'tz']);
  const v = cardToVcard(giulia);
  assert.match(v, /^BEGIN:VCARD\r\nVERSION:4\.0\r\n/);
  assert.match(v, /IMPP:xmpp:giulia@example\.it/);
  assert.match(v, /EMAIL;PREF=1:giulia\.rossi@example\.it/);
  roundTrip(giulia);
  assert.ok(cardSearchText(giulia).includes('progetto x'));
});

test('fiche JSContact (forme Stalwart) → vCard 4.0 → fiche, et export 3.0 forcé', () => {
  const card: ContactCard = {
    id: 'e',
    '@type': 'Card',
    version: '1.0',
    uid: 'urn:uuid:11111111-2222-3333-4444-555555555555',
    name: { full: 'Zoé Test', components: [{ kind: 'given', value: 'Zoé' }, { kind: 'surname', value: 'Test' }], isOrdered: true },
    emails: { e1: { address: 'zoe@example.com', contexts: { work: true } } },
    phones: { p1: { number: '+33 1 23', features: { mobile: true } } },
    addresses: { a: { components: [{ kind: 'name', value: '1 rue X' }, { kind: 'locality', value: 'Paris' }], contexts: { private: true }, full: '1 rue X, Paris' } },
    anniversaries: { b: { kind: 'birth', date: { '@type': 'PartialDate', year: 1990, month: 5, day: 3 } } },
    notes: { n: { note: 'ligne 1\nligne 2; avec, ponctuation' } },
    media: { p: { kind: 'photo', blobId: 'abc', mediaType: 'image/png' } },
  };
  const v4 = cardToVcard(card);
  assert.match(v4, /UID:urn:uuid:11111111-2222-3333-4444-555555555555/);
  assert.match(v4, /BDAY:19900503/);
  assert.doesNotMatch(v4, /PHOTO/); // média stocké en blob : pas d'URI à écrire
  const back = vcardToCard(v4);
  assert.equal(back.name?.full, 'Zoé Test');
  assert.equal(vals(back.notes)[0]?.note, 'ligne 1\nligne 2; avec, ponctuation');
  assert.equal(vals(back.addresses)[0]?.full, '1 rue X, Paris');
  const v3 = cardToVcard(card, { version: '3.0' });
  assert.match(v3, /VERSION:3\.0/);
  assert.match(v3, /EMAIL;TYPE=INTERNET,WORK:zoe@example\.com/i);
  assert.match(v3, /TEL;TYPE=CELL:\+33 1 23/i);
  assert.equal(cardsToVcf([card, card]).match(/BEGIN:VCARD/g)?.length, 2);
});

test('dates vCard, découpage, groupes', () => {
  assert.deepEqual(parseVcardDate('--05-03'), { '@type': 'PartialDate', month: 5, day: 3 });
  assert.deepEqual(parseVcardDate('1990'), { '@type': 'PartialDate', year: 1990 });
  assert.deepEqual(parseVcardDate('19900503T101010Z'), { '@type': 'PartialDate', year: 1990, month: 5, day: 3 });
  assert.equal(parseVcardDate('demain'), null);
  assert.deepEqual(splitVcards('﻿bruit\nBEGIN:VCARD\nFN:a\nEND:VCARD\nBEGIN:VCARD\r\nFN:b\r\n c\r\nEND:VCARD'), [
    'BEGIN:VCARD\r\nFN:a\r\nEND:VCARD\r\n',
    'BEGIN:VCARD\r\nFN:b\r\n c\r\nEND:VCARD\r\n',
  ]);
  assert.equal(parseVcf('BEGIN:VCARD\nVERSION:4.0\nFN:ok\nEND:VCARD\nBEGIN:VCARD\nnimporte quoi\nEND:VCARD').invalid, 1);
  const a = { uid: 'A1', name: { full: 'A' }, emails: { e: { address: 'a@x.fr' } } };
  const b = { uid: 'urn:uuid:B2', name: { full: 'B' }, emails: { e: { address: 'b@x.fr' } } };
  const c = { uid: 'C3', name: { full: 'C' } };
  const g = { kind: 'group' as const, members: { 'urn:uuid:a1': true, B2: true, C3: true, Z: false } };
  assert.deepEqual(expandGroup(g, [a, b, c]), [
    { name: 'A', email: 'a@x.fr' },
    { name: 'B', email: 'b@x.fr' },
  ]);
});
