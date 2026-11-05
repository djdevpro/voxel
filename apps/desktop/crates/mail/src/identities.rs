//! Identités d'envoi émulées dans la table clé-valeur (port de `identities.ts`, IMAP n'en a pas) :
//! Identity/get|set|changes. Une identité par défaut est créée depuis l'adresse de la boîte. Les identités
//! sont gardées en JSON tel que Node l'écrivait, dans le même ordre de clés : l'état reste le même.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::{Value, json};
use voxel_core::jmap::{CreatedIds, FacadeError, MethodError, Object, SetError};
use voxel_core::kv::KvStore;
use voxel_core::util::{hash_of, random_base36};

use crate::jmap_json::{as_object, js_string, list_or_null, object_or_null};

/// Clé de la table clé-valeur.
const KEY: &str = "identities";
/// Propriétés modifiables.
const MUTABLE: [&str; 5] = ["name", "replyTo", "bcc", "textSignature", "htmlSignature"];
/// Adresse acceptée pour une nouvelle identité.
static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^\s@]+@[^\s@]+$").unwrap());

pub struct Identities {
    kv: Arc<dyn KvStore>,
    email: String,
}

fn identity(id: &str, email: &str, may_delete: bool) -> Object {
    let v = json!({ "id": id, "name": "", "email": email, "replyTo": null, "bcc": null, "textSignature": "", "htmlSignature": "", "mayDelete": may_delete });
    v.as_object().cloned().unwrap_or_default()
}

fn id_of(i: &Object) -> &str {
    i.get("id").and_then(Value::as_str).unwrap_or("")
}

impl Identities {
    pub fn new(kv: Arc<dyn KvStore>, email: &str) -> Self {
        Identities {
            kv,
            email: email.to_string(),
        }
    }

    pub fn all(&self) -> Vec<Object> {
        if let Some(raw) = self.kv.get(KEY).filter(|r| !r.is_empty())
            && let Ok(Value::Array(list)) = serde_json::from_str::<Value>(&raw)
            && !list.is_empty()
        {
            return list
                .into_iter()
                .map(|v| v.as_object().cloned().unwrap_or_default())
                .collect();
        }
        let def = identity("i0", &self.email, false);
        self.save(std::slice::from_ref(&def));
        vec![def]
    }

    fn save(&self, list: &[Object]) {
        self.kv.set(KEY, &json!(list).to_string());
    }

    pub fn state(&self) -> String {
        format!("i{}", hash_of(&json!(self.all()).to_string(), 12))
    }

    pub fn find(&self, id: &str) -> Option<Object> {
        self.all().into_iter().find(|i| id_of(i) == id)
    }

    pub fn get(&self, args: &Object) -> Result<Object, FacadeError> {
        let all = self.all();
        let props: Option<Vec<String>> = args
            .get("properties")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js_string).collect());
        let pick = |i: &Object| -> Value {
            let Some(props) = &props else {
                return Value::Object(i.clone());
            };
            let mut o = Object::new();
            o.insert("id".into(), json!(id_of(i)));
            for p in props {
                if let Some(v) = i.get(p) {
                    o.insert(p.clone(), v.clone());
                }
            }
            Value::Object(o)
        };
        let mut r = Object::new();
        r.insert("state".into(), json!(self.state()));
        match args.get("ids") {
            None | Some(Value::Null) => {
                r.insert("list".into(), Value::Array(all.iter().map(pick).collect()));
                r.insert("notFound".into(), json!([]));
            }
            Some(Value::Array(ids)) => {
                let mut list = Vec::new();
                let mut not_found = Vec::new();
                for id in ids {
                    match all.iter().find(|x| Some(id_of(x)) == id.as_str()) {
                        Some(i) => list.push(pick(i)),
                        None => not_found.push(id.clone()),
                    }
                }
                r.insert("list".into(), Value::Array(list));
                r.insert("notFound".into(), Value::Array(not_found));
            }
            Some(_) => {
                return Err(MethodError::described(
                    "invalidArguments",
                    "ids must be an array or null",
                )
                .into());
            }
        }
        Ok(r)
    }

    pub fn changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let state = self.state();
        if args.get("sinceState").and_then(Value::as_str) == Some(state.as_str()) {
            let r = json!({ "oldState": state, "newState": state, "hasMoreChanges": false, "created": [], "updated": [], "destroyed": [] });
            return Ok(r.as_object().cloned().unwrap_or_default());
        }
        Err(MethodError::new("cannotCalculateChanges").into())
    }

    pub fn set(&self, args: &Object, ctx: &mut CreatedIds) -> Result<Object, FacadeError> {
        let old_state = self.state();
        if let Some(s) = args.get("ifInState").and_then(Value::as_str)
            && s != old_state
        {
            return Err(MethodError::new("stateMismatch").into());
        }
        let mut list = self.all();
        let mut created = Object::new();
        let mut not_created = Object::new();
        let mut updated = Object::new();
        let mut not_updated = Object::new();
        let mut destroyed: Vec<String> = Vec::new();
        let mut not_destroyed = Object::new();

        if let Some(create) = as_object(args.get("create")) {
            for (cid, obj) in create {
                let r: Result<String, FacadeError> = (|| {
                    let obj = obj
                        .as_object()
                        .ok_or_else(|| SetError::new("invalidProperties"))?;
                    let email = obj
                        .get("email")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if !EMAIL.is_match(email) {
                        return Err(SetError::on(
                            "invalidProperties",
                            "valid email required",
                            &["email"],
                        )
                        .into());
                    }
                    let mut id;
                    loop {
                        id = format!("i{}", random_base36(6));
                        if !list.iter().any(|x| id_of(x) == id) {
                            break;
                        }
                    }
                    let mut ident = identity(&id, email, true);
                    apply_patch(&mut ident, obj, true)?;
                    list.push(ident);
                    Ok(id)
                })();
                match r {
                    Ok(id) => {
                        ctx.record(cid, &id);
                        created.insert(cid.clone(), json!({ "id": id, "mayDelete": true }));
                    }
                    Err(e) => {
                        not_created.insert(cid.clone(), e.set_error_json());
                    }
                }
            }
        }
        if let Some(update) = as_object(args.get("update")) {
            for (raw, patch) in update {
                let id = ctx.resolve(raw);
                let r: Result<(), FacadeError> = (|| {
                    let cur = list
                        .iter()
                        .find(|x| id_of(x) == id)
                        .ok_or_else(|| SetError::new("notFound"))?;
                    let patch = patch
                        .as_object()
                        .ok_or_else(|| SetError::new("invalidPatch"))?;
                    let mut next = cur.clone();
                    apply_patch(&mut next, patch, false)?;
                    for x in list.iter_mut() {
                        if id_of(x) == id {
                            *x = next.clone();
                        }
                    }
                    Ok(())
                })();
                match r {
                    Ok(()) => {
                        updated.insert(raw.clone(), Value::Null);
                    }
                    Err(e) => {
                        not_updated.insert(raw.clone(), e.set_error_json());
                    }
                }
            }
        }
        for raw in args
            .get("destroy")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js_string).collect::<Vec<_>>())
            .unwrap_or_default()
        {
            let id = ctx.resolve(&raw);
            match list.iter().find(|x| id_of(x) == id) {
                None => {
                    not_destroyed.insert(raw, json!({ "type": "notFound" }));
                }
                Some(cur) if cur.get("mayDelete") != Some(&Value::Bool(true)) => {
                    not_destroyed.insert(
                        raw,
                        json!({ "type": "forbidden", "description": "the default identity cannot be deleted" }),
                    );
                }
                Some(_) => {
                    list.retain(|x| id_of(x) != id);
                    destroyed.push(raw);
                }
            }
        }
        self.save(&list);
        let mut r = Object::new();
        r.insert("oldState".into(), json!(old_state));
        r.insert("newState".into(), json!(self.state()));
        r.insert("created".into(), object_or_null(created));
        r.insert("updated".into(), object_or_null(updated));
        r.insert("destroyed".into(), list_or_null(destroyed));
        r.insert("notCreated".into(), object_or_null(not_created));
        r.insert("notUpdated".into(), object_or_null(not_updated));
        r.insert("notDestroyed".into(), object_or_null(not_destroyed));
        Ok(r)
    }
}

