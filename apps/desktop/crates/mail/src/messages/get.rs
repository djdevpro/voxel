//! Email/get (port de `Messages.get` et `Messages.build`) : regroupement par dossier, lecture de la structure,
//! des drapeaux, des corps et des aperçus, puis construction des objets Email.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use voxel_core::jmap::{FacadeError, MethodError, Object};
use voxel_core::util::{hash_of, utc_date};
use voxel_imap::headers::{header_values, parse_message_ids};
use voxel_imap::structure::{BodyPart, has_real_attachment};

use super::{
    BASE_HEADERS, BODY_PROPS_NEEDING_FETCH, BodyMap, DEFAULT_BODY_PROPS, DEFAULT_PROPS,
    KNOWN_PROPS, Located, Messages, StaticInfo, flags_to_keywords, flatten_leaves, lock,
    unique_parts,
};
use crate::backend::imap_err;
use crate::folders::Folders;
use crate::jmap_json::{
    address_json, header_name_of, header_property, js_string, part_json, valid_header_name,
};

/// Ce que demande un Email/get, partagé par les lectures de chaque dossier.
#[derive(Clone)]
struct Wants {
    cheap: bool,
    extra_headers: Vec<String>,
    header_names: Vec<String>,
    need_keywords: bool,
    want_body_values: bool,
    fetch_all: bool,
    fetch_text: bool,
    fetch_html: bool,
    need_preview: bool,
}

/// Coupe `v` à au plus `max` octets, sur une frontière de caractère.
fn truncate_utf8(v: &str, max: usize) -> &str {
    let mut end = max.min(v.len());
    while !v.is_char_boundary(end) {
        end -= 1;
    }
    &v[..end]
}

impl Messages {
    pub async fn get(self: &Arc<Self>, args: &Object) -> Result<Object, FacadeError> {
        let state = self.folders.email_state().await?;
        let ids = match args.get("ids") {
            None | Some(Value::Null) => {
                return Err(MethodError::described(
                    "requestTooLarge",
                    "ids: null is not supported, use Email/query",
                )
                .into());
            }
            Some(Value::Array(ids)) => ids.iter().map(js_string).collect::<Vec<_>>(),
            Some(_) => {
                return Err(
                    MethodError::described("invalidArguments", "ids must be an array").into(),
                );
            }
        };
        if ids.len() > 500 {
            return Err(MethodError::described("requestTooLarge", "too many ids").into());
        }
        // RFC 8620 §5.1 : « id » est toujours renvoyé, même s'il n'est pas demandé
        let props: Vec<String> = match args.get("properties").and_then(Value::as_array) {
            Some(list) => {
                let mut out = vec!["id".to_string()];
                for p in list.iter().map(js_string) {
                    if !out.contains(&p) {
                        out.push(p);
                    }
                }
                out
            }
            None => DEFAULT_PROPS.iter().map(|p| p.to_string()).collect(),
        };
        for p in &props {
            let known = DEFAULT_PROPS.contains(&p.as_str()) || KNOWN_PROPS.contains(&p.as_str());
            if !known && !p.starts_with("header:") {
                return Err(MethodError::described(
                    "invalidArguments",
                    format!("unknown property {p}"),
                )
                .into());
            }
        }
        // nom d'en-tête envoyé tel quel dans FETCH HEADER.FIELDS : contrôlé (C15)
        for p in &props {
            if let Some(rest) = p.strip_prefix("header:") {
                let name = rest.split(':').next().unwrap_or("");
                if !valid_header_name(name) {
                    return Err(MethodError::described(
                        "invalidArguments",
                        format!("invalid header name in {p}"),
                    )
                    .into());
                }
            }
        }
        let body_props: Vec<String> = match args.get("bodyProperties").and_then(Value::as_array) {
            Some(list) => list.iter().map(js_string).collect(),
            None => DEFAULT_BODY_PROPS.iter().map(|p| p.to_string()).collect(),
        };
        let is_true = |k: &str| args.get(k) == Some(&Value::Bool(true));
        let (fetch_text, fetch_html, fetch_all) = (
            is_true("fetchTextBodyValues"),
            is_true("fetchHTMLBodyValues"),
            is_true("fetchAllBodyValues"),
        );
        let max_bytes = args
            .get("maxBodyValueBytes")
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0)
            .map_or(0, |n| n as usize);
        let has = |p: &str| props.iter().any(|x| x == p);
        let extra_headers: Vec<String> = props.iter().filter_map(|p| header_name_of(p)).collect();
        let mut header_names: Vec<String> = BASE_HEADERS.iter().map(|h| h.to_string()).collect();
        for h in &extra_headers {
            if !header_names.contains(h) {
                header_names.push(h.clone());
            }
        }
        let wants = Wants {
            // propriétés sans en-têtes ni structure : un simple FETCH FLAGS suffit (et vérifie l'existence)
            cheap: props
                .iter()
                .all(|p| p == "id" || p == "mailboxIds" || p == "keywords"),
            extra_headers,
            header_names,
            need_keywords: has("keywords"),
            want_body_values: has("bodyValues") && (fetch_text || fetch_html || fetch_all),
            fetch_all,
            fetch_text,
            fetch_html,
            need_preview: has("preview"),
        };
        let need_structure = props
            .iter()
            .any(|p| BODY_PROPS_NEEDING_FETCH.contains(&p.as_str()));

