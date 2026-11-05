//! Types JMAP du cœur (RFC 8620) : requêtes, réponses, erreurs de méthode et d'objet, références arrière.
//! Port de `apps/server/src/imap/util.ts` et de `resolveRefs` (`imap/index.ts`), pour que la façade Rust
//! réponde octet pour octet comme la façade Node.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Object = serde_json::Map<String, Value>;

/// Erreur de méthode JMAP (RFC 8620 §3.6.2) : renvoyée comme `["error", {type, description}, callId]`.
#[derive(Debug, Clone, PartialEq)]
pub struct MethodError {
    pub kind: String,
    pub description: Option<String>,
    pub extra: Object,
}

impl MethodError {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            description: None,
            extra: Object::new(),
        }
    }

    pub fn described(kind: &str, description: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            description: Some(description.into()),
            extra: Object::new(),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut out = Object::new();
        out.insert("type".into(), Value::String(self.kind.clone()));
        if let Some(d) = described_only(&self.kind, &self.description) {
            out.insert("description".into(), Value::String(d.to_string()));
        }
        for (k, v) in &self.extra {
            out.insert(k.clone(), v.clone());
        }
        Value::Object(out)
    }
}

/// Erreur par objet dans un `/set` (SetError, RFC 8620 §5.3).
#[derive(Debug, Clone, PartialEq)]
pub struct SetError {
    pub kind: String,
    pub description: Option<String>,
    pub properties: Option<Vec<String>>,
}

impl SetError {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            description: None,
            properties: None,
        }
    }

    pub fn described(kind: &str, description: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            description: Some(description.into()),
            properties: None,
        }
    }

    pub fn on(kind: &str, description: impl Into<String>, properties: &[&str]) -> Self {
        Self {
            kind: kind.to_string(),
            description: Some(description.into()),
            properties: Some(properties.iter().map(|p| p.to_string()).collect()),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut out = Object::new();
        out.insert("type".into(), Value::String(self.kind.clone()));
        if let Some(d) = described_only(&self.kind, &self.description) {
            out.insert("description".into(), Value::String(d.to_string()));
        }
        if let Some(props) = &self.properties {
            out.insert(
                "properties".into(),
                Value::Array(props.iter().cloned().map(Value::String).collect()),
            );
        }
        Value::Object(out)
    }
}

/// Comme `toJSON` en TS : la description n'est écrite que si elle dit autre chose que le type.
fn described_only<'a>(kind: &str, description: &'a Option<String>) -> Option<&'a str> {
    description
        .as_deref()
        .filter(|d| !d.is_empty() && *d != kind)
}

/// Échec d'un appel de méthode ou d'une opération d'objet.
#[derive(Debug)]
pub enum FacadeError {
    Method(MethodError),
    Set(SetError),
    Backend(crate::error::BackendError),
    Fail(String),
}

impl FacadeError {
    /// Port de `setErrorOf` : l'erreur vue comme une SetError d'un objet.
    pub fn set_error_json(&self) -> Value {
        match self {
            FacadeError::Set(e) => e.to_json(),
            FacadeError::Method(e) => {
                let kind = if e.kind == "notFound" {
                    "notFound"
                } else {
                    "invalidProperties"
                };
                let description = e.description.clone().unwrap_or_else(|| e.kind.clone());
                serde_json::json!({ "type": kind, "description": description })
            }
            FacadeError::Backend(e) => {
                serde_json::json!({ "type": "serverFail", "description": e.to_string() })
            }
            FacadeError::Fail(m) => serde_json::json!({ "type": "serverFail", "description": m }),
        }
    }
}

impl From<MethodError> for FacadeError {
    fn from(e: MethodError) -> Self {
        FacadeError::Method(e)
    }
}

impl From<SetError> for FacadeError {
    fn from(e: SetError) -> Self {
        FacadeError::Set(e)
    }
}

impl From<crate::error::BackendError> for FacadeError {
    fn from(e: crate::error::BackendError) -> Self {
        FacadeError::Backend(e)
    }
}

/// `[nom, arguments, callId]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invocation(pub String, pub Value, pub String);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JmapRequest {
    pub using: Vec<String>,
    pub method_calls: Vec<Invocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_ids: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JmapResponse {
    pub method_responses: Vec<Invocation>,
    pub session_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_ids: Option<BTreeMap<String, String>>,
}

/// Ids créés pendant une requête : `#creationId` → id du serveur.
#[derive(Debug, Default, Clone)]
pub struct CreatedIds(pub BTreeMap<String, String>);

impl CreatedIds {
    pub fn resolve(&self, id: &str) -> String {
        match id.strip_prefix('#').and_then(|cid| self.0.get(cid)) {
            Some(created) => created.clone(),
            None => id.to_string(),
        }
    }

    pub fn record(&mut self, creation_id: &str, id: &str) {
        self.0.insert(creation_id.to_string(), id.to_string());
    }
}

/// Résout les arguments `#nom` (références arrière, RFC 8620 §3.7).
pub fn resolve_refs(args: &Object, responses: &[Invocation]) -> Result<Object, MethodError> {
    let mut out = Object::new();
    for (k, v) in args {
        let Some(plain) = k.strip_prefix('#') else {
            out.insert(k.clone(), v.clone());
            continue;
        };
        if args.contains_key(plain) {
            return Err(MethodError::described(
                "invalidArguments",
                format!("both {plain} and #{plain} given"),
            ));
        }
        let field = |name: &str| {
            v.as_object()
                .and_then(|o| o.get(name))
                .and_then(Value::as_str)
        };
        let (Some(result_of), Some(name), Some(path)) =
            (field("resultOf"), field("name"), field("path"))
        else {
            return Err(MethodError::described(
                "invalidResultReference",
                format!("bad reference for {k}"),
            ));
        };
        let Some(target) = responses.iter().find(|r| r.2 == result_of && r.0 == name) else {
            return Err(MethodError::described(
                "invalidResultReference",
                format!("no {name} response for {result_of}"),
            ));
        };
        out.insert(plain.to_string(), eval_pointer(&target.1, path)?);
    }
    Ok(out)
}

