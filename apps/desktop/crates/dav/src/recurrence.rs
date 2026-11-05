//! Occurrences d'un événement sur une plage, et instants de début et de fin. Port de `expandEvent` et
//! `occurrenceOf` (`packages/jmap/src/recurrence.ts`), `eventSpan` et `parseUtc` (`jscalendar.ts`) ; les dates des
//! séries viennent de `ICalendar::expand_dates` de calcard, sur l'iCalendar de la ressource.
//!
//! Heures flottantes et journées entières : fuseau local de la machine (`chrono::Local`), comme Node le faisait
//! avec le fuseau du serveur.

use std::collections::HashMap;
use std::str::FromStr;

use calcard::common::timezone::Tz;
use calcard::icalendar::{
    ICalendar, ICalendarParameterName, ICalendarProperty, ICalendarValue, dates::TimeOrDelta,
};
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use serde_json::Value;

use crate::patch::apply_patch;

/// Plafond d'itération des dates d'une série (`MAX_ITER` de `recurrence.ts`).
const MAX_ITER: usize = 100_000;

/// Plafond des occurrences rendues.
const MAX_RESULTS: usize = 5_000;

/// Première limite de `expand_dates`.
const FIRST_LIMIT: usize = 256;

/// Un jour, marge des pré-tests sur les dates naïves (décalages horaires).
const DAY_MS: i64 = 86_400_000;

/// Marge au-delà de la fin de plage (décalages horaires), comme `recurrence.ts`.
const MARGIN_MS: i64 = 2 * 86_400_000;

/// Propriétés propres à la série, absentes d'une occurrence.
const BASE_ONLY: [&str; 3] = [
    "recurrenceRules",
    "excludedRecurrenceRules",
    "recurrenceOverrides",
];

/// Format des dates locales JSCalendar.
const LOCAL_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

#[allow(dead_code)] // `event` et `end_ms` : contrat du module, lus par les tests
pub struct Occurrence {
    pub recurrence_id: Option<String>,
    pub event: Value,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// `YYYY-MM-DD[THH:MM[:SS]]` → date locale.
fn parse_local(s: &str) -> Option<NaiveDateTime> {
    let date = NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()?;
    let rest = &s[10..];
    let Some(time) = rest.strip_prefix('T') else {
        return date.and_hms_opt(0, 0, 0);
    };
    let num = |r: std::ops::Range<usize>| time.get(r).and_then(|t| t.parse::<u32>().ok());
    let (hh, mm) = (num(0..2)?, num(3..5)?);
    let ss = if time.get(5..6) == Some(":") {
        num(6..8)?
    } else {
        0
    };
    date.and_hms_opt(hh, mm, ss)
}

/// Instant d'une date locale dans un fuseau quelconque ; heure inexistante : décalée vers l'avant.
fn local_in<T: TimeZone>(tz: &T, naive: NaiveDateTime) -> i64 {
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => t.timestamp_millis(),
        chrono::LocalResult::Ambiguous(a, _) => a.timestamp_millis(),
        chrono::LocalResult::None => tz
            .from_local_datetime(&(naive + chrono::TimeDelta::hours(1)))
            .earliest()
            .map(|t| t.timestamp_millis())
            .unwrap_or_else(|| naive.and_utc().timestamp_millis()),
    }
}

/// Date locale dans un fuseau → instant UTC (ms) ; fuseau absent ou inconnu : heure locale de la machine.
fn zoned_to_utc(local: &str, tz: Option<&str>) -> i64 {
    let naive = parse_local(local).unwrap_or_default();
    match tz
        .and_then(|t| Tz::from_str(t).ok())
        .filter(|t| !t.is_floating())
    {
        Some(tz) => local_in(&tz, naive),
        None => local_in(&Local, naive),
    }
}

/// `2026-11-03T10:00:00Z` → ms ; date locale sans `Z` ni décalage : heure de la machine.
pub fn parse_utc(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let n = bytes.len();
    let zoned = value.ends_with(['z', 'Z'])
        || (n >= 6
            && matches!(bytes[n - 6], b'+' | b'-')
            && bytes[n - 3] == b':'
            && [n - 5, n - 4, n - 2, n - 1]
                .iter()
                .all(|&i| bytes[i].is_ascii_digit()));
    if zoned {
        return DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|d| d.timestamp_millis());
    }
    parse_local(value).map(|naive| local_in(&Local, naive))
}

