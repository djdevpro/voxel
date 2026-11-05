//! Conversions calcard + règles K, C et W sur les jeux d'essai réels (`tests/fixtures/`), attentes tirées de la sortie
//! des convertisseurs TS. Les modules sont privés à la crate : le test les compile depuis leurs sources.

#[path = "../src/convert.rs"]
#[allow(dead_code)]
mod convert;
#[path = "../src/patch.rs"]
#[allow(dead_code)]
mod patch;
#[path = "../src/recurrence.rs"]
#[allow(dead_code)]
mod recurrence;

use chrono::{Local, NaiveDate, TimeZone};
use serde_json::{Value, json};

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path).unwrap()
}

/// Entrée d'une table (`emails`, `phones`…) dont `key` vaut `value`.
fn entry<'a>(card: &'a Value, table: &str, key: &str, value: &str) -> &'a Value {
    card[table]
        .as_object()
        .and_then(|t| t.values().find(|e| e[key] == value))
        .unwrap_or_else(|| panic!("{table} sans {key} = {value}"))
}

fn participant<'a>(event: &'a Value, address: &str) -> &'a Value {
    event["participants"]
        .as_object()
        .and_then(|t| t.values().find(|p| p["calendarAddress"] == address))
        .unwrap_or_else(|| panic!("pas de participant {address}"))
}

fn alert<'a>(event: &'a Value, trigger_type: &str) -> &'a Value {
    event["alerts"]
        .as_object()
        .and_then(|t| t.values().find(|a| a["trigger"]["@type"] == trigger_type))
        .unwrap_or_else(|| panic!("pas d'alerte {trigger_type}"))
}

