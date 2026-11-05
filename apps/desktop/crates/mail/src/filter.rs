//! Filtres JMAP → critères IMAP SEARCH pour un dossier donné (port de `compileFilter`, `andAll`, `orAll`,
//! `dayStr` et `mentionsKey` de `messages.ts`). Comme l'objet `SearchObject` d'imapflow, un ET fusionne les
//! critères de noms différents ; deux critères de même nom passent par De Morgan.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::Value;
use voxel_core::jmap::{CreatedIds, MethodError, Object};
use voxel_imap::search::SearchKey;

use crate::folders::Folder;
use crate::jmap_json::{has_control, js_string, truthy, valid_header_name};
use crate::messages::{keyword_to_flag, valid_keyword};

pub enum Compiled {
    All,
    Nothing,
    Key(SearchKey),
}

/// Nom de clé de `SearchObject` d'un critère (pour la fusion de `andAll`).
fn key_name(k: &SearchKey) -> &'static str {
    match k {
        SearchKey::All => "all",
        SearchKey::Seen(_) => "seen",
        SearchKey::Flagged(_) => "flagged",
        SearchKey::Answered(_) => "answered",
        SearchKey::Draft(_) => "draft",
        SearchKey::Keyword(_) => "keyword",
        SearchKey::UnKeyword(_) => "unKeyword",
        SearchKey::From(_) => "from",
        SearchKey::To(_) => "to",
        SearchKey::Cc(_) => "cc",
        SearchKey::Bcc(_) => "bcc",
        SearchKey::Subject(_) => "subject",
        SearchKey::Body(_) => "body",
        SearchKey::Text(_) => "text",
        SearchKey::Before(_) => "before",
        SearchKey::Since(_) => "since",
        SearchKey::Larger(_) => "larger",
        SearchKey::Smaller(_) => "smaller",
        SearchKey::Header(..) => "header",
        SearchKey::Uid(_) => "uid",
        SearchKey::And(_) => "and",
        SearchKey::Or(_) => "or",
        SearchKey::Not(_) => "not",
    }
}

/// Critères d'un objet fusionné (un `And` porte plusieurs clés, les autres une seule).
fn members(k: SearchKey) -> Vec<SearchKey> {
    match k {
        SearchKey::And(list) => list,
        other => vec![other],
    }
}

fn object_of(mut list: Vec<SearchKey>) -> SearchKey {
    if list.len() == 1 {
        list.remove(0)
    } else {
        SearchKey::And(list)
    }
}

fn and_all(list: Vec<Compiled>) -> Compiled {
    if list.iter().any(|x| matches!(x, Compiled::Nothing)) {
        return Compiled::Nothing;
    }
    let objs: Vec<SearchKey> = list
        .into_iter()
        .filter_map(|x| match x {
            Compiled::Key(k) => Some(k),
            _ => None,
        })
        .collect();
    if objs.is_empty() {
        return Compiled::All;
    }
    // fusion des clés ; conflit → De Morgan (NOT (OR (NOT a) (NOT b)))
    let mut merged: Vec<SearchKey> = Vec::new();
    let mut extra: Vec<SearchKey> = Vec::new();
    for o in objs {
        let keys = members(o.clone());
        let conflict = keys
            .iter()
            .any(|k| merged.iter().any(|m| key_name(m) == key_name(k)));
        if conflict {
            extra.push(o);
        } else {
            merged.extend(keys);
        }
    }
    if extra.is_empty() {
        return Compiled::Key(object_of(merged));
    }
    let mut all = vec![object_of(merged)];
    all.extend(extra);
    Compiled::Key(SearchKey::Not(Box::new(SearchKey::Or(
        all.into_iter()
            .map(|x| SearchKey::Not(Box::new(x)))
            .collect(),
    ))))
}

fn or_all(list: Vec<Compiled>) -> Compiled {
    if list.iter().any(|x| matches!(x, Compiled::All)) {
        return Compiled::All;
    }
    let mut objs: Vec<SearchKey> = list
        .into_iter()
        .filter_map(|x| match x {
            Compiled::Key(k) => Some(k),
            _ => None,
        })
        .collect();
    match objs.len() {
        0 => Compiled::Nothing,
        1 => Compiled::Key(objs.remove(0)),
        _ => Compiled::Key(SearchKey::Or(objs)),
    }
}