/// Parties d'une durée ISO 8601 (`P1W2DT3H4M5S`) : semaines + jours, et secondes du reste.
fn parse_duration(value: Option<&str>) -> (i64, i64) {
    let Some(text) = value.map(str::trim) else {
        return (0, 0);
    };
    let text = text.strip_prefix(['+', '-']).unwrap_or(text);
    let Some(body) = text.strip_prefix('P') else {
        return (0, 0);
    };
    let (date, time) = match body.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (body, None),
    };
    let mut days = 0i64;
    let mut secs = 0f64;
    let mut num = String::new();
    for c in date.chars() {
        match c {
            '0'..='9' => num.push(c),
            'W' => days = days.saturating_add(num.parse::<i64>().unwrap_or(0).saturating_mul(7)),
            'D' => days = days.saturating_add(num.parse::<i64>().unwrap_or(0)),
            _ => return (0, 0),
        }
        if !c.is_ascii_digit() {
            num.clear();
        }
    }
    if !num.is_empty() {
        return (0, 0);
    }
    for c in time.unwrap_or("").chars() {
        match c {
            '0'..='9' | '.' => num.push(c),
            'H' => secs += num.parse::<f64>().unwrap_or(0.0) * 3600.0,
            'M' => secs += num.parse::<f64>().unwrap_or(0.0) * 60.0,
            'S' => secs += num.parse::<f64>().unwrap_or(0.0).round(),
            _ => return (0, 0),
        }
        if !matches!(c, '0'..='9' | '.') {
            num.clear();
        }
    }
    (days, secs as i64)
}

/// Instants de début et de fin (ms) d'un événement ou d'une occurrence.
pub fn event_span(event: &Value) -> (i64, i64) {
    let start = event
        .get("start")
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00");
    let tz = if event.get("showWithoutTime") == Some(&Value::Bool(true)) {
        None
    } else {
        event.get("timeZone").and_then(Value::as_str)
    };
    let s = zoned_to_utc(start, tz);
    let (days, rest) = parse_duration(event.get("duration").and_then(Value::as_str));
    let e = if days != 0 {
        let end_local = parse_local(start)
            .and_then(|n| n.checked_add_signed(chrono::TimeDelta::try_days(days)?))
            .map(|n| n.format(LOCAL_FORMAT).to_string());
        match end_local {
            Some(end) => zoned_to_utc(&end, tz).saturating_add(rest.saturating_mul(1000)),
            None => i64::MAX,
        }
    } else {
        s.saturating_add(rest.saturating_mul(1000))
    };
    (s, e.max(s))
}

/// Instance d'une occurrence (exception appliquée) ; `None` si elle est exclue.
pub fn occurrence_of(event: &Value, recurrence_id: &str) -> Option<Value> {
    let mut base = event.as_object()?.clone();
    base.insert("start".into(), Value::String(recurrence_id.to_string()));
    for k in BASE_ONLY {
        base.remove(k);
    }
    let patch = event
        .get("recurrenceOverrides")
        .and_then(|o| o.get(recurrence_id))
        .and_then(Value::as_object);
    if patch
        .and_then(|p| p.get("excluded"))
        .is_some_and(|x| !matches!(x, Value::Null | Value::Bool(false)))
    {
        return None;
    }
    let base = Value::Object(base);
    let mut inst = match patch {
        Some(p) => apply_patch(&base, p).unwrap_or(base),
        None => base,
    };
    if let Some(map) = inst.as_object_mut() {
        map.insert(
            "recurrenceId".into(),
            Value::String(recurrence_id.to_string()),
        );
    }
    Some(inst)
}

fn in_range(start: i64, end: i64, from: i64, to: i64) -> bool {
    (end > from && start < to) || (start == end && start >= from && start < to)
}

/// Instant d'une date de calcard ; flottante : UTC si le DTSTART du composant est en UTC (calcard rend alors ses
/// dates de série flottantes), sinon heure locale de la machine.
fn instant(t: &DateTime<Tz>, utc: bool) -> i64 {
    if t.timezone().is_floating() {
        if utc {
            return t.naive_local().and_utc().timestamp_millis();
        }
        local_in(&Local, t.naive_local())
    } else {
        t.timestamp_millis()
    }
}

/// `RECURRENCE-ID` d'une exception, en date locale.
fn recurrence_id_of(ical: &ICalendar, comp_id: u32) -> Option<String> {
    let comp = ical.components.get(comp_id as usize)?;
    comp.entries.iter().find_map(|e| {
        if e.name != ICalendarProperty::RecurrenceId {
            return None;
        }
        match e.values.first() {
            Some(ICalendarValue::PartialDateTime(dt)) => Some(format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
                dt.year.unwrap_or(1970),
                dt.month.unwrap_or(1),
                dt.day.unwrap_or(1),
                dt.hour.unwrap_or(0),
                dt.minute.unwrap_or(0),
                dt.second.unwrap_or(0)
            )),
            _ => None,
        }
    })
}