#[test]
fn apple_vcf() {
    let (cards, invalid) = convert::parse_vcf(&fixture("apple.vcf"));
    assert_eq!((cards.len(), invalid), (2, 0));
    let c = &cards[0];
    assert_eq!(c["name"]["full"], "Claire Martin");
    let e1 = entry(c, "emails", "address", "claire.martin@example.com");
    assert_eq!(e1["pref"], 1);
    assert_eq!(e1["label"], "Other");
    assert!(e1.get("contexts").is_none());
    let e2 = entry(c, "emails", "address", "claire@example.org");
    assert_eq!(e2["contexts"], json!({"private": true}));
    let p = entry(c, "phones", "number", "+33 6 12 34 56 78");
    assert_eq!(p["features"]["mobile"], true);
    assert_eq!(p["pref"], 1);
    let a = c["addresses"].as_object().unwrap().values().next().unwrap();
    assert_eq!(a["isOrdered"], true);
    assert_eq!(a["pref"], 1);
    let l = c["links"].as_object().unwrap().values().next().unwrap();
    assert_eq!(l["label"], "HomePage");
    let b = c["anniversaries"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert_eq!(b["date"]["month"], 7);
    assert_eq!(b["date"]["day"], 14);
    assert!(b["date"].get("year").is_none());
    let m = c["media"].as_object().unwrap().values().next().unwrap();
    assert_eq!(m["mediaType"], "image/jpeg");

    let g = &cards[1];
    assert_eq!(g["kind"], "group");
    assert_eq!(
        g["members"]["urn:uuid:4D2C1F3A-1B2C-4D5E-8F90-ABCDEF012345"],
        true
    );
    let props = g["vCard"]["properties"].as_array().unwrap();
    assert!(
        !props
            .iter()
            .any(|p| p[0].as_str().unwrap().starts_with("x-addressbookserver"))
    );
}

#[test]
fn google_vcf() {
    let c = convert::vcard_to_card(&fixture("google.vcf")).unwrap();
    let n = c["nicknames"].as_object().unwrap().values().next().unwrap();
    assert_eq!(n["name"], "Mido");
    assert_eq!(
        c["keywords"],
        json!({"myContacts": true, "Collègues": true})
    );
    let b = c["anniversaries"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert_eq!(
        (&b["date"]["year"], &b["date"]["month"], &b["date"]["day"]),
        (&json!(1985), &json!(3), &json!(21))
    );
    let a = c["addresses"].as_object().unwrap().values().next().unwrap();
    assert_eq!(a["isOrdered"], true);
}

#[test]
fn nextcloud_vcf() {
    let c = convert::vcard_to_card(&fixture("nextcloud.vcf")).unwrap();
    assert_eq!(c["updated"], "2025-01-02T10:11:12Z");
    assert_eq!(c["keywords"]["Amigos"], true);
    let props = c["vCard"]["properties"].as_array().unwrap();
    assert!(
        props
            .iter()
            .any(|p| p[0] == "x-nc-custom" && p[3] == "valeur")
    );
}

#[test]
fn thunderbird_vcf() {
    let c = convert::vcard_to_card(&fixture("thunderbird.vcf")).unwrap();
    let p = entry(&c, "phones", "number", "+39-02-1234567");
    assert_eq!(p["contexts"]["work"], true);
    let comps = c["name"]["components"].as_array().unwrap();
    assert!(comps.contains(&json!({"kind": "given2", "value": "Maria"})));
    assert!(comps.contains(&json!({"kind": "title", "value": "Dott."})));
    let dates: Vec<(Value, Value)> = c["anniversaries"]
        .as_object()
        .unwrap()
        .values()
        .map(|a| (a["kind"].clone(), a["date"].clone()))
        .collect();
    assert!(dates.contains(&(
        json!("birth"),
        json!({"@type": "PartialDate", "year": 1992, "month": 2, "day": 29})
    )));
    assert!(dates.contains(&(
        json!("wedding"),
        json!({"@type": "PartialDate", "year": 2015, "month": 6, "day": 12})
    )));
}

#[test]
fn recurring_ics() {
    let events = convert::ics_to_events(&fixture("recurring.ics"));
    assert_eq!(events.len(), 2);
    let e = &events[0];
    assert_eq!(
        e["recurrenceRules"],
        json!([{"@type": "RecurrenceRule", "frequency": "weekly", "count": 3}])
    );
    assert_eq!(e["timeZone"], "Europe/Paris");
    assert_eq!(
        e["recurrenceOverrides"]["2026-11-12T10:00:00"],
        json!({"excluded": true})
    );
    let moved = &e["recurrenceOverrides"]["2026-11-19T10:00:00"];
    assert_eq!(moved["start"], "2026-11-19T14:00:00");
    assert_eq!(moved["title"], "Réunion déplacée");
    assert_eq!(
        participant(e, "mailto:alice@example.com")["roles"],
        json!({"owner": true})
    );
    let bob = participant(e, "mailto:bob@example.com");
    assert_eq!(bob["roles"], json!({"attendee": true}));
    assert_eq!(bob["participationStatus"], "accepted");
    assert_eq!(alert(e, "OffsetTrigger")["trigger"]["offset"], "-PT15M");
}

#[test]
fn attendees_ics() {
    let e = &convert::ics_to_events(&fixture("attendees.ics"))[0];
    let chloe = participant(e, "mailto:chloe@example.com");
    assert_eq!(chloe["roles"], json!({"chair": true, "attendee": true}));
    assert_eq!(chloe["expectReply"], true);
    let dan = participant(e, "mailto:dan@example.com");
    assert_eq!(dan["roles"], json!({"optional": true, "attendee": true}));
    assert_eq!(dan["participationStatus"], "needs-action");
    let room = participant(e, "mailto:salle@example.com");
    assert_eq!(room["roles"], json!({"informational": true}));
    assert_eq!(room["kind"], "location");
    assert_eq!(room["participationStatus"], "needs-action");
    let eve = participant(e, "mailto:eve@example.com");
    assert_eq!(eve["roles"], json!({"attendee": true}));
    assert_eq!(eve["participationStatus"], "needs-action");
    let offset = alert(e, "OffsetTrigger");
    assert_eq!(offset["trigger"]["offset"], "PT5M");
    assert_eq!(offset["trigger"]["relativeTo"], "end");
    assert_eq!(offset["action"], "email");
    let absolute = alert(e, "AbsoluteTrigger");
    assert_eq!(absolute["trigger"]["when"], "2026-11-10T13:00:00Z");
    assert_eq!(absolute["action"], "display");
    assert_eq!(e["keywords"], json!({"Travail": true, "Projet": true}));
    assert_eq!(e["privacy"], "private");
    assert_eq!(e["freeBusyStatus"], "free");
    assert_eq!(e["status"], "tentative");
    assert_eq!(e["priority"], 1);
    assert_eq!(e["color"], "red");
    assert_eq!(e["sequence"], 2);
    assert_eq!(e["created"], "2026-10-01T08:00:00Z");
}

#[test]
fn exchange_ics() {
    let e = &convert::ics_to_events(&fixture("exchange.ics"))[0];
    assert_eq!(e["timeZone"], "Europe/Berlin");
    let r = &e["recurrenceRules"][0];
    assert_eq!(r["frequency"], "weekly");
    assert_eq!(r["interval"], 2);
    assert_eq!(r["until"], "2026-12-31T23:59:59");
    assert_eq!(
        r["byDay"],
        json!([{"@type": "NDay", "day": "mo"}, {"@type": "NDay", "day": "we"}])
    );
    assert_eq!(e["recurrenceOverrides"]["2026-11-07T09:00:00"], json!({}));
}

#[test]
fn floating_ics() {
    let e = &convert::ics_to_events(&fixture("floating.ics"))[0];
    assert!(e.get("timeZone").is_none());
    let r = &e["recurrenceRules"][0];
    assert_eq!(r["frequency"], "monthly");
    assert_eq!(r["count"], 4);
    assert_eq!(r["byMonthDay"], json!([20]));
}

#[test]
fn round_trips() {
    let e = convert::ics_to_events(&fixture("recurring.ics")).remove(0);
    let ics = convert::event_to_ics(&e).unwrap();
    assert!(ics.contains("BEGIN:VTIMEZONE"), "{ics}");
    assert!(ics.contains("TZID:Europe/Paris"), "{ics}");
    let again = convert::ics_to_events(&ics).remove(0);
    assert_eq!(again["recurrenceRules"], e["recurrenceRules"]);
    assert_eq!(again["recurrenceOverrides"], e["recurrenceOverrides"]);
    let roles = |ev: &Value| {
        let mut r: Vec<String> = ev["participants"]
            .as_object()
            .unwrap()
            .values()
            .map(|p| format!("{} {}", p["calendarAddress"], p["roles"]))
            .collect();
        r.sort();
        r
    };
    assert_eq!(roles(&again), roles(&e));

    let c = convert::vcard_to_card(&fixture("google.vcf")).unwrap();
    let text = convert::card_to_vcard(&c).unwrap();
    let back = convert::vcard_to_card(&text).unwrap();
    assert_eq!(back["name"]["full"], c["name"]["full"]);
    assert_eq!(back["name"]["components"], c["name"]["components"]);
    assert_eq!(back["emails"], c["emails"]);
    assert_eq!(back["anniversaries"], c["anniversaries"]);
}

#[test]
fn expand_recurring() {
    let ics = fixture("recurring.ics");
    let e = convert::ics_to_events(&ics).remove(0);
    let utc = |d: u32| {
        chrono::Utc
            .with_ymd_and_hms(2026, if d == 0 { 12 } else { 11 }, d.max(1), 0, 0, 0)
            .unwrap()
            .timestamp_millis()
    };
    let occ = recurrence::expand(&ics, &e, utc(1), utc(0), None);
    let ids: Vec<Option<String>> = occ.iter().map(|o| o.recurrence_id.clone()).collect();
    assert_eq!(
        ids,
        vec![
            Some("2026-11-05T10:00:00".to_string()),
            Some("2026-11-19T10:00:00".to_string())
        ]
    );
    // 19 novembre, 14:00 à Paris = 13:00 UTC
    let moved = chrono::Utc
        .with_ymd_and_hms(2026, 11, 19, 13, 0, 0)
        .unwrap()
        .timestamp_millis();
    assert_eq!(occ[1].start_ms, moved);
    assert_eq!(occ[1].event["title"], "Réunion déplacée");
    assert_eq!(occ[1].end_ms - occ[1].start_ms, 3_600_000);

    // journée entière : heure locale de la machine
    let noel = convert::ics_to_events(&ics).remove(1);
    let (start, end) = recurrence::event_span(&noel);
    let local = |d: u32| {
        let n = NaiveDate::from_ymd_opt(2026, 12, d)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        Local.from_local_datetime(&n).unwrap().timestamp_millis()
    };
    assert_eq!((start, end), (local(24), local(26)));
}

#[test]
fn apple_group_round_trip_keeps_apple_properties() {
    let cards = convert::parse_vcf(&fixture("apple.vcf")).0;
    let text = convert::card_to_vcard(&cards[1]).unwrap();
    let upper = text.to_uppercase();
    assert!(upper.contains("X-ADDRESSBOOKSERVER-KIND:GROUP"), "{text}");
    assert!(
        upper.contains("X-ADDRESSBOOKSERVER-MEMBER:URN:UUID:4D2C1F3A-1B2C-4D5E-8F90-ABCDEF012345"),
        "{text}"
    );
    assert!(
        !text
            .lines()
            .any(|l| l.starts_with("KIND:") || l.starts_with("MEMBER:")),
        "{text}"
    );
    let back = convert::vcard_to_card(&text).unwrap();
    assert_eq!(back["kind"], "group");
    assert_eq!(
        back["members"]["urn:uuid:4D2C1F3A-1B2C-4D5E-8F90-ABCDEF012345"],
        true
    );
}

#[test]
fn daily_series_started_twenty_years_ago() {
    let ics = concat!(
        "BEGIN:VCALENDAR
",
        "VERSION:2.0
",
        "PRODID:-//t//EN
",
        "BEGIN:VEVENT
",
        "UID:daily
",
        "DTSTAMP:20061101T000000Z
",
        "DTSTART:20061101T080000Z
",
        "DURATION:PT30M
",
        "RRULE:FREQ=DAILY
",
        "SUMMARY:Quotidien
",
        "END:VEVENT
",
        "END:VCALENDAR
"
    );
    let e = convert::ics_to_events(ics).remove(0);
    let from = chrono::Utc
        .with_ymd_and_hms(2026, 11, 1, 0, 0, 0)
        .unwrap()
        .timestamp_millis();
    let to = chrono::Utc
        .with_ymd_and_hms(2026, 11, 8, 0, 0, 0)
        .unwrap()
        .timestamp_millis();
    let occ = recurrence::expand(ics, &e, from, to, None);
    assert_eq!(occ.len(), 7);
    assert_eq!(occ[0].start_ms, from + 8 * 3_600_000);
}

fn calendar(lines: &[&str]) -> String {
    let mut all = vec!["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN"];
    all.extend_from_slice(lines);
    all.push("END:VCALENDAR");
    all.push("");
    all.join("\r\n")
}

fn utc_ms(y: i32, m: u32, d: u32, h: u32) -> i64 {
    chrono::Utc
        .with_ymd_and_hms(y, m, d, h, 0, 0)
        .unwrap()
        .timestamp_millis()
}

/// Série hebdomadaire à Paris (5, 12, 19, 26 novembre 2026 à 10:00), plus une exception donnée.
fn weekly_with(exception: &[&str]) -> String {
    let mut lines = vec![
        "BEGIN:VEVENT",
        "UID:w",
        "DTSTAMP:20261101T000000Z",
        "SEQUENCE:3",
        "DTSTART;TZID=Europe/Paris:20261105T100000",
        "DTEND;TZID=Europe/Paris:20261105T110000",
        "RRULE:FREQ=WEEKLY;COUNT=4",
        "SUMMARY:Hebdo",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:w",
        "DTSTAMP:20261101T000000Z",
    ];
    lines.extend_from_slice(exception);
    lines.push("END:VEVENT");
    calendar(&lines)
}

fn rids(occ: &[recurrence::Occurrence]) -> Vec<String> {
    occ.iter()
        .map(|o| o.recurrence_id.clone().unwrap_or_default())
        .collect()
}

#[test]
fn exception_keeps_its_start_without_matching_sequence() {
    let ics = weekly_with(&[
        "RECURRENCE-ID;TZID=Europe/Paris:20261119T100000",
        "DTSTART;TZID=Europe/Paris:20261119T140000",
        "DTEND;TZID=Europe/Paris:20261119T150000",
        "SUMMARY:Déplacée",
    ]);
    let e = convert::ics_to_events(&ics).remove(0);
    let occ = recurrence::expand(
        &ics,
        &e,
        utc_ms(2026, 11, 1, 0),
        utc_ms(2026, 12, 1, 0),
        None,
    );
    assert_eq!(
        rids(&occ),
        vec![
            "2026-11-05T10:00:00",
            "2026-11-12T10:00:00",
            "2026-11-19T10:00:00",
            "2026-11-26T10:00:00"
        ]
    );
    assert_eq!(occ[2].start_ms, utc_ms(2026, 11, 19, 13));
}

#[test]
fn exception_moved_after_the_window_leaves_it() {
    let ics = weekly_with(&[
        "RECURRENCE-ID;TZID=Europe/Paris:20261112T100000",
        "DTSTART;TZID=Europe/Paris:20261220T100000",
        "DTEND;TZID=Europe/Paris:20261220T110000",
    ]);
    let e = convert::ics_to_events(&ics).remove(0);
    let occ = recurrence::expand(
        &ics,
        &e,
        utc_ms(2026, 11, 1, 0),
        utc_ms(2026, 11, 20, 0),
        None,
    );
    assert_eq!(
        rids(&occ),
        vec!["2026-11-05T10:00:00", "2026-11-19T10:00:00"]
    );
}

#[test]
fn this_and_future_keeps_following_occurrences() {
    let ics = weekly_with(&[
        "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Paris:20261112T100000",
        "DTSTART;TZID=Europe/Paris:20261112T110000",
        "DTEND;TZID=Europe/Paris:20261112T120000",
    ]);
    let e = convert::ics_to_events(&ics).remove(0);
    let occ = recurrence::expand(
        &ics,
        &e,
        utc_ms(2026, 11, 1, 0),
        utc_ms(2026, 12, 1, 0),
        None,
    );
    let r = rids(&occ);
    assert_eq!(occ.len(), 4, "{r:?}");
    assert_eq!(
        r.iter().filter(|x| *x == "2026-11-12T10:00:00").count(),
        1,
        "{r:?}"
    );
    assert_eq!(occ[1].start_ms, utc_ms(2026, 11, 12, 10));
}

#[test]
fn expansion_stops_at_the_cutoff() {
    let count = |lines: &[&str]| {
        let ics = calendar(lines);
        let e = convert::ics_to_events(&ics).remove(0);
        recurrence::DATES_PRODUCED.with(|n| n.set(0));
        let occ = recurrence::expand(
            &ics,
            &e,
            utc_ms(2026, 11, 1, 0),
            utc_ms(2026, 12, 1, 0),
            None,
        );
        (occ.len(), recurrence::DATES_PRODUCED.with(|n| n.get()))
    };
    let birthday = count(&[
        "BEGIN:VEVENT",
        "UID:b",
        "DTSTAMP:19900101T000000Z",
        "DTSTART;VALUE=DATE:19901115",
        "DTEND;VALUE=DATE:19901116",
        "RRULE:FREQ=YEARLY",
        "SUMMARY:Anniversaire",
        "END:VEVENT",
    ]);
    assert_eq!(birthday.0, 1);
    assert!(birthday.1 <= 1_024, "{} dates", birthday.1);
    let daily = count(&[
        "BEGIN:VEVENT",
        "UID:d",
        "DTSTAMP:20100101T000000Z",
        "DTSTART:20100101T070000Z",
        "DURATION:PT15M",
        "RRULE:FREQ=DAILY",
        "SUMMARY:Rappel",
        "END:VEVENT",
    ]);
    assert_eq!(daily.0, 30);
    assert!(daily.1 <= 25_000, "{} dates", daily.1);
}

#[test]
fn deeply_nested_ics_is_refused() {
    let depth = 50_000;
    let mut text = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    text.push_str(&"BEGIN:X-DEEP\r\n".repeat(depth));
    text.push_str(&"END:X-DEEP\r\n".repeat(depth));
    text.push_str("END:VCALENDAR\r\n");
    let handle = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(move || convert::ics_to_events(&text).len())
        .unwrap();
    assert_eq!(handle.join().expect("pas de débordement de pile"), 0);
}

#[test]
fn moved_future_occurrence_does_not_stop_the_expansion() {
    let count = |lines: &[&str]| {
        let ics = calendar(lines);
        let e = convert::ics_to_events(&ics).remove(0);
        recurrence::expand(
            &ics,
            &e,
            utc_ms(2026, 11, 1, 0),
            utc_ms(2026, 12, 1, 0),
            None,
        )
        .len()
    };
    let daily = count(&[
        "BEGIN:VEVENT",
        "UID:d",
        "DTSTAMP:20250101T000000Z",
        "DTSTART;TZID=Europe/Paris:20250101T090000",
        "DTEND;TZID=Europe/Paris:20250101T093000",
        "RRULE:FREQ=DAILY",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:d",
        "DTSTAMP:20250101T000000Z",
        "RECURRENCE-ID;TZID=Europe/Paris:20261220T090000",
        "DTSTART;TZID=Europe/Paris:20261221T090000",
        "DTEND;TZID=Europe/Paris:20261221T093000",
        "END:VEVENT",
    ]);
    assert_eq!(daily, 30);
    let weekly = count(&[
        "BEGIN:VEVENT",
        "UID:w",
        "DTSTAMP:20180101T000000Z",
        "DTSTART;TZID=Europe/Paris:20180101T100000",
        "DTEND;TZID=Europe/Paris:20180101T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:w",
        "DTSTAMP:20180101T000000Z",
        "RECURRENCE-ID;TZID=Europe/Paris:20261207T100000",
        "DTSTART;TZID=Europe/Paris:20261208T100000",
        "DTEND;TZID=Europe/Paris:20261208T110000",
        "END:VEVENT",
    ]);
    assert_eq!(weekly, 5);
}