        let (found, mut not_found) = self.locate(&ids).await?;
        let mut by_folder: Vec<Vec<Located>> = Vec::new();
        for l in &found {
            match by_folder.iter_mut().find(|g| g[0].folder.id == l.folder.id) {
                Some(g) => g.push(l.clone()),
                None => by_folder.push(vec![l.clone()]),
            }
        }
        let outs = futures_util::future::join_all(by_folder.into_iter().map(|group| {
            let me = self.clone();
            let wants = wants.clone();
            let path = group[0].folder.path.clone();
            async move {
                self.pool
                    .with_mailbox(&path, false, move |c| {
                        let (me, wants, group) = (me.clone(), wants.clone(), group.clone());
                        Box::pin(async move { me.read_group(c, &group, &wants).await })
                    })
                    .await
            }
        }))
        .await;
        let mut missing: HashSet<String> = HashSet::new();
        let mut body_maps: Vec<(String, BodyMap)> = Vec::new();
        for out in outs {
            let (m, b) = out.map_err(imap_err)?;
            missing.extend(m);
            body_maps.extend(b);
        }

        let mut list: Vec<Value> = Vec::new();
        for l in &found {
            if missing.contains(&l.id) {
                not_found.push(l.id.clone());
                continue;
            }
            let st = self.static_of(&l.current);
            if st.is_none() && need_structure {
                not_found.push(l.id.clone());
                continue;
            }
            let body = body_maps
                .iter()
                .find(|(k, _)| *k == l.current)
                .map(|(_, b)| b);
            list.push(self.build(l, st.as_ref(), &props, &body_props, body, max_bytes));
        }
        let mut r = Object::new();
        r.insert("state".into(), json!(state));
        r.insert("list".into(), Value::Array(list));
        r.insert("notFound".into(), json!(not_found));
        Ok(r)
    }

    /// Lectures IMAP d'un groupe d'emails du dossier sélectionné : (ids absents, corps lus).
    async fn read_group(
        &self,
        c: &mut voxel_imap::session::ImapSession,
        group: &[Located],
        w: &Wants,
    ) -> Result<(Vec<String>, Vec<(String, BodyMap)>), voxel_imap::ImapError> {
        let folder = &group[0].folder;
        let mut missing: HashSet<String> = HashSet::new();
        let mut bodies = Vec::new();
        if c.selected()
            .is_none_or(|m| m.uid_validity != folder.uid_validity)
        {
            return Ok((group.iter().map(|g| g.id.clone()).collect(), bodies));
        }
        let need_static: Vec<&Located> = group
            .iter()
            .filter(|g| {
                if w.cheap {
                    return false;
                }
                match self.static_of(&g.current) {
                    None => true,
                    Some(st) => w.extra_headers.iter().any(|h| !st.header_names.contains(h)),
                }
            })
            .collect();
        let mut fetched_flags: HashSet<u32> = HashSet::new();
        if !need_static.is_empty() {
            let uids: Vec<u32> = need_static.iter().map(|g| g.key.uid).collect();
            let got = self.fetch_static(c, folder, &uids, &w.header_names).await?;
            for g in &need_static {
                if !got.contains(&g.key.uid) {
                    missing.insert(g.id.clone());
                } else {
                    fetched_flags.insert(g.key.uid);
                }
            }
        }
        let alive: Vec<&Located> = group.iter().filter(|g| !missing.contains(&g.id)).collect();
        if w.cheap {
            let uids: Vec<u32> = alive.iter().map(|g| g.key.uid).collect();
            let got = self.fetch_flags(c, folder, &uids).await?;
            for g in &alive {
                if !got.contains(&g.key.uid) {
                    missing.insert(g.id.clone());
                }
            }
        } else if w.need_keywords {
            let stamp = Folders::stamp(folder);
            let stale: Vec<&&Located> = alive
                .iter()
                .filter(|g| {
                    !fetched_flags.contains(&g.key.uid)
                        && lock(&self.flags).get(&g.current).map(|f| f.0.as_str())
                            != Some(stamp.as_str())
                })
                .collect();
            if !stale.is_empty() {
                let uids: Vec<u32> = stale.iter().map(|g| g.key.uid).collect();
                let got = self.fetch_flags(c, folder, &uids).await?;
                for g in &stale {
                    if !got.contains(&g.key.uid) {
                        missing.insert(g.id.clone());
                    }
                }
            }
        }
        let alive2: Vec<&Located> = group.iter().filter(|g| !missing.contains(&g.id)).collect();
        if w.want_body_values {
            for g in &alive2 {
                let Some(st) = self.static_of(&g.current) else {
                    continue;
                };
                let parts: Vec<BodyPart> = if w.fetch_all {
                    flatten_leaves(&st.root)
                        .into_iter()
                        .filter(|p| p.content_type.starts_with("text/"))
                        .collect()
                } else {
                    let mut parts = Vec::new();
                    if w.fetch_text {
                        parts.extend(st.text_body.iter().cloned());
                    }
                    if w.fetch_html {
                        parts.extend(st.html_body.iter().cloned());
                    }
                    parts
                        .into_iter()
                        .filter(|p| p.content_type.starts_with("text/"))
                        .collect()
                };
                let map = self
                    .fetch_body_values(c, folder, g.key.uid, &unique_parts(parts))
                    .await?;
                bodies.push((g.current.clone(), map));
            }
        }
        if w.need_preview {
            let uids: Vec<u32> = alive2.iter().map(|g| g.key.uid).collect();
            self.fetch_previews(c, folder, &uids).await?;
        }
        Ok((missing.into_iter().collect(), bodies))
    }

    fn build(
        &self,
        l: &Located,
        st: Option<&StaticInfo>,
        props: &[String],
        body_props: &[String],
        body_map: Option<&BodyMap>,
        max_bytes: usize,
    ) -> Value {
        let mut out = Map::new();
        let env = st.map(|s| &s.envelope);
        let headers = st.map(|s| s.headers.as_slice()).unwrap_or(&[]);
        let last = |name: &str| header_values(headers, name).last().copied();
        let parts = |list: &[BodyPart]| -> Value {
            Value::Array(list.iter().map(|p| part_json(p, body_props)).collect())
        };
        for p in props {
            let v = match p.as_str() {
                "id" | "blobId" => json!(l.current),
                "threadId" => {
                    let tid = st
                        .map(|s| s.thread_id.clone())
                        .or_else(|| lock(&self.thread_of_email).get(&l.current).cloned());
                    json!(tid.unwrap_or_else(|| format!("T{}", hash_of(&l.current, 14))))
                }
                "mailboxIds" => json!({ l.folder.id.clone(): true }),
                "keywords" => {
                    let flags = lock(&self.flags).get(&l.current).map(|f| f.1.clone());
                    flags_to_keywords(flags.as_deref())
                }
                "size" => json!(st.map_or(0, |s| s.size)),
                "receivedAt" => json!(utc_date(st.map_or(0, |s| s.internal_date))),
                "sentAt" => env
                    .and_then(|e| e.date)
                    .map_or(Value::Null, |d| json!(utc_date(d.timestamp_millis()))),
                "subject" => json!(env.and_then(|e| e.subject.clone())),
                "from" => env.map_or(Value::Null, |e| address_json(&e.from)),
                "to" => env.map_or(Value::Null, |e| address_json(&e.to)),
                "cc" => env.map_or(Value::Null, |e| address_json(&e.cc)),
                "bcc" => env.map_or(Value::Null, |e| address_json(&e.bcc)),
                "sender" => env.map_or(Value::Null, |e| address_json(&e.sender)),
                "replyTo" => env.map_or(Value::Null, |e| address_json(&e.reply_to)),
                "messageId" => json!(parse_message_ids(last("message-id")).or_else(|| {
                    env.and_then(|e| e.message_id.as_deref())
                        .and_then(|m| parse_message_ids(Some(m)))
                })),
                "inReplyTo" => json!(parse_message_ids(last("in-reply-to")).or_else(|| {
                    env.and_then(|e| e.in_reply_to.as_deref())
                        .and_then(|m| parse_message_ids(Some(m)))
                })),
                "references" => json!(parse_message_ids(last("references"))),
                "hasAttachment" => json!(st.is_some_and(|s| has_real_attachment(&s.attachments))),
                "preview" => json!(st.and_then(|s| s.preview.clone()).unwrap_or_default()),
                "bodyStructure" => st.map_or(Value::Null, |s| part_json(&s.root, body_props)),
                "textBody" => st.map_or(json!([]), |s| parts(&s.text_body)),
                "htmlBody" => st.map_or(json!([]), |s| parts(&s.html_body)),
                "attachments" => st.map_or(json!([]), |s| parts(&s.attachments)),
                "bodyValues" => {
                    let mut bv = Map::new();
                    for (pid, value) in body_map.map(Vec::as_slice).unwrap_or(&[]) {
                        let truncated = max_bytes > 0 && value.len() > max_bytes;
                        let v = if truncated {
                            truncate_utf8(value, max_bytes)
                        } else {
                            value
                        };
                        bv.insert(
                            pid.clone(),
                            json!({ "value": v, "isEncodingProblem": false, "isTruncated": truncated }),
                        );
                    }
                    Value::Object(bv)
                }
                "headers" => Value::Array(
                    headers
                        .iter()
                        .map(|h| json!({ "name": h.name, "value": format!(" {}", h.value) }))
                        .collect(),
                ),
                other if other.starts_with("header:") => header_property(headers, other),
                _ => continue,
            };
            out.insert(p.clone(), v);
        }
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::truncate_utf8;

    #[test]
    fn coupe_sur_une_frontiere_de_caractere() {
        assert_eq!(truncate_utf8("café", 4), "caf");
        assert_eq!(truncate_utf8("café", 5), "café");
        assert_eq!(truncate_utf8("abc", 10), "abc");
    }
}