/// Le DTSTART du composant est-il une heure UTC (`Z`, sans TZID) ?
fn starts_in_utc(ical: &ICalendar, comp_id: u32) -> bool {
    let Some(comp) = ical.components.get(comp_id as usize) else {
        return false;
    };
    comp.entries.iter().any(|e| {
        e.name == ICalendarProperty::Dtstart
            && e.tz_id().is_none()
            && matches!(e.values.first(), Some(ICalendarValue::PartialDateTime(dt)) if dt.tz_hour.is_some())
    })
}

fn uid_of(ical: &ICalendar, comp_id: u32) -> Option<&str> {
    let comp = ical.components.get(comp_id as usize)?;
    comp.entries.iter().find_map(|e| {
        (e.name == ICalendarProperty::Uid)
            .then(|| e.values.first().and_then(|v| v.as_text()))
            .flatten()
    })
}

/// Occurrences qui touchent la plage [from, to[ (ms UTC), triées par début.
/// Ce qu'`expand` lit d'un composant, une fois par composant.
struct Comp {
    uid: Option<String>,
    rid: Option<String>,
    this_and_future: bool,
    dtstart: Option<NaiveDateTime>,
    utc: bool,
}

impl Comp {
    fn of(ical: &ICalendar, comp_id: u32) -> Self {
        let entry = |name: ICalendarProperty| {
            ical.components
                .get(comp_id as usize)
                .and_then(|c| c.entries.iter().find(|e| e.name == name))
        };
        let this_and_future = entry(ICalendarProperty::RecurrenceId).is_some_and(|e| {
            e.params
                .iter()
                .any(|p| p.name == ICalendarParameterName::Range)
        });
        let dtstart = entry(ICalendarProperty::Dtstart).and_then(|e| match e.values.first() {
            Some(ICalendarValue::PartialDateTime(dt)) => dt.to_date_time().map(|d| d.date_time),
            _ => None,
        });
        Comp {
            uid: uid_of(ical, comp_id).map(str::to_string),
            rid: recurrence_id_of(ical, comp_id),
            this_and_future,
            dtstart,
            utc: starts_in_utc(ical, comp_id),
        }
    }
}