/// `Date.parse` des dates JMAP (RFC 3339) ; None si illisible.
pub fn parse_ms(v: &str) -> Option<i64> {
    if let Ok(d) = DateTime::parse_from_rfc3339(v) {
        return Some(d.timestamp_millis());
    }
    if let Ok(d) = chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(d.and_utc().timestamp_millis());
    }
    NaiveDate::parse_from_str(v, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc().timestamp_millis())
}

/// Jour UTC de l'instant `t` (ms).
fn day_str(t: i64) -> NaiveDate {
    DateTime::<Utc>::from_timestamp_millis(t)
        .map(|d| d.date_naive())
        .unwrap_or_default()
}

/// Traduit un filtre JMAP en critères SEARCH pour un dossier donné.
pub fn compile_filter(
    filter: &Object,
    folder: &Folder,
    created: &CreatedIds,
) -> Result<Compiled, MethodError> {
    if let Some(op) = filter.get("operator").and_then(Value::as_str) {
        let mut subs = Vec::new();
        for c in filter
            .get("conditions")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let empty = Object::new();
            subs.push(compile_filter(
                c.as_object().unwrap_or(&empty),
                folder,
                created,
            )?);
        }
        return match op {
            "AND" => Ok(and_all(subs)),
            "OR" => Ok(or_all(subs)),
            "NOT" => Ok(match or_all(subs) {
                Compiled::All => Compiled::Nothing,
                Compiled::Nothing => Compiled::All,
                Compiled::Key(k) => Compiled::Key(SearchKey::Not(Box::new(k))),
            }),
            other => Err(MethodError::described(
                "unsupportedFilter",
                format!("unknown operator {other}"),
            )),
        };
    }
    compile_conditions(filter, folder, created)
}

fn compile_conditions(
    filter: &Object,
    folder: &Folder,
    created: &CreatedIds,
) -> Result<Compiled, MethodError> {
    let mut parts: Vec<Compiled> = Vec::new();
    let bool_of = |b: bool| if b { Compiled::All } else { Compiled::Nothing };
    for (k, v) in filter {
        match k.as_str() {
            "inMailbox" => parts.push(bool_of(created.resolve(&js_string(v)) == folder.id)),
            "inMailboxOtherThan" => {
                let ids: Vec<String> = v
                    .as_array()
                    .map(|a| a.iter().map(|x| created.resolve(&js_string(x))).collect())
                    .unwrap_or_default();
                parts.push(bool_of(!ids.contains(&folder.id)));
            }
            "text" | "from" | "to" | "cc" | "bcc" | "subject" | "body" => {
                if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    if has_control(s) {
                        return Err(MethodError::described(
                            "invalidArguments",
                            format!("invalid characters in {k}"),
                        ));
                    }
                    let s = s.to_string();
                    parts.push(Compiled::Key(match k.as_str() {
                        "text" => SearchKey::Text(s),
                        "from" => SearchKey::From(s),
                        "to" => SearchKey::To(s),
                        "cc" => SearchKey::Cc(s),
                        "bcc" => SearchKey::Bcc(s),
                        "subject" => SearchKey::Subject(s),
                        _ => SearchKey::Body(s),
                    }));
                }
            }
            "before" => {
                let t = parse_ms(&js_string(v))
                    .ok_or_else(|| MethodError::described("invalidArguments", "bad before date"))?;
                parts.push(Compiled::Key(SearchKey::Before(
                    day_str(t) + Duration::days(2),
                )));
            }
            "after" => {
                let t = parse_ms(&js_string(v))
                    .ok_or_else(|| MethodError::described("invalidArguments", "bad after date"))?;
                parts.push(Compiled::Key(SearchKey::Since(
                    day_str(t) - Duration::days(1),
                )));
            }
            "minSize" => {
                let n = js_number(v);
                parts.push(Compiled::Key(SearchKey::Larger((n - 1.0).max(0.0) as u64)));
            }
            "maxSize" => parts.push(Compiled::Key(SearchKey::Smaller(
                js_number(v).max(0.0) as u64
            ))),
            "hasKeyword" | "notKeyword" => {
                let has = k == "hasKeyword";
                let kw = js_string(v);
                if !valid_keyword(&kw) {
                    return Err(MethodError::described(
                        "invalidArguments",
                        format!("invalid keyword {kw}"),
                    ));
                }
                let flag = keyword_to_flag(&kw);
                parts.push(Compiled::Key(match flag.as_str() {
                    "\\Seen" => SearchKey::Seen(has),
                    "\\Flagged" => SearchKey::Flagged(has),
                    "\\Answered" => SearchKey::Answered(has),
                    "\\Draft" => SearchKey::Draft(has),
                    _ if has => SearchKey::Keyword(flag),
                    _ => SearchKey::UnKeyword(flag),
                }));
            }
            "hasAttachment" => {
                let h = SearchKey::Header("content-type".into(), Some("multipart/mixed".into()));
                parts.push(Compiled::Key(if truthy(v) {
                    h
                } else {
                    SearchKey::Not(Box::new(h))
                }));
            }
            "header" => {
                let arr: Vec<&Value> = v.as_array().map(|a| a.iter().collect()).unwrap_or_default();
                let name = arr.first().map(|x| js_string(x)).filter(|n| !n.is_empty());
                let Some(name) = name else {
                    return Err(MethodError::described(
                        "invalidArguments",
                        "header filter needs a name",
                    ));
                };
                if !valid_header_name(&name) {
                    return Err(MethodError::described(
                        "invalidArguments",
                        "invalid header name",
                    ));
                }
                let value = arr.get(1).filter(|x| !x.is_null()).map(|x| js_string(x));
                if value.as_deref().is_some_and(has_control) {
                    return Err(MethodError::described(
                        "invalidArguments",
                        "invalid characters in header",
                    ));
                }
                parts.push(Compiled::Key(SearchKey::Header(name.to_lowercase(), value)));
            }
            "allInThreadHaveKeyword" | "someInThreadHaveKeyword" | "noneInThreadHaveKeyword" => {
                return Err(MethodError::described(
                    "unsupportedFilter",
                    format!("{k} is not supported"),
                ));
            }
            _ => {
                return Err(MethodError::described(
                    "unsupportedFilter",
                    format!("unknown filter {k}"),
                ));
            }
        }
    }
    Ok(and_all(parts))
}

