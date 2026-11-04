/**
 * Conversion iCalendar ↔ JSCalendar et développement des récurrences : séries, exceptions,
 * fuseaux, alarmes, participants, propriétés inconnues, jeux d'invitations réels (Outlook, Google).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanParsedEvent,
  durationSeconds,
  eventSpan,
  formatDuration,
  organizerOf,
  participantEmail,
  utcToZoned,
  zonedToUtc,
  type CalendarEventCreate,
} from '../src/jscalendar.ts';
import { alertMinutes, buildVtimezone, eventToIcs, eventsToIcs, parseIcs } from '../src/ical.ts';
import { expandEvent, ruleToRrule, rruleToRule } from '../src/recurrence.ts';

const CRLF = (s: string) => s.replace(/\r?\n/g, '\r\n');

const SERIES = CRLF(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:Europe/Paris
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:serie-1
DTSTAMP:20261101T000000Z
DTSTART;TZID=Europe/Paris:20261110T090000
DTEND;TZID=Europe/Paris:20261110T100000
SUMMARY:Réunion
LOCATION:Salle 1
DESCRIPTION:Ordre du jour
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261203T080000Z
EXDATE;TZID=Europe/Paris:20261117T090000
TRANSP:OPAQUE
X-FOO;BAR=1:baz
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Rappel
END:VALARM
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER;VALUE=DATE-TIME:20261109T080000Z
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:serie-1
DTSTAMP:20261101T000000Z
RECURRENCE-ID;TZID=Europe/Paris:20261112T090000
DTSTART;TZID=Europe/Paris:20261112T110000
DTEND;TZID=Europe/Paris:20261112T123000
SUMMARY:Réunion déplacée
LOCATION:Salle 1
DESCRIPTION:Ordre du jour
END:VEVENT
END:VCALENDAR
`);

test('fuseaux : heure locale ↔ UTC, heure d’été, flottant', () => {
  assert.equal(new Date(zonedToUtc('2026-11-10T09:00:00', 'Europe/Paris')).toISOString(), '2026-11-10T08:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-07-10T09:00:00', 'Europe/Paris')).toISOString(), '2026-07-10T07:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-10T09:00:00', 'America/New_York')).toISOString(), '2026-11-10T14:00:00.000Z');
  assert.equal(utcToZoned(Date.parse('2026-03-29T01:30:00Z'), 'Europe/Paris'), '2026-03-29T03:30:00');
  // heure inexistante (02:30 le jour du passage) : décalée vers l'avant
  assert.equal(new Date(zonedToUtc('2026-03-29T02:30:00', 'Europe/Paris')).toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-10T09:00:00', 'Etc/UTC')).toISOString(), '2026-11-10T09:00:00.000Z');
});

test('durées', () => {
  assert.equal(durationSeconds('PT1H30M'), 5400);
  assert.equal(durationSeconds('-PT15M'), -900);
  assert.equal(durationSeconds('P1W'), 7 * 86400);
  assert.equal(formatDuration(5400), 'PT1H30M');
  assert.equal(formatDuration(86400), 'P1D');
  assert.equal(formatDuration(0), 'PT0S');
  assert.equal(formatDuration(-900), '-PT15M');
  // un jour nominal traverse le changement d'heure en gardant l'heure murale
  const s = eventSpan({ start: '2026-10-24T09:00:00', timeZone: 'Europe/Paris', duration: 'P1D' });
  assert.equal(s.end - s.start, 25 * 3600_000);
});

test('iCal → JSCalendar : série, exception, EXDATE, fuseau, alarmes, inconnues', () => {
  const { events, method } = parseIcs(SERIES);
  assert.equal(method, null);
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.uid, 'serie-1');
  assert.equal(ev.title, 'Réunion');
  assert.equal(ev.start, '2026-11-10T09:00:00');
  assert.equal(ev.timeZone, 'Europe/Paris');
  assert.equal(ev.duration, 'PT1H');
  assert.equal(ev.freeBusyStatus, 'busy');
  assert.equal(Object.values(ev.locations ?? {})[0]?.name, 'Salle 1');
  const rule = ev.recurrenceRules?.[0];
  assert.equal(rule?.frequency, 'weekly');
  assert.deepEqual(rule?.byDay?.map((d) => d.day), ['tu', 'th']);
  // UNTIL en UTC → date locale du fuseau de la série
  assert.equal(rule?.until, '2026-12-03T09:00:00');
  assert.deepEqual(ev.recurrenceOverrides?.['2026-11-17T09:00:00'], { excluded: true });
  assert.deepEqual(ev.recurrenceOverrides?.['2026-11-12T09:00:00'], { start: '2026-11-12T11:00:00', duration: 'PT1H30M', title: 'Réunion déplacée' });
  const alerts = Object.values(ev.alerts ?? {});
  assert.equal(alerts.length, 2);
  assert.equal(alertMinutes(alerts[0]!), 15);
  assert.deepEqual(alerts[1]!.trigger, { '@type': 'AbsoluteTrigger', when: '2026-11-09T08:00:00Z' });
  const names = (ev.iCalendar?.properties ?? []).map((p) => p[0]);
  assert.deepEqual(names.sort(), ['x-apple-travel-advisory-behavior', 'x-foo']);
});

test('développement : plage, exceptions, exclusions, UNTIL', () => {
  const ev = { ...parseIcs(SERIES).events[0]!, id: 'e1' };
  const occ = expandEvent(ev, Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-21T00:00:00Z'));
  assert.deepEqual(
    occ.map((o) => [o.recurrenceId, new Date(o.start).toISOString(), o.event.title]),
    [
      ['2026-11-10T09:00:00', '2026-11-10T08:00:00.000Z', 'Réunion'],
      ['2026-11-12T09:00:00', '2026-11-12T10:00:00.000Z', 'Réunion déplacée'],
      ['2026-11-19T09:00:00', '2026-11-19T08:00:00.000Z', 'Réunion'],
    ],
  );
  // dernière occurrence : jeudi 3 décembre (UNTIL inclus), rien après
  const all = expandEvent(ev, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-12-31T00:00:00Z'));
  assert.equal(all.length, 7);
  assert.equal(all.at(-1)!.recurrenceId, '2026-12-03T09:00:00');
  assert.equal(all.every((o) => o.eventId === 'e1'), true);
});

test('développement : quotidien N fois, mensuel, annuel, journée entière, RDATE, flottant', () => {
  const daily: CalendarEventCreate = { start: '2026-03-27T09:00:00', timeZone: 'Europe/Paris', duration: 'PT1H', recurrenceRules: [{ frequency: 'daily', count: 4 }] };
  const d = expandEvent(daily, 0, Date.parse('2030-01-01T00:00:00Z'));
  // l'heure murale reste 9 h de part et d'autre du passage à l'heure d'été (29 mars)
  assert.deepEqual(d.map((o) => new Date(o.start).toISOString()), ['2026-03-27T08:00:00.000Z', '2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z', '2026-03-30T07:00:00.000Z']);
  const monthly: CalendarEventCreate = { start: '2026-01-30T10:00:00', timeZone: 'Etc/UTC', duration: 'PT30M', recurrenceRules: [{ frequency: 'monthly', byDay: [{ day: 'fr', nthOfPeriod: -1 }], count: 3 }] };
  assert.deepEqual(expandEvent(monthly, 0, Date.parse('2030-01-01T00:00:00Z')).map((o) => o.recurrenceId), ['2026-01-30T10:00:00', '2026-02-27T10:00:00', '2026-03-27T10:00:00']);
  const yearly: CalendarEventCreate = { start: '2026-05-03T00:00:00', showWithoutTime: true, duration: 'P1D', recurrenceRules: [{ frequency: 'yearly' }], recurrenceOverrides: { '2027-05-03T00:00:00': { excluded: true }, '2027-06-01T00:00:00': {} } };
  const y = expandEvent(yearly, Date.parse('2026-01-01T00:00:00Z'), Date.parse('2028-12-31T00:00:00Z'));
  assert.deepEqual(y.map((o) => o.recurrenceId), ['2026-05-03T00:00:00', '2027-06-01T00:00:00', '2028-05-03T00:00:00']);
  const floating: CalendarEventCreate = { start: '2026-06-01T12:00:00', duration: 'PT1H' };
  const f = expandEvent(floating, 0, Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(f.length, 1);
  assert.equal(f[0]!.recurrenceId, null);
  assert.equal(f[0]!.start, new Date(2026, 5, 1, 12).getTime());
});

test('RRULE ↔ règle JSCalendar', () => {
  const r = rruleToRule('FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO,-1FR;BYMONTH=1,6;COUNT=10;WKST=SU', (x) => x);
  assert.deepEqual(r, {
    '@type': 'RecurrenceRule',
    frequency: 'monthly',
    interval: 2,
    count: 10,
    byDay: [{ '@type': 'NDay', day: 'mo', nthOfPeriod: 1 }, { '@type': 'NDay', day: 'fr', nthOfPeriod: -1 }],
    byMonth: ['1', '6'],
    firstDayOfWeek: 'su',
  });
  assert.equal(ruleToRrule(r), 'FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1MO,-1FR;BYMONTH=1,6;WKST=SU');
});

test('aller-retour JSCalendar → iCal → JSCalendar sans perte', () => {
  const ev = parseIcs(SERIES).events[0]!;
  const ics = eventToIcs(ev);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;.*UNTIL=20261203T080000Z/);
  assert.match(ics, /RRULE:.*BYDAY=TU,TH/);
  assert.match(ics, /EXDATE;TZID=Europe\/Paris:20261117T090000/);
  assert.match(ics, /RECURRENCE-ID;TZID=Europe\/Paris:20261112T090000/);
  assert.match(ics, /X-FOO;BAR=1:baz/);
  const back = parseIcs(ics).events[0]!;
  for (const k of ['uid', 'title', 'description', 'start', 'timeZone', 'duration', 'recurrenceRules', 'recurrenceOverrides', 'freeBusyStatus', 'iCalendar'] as const) {
    assert.deepEqual(back[k], ev[k], k);
  }
  assert.deepEqual(Object.values(back.alerts ?? {}), Object.values(ev.alerts ?? {}));
});

test('journée entière, flottant, UTC', () => {
  const ics = CRLF(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:a
DTSTART;VALUE=DATE:20261121
DTEND;VALUE=DATE:20261123
SUMMARY:Week-end
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART:20261121T100000
DURATION:PT45M
SUMMARY:Flottant
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART:20261121T100000Z
DTEND:20261121T110000Z
SUMMARY:UTC
END:VEVENT
END:VCALENDAR
`);
  const [a, b, c] = parseIcs(ics).events;
  assert.deepEqual([a!.start, a!.showWithoutTime, a!.duration, a!.timeZone], ['2026-11-21T00:00:00', true, 'P2D', undefined]);
  assert.deepEqual([b!.start, b!.duration, b!.timeZone], ['2026-11-21T10:00:00', 'PT45M', undefined]);
  assert.deepEqual([c!.start, c!.timeZone, c!.duration], ['2026-11-21T10:00:00', 'Etc/UTC', 'PT1H']);
  const out = eventsToIcs([a!, b!, c!]);
  assert.match(out, /DTSTART;VALUE=DATE:20261121\r\nDTEND;VALUE=DATE:20261123/);
  assert.match(out, /DTSTART:20261121T100000\r\nDTEND:20261121T104500/);
  assert.match(out, /DTSTART:20261121T100000Z/);
  assert.doesNotMatch(out, /VTIMEZONE/);
});

test('invitation Outlook : METHOD, fuseau Windows, organisateur, participants', () => {
  const ics = CRLF(`BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Romance Standard Time
BEGIN:STANDARD
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN=Alice Martin:mailto:alice@example.com
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Test:mailto:test@example.com
ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Bob:mailto:bob@example.com
DESCRIPTION;LANGUAGE=fr-FR:Point projet
UID:040000008200E00074C5B7101A82E00800000000
SUMMARY;LANGUAGE=fr-FR:Point projet
DTSTART;TZID=Romance Standard Time:20261120T140000
DTEND;TZID=Romance Standard Time:20261120T150000
CLASS:PUBLIC
PRIORITY:5
DTSTAMP:20261101T101010Z
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:0
X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE
END:VEVENT
END:VCALENDAR
`);
  const { method, events } = parseIcs(ics);
  assert.equal(method, 'request');
  const ev = events[0]!;
  assert.equal(ev.timeZone, 'Europe/Paris');
  assert.equal(ev.status, 'confirmed');
  assert.deepEqual(organizerOf(ev), { name: 'Alice Martin', email: 'alice@example.com' });
  const ps = Object.values(ev.participants ?? {});
  assert.equal(ps.length, 3);
  const me = ps.find((p) => participantEmail(p) === 'test@example.com')!;
  assert.deepEqual([me.participationStatus, me.expectReply, me.roles], ['needs-action', true, { attendee: true }]);
  assert.equal(ps.find((p) => p.name === 'Bob')!.roles?.optional, true);
  assert.ok(ev.iCalendar?.properties?.some((p) => p[0] === 'x-microsoft-cdo-busystatus'));
  const out = eventToIcs(ev, { method: 'reply' }).replace(/\r\n /g, '');
  assert.match(out, /METHOD:REPLY/);
  assert.match(out, /ORGANIZER;CN=Alice Martin:mailto:alice@example.com/);
  assert.match(out, /ATTENDEE;CN=Test;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:test@example\.com/);
});

test('fuseau inconnu sans correspondance : converti en UTC par le VTIMEZONE du fichier', () => {
  const ics = CRLF(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Mon fuseau maison
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0300
TZOFFSETTO:+0300
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:z
DTSTART;TZID=Mon fuseau maison:20261120T120000
DTEND;TZID=Mon fuseau maison:20261120T130000
END:VEVENT
END:VCALENDAR
`);
  const ev = parseIcs(ics).events[0]!;
  assert.deepEqual([ev.start, ev.timeZone, ev.duration], ['2026-11-20T09:00:00', 'Etc/UTC', 'PT1H']);
});

test('VTIMEZONE produit depuis Intl', () => {
  const vtz = buildVtimezone('Europe/Paris', 2026, 2026);
  const kinds = vtz[2].map((c) => [c[0], c[1].find((p) => p[0] === 'dtstart')?.[3], c[1].find((p) => p[0] === 'tzoffsetto')?.[3]]);
  assert.deepEqual(kinds, [
    ['daylight', '2026-03-29T02:00:00', '+02:00'],
    ['standard', '2026-10-25T03:00:00', '+01:00'],
  ]);
  const tokyo = buildVtimezone('Asia/Tokyo', 2026, 2026);
  assert.equal(tokyo[2].length, 1);
});

test('nettoyage d’un événement de CalendarEvent/parse (Stalwart)', () => {
  const clean = cleanParsedEvent({ uid: 'x', title: 't', method: 'request', id: null, calendarIds: null, isDraft: null, start: '2026-01-01T00:00:00' });
  assert.deepEqual(clean, { uid: 'x', title: 't', start: '2026-01-01T00:00:00' });
});