fn apply_patch(target: &mut Object, patch: &Object, creating: bool) -> Result<(), FacadeError> {
    for (k, v) in patch {
        if k == "id" || k == "mayDelete" {
            if !creating && Some(v) != target.get(k) {
                return Err(
                    SetError::on("invalidProperties", format!("{k} is immutable"), &[k]).into(),
                );
            }
            continue;
        }
        if k == "email" {
            if !creating && Some(v) != target.get("email") {
                return Err(
                    SetError::on("invalidProperties", "email is immutable", &["email"]).into(),
                );
            }
            continue;
        }
        if !MUTABLE.contains(&k.as_str()) {
            return Err(
                SetError::on("invalidProperties", format!("unknown property {k}"), &[k]).into(),
            );
        }
        if k == "replyTo" || k == "bcc" {
            let list = match v {
                Value::Null => None,
                Value::Array(a) => Some(
                    a.iter()
                        .filter_map(|x| {
                            let email = x.get("email")?.as_str()?;
                            Some(json!({ "name": x.get("name").filter(|n| !n.is_null()).cloned().unwrap_or(Value::Null), "email": email }))
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => {
                    return Err(SetError::on("invalidProperties", format!("{k} must be an array or null"), &[k]).into());
                }
            };
            target.insert(
                k.clone(),
                list.filter(|l| !l.is_empty())
                    .map_or(Value::Null, Value::Array),
            );
        } else {
            let Some(s) = v.as_str() else {
                return Err(SetError::on(
                    "invalidProperties",
                    format!("{k} must be a string"),
                    &[k],
                )
                .into());
            };
            target.insert(k.clone(), json!(s));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use voxel_core::kv::MemoryKv;

    #[test]
    fn identite_par_defaut_creation_et_signature() {
        let ids = Identities::new(Arc::new(MemoryKv::default()), "a@b.c");
        let all = ids.all();
        assert_eq!(
            Value::Object(all[0].clone()).to_string(),
            r#"{"id":"i0","name":"","email":"a@b.c","replyTo":null,"bcc":null,"textSignature":"","htmlSignature":"","mayDelete":false}"#
        );
        let mut ctx = CreatedIds::default();
        let args = json!({
            "create": { "n": { "email": "x@y.z", "name": "X" } },
            "update": { "i0": { "textSignature": "-- A" } },
            "destroy": ["i0"]
        });
        let r = ids.set(args.as_object().unwrap(), &mut ctx).unwrap();
        let new_id = ctx.resolve("#n");
        assert!(new_id.starts_with('i') && new_id.len() == 7);
        assert_eq!(r["updated"], json!({ "i0": null }));
        assert_eq!(r["notDestroyed"]["i0"]["type"], json!("forbidden"));
        assert_eq!(ids.find("i0").unwrap()["textSignature"], json!("-- A"));
        let bad = json!({ "update": { "i0": { "email": "z@z.z" } } });
        let r = ids.set(bad.as_object().unwrap(), &mut ctx).unwrap();
        assert_eq!(r["notUpdated"]["i0"]["type"], json!("invalidProperties"));
    }
}