/// `Number(v)` de JS (NaN → 0 pour les tailles).
fn js_number(v: &Value) -> f64 {
    let n = match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    };
    if n.is_nan() { 0.0 } else { n }
}

/// Le filtre (y compris ses sous-conditions) utilise-t-il la clé `key` ?
#[allow(dead_code)]
pub fn mentions_key(filter: Option<&Object>, key: &str) -> bool {
    let Some(filter) = filter else {
        return false;
    };
    if filter.contains_key(key) {
        return true;
    }
    filter
        .get("conditions")
        .and_then(Value::as_array)
        .is_some_and(|c| c.iter().any(|x| mentions_key(x.as_object(), key)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn folder() -> Folder {
        Folder {
            id: "mabc".into(),
            path: "INBOX".into(),
            name: "Inbox".into(),
            delimiter: "/".into(),
            parent_id: None,
            role: Some("inbox".into()),
            subscribed: true,
            messages: 1,
            unseen: 0,
            uid_next: 2,
            uid_validity: 1,
            highest_modseq: None,
        }
    }

    fn compile(v: Value) -> Result<Compiled, MethodError> {
        compile_filter(v.as_object().unwrap(), &folder(), &CreatedIds::default())
    }

    fn key(v: Value) -> SearchKey {
        match compile(v).unwrap() {
            Compiled::Key(k) => k,
            Compiled::All => SearchKey::All,
            Compiled::Nothing => SearchKey::Uid("none".into()),
        }
    }

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn chaque_condition() {
        assert_eq!(
            key(json!({ "from": " a@b " })),
            SearchKey::From("a@b".into())
        );
        assert_eq!(key(json!({ "to": "x" })), SearchKey::To("x".into()));
        assert_eq!(key(json!({ "cc": "x" })), SearchKey::Cc("x".into()));
        assert_eq!(key(json!({ "bcc": "x" })), SearchKey::Bcc("x".into()));
        assert_eq!(
            key(json!({ "subject": "x" })),
            SearchKey::Subject("x".into())
        );
        assert_eq!(key(json!({ "body": "x" })), SearchKey::Body("x".into()));
        assert_eq!(key(json!({ "text": "x" })), SearchKey::Text("x".into()));
        assert_eq!(key(json!({ "text": "  " })), SearchKey::All);
        assert_eq!(key(json!({ "hasKeyword": "$seen" })), SearchKey::Seen(true));
        assert_eq!(
            key(json!({ "notKeyword": "$flagged" })),
            SearchKey::Flagged(false)
        );
        assert_eq!(
            key(json!({ "hasKeyword": "$forwarded" })),
            SearchKey::Keyword("$Forwarded".into())
        );
        assert_eq!(
            key(json!({ "notKeyword": "perso" })),
            SearchKey::UnKeyword("perso".into())
        );
        assert_eq!(
            key(json!({ "before": "2025-03-10T12:00:00Z" })),
            SearchKey::Before(d("2025-03-12"))
        );
        assert_eq!(
            key(json!({ "after": "2025-03-10T12:00:00Z" })),
            SearchKey::Since(d("2025-03-09"))
        );
        assert_eq!(key(json!({ "minSize": 100 })), SearchKey::Larger(99));
        assert_eq!(key(json!({ "maxSize": 100 })), SearchKey::Smaller(100));
        assert_eq!(
            key(json!({ "header": ["X-Spam", "yes"] })),
            SearchKey::Header("x-spam".into(), Some("yes".into()))
        );
        assert_eq!(
            key(json!({ "header": ["List-Id"] })),
            SearchKey::Header("list-id".into(), None)
        );
        assert_eq!(
            key(json!({ "hasAttachment": true })),
            SearchKey::Header("content-type".into(), Some("multipart/mixed".into()))
        );
        assert!(compile(json!({ "before": "nope" })).is_err());
        assert!(compile(json!({ "someInThreadHaveKeyword": "$seen" })).is_err());
        assert!(compile(json!({ "bogus": 1 })).is_err());
    }

    #[test]
    fn trois_refus() {
        let kind = |v: Value| match compile(v) {
            Err(e) => e.kind,
            Ok(_) => "accepté".into(),
        };
        assert_eq!(
            kind(json!({ "text": "a\r\nA1 STORE 1:* +FLAGS (\\Deleted)" })),
            "invalidArguments"
        );
        assert_eq!(kind(json!({ "subject": "a\u{0}b" })), "invalidArguments");
        assert_eq!(
            kind(json!({ "header": ["X-A", "v\nw"] })),
            "invalidArguments"
        );
        assert_eq!(kind(json!({ "header": ["X A"] })), "invalidArguments");
        assert_eq!(kind(json!({ "header": ["X:A"] })), "invalidArguments");
        assert_eq!(kind(json!({ "hasKeyword": "a(b" })), "invalidArguments");
        assert_eq!(kind(json!({ "notKeyword": "a b" })), "invalidArguments");
        assert!(matches!(
            compile(json!({ "text": "café" })),
            Ok(Compiled::Key(SearchKey::Text(_)))
        ));
    }

    #[test]
    fn and_avec_conflit_et_not_d_un_or() {
        assert_eq!(
            key(json!({ "operator": "AND", "conditions": [{ "from": "a" }, { "subject": "b" }] })),
            SearchKey::And(vec![
                SearchKey::From("a".into()),
                SearchKey::Subject("b".into())
            ])
        );
        assert_eq!(
            key(json!({ "operator": "AND", "conditions": [{ "from": "a" }, { "from": "b" }] })),
            SearchKey::Not(Box::new(SearchKey::Or(vec![
                SearchKey::Not(Box::new(SearchKey::From("a".into()))),
                SearchKey::Not(Box::new(SearchKey::From("b".into()))),
            ])))
        );
        assert_eq!(
            key(json!({ "operator": "NOT", "conditions": [{ "from": "a" }, { "to": "b" }] })),
            SearchKey::Not(Box::new(SearchKey::Or(vec![
                SearchKey::From("a".into()),
                SearchKey::To("b".into())
            ])))
        );
        assert!(compile(json!({ "operator": "XOR", "conditions": [] })).is_err());
    }

    #[test]
    fn dossiers() {
        assert!(matches!(
            compile(json!({ "inMailbox": "mabc" })).unwrap(),
            Compiled::All
        ));
        assert!(matches!(
            compile(json!({ "inMailbox": "mzzz" })).unwrap(),
            Compiled::Nothing
        ));
        assert!(matches!(
            compile(json!({ "inMailboxOtherThan": ["mabc"] })).unwrap(),
            Compiled::Nothing
        ));
        assert!(matches!(
            compile(json!({ "inMailboxOtherThan": ["mzzz"], "from": "a" })).unwrap(),
            Compiled::Key(SearchKey::From(_))
        ));
        assert!(mentions_key(
            json!({ "operator": "AND", "conditions": [{ "text": "x" }] }).as_object(),
            "text"
        ));
    }
}
