//! PatchObject JMAP (RFC 8620 §5.3) : chemins JSON Pointer sans « / » initial, `null` = suppression. Port de
//! `applyPatch` (`carddav/facade.ts`) et `applyEventPatch` (`jscalendar.ts`), qui servent aussi aux
//! `recurrenceOverrides` (RFC 8984 §4.3.5).

use serde_json::Value;
use voxel_core::jmap::{Object, SetError};

/// Segments refusés dans un chemin.
const BAD_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

pub fn apply_patch(object: &Value, patch: &Object) -> Result<Value, SetError> {
    let mut out = object.clone();
    for (path, value) in patch {
        let bad = || SetError::described("invalidPatch", format!("bad path {path}"));
        let parts: Vec<String> = path
            .split('/')
            .map(|p| p.replace("~1", "/").replace("~0", "~"))
            .collect();
        if parts
            .iter()
            .any(|p| p.is_empty() || BAD_KEYS.contains(&p.as_str()))
        {
            return Err(bad());
        }
        let mut cur = out.as_object_mut().ok_or_else(bad)?;
        for p in &parts[..parts.len() - 1] {
            let next = cur.entry(p.clone()).or_insert(Value::Null);
            if next.is_null() {
                *next = Value::Object(Object::new());
            }
            cur = next.as_object_mut().ok_or_else(bad)?;
        }
        let last = &parts[parts.len() - 1];
        if value.is_null() {
            cur.remove(last);
        } else {
            cur.insert(last.clone(), value.clone());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_escapes_removal_and_guards() {
        let o = json!({"name": {"full": "A"}, "members": {"urn:uuid:1": true}});
        let patch = json!({
            "name/full": "B",
            "members/urn:uuid:2": true,
            "members/urn:uuid:1": null,
            "emails/e~1x": {"address": "a@b"}
        });
        let r = apply_patch(&o, patch.as_object().unwrap()).unwrap();
        assert_eq!(
            r,
            json!({"name": {"full": "B"}, "members": {"urn:uuid:2": true}, "emails": {"e/x": {"address": "a@b"}}})
        );
        assert_eq!(o["members"], json!({"urn:uuid:1": true}));
        let err = apply_patch(&o, json!({"__proto__/x": 1}).as_object().unwrap()).unwrap_err();
        assert_eq!(err.description.as_deref(), Some("bad path __proto__/x"));
        assert!(apply_patch(&o, json!({"name/full/x": 1}).as_object().unwrap()).is_err());
        assert!(apply_patch(&o, json!({"a//b": 1}).as_object().unwrap()).is_err());
    }
}
