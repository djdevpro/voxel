/**
 * Dialectes des serveurs JMAP (Stalwart v1.0.1, Cyrus 3.13.8, mesurés le 2026-11-04) : JSCalendar 2.0
 * (`recurrenceRule` unique, `version` obligatoire chez Cyrus) et fiches JSContact venues de CardDAV.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fromServerEvent, toServerEventSet } from '../src/jscalendar.ts';
import { cardEmails, fromServerCard, toServerCardSet } from '../src/jscontact.ts';
import { vcardToCard } from '../src/vcard.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const typed = { '@type': 'RecurrenceRule', frequency: 'weekly', count: 4, byDay: [{ '@type': 'NDay', day: 'mo' }] };
const untyped = { frequency: 'weekly', count: 4, byDay: [{ day: 'mo' }] };
const typed2 = { '@type': 'RecurrenceRule', frequency: 'daily', interval: 2 };

test('fromServerEvent : recurrenceRule → recurrenceRules typées', () => {
  const ev = { recurrenceRule: clone(untyped), title: 'x' };
  const before = clone(ev);
  const out = fromServerEvent(ev) as Record<string, unknown>;
  assert.deepEqual(out, { title: 'x', recurrenceRules: [typed] });
  assert.equal('recurrenceRule' in out, false);
  assert.deepEqual(ev, before);
});

test('fromServerEvent : recurrenceRule fait foi, null efface la récurrence', () => {
  const out = fromServerEvent({ recurrenceRule: clone(untyped), recurrenceRules: [typed2], excludedRecurrenceRules: [typed2], title: 'x' });
  assert.deepEqual(out, { title: 'x', recurrenceRules: [typed] });
  const none = fromServerEvent({ recurrenceRule: null, recurrenceRules: [typed2], title: 'x' }) as Record<string, unknown>;
  assert.deepEqual(none, { title: 'x' });
  assert.equal('recurrenceRule' in none, false);
  assert.equal('recurrenceRules' in none, false);
});

test('fromServerEvent : sans recurrenceRule, même référence ; idempotente', () => {
  const ev = { recurrenceRules: [typed], title: 'x' };
  assert.equal(fromServerEvent(ev), ev);
  const once = fromServerEvent({ recurrenceRule: clone(untyped), title: 'x' });
  assert.deepEqual(fromServerEvent(once), once);
});

test('toServerEventSet : création en JSCalendar 2.0', () => {
  const args = {
    accountId: 'a',
    create: {
      e1: { title: 'x', recurrenceRules: [typed, typed2], excludedRecurrenceRules: [typed2] },
      e2: { title: 'y', version: '1.0' },
    },
    destroy: ['d1'],
  };
  const before = clone(args);
  const out = toServerEventSet(args);
  assert.deepEqual(out.create.e1, { title: 'x', version: '2.0', recurrenceRule: untyped });
  assert.deepEqual(out.create.e2, { title: 'y', version: '1.0' });
  assert.equal(out.destroy, args.destroy);
  assert.equal(out.accountId, 'a');
  assert.deepEqual(args, before);
});

test('toServerEventSet : patchs entiers', () => {
  const out = toServerEventSet({
    update: { u1: { recurrenceRules: [typed], title: 't' }, u2: { recurrenceRules: null }, u3: { excludedRecurrenceRules: [typed] } },
  });
  assert.deepEqual(out.update.u1, { recurrenceRule: untyped, title: 't' });
  assert.deepEqual(Object.keys(out.update.u1), ['recurrenceRule', 'title']);
  assert.deepEqual(out.update.u2, { recurrenceRule: null });
  assert.deepEqual(out.update.u3, {});
  assert.equal('version' in out.update.u1, false);
});

test('toServerEventSet : patchs par pointeurs', () => {
  const out = toServerEventSet({
    update: {
      u1: {
        'recurrenceRules/0/count': 6,
        'recurrenceRules/1': typed2,
        'excludedRecurrenceRules/0': typed2,
        'participants/p1/participationStatus': 'accepted',
      },
      u2: { 'recurrenceRules/0': typed },
    },
  });
  assert.deepEqual(out.update.u1, { 'recurrenceRule/count': 6, 'participants/p1/participationStatus': 'accepted' });
  assert.deepEqual(out.update.u2, { recurrenceRule: untyped });
});

test('aller-retour : création puis relecture chez Cyrus', () => {
  const rules = [typed];
  const sent = toServerEventSet({ create: { e1: { title: 'x', recurrenceRules: clone(rules) } } }).create.e1 as Record<string, unknown>;
  // Cyrus renvoie la règle avec ses types, et la version 2.0
  const fromCyrus = { ...sent, recurrenceRule: clone(typed), version: '2.0', id: 'E1' };
  const back = fromServerEvent(fromCyrus) as Record<string, unknown>;
  assert.deepEqual(back.recurrenceRules, rules);
  assert.equal('recurrenceRule' in back, false);
});

test('fromServerCard : fiche Apple lue chez Stalwart', () => {
  const card = {
    name: { full: 'Claire Martin' },
    emails: {
      k1: { address: 'claire@icloud.com', contexts: { internet: true, pref: true }, label: '_$!<Other>!$_' },
      k2: { address: 'claire@example.org', contexts: { internet: true, private: true } },
    },
    phones: { k1: { number: '+33 6 12 34 56 78', contexts: { pref: true } } },
    addresses: { k1: { full: '1 rue de la Paix, Paris', contexts: { private: true, pref: true } } },
    links: { k1: { uri: 'https://claire.example.com', contexts: { pref: true }, label: '_$!<HomePage>!$_' } },
    anniversaries: { k1: { kind: 'birth', date: { '@type': 'PartialDate', year: 1604, month: 7, day: 14 } } },
  };
  const before = clone(card);
  const out = fromServerCard(card);
  assert.deepEqual(out.emails.k1, { address: 'claire@icloud.com', pref: 1, label: 'Other' });
  assert.deepEqual(out.emails.k2.contexts, { private: true });
  assert.equal((out.phones.k1 as Record<string, unknown>).pref, 1);
  assert.equal('contexts' in out.phones.k1, false);
  assert.deepEqual(out.addresses.k1, { full: '1 rue de la Paix, Paris', contexts: { private: true }, pref: 1 });
  assert.equal(out.links.k1.label, 'HomePage');
  assert.deepEqual(out.anniversaries.k1.date, { '@type': 'PartialDate', month: 7, day: 14 });
  assert.deepEqual(card, before);
  assert.deepEqual(fromServerCard(out), out);
});

test('fromServerCard : numéros tel: et URL échappées (vCard 3.0)', () => {
  const out = fromServerCard({
    phones: { k2: { number: 'tel:+39-02-1234567' }, k3: { number: 'TEL:+1' } },
    links: { l1: { uri: 'https\\://claire.example.com' } },
  });
  assert.equal(out.phones.k2.number, '+39-02-1234567');
  assert.equal(out.phones.k3.number, '+1');
  assert.equal(out.links.l1.uri, 'https://claire.example.com');
});

test('fromServerCard : fiche de l’interface déjà correcte → même référence', () => {
  const card = vcardToCard(fixture('thunderbird.vcf'));
  assert.equal(fromServerCard(card), card);
});

test('fromServerCard : adresse préférée d’abord, année 2000 gardée', () => {
  const card = {
    emails: {
      k1: { address: 'claire@example.org', contexts: { internet: true, private: true } },
      k2: { address: 'claire.martin@example.com', contexts: { internet: true, pref: true } },
    },
    anniversaries: { k1: { kind: 'birth', date: { '@type': 'PartialDate', year: 2000, month: 2, day: 29 } } },
  };
  const out = fromServerCard(card);
  assert.deepEqual(cardEmails(out), ['claire.martin@example.com', 'claire@example.org']);
  assert.equal(out.anniversaries.k1.date.year, 2000);
});

test('toServerCardSet : version 1.0 aux créations', () => {
  const args = {
    accountId: 'a',
    create: { c1: { name: { full: 'A' } }, c2: { name: { full: 'B' }, version: '2.0' } },
    update: { u1: { 'name/full': 'C' } },
    destroy: ['d1'],
  };
  const before = clone(args);
  const out = toServerCardSet(args);
  assert.deepEqual(out.create.c1, { name: { full: 'A' }, version: '1.0' });
  assert.deepEqual(out.create.c2, { name: { full: 'B' }, version: '2.0' });
  assert.equal(out.update, args.update);
  assert.equal(out.destroy, args.destroy);
  assert.deepEqual(args, before);
});
