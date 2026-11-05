//! vCard et iCalendar ↔ JSContact et JSCalendar par calcard, avec l'adaptateur de dialecte (D12) : à la lecture, les
//! règles K1–K8 (fiches) et C1–C3 (événements) ramènent le JSON de calcard au modèle de l'interface et de la façade
//! Node ; à l'écriture, W1–W2 le rendent à JSCalendar 2.0. Toutes les fonctions sont pures.

use calcard::jscalendar::JSCalendar;
use calcard::jscontact::JSContact;
use calcard::{Entry, Parser};
use serde_json::{Map, Value, json};

/// Tables de fiche où `contexts.pref` devient `pref: 1` (K1).
const PREF_TABLES: [&str; 5] = ["emails", "phones", "addresses", "links", "onlineServices"];

/// Rôles qui, avec `attendee`, rendent un participant facultatif ou président plutôt que requis (W2).
const NON_REQUIRED_ROLES: [&str; 3] = ["optional", "chair", "informational"];

fn entries_mut<'a>(
    card: &'a mut Map<String, Value>,
    table: &str,
) -> Vec<&'a mut Map<String, Value>> {
    match card.get_mut(table).and_then(Value::as_object_mut) {
        Some(t) => t.values_mut().filter_map(Value::as_object_mut).collect(),
        None => Vec::new(),
    }
}

/// Retire `contexts.<name>` ; renvoie vrai si le contexte était vrai. Un `contexts` vidé est retiré.
fn take_context(entry: &mut Map<String, Value>, name: &str) -> bool {
    let Some(contexts) = entry.get_mut("contexts").and_then(Value::as_object_mut) else {
        return false;
    };
    let was = contexts
        .remove(name)
        .is_some_and(|v| v == Value::Bool(true));
    if contexts.is_empty() {
        entry.remove("contexts");
    }
    was
}

/// `_$!<Other>!$_` → `Other` (K3).
fn apple_label(label: &str) -> Option<&str> {
    label
        .strip_prefix("_$!<")?
        .strip_suffix(">!$_")
        .filter(|inner| !inner.is_empty())
}

fn fix_labels(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if key == "label"
                    && let Some(inner) = v.as_str().and_then(apple_label)
                {
                    *v = Value::String(inner.to_string());
                    continue;
                }
                fix_labels(v);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(fix_labels),
        _ => {}
    }
}

