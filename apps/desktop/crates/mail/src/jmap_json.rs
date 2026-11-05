//! Valeurs JSON de la façade (port de `headerProperty`, `headerNameOf` de `mime.ts` et de `part()` de
//! `Messages.build`) : propriétés `header:…`, parties de corps, adresses, plus les petits outils de lecture
//! des arguments JMAP partagés par les méthodes.

use serde_json::{Map, Value, json};
use voxel_core::jmap::Object;
use voxel_imap::headers::{
    Address, RawHeader, decode_words, header_values, parse_addresses, parse_date,
    parse_message_ids, parse_urls,
};
use voxel_imap::structure::BodyPart;

/// Date ISO sans millisecondes (`utcDate`).
fn iso(d: &chrono::DateTime<chrono::FixedOffset>) -> String {
    d.with_timezone(&chrono::Utc)
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

pub fn header_property(headers: &[RawHeader], property: &str) -> Value {
    let parts: Vec<&str> = property.split(':').collect();
    let name = parts.get(1).copied().unwrap_or("");
    let mut form = "asRaw";
    let mut all = false;
    for p in parts.iter().skip(2) {
        if *p == "all" {
            all = true;
        } else if !p.is_empty() {
            form = p;
        }
    }
    let values = header_values(headers, name);
    let conv = |v: &str| -> Value {
        match form {
            "asText" => Value::String(
                decode_words(v)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
            "asURLs" => parse_urls(v).map_or(Value::Null, |u| json!(u)),
            "asAddresses" => parse_addresses(v).map_or(Value::Null, |a| addresses(&a)),
            "asGroupedAddresses" => parse_addresses(v).map_or(
                Value::Null,
                |a| json!([{ "name": null, "addresses": addresses(&a) }]),
            ),
            "asMessageIds" => parse_message_ids(Some(v)).map_or(Value::Null, |m| json!(m)),
            "asDate" => parse_date(v).map_or(Value::Null, |d| Value::String(iso(&d))),
            _ => Value::String(format!(" {v}")),
        }
    };
    if all {
        return Value::Array(values.iter().map(|v| conv(v)).collect());
    }
    values.last().map_or(Value::Null, |v| conv(v))
}

pub fn header_name_of(prop: &str) -> Option<String> {
    let rest = prop.strip_prefix("header:")?;
    let name = rest.split(':').next().unwrap_or("").to_lowercase();
    (!name.is_empty()).then_some(name)
}

fn addresses(list: &[Address]) -> Value {
    Value::Array(
        list.iter()
            .map(|a| json!({ "name": a.name, "email": a.email }))
            .collect(),
    )
}

pub fn address_json(list: &[Address]) -> Value {
    let kept: Vec<Value> = list
        .iter()
        .filter(|a| !a.email.is_empty())
        .map(|a| json!({ "name": a.name.clone().filter(|n| !n.is_empty()), "email": a.email }))
        .collect();
    if kept.is_empty() {
        Value::Null
    } else {
        Value::Array(kept)
    }
}

/// Valeur d'un champ de `BodyPart` sous son nom JSON (None : le champ n'existe pas).
fn part_field(p: &BodyPart, key: &str) -> Option<Value> {
    Some(match key {
        "partId" => json!(p.part_id),
        "blobId" => json!(p.blob_id),
        "size" => json!(p.size),
        "name" => json!(p.name),
        "type" => json!(p.content_type),
        "charset" => json!(p.charset),
        "disposition" => json!(p.disposition),
        "cid" => json!(p.cid),
        "language" => json!(p.language),
        "location" => json!(p.location),
        "encoding" => json!(p.encoding),
        _ => return None,
    })
}

pub fn part_json(part: &BodyPart, body_properties: &[String]) -> Value {
    let mut o = Map::new();
    for k in body_properties {
        if k == "subParts" {
            o.insert(
                "subParts".into(),
                part.sub_parts.as_ref().map_or(Value::Null, |s| {
                    Value::Array(s.iter().map(|x| part_json(x, body_properties)).collect())
                }),
            );
        } else if k == "headers" {
            o.insert("headers".into(), json!([]));
        } else if let Some(v) = part_field(part, k) {
            o.insert(k.clone(), v);
        }
    }
    if let Some(subs) = &part.sub_parts
        && !o.contains_key("subParts")
    {
        o.insert(
            "subParts".into(),
            Value::Array(subs.iter().map(|x| part_json(x, body_properties)).collect()),
        );
    }
    Value::Object(o)
}

// ------------------------------------------------------------------ lecture des arguments

/// `isObject` : objet JSON (ni tableau ni null).
pub fn as_object(v: Option<&Value>) -> Option<&Object> {
    v.and_then(Value::as_object)
}

/// Clés dont la valeur est vraie au sens JS (`Object.keys(o).filter((k) => o[k])`).
pub fn truthy_keys(o: &Object) -> Vec<String> {
    o.iter()
        .filter(|(_, v)| truthy(v))
        .map(|(k, _)| k.clone())
        .collect()
}

/// Valeur vraie au sens JS.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Texte d'une valeur comme `String(v)` le donnerait pour un identifiant.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// CR, LF ou NUL : interdits dans une commande IMAP (C15).
pub fn has_control(s: &str) -> bool {
    s.contains(['\r', '\n', '\0'])
}

/// Nom d'en-tête acceptable dans une commande IMAP : `[!-9;-~]+` (C15).
pub fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b':')
}