thread_local! {
    /// Dates produites par calcard sur ce fil, comptées pour les tests du coût du développement.
    pub(crate) static DATES_PRODUCED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Date produite par `expand_dates`.
type ExpandedDate = calcard::icalendar::dates::CalendarEvent<
    DateTime<Tz>,
    TimeOrDelta<DateTime<Tz>, chrono::TimeDelta>,
>;

/// `expand_dates` avec une limite croissante (256, puis ×4 jusqu'à `MAX_ITER`) : on s'arrête dès que la série est
/// finie ou que sa dernière date dépasse la coupure.
fn expand_until(ical: &ICalendar, naive_cutoff: Option<NaiveDateTime>) -> Vec<ExpandedDate> {
    let mut limit = FIRST_LIMIT;
    loop {
        let events = ical.expand_dates(Tz::Floating, limit).events;
        DATES_PRODUCED.with(|n| n.set(n.get() + events.len()));
        // dernière date de la série principale : une exception non appariée est rangée en fin de liste (C18)
        let last = events
            .iter()
            .filter(|e| recurrence_id_of(ical, e.comp_id).is_none())
            .map(|e| e.start.naive_local())
            .max();
        let past = matches!((last, naive_cutoff), (Some(l), Some(c)) if l > c);
        if past || events.len() < limit || limit >= MAX_ITER {
            return events;
        }
        limit = (limit * 4).min(MAX_ITER);
    }
}

pub fn expand(
    ics: &str,
    event: &Value,
    from_ms: i64,
    to_ms: i64,
    max_results: Option<usize>,
) -> Vec<Occurrence> {
    if event.get("start").and_then(Value::as_str).is_none() {
        return Vec::new();
    }
    let non_empty = |k: &str| match event.get(k) {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        _ => false,
    };
    if !non_empty("recurrenceRules") && !non_empty("recurrenceOverrides") {
        let (start_ms, end_ms) = event_span(event);
        if !in_range(start_ms, end_ms, from_ms, to_ms) {
            return Vec::new();
        }
        return vec![Occurrence {
            recurrence_id: None,
            event: event.clone(),
            start_ms,
            end_ms,
        }];
    }
    let Ok(ical) = ICalendar::parse(ics) else {
        return Vec::new();
    };
    let uid = event.get("uid").and_then(Value::as_str);
    let cutoff = to_ms.saturating_add(MARGIN_MS);
    // bornes naïves (dates locales, toutes zones confondues) : au-delà d'un jour de marge, aucune date n'est utile
    let naive_of = |ms: i64| DateTime::from_timestamp_millis(ms).map(|d| d.naive_utc());
    let naive_cutoff = naive_of(cutoff.saturating_add(DAY_MS));
    let naive_from = naive_of(from_ms.saturating_sub(DAY_MS));
    let dates = expand_until(&ical, naive_cutoff);
    let mut comps: HashMap<u32, Comp> = HashMap::new();
    // une seule occurrence par `recurrence_id` : l'instance issue d'un composant RECURRENCE-ID l'emporte
    let mut slots: Vec<(String, bool, i64, i64)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for date in &dates {
        let comp = comps
            .entry(date.comp_id)
            .or_insert_with(|| Comp::of(&ical, date.comp_id));
        if uid.is_some() && comp.uid.as_deref() != uid {
            continue;
        }
        let start_naive = date.start.naive_local();
        // RANGE=THISANDFUTURE : seule la date du DTSTART du composant est l'exception
        let exception = comp
            .rid
            .clone()
            .filter(|_| !comp.this_and_future || comp.dtstart == Some(start_naive));
        let is_exception = exception.is_some();
        let end_naive = match &date.end {
            TimeOrDelta::Time(t) => Some(t.naive_local()),
            TimeOrDelta::Delta(d) => start_naive.checked_add_signed(*d),
        };
        // une exception n'est jamais coupée : elle doit remplacer sa date d'origine
        if !is_exception {
            let late = naive_cutoff.is_some_and(|c| start_naive > c);
            let early = naive_from.zip(end_naive).is_some_and(|(f, e)| e < f);
            if late || early {
                continue;
            }
        }
        let start_ms = instant(&date.start, comp.utc);
        if !is_exception && start_ms > cutoff {
            continue;
        }
        let end_ms = match &date.end {
            TimeOrDelta::Time(t) => instant(t, comp.utc),
            TimeOrDelta::Delta(d) => start_ms.saturating_add(d.num_milliseconds()),
        };
        let rid = exception.unwrap_or_else(|| start_naive.format(LOCAL_FORMAT).to_string());
        match index.get(&rid) {
            Some(&i) if is_exception && !slots[i].1 => slots[i] = (rid, true, start_ms, end_ms),
            Some(_) => {}
            None => {
                index.insert(rid.clone(), slots.len());
                slots.push((rid, is_exception, start_ms, end_ms));
            }
        }
    }
    let mut out = Vec::new();
    for (rid, _, start_ms, end_ms) in slots {
        if !in_range(start_ms, end_ms, from_ms, to_ms) {
            continue;
        }
        let Some(inst) = occurrence_of(event, &rid) else {
            continue;
        };
        out.push(Occurrence {
            recurrence_id: Some(rid),
            event: inst,
            start_ms,
            end_ms: end_ms.max(start_ms),
        });
    }
    out.sort_by_key(|o| o.start_ms);
    // sans `max_results`, une occurrence de plus que le plafond laisse `CalendarEvent/query` signaler `tooManyResults`
    out.truncate(max_results.unwrap_or(MAX_RESULTS + 1));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spans_durations_and_dates() {
        assert_eq!(parse_duration(Some("PT1H30M")), (0, 5400));
        assert_eq!(parse_duration(Some("P1W2D")), (9, 0));
        assert_eq!(parse_duration(Some("-PT15M")), (0, 900));
        assert_eq!(parse_utc("2026-11-03T10:00:00Z"), Some(1_793_700_000_000));
        assert_eq!(
            parse_utc("2026-11-03T11:00:00+01:00"),
            Some(1_793_700_000_000)
        );
        let ev =
            json!({"start": "2026-11-03T11:00:00", "timeZone": "Europe/Paris", "duration": "PT1H"});
        assert_eq!(event_span(&ev), (1_793_700_000_000, 1_793_703_600_000));
        let huge = json!({"start": "2026-11-03T11:00:00", "duration": "P200000000D"});
        assert_eq!(
            event_span(&huge).0,
            parse_utc("2026-11-03T11:00:00").unwrap()
        );
        let huge = json!({"start": "2026-11-03T11:00:00", "duration": "P99999999999999999999W"});
        let _ = event_span(&huge);
        let occ = occurrence_of(
            &json!({"start": "2026-11-03T11:00:00", "recurrenceRules": [{}], "recurrenceOverrides": {"2026-11-10T11:00:00": {"title": "X"}, "2026-11-17T11:00:00": {"excluded": true}}}),
            "2026-11-10T11:00:00",
        )
        .unwrap();
        assert_eq!(
            occ,
            json!({"start": "2026-11-10T11:00:00", "title": "X", "recurrenceId": "2026-11-10T11:00:00"})
        );
    }
}