/// Règles K1 à K8 sur une fiche lue par calcard.
fn adapt_card(mut card: Value) -> Value {
    let Some(map) = card.as_object_mut() else {
        return card;
    };
    for table in PREF_TABLES {
        for entry in entries_mut(map, table) {
            // K1
            if take_context(entry, "pref") {
                entry.insert("pref".into(), json!(1));
            }
            // K2
            if table == "emails" {
                take_context(entry, "internet");
            }
        }
    }
    // K4
    for entry in entries_mut(map, "addresses") {
        if entry.contains_key("components") && !entry.contains_key("isOrdered") {
            entry.insert("isOrdered".into(), json!(true));
        }
    }
    // K5
    for entry in entries_mut(map, "media") {
        if entry.contains_key("mediaType") {
            continue;
        }
        let kind = entry
            .get("uri")
            .and_then(Value::as_str)
            .and_then(|u| u.strip_prefix("data:"))
            .and_then(|rest| rest.split_once(';'))
            .map(|(t, _)| t.to_string());
        if let Some(kind) = kind.filter(|k| !k.is_empty()) {
            entry.insert("mediaType".into(), json!(kind));
        }
    }
    // K6
    for entry in entries_mut(map, "phones") {
        if let Some(Value::String(number)) = entry.get_mut("number")
            && let Some(rest) = number.strip_prefix("tel:")
        {
            *number = rest.to_string();
        }
    }
    // K7
    let mut group = false;
    let mut members: Vec<String> = Vec::new();
    if let Some(props) = map
        .get_mut("vCard")
        .and_then(|v| v.get_mut("properties"))
        .and_then(Value::as_array_mut)
    {
        props.retain(|p| {
            let name = p.get(0).and_then(Value::as_str).unwrap_or("");
            let value = p.get(3).and_then(Value::as_str).unwrap_or("");
            if name.eq_ignore_ascii_case("x-addressbookserver-kind")
                && value.eq_ignore_ascii_case("group")
            {
                group = true;
                return false;
            }
            if name.eq_ignore_ascii_case("x-addressbookserver-member") {
                members.push(value.to_string());
                return false;
            }
            true
        });
    }
    if group {
        map.insert("kind".into(), json!("group"));
    }
    if !members.is_empty() {
        let table = map
            .entry("members")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(table) = table.as_object_mut() {
            for m in members {
                table.insert(m, json!(true));
            }
        }
    }
    // K8
    let omitted: Vec<(String, String)> = map
        .get("vCard")
        .and_then(|v| v.get("convertedProperties"))
        .and_then(Value::as_object)
        .map(|conv| {
            conv.iter()
                .filter_map(|(path, v)| {
                    let key = path.strip_prefix("anniversaries/")?.strip_suffix("/date")?;
                    let year = v.get("parameters")?.get("x-apple-omit-year")?;
                    let year = match year {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    Some((key.to_string(), year))
                })
                .collect()
        })
        .unwrap_or_default();
    for (key, year) in omitted {
        if let Some(date) = map
            .get_mut("anniversaries")
            .and_then(|a| a.get_mut(&key))
            .and_then(|a| a.get_mut("date"))
            .and_then(Value::as_object_mut)
            && date
                .get("year")
                .and_then(Value::as_i64)
                .is_some_and(|y| year.parse() == Ok(y))
        {
            date.remove("year");
        }
    }
    // K3
    fix_labels(&mut card);
    card
}

/// Règle de calcard (JSCalendar 2.0) → règle typée du modèle de l'interface (C1).
fn typed_rule(rule: &Value) -> Value {
    let Some(r) = rule.as_object() else {
        return rule.clone();
    };
    let mut out = Map::new();
    out.insert("@type".into(), json!("RecurrenceRule"));
    for (k, v) in r {
        out.insert(k.clone(), v.clone());
    }
    if let Some(days) = r.get("byDay").and_then(Value::as_array) {
        let days = days
            .iter()
            .map(|d| match d.as_object() {
                Some(d) => {
                    let mut nd = Map::new();
                    nd.insert("@type".into(), json!("NDay"));
                    for (k, v) in d {
                        nd.insert(k.clone(), v.clone());
                    }
                    Value::Object(nd)
                }
                None => d.clone(),
            })
            .collect();
        out.insert("byDay".into(), Value::Array(days));
    }
    Value::Object(out)
}

fn rule_to_rules(map: &mut Map<String, Value>) {
    if let Some(rule) = map.remove("recurrenceRule")
        && rule.is_object()
    {
        map.insert("recurrenceRules".into(), json!([typed_rule(&rule)]));
    }
}

/// Règles C1 à C3 sur un événement lu par calcard.
fn adapt_event(mut event: Value) -> Value {
    let Some(map) = event.as_object_mut() else {
        return event;
    };
    // C1
    rule_to_rules(map);
    if let Some(overrides) = map
        .get_mut("recurrenceOverrides")
        .and_then(Value::as_object_mut)
    {
        for patch in overrides.values_mut().filter_map(Value::as_object_mut) {
            rule_to_rules(patch);
        }
    }
    // C2
    let organizer = map
        .get("organizerCalendarAddress")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(participants) = map.get_mut("participants").and_then(Value::as_object_mut) {
        for p in participants.values_mut().filter_map(Value::as_object_mut) {
            let no_roles = p
                .get("roles")
                .and_then(Value::as_object)
                .is_none_or(Map::is_empty);
            if let Some(roles) = p.get_mut("roles").and_then(Value::as_object_mut) {
                if roles.remove("required").is_some() {
                    roles.insert("attendee".into(), json!(true));
                }
                if roles.contains_key("optional") || roles.contains_key("chair") {
                    roles.insert("attendee".into(), json!(true));
                }
            }
            let address = p.get("calendarAddress").and_then(Value::as_str);
            if no_roles && address != organizer.as_deref() {
                p.insert("roles".into(), json!({ "attendee": true }));
            }
            let attends = p
                .get("roles")
                .and_then(Value::as_object)
                .is_some_and(|r| r.contains_key("attendee") || r.contains_key("informational"));
            if !p.contains_key("participationStatus") && attends {
                p.insert("participationStatus".into(), json!("needs-action"));
            }
        }
    }
    // C3
    map.remove("version");
    event
}

/// Règle typée → règle JSCalendar 2.0, sans aucune clé `@type`.
fn untyped_rule(rule: &Value) -> Value {
    let Some(r) = rule.as_object() else {
        return rule.clone();
    };
    let mut out = r.clone();
    out.remove("@type");
    if let Some(days) = out.get_mut("byDay").and_then(Value::as_array_mut) {
        for d in days.iter_mut().filter_map(Value::as_object_mut) {
            d.remove("@type");
        }
    }
    Value::Object(out)
}

/// Règles W1 et W2 sur une copie de l'événement à écrire.
fn to_jscalendar2(event: &Value) -> Value {
    let mut event = event.clone();
    let Some(map) = event.as_object_mut() else {
        return event;
    };
    // W1
    if let Some(rules) = map.remove("recurrenceRules")
        && let Some(rules) = rules.as_array()
        && let Some(first) = rules.first()
    {
        map.insert("recurrenceRule".into(), untyped_rule(first));
        if rules.len() > 1 {
            voxel_core::log::warn("calendar: extra recurrence rules ignored");
        }
    }
    map.remove("excludedRecurrenceRules");
    // W2
    if let Some(participants) = map.get_mut("participants").and_then(Value::as_object_mut) {
        for roles in participants
            .values_mut()
            .filter_map(|p| p.get_mut("roles"))
            .filter_map(Value::as_object_mut)
        {
            let attendee = roles.remove("attendee") == Some(Value::Bool(true));
            if attendee && !NON_REQUIRED_ROLES.iter().any(|r| roles.contains_key(*r)) {
                roles.insert("required".into(), json!(true));
            }
        }
    }
    event
}

/// Première fiche d'un texte vCard.
pub fn vcard_to_card(text: &str) -> Option<Value> {
    parse_vcf(text).0.into_iter().next()
}

/// Fiches d'un fichier vCard, et nombre d'entrées illisibles.
pub fn parse_vcf(text: &str) -> (Vec<Value>, usize) {
    let mut parser = Parser::new(text);
    let mut cards = Vec::new();
    let mut invalid = 0;
    loop {
        match parser.entry() {
            Entry::VCard(v) => {
                if let Ok(json) = serde_json::to_value(v.into_jscontact::<String, String>()) {
                    cards.push(adapt_card(json));
                } else {
                    invalid += 1;
                }
            }
            Entry::Eof => break,
            _ => {
                invalid += 1;
                // garde-fou : un analyseur qui n'avancerait plus
                if invalid > text.len() {
                    break;
                }
            }
        }
    }
    (cards, invalid)
}

/// Règle W3 : une fiche 3.0 de `kind: "group"` écrit son groupe en propriétés Apple (réciproque de K7).
fn apple_group(card: &Value) -> Value {
    let mut card = card.clone();
    let Some(map) = card.as_object_mut() else {
        return card;
    };
    let v3 = map
        .get("vCard")
        .and_then(|v| v.get("properties"))
        .and_then(Value::as_array)
        .is_some_and(|props| {
            props.iter().any(|p| {
                p.get(0)
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case("version"))
                    && p.get(3).and_then(Value::as_str) == Some("3.0")
            })
        });
    if !v3 || map.get("kind").and_then(Value::as_str) != Some("group") {
        return card;
    }
    map.remove("kind");
    let members: Vec<String> = map
        .remove("members")
        .and_then(|m| m.as_object().cloned())
        .map(|m| {
            m.into_iter()
                .filter(|(_, v)| *v == Value::Bool(true))
                .map(|(k, _)| {
                    if k.to_ascii_lowercase().starts_with("urn:uuid:") {
                        k
                    } else {
                        format!("urn:uuid:{k}")
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(props) = map
        .get_mut("vCard")
        .and_then(|v| v.get_mut("properties"))
        .and_then(Value::as_array_mut)
    {
        props.push(json!(["x-addressbookserver-kind", {}, "unknown", "group"]));
        for m in members {
            props.push(json!(["x-addressbookserver-member", {}, "unknown", m]));
        }
    }
    card
}

pub fn card_to_vcard(card: &Value) -> Option<String> {
    let json = serde_json::to_string(&apple_group(card)).ok()?;
    let contact = JSContact::<String, String>::parse(&json).ok()?;
    Some(contact.into_vcard()?.to_string())
}

/// Profondeur maximale des composants `BEGIN:`/`END:` d'un iCalendar (VCALENDAR/VEVENT/VALARM en utilise 3).
const MAX_ICS_DEPTH: usize = 32;

/// Imbrication `BEGIN:`/`END:` mesurée avant l'analyse : calcard convertit par récursion, et un fichier très
/// imbriqué ferait déborder la pile.
fn ics_too_deep(text: &str) -> bool {
    let mut depth = 0usize;
    for line in text.lines() {
        let line = line.trim_start();
        let head = line.get(..6).map(str::to_ascii_uppercase);
        if head.as_deref() == Some("BEGIN:") {
            depth += 1;
            if depth > MAX_ICS_DEPTH {
                return true;
            }
        } else if line
            .get(..4)
            .is_some_and(|h| h.eq_ignore_ascii_case("END:"))
        {
            depth = depth.saturating_sub(1);
        }
    }
    false
}

/// Une entrée par série (exceptions incluses dans `recurrenceOverrides`).
pub fn ics_to_events(text: &str) -> Vec<Value> {
    if ics_too_deep(text) {
        return Vec::new();
    }
    let Ok(ical) = calcard::icalendar::ICalendar::parse(text) else {
        return Vec::new();
    };
    let Ok(group) = serde_json::to_value(ical.into_jscalendar::<String, String>()) else {
        return Vec::new();
    };
    group
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|e| e.get("@type").and_then(Value::as_str) == Some("Event"))
                .cloned()
                .map(adapt_event)
                .collect()
        })
        .unwrap_or_default()
}

pub fn event_to_ics(event: &Value) -> Option<String> {
    let group = json!({ "@type": "Group", "entries": [to_jscalendar2(event)] });
    let json = serde_json::to_string(&group).ok()?;
    let calendar = JSCalendar::<String, String>::parse(&json).ok()?;
    let mut ical = calendar.into_icalendar()?;
    ical.add_missing_timezones();
    Some(ical.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialect_rules() {
        assert_eq!(apple_label("_$!<Other>!$_"), Some("Other"));
        assert_eq!(apple_label("Maison"), None);
        let ev = json!({
            "organizerCalendarAddress": "mailto:a@x",
            "version": "2.0",
            "recurrenceRule": {"frequency": "weekly", "byDay": [{"day": "mo"}]},
            "participants": {
                "a": {"calendarAddress": "mailto:a@x", "roles": {"owner": true}},
                "b": {"calendarAddress": "mailto:b@x", "roles": {"required": true}, "participationStatus": "accepted"},
                "c": {"calendarAddress": "mailto:c@x"}
            }
        });
        let out = adapt_event(ev);
        assert_eq!(
            out["recurrenceRules"],
            json!([{"@type": "RecurrenceRule", "frequency": "weekly", "byDay": [{"@type": "NDay", "day": "mo"}]}])
        );
        assert!(out.get("version").is_none());
        assert_eq!(out["participants"]["a"]["roles"], json!({"owner": true}));
        assert_eq!(out["participants"]["b"]["roles"], json!({"attendee": true}));
        assert_eq!(
            out["participants"]["c"]["participationStatus"],
            "needs-action"
        );
        let back = to_jscalendar2(&out);
        assert_eq!(
            back["recurrenceRule"],
            json!({"frequency": "weekly", "byDay": [{"day": "mo"}]})
        );
        assert_eq!(
            back["participants"]["b"]["roles"],
            json!({"required": true})
        );
    }
}