pub fn unescape_pointer_token(token: &str) -> String {
    token.replace("~1", "/").replace("~0", "~")
}

/// Évalue un pointeur JSON avec l'extension `*` de JMAP (RFC 8620 §3.7).
pub fn eval_pointer(value: &Value, path: &str) -> Result<Value, MethodError> {
    if path.is_empty() || path == "/" {
        return Ok(value.clone());
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err(MethodError::described(
            "invalidResultReference",
            format!("bad path {path}"),
        ));
    };
    let tokens: Vec<String> = rest.split('/').map(unescape_pointer_token).collect();
    walk(value, &tokens, path)
}

fn walk(value: &Value, tokens: &[String], path: &str) -> Result<Value, MethodError> {
    let Some((t, rest)) = tokens.split_first() else {
        return Ok(value.clone());
    };
    match value {
        Value::Array(items) => {
            if t == "*" {
                let mut out = Vec::new();
                for item in items {
                    match walk(item, rest, path)? {
                        Value::Array(inner) => out.extend(inner),
                        other => out.push(other),
                    }
                }
                return Ok(Value::Array(out));
            }
            match t.parse::<usize>() {
                Ok(i) if i < items.len() => walk(&items[i], rest, path),
                _ => Err(MethodError::described(
                    "invalidResultReference",
                    format!("index {t} out of range"),
                )),
            }
        }
        Value::Object(map) if map.contains_key(t.as_str()) => walk(&map[t.as_str()], rest, path),
        _ => Err(MethodError::described(
            "invalidResultReference",
            format!("path {path} not found"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Object {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn pointers() {
        let v = json!({ "ids": ["a", "b"], "list": [{ "threadId": "t1" }, { "threadId": ["t2", "t3"] }], "a/b": 1 });
        assert_eq!(eval_pointer(&v, "/ids").unwrap(), json!(["a", "b"]));
        assert_eq!(
            eval_pointer(&v, "/list/*/threadId").unwrap(),
            json!(["t1", "t2", "t3"])
        );
        assert_eq!(eval_pointer(&v, "/a~1b").unwrap(), json!(1));
        assert_eq!(eval_pointer(&v, "").unwrap(), v);
        let e = eval_pointer(&v, "/ids/5").unwrap_err();
        assert_eq!(
            (e.kind.as_str(), e.description.as_deref()),
            ("invalidResultReference", Some("index 5 out of range"))
        );
        assert_eq!(
            eval_pointer(&v, "/nope")
                .unwrap_err()
                .description
                .as_deref(),
            Some("path /nope not found")
        );
        assert_eq!(
            eval_pointer(&v, "ids").unwrap_err().description.as_deref(),
            Some("bad path ids")
        );
    }

    #[test]
    fn refs() {
        let responses = vec![Invocation(
            "Email/query".into(),
            json!({ "ids": ["m1"] }),
            "c0".into(),
        )];
        let args = obj(
            json!({ "accountId": "a", "#ids": { "resultOf": "c0", "name": "Email/query", "path": "/ids" } }),
        );
        assert_eq!(
            resolve_refs(&args, &responses).unwrap(),
            obj(json!({ "accountId": "a", "ids": ["m1"] }))
        );

        let missing =
            obj(json!({ "#ids": { "resultOf": "c9", "name": "Email/query", "path": "/ids" } }));
        let e = resolve_refs(&missing, &responses).unwrap_err();
        assert_eq!(
            (e.kind.as_str(), e.description.as_deref()),
            (
                "invalidResultReference",
                Some("no Email/query response for c9")
            )
        );

        let both = obj(
            json!({ "ids": [], "#ids": { "resultOf": "c0", "name": "Email/query", "path": "/ids" } }),
        );
        let e = resolve_refs(&both, &responses).unwrap_err();
        assert_eq!(
            (e.kind.as_str(), e.description.as_deref()),
            ("invalidArguments", Some("both ids and #ids given"))
        );

        let bad = obj(json!({ "#ids": "c0" }));
        assert_eq!(
            resolve_refs(&bad, &responses)
                .unwrap_err()
                .description
                .as_deref(),
            Some("bad reference for #ids")
        );
    }

    #[test]
    fn to_json() {
        assert_eq!(
            MethodError::new("notFound").to_json(),
            json!({ "type": "notFound" })
        );
        assert_eq!(
            MethodError::described("notFound", "notFound").to_json(),
            json!({ "type": "notFound" })
        );
        assert_eq!(
            MethodError::described("invalidArguments", "x").to_json(),
            json!({ "type": "invalidArguments", "description": "x" })
        );
        assert_eq!(
            SetError::new("forbidden").to_json(),
            json!({ "type": "forbidden" })
        );
        assert_eq!(
            SetError::on("invalidProperties", "bad", &["name"]).to_json(),
            json!({ "type": "invalidProperties", "description": "bad", "properties": ["name"] })
        );
        assert_eq!(
            FacadeError::from(MethodError::new("tooLarge")).set_error_json(),
            json!({ "type": "invalidProperties", "description": "tooLarge" })
        );
    }

    #[test]
    fn created_ids() {
        let mut c = CreatedIds::default();
        c.record("k1", "M42");
        assert_eq!(c.resolve("#k1"), "M42");
        assert_eq!(c.resolve("#k2"), "#k2");
        assert_eq!(c.resolve("M1"), "M1");
    }
}