/// Objet vide → null (réponses `/set`).
pub fn object_or_null(o: Object) -> Value {
    if o.is_empty() {
        Value::Null
    } else {
        Value::Object(o)
    }
}

/// Liste vide → null (réponses `/set`).
pub fn list_or_null(l: Vec<String>) -> Value {
    if l.is_empty() { Value::Null } else { json!(l) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: &str, value: &str) -> RawHeader {
        RawHeader {
            name: name.into(),
            value: value.into(),
        }
    }

    #[test]
    fn proprietes_d_en_tete() {
        let hs = vec![
            h("Subject", "=?utf-8?q?Caf=C3=A9?=   du  jour"),
            h("List-Unsubscribe", "<mailto:x@y.z>, <https://a.b/c>"),
            h("To", "Alice <a@b.c>, d@e.f"),
            h("Date", "Tue, 1 Jul 2025 10:00:00 +0200"),
            h("X-A", "1"),
            h("X-A", "2"),
        ];
        assert_eq!(
            header_property(&hs, "header:Subject:asText"),
            json!("Café du jour")
        );
        assert_eq!(
            header_property(&hs, "header:List-Unsubscribe:asURLs"),
            json!(["mailto:x@y.z", "https://a.b/c"])
        );
        assert_eq!(
            header_property(&hs, "header:To:asAddresses"),
            json!([{ "name": "Alice", "email": "a@b.c" }, { "name": null, "email": "d@e.f" }])
        );
        assert_eq!(
            header_property(&hs, "header:Date:asDate"),
            json!("2025-07-01T08:00:00Z")
        );
        assert_eq!(header_property(&hs, "header:x-a"), json!(" 2"));
        assert_eq!(header_property(&hs, "header:X-A:all"), json!([" 1", " 2"]));
        assert_eq!(header_property(&hs, "header:Absent"), Value::Null);
        assert_eq!(header_name_of("header:X-A:asText"), Some("x-a".into()));
        assert_eq!(header_name_of("subject"), None);
    }

    #[test]
    fn parties_et_adresses() {
        let leaf = BodyPart {
            part_id: Some("1".into()),
            blob_id: Some("e.1".into()),
            size: 3,
            name: None,
            content_type: "text/plain".into(),
            charset: Some("utf-8".into()),
            disposition: None,
            cid: None,
            language: None,
            location: None,
            encoding: Some("7bit".into()),
            sub_parts: None,
        };
        let root = BodyPart {
            part_id: None,
            blob_id: None,
            content_type: "multipart/mixed".into(),
            sub_parts: Some(vec![leaf.clone()]),
            ..leaf.clone()
        };
        let props = vec![
            "partId".to_string(),
            "type".to_string(),
            "headers".to_string(),
        ];
        assert_eq!(
            part_json(&root, &props),
            json!({ "partId": null, "type": "multipart/mixed", "headers": [],
                    "subParts": [{ "partId": "1", "type": "text/plain", "headers": [] }] })
        );
        assert_eq!(address_json(&[]), Value::Null);
        assert_eq!(
            address_json(&[Address {
                name: Some(String::new()),
                email: "a@b.c".into()
            }]),
            json!([{ "name": null, "email": "a@b.c" }])
        );
    }
}
