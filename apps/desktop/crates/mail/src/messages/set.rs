//! Email/set et Email/import (port de `messages.ts`) : composition MIME et APPEND des créations, mots-clés
//! puis déplacements ou copies regroupés par dossier source, suppressions définitives.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, FixedOffset, Utc};
use serde_json::{Value, json};
use voxel_core::jmap::{
    CreatedIds, FacadeError, MethodError, Object, SetError, unescape_pointer_token,
};
use voxel_core::util::now_ms;
use voxel_imap::compose::{Attachment, ComposeInput, compose_mime};
use voxel_imap::headers::{
    Address, RawHeader, header_values, parse_header_block, parse_message_ids,
};
use voxel_imap::search::SearchKey;
use voxel_imap::session::FlagOp;

use super::{
    Located, Messages, keyword_to_flag, lock, search_or_empty, thread_id_of, valid_keyword,
};
use crate::backend::imap_err;
use crate::filter::parse_ms;
use crate::folders::Folder;
use crate::ids::{encode_email_id, to_seq_set};
use crate::jmap_json::{
    as_object, has_control, js_string, list_or_null, object_or_null, truthy_keys,
};

/// Plan de mise à jour d'un email.
#[derive(Clone)]
struct Plan {
    raw: String,
    loc: Located,
    add: Vec<String>,
    remove: Vec<String>,
    set_all: Option<Vec<String>>,
    /// dossiers finaux
    targets: Option<Vec<String>>,
}

fn push_unique(list: &mut Vec<String>, v: String) {
    if !list.contains(&v) {
        list.push(v);
    }
}

fn date_from_ms(ms: i64) -> DateTime<FixedOffset> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .fixed_offset()
}

/// Mots-clés vrais d'un objet, contrôlés.
fn keywords_of(obj: &Object) -> Result<Vec<String>, FacadeError> {
    let keywords = as_object(obj.get("keywords"))
        .map(truthy_keys)
        .unwrap_or_default();
    for k in &keywords {
        if !valid_keyword(k) {
            return Err(SetError::on(
                "invalidProperties",
                format!("invalid keyword {k}"),
                &["keywords"],
            )
            .into());
        }
    }
    Ok(keywords)
}

impl Messages {
    pub async fn set(
        self: &Arc<Self>,
        args: &Object,
        ctx: &mut CreatedIds,
    ) -> Result<Object, FacadeError> {
        let old_state = self.folders.email_state().await?;
        if let Some(s) = args.get("ifInState").and_then(Value::as_str)
            && s != old_state
        {
            return Err(MethodError::new("stateMismatch").into());
        }
        let mut created = Object::new();
        let mut not_created = Object::new();
        let mut updated = Object::new();
        let mut not_updated = Object::new();
        let mut destroyed: Vec<String> = Vec::new();
        let mut not_destroyed = Object::new();
        let mut changed = false;

        if let Some(create) = as_object(args.get("create")) {
            for (cid, obj) in create {
                match self.create(obj, ctx).await {
                    Ok(r) => {
                        if let Some(id) = r.get("id").and_then(Value::as_str) {
                            ctx.record(cid, id);
                        }
                        created.insert(cid.clone(), r);
                        changed = true;
                    }
                    Err(e) => {
                        not_created.insert(cid.clone(), e.set_error_json());
                    }
                }
            }
        }

        if let Some(update) = as_object(args.get("update")) {
            let (u, nu) = self.update(update, ctx).await?;
            updated = u;
            not_updated = nu;
            if !updated.is_empty() {
                changed = true;
            }
        }

        if let Some(list) = args.get("destroy").and_then(Value::as_array) {
            let items: Vec<(String, String)> = list
                .iter()
                .map(|x| {
                    let raw = js_string(x);
                    let id = ctx.resolve(&raw);
                    (raw, id)
                })
                .collect();
            let (d, nd) = self.destroy(&items).await?;
            if !d.is_empty() {
                changed = true;
            }
            destroyed.extend(d);
            not_destroyed.extend(nd);
        }

        if changed {
            self.folders.invalidate();
            self.invalidate_queries();
            (self.on_change)();
        }
        let mut r = Object::new();
        r.insert("oldState".into(), json!(old_state));
        r.insert("newState".into(), json!(self.folders.email_state().await?));
        r.insert("created".into(), object_or_null(created));
        r.insert("updated".into(), object_or_null(updated));
        r.insert("destroyed".into(), list_or_null(destroyed));
        r.insert("notCreated".into(), object_or_null(not_created));
        r.insert("notUpdated".into(), object_or_null(not_updated));
        r.insert("notDestroyed".into(), object_or_null(not_destroyed));
        Ok(r)
    }

    /// Dossiers cibles d'une création ou d'un import.
    async fn targets_of(&self, obj: &Object, ctx: &CreatedIds) -> Result<Vec<Folder>, FacadeError> {
        let mb_ids: Vec<String> = as_object(obj.get("mailboxIds"))
            .map(truthy_keys)
            .unwrap_or_default()
            .iter()
            .map(|k| ctx.resolve(k))
            .collect();
        if mb_ids.is_empty() {
            return Err(
                SetError::on("invalidProperties", "mailboxIds required", &["mailboxIds"]).into(),
            );
        }
        let folders = self.folders.list(false).await?;
        let mut targets = Vec::new();
        for id in &mb_ids {
            match folders.iter().find(|f| &f.id == id) {
                Some(f) => targets.push(f.clone()),
                None => {
                    return Err(SetError::on(
                        "invalidProperties",
                        "mailbox not found",
                        &["mailboxIds"],
                    )
                    .into());
                }
            }
        }
        Ok(targets)
    }

    async fn create(self: &Arc<Self>, obj: &Value, ctx: &CreatedIds) -> Result<Value, FacadeError> {
        let obj = obj
            .as_object()
            .ok_or_else(|| SetError::described("invalidProperties", "object expected"))?;
        let targets = self.targets_of(obj, ctx).await?;
        let keywords = keywords_of(obj)?;

        let input = self.compose_input(obj).await?;
        let raw = compose_mime(&input);
        let flags: Vec<String> = keywords.iter().map(|k| keyword_to_flag(k)).collect();
        let idate = obj
            .get("receivedAt")
            .and_then(Value::as_str)
            .and_then(parse_ms)
            .unwrap_or_else(now_ms);
        let first_id = self
            .append_to(&targets, &raw, &flags, idate, Some(&input.message_id))
            .await?;
        let mut headers = Vec::new();
        if !input.references.is_empty() {
            headers.push(RawHeader {
                name: "References".into(),
                value: input
                    .references
                    .iter()
                    .map(|r| format!("<{r}>"))
                    .collect::<Vec<_>>()
                    .join(" "),
            });
        }
        if !input.in_reply_to.is_empty() {
            headers.push(RawHeader {
                name: "In-Reply-To".into(),
                value: input
                    .in_reply_to
                    .iter()
                    .map(|r| format!("<{r}>"))
                    .collect::<Vec<_>>()
                    .join(" "),
            });
        }
        headers.push(RawHeader {
            name: "Message-ID".into(),
            value: format!("<{}>", input.message_id),
        });
        let (tid, root) = thread_id_of(&headers, &first_id);
        self.remember_thread(&first_id, &tid, &root, true);
        Ok(json!({ "id": first_id, "blobId": first_id, "threadId": tid, "size": raw.len() }))
    }

    /// APPEND d'un message brut dans chaque dossier cible ; renvoie l'id du premier exemplaire.
    pub async fn append_to(
        &self,
        targets: &[Folder],
        raw: &[u8],
        flags: &[String],
        idate: i64,
        message_id: Option<&str>,
    ) -> Result<String, FacadeError> {
        let mut first_id = String::new();
        let date = date_from_ms(idate);
        for folder in targets {
            let raw = raw.to_vec();
            let flags = flags.to_vec();
            let path = folder.path.clone();
            let message_id = message_id.map(String::from);
            let res = self
                .pool
                .with_conn(move |c| {
                    let (raw, flags, path, message_id) =
                        (raw.clone(), flags.clone(), path.clone(), message_id.clone());
                    Box::pin(async move {
                        let r = c.append(&path, &flags, date, &raw).await?;
                        if let Some((uid_validity, uid)) = r
                            && uid > 0
                            && uid_validity > 0
                        {
                            return Ok(Ok(Some((uid_validity, uid))));
                        }
                        let Some(mid) = message_id else {
                            return Ok(Ok(None));
                        };
                        // jamais de CR, LF ni NUL dans une commande IMAP (C15)
                        if has_control(&mid) {
                            return Ok(Err(()));
                        }
                        // serveur sans UIDPLUS : on retrouve le message par son Message-ID
                        let mb = c.select(&path, false).await?;
                        let found =
                            search_or_empty(c, &SearchKey::Header("message-id".into(), Some(mid)))
                                .await?;
                        Ok(Ok(found
                            .into_iter()
                            .max()
                            .filter(|u| *u > 0 && mb.uid_validity > 0)
                            .map(|uid| (mb.uid_validity, uid))))
                    })
                })
                .await
                .map_err(imap_err)?
                .map_err(|()| MethodError::described("invalidArguments", "invalid Message-ID"))?;
            let Some((uid_validity, uid)) = res else {
                return Err(
                    SetError::described("serverFail", "cannot locate appended message").into(),
                );
            };
            let id = encode_email_id(&folder.id, uid_validity, uid);
            self.date_set(&folder.id, uid_validity, uid, idate);
            if first_id.is_empty() {
                first_id = id;
            }
        }
        Ok(first_id)
    }

    // ---------------------------------------------------------------- Email/import

    /// Email/import (RFC 8621 §4.8) : APPEND du blob téléversé (message RFC 5322 brut) dans les dossiers
    /// demandés, avec ses mots-clés et sa date de réception.
    pub async fn import_emails(
        self: &Arc<Self>,
        args: &Object,
        ctx: &mut CreatedIds,
    ) -> Result<Object, FacadeError> {
        let old_state = self.folders.email_state().await?;
        if let Some(s) = args.get("ifInState").and_then(Value::as_str)
            && s != old_state
        {
            return Err(MethodError::new("stateMismatch").into());
        }
        let Some(emails) = as_object(args.get("emails")) else {
            return Err(MethodError::described("invalidArguments", "emails required").into());
        };
        let mut created = Object::new();
        let mut not_created = Object::new();
        for (cid, obj) in emails {
            let r: Result<Value, FacadeError> = async {
                let blob_ref = obj.get("blobId").and_then(Value::as_str);
                let (Some(obj), Some(blob_ref)) = (obj.as_object(), blob_ref) else {
                    return Err(
                        SetError::on("invalidProperties", "blobId required", &["blobId"]).into(),
                    );
                };
                let targets = self.targets_of(obj, ctx).await?;
                let keywords = keywords_of(obj)?;
                let Some((data, _)) = self.load_blob(&ctx.resolve(blob_ref)).await? else {
                    return Err(SetError::on(
                        "blobNotFound",
                        format!("blob {blob_ref} not found"),
                        &["blobId"],
                    )
                    .into());
                };
                let find = |pat: &[u8]| data.windows(pat.len()).position(|w| w == pat);
                let end = find(b"\r\n\r\n").or_else(|| find(b"\n\n"));
                let head = &data[..end.unwrap_or_else(|| data.len().min(65536))];
                let headers = parse_header_block(head);
                if headers.is_empty() {
                    return Err(SetError::on(
                        "invalidEmail",
                        "not an RFC 5322 message",
                        &["blobId"],
                    )
                    .into());
                }
                let message_id =
                    parse_message_ids(header_values(&headers, "message-id").last().copied())
                        .and_then(|v| v.into_iter().next());
                let idate = obj
                    .get("receivedAt")
                    .and_then(Value::as_str)
                    .and_then(parse_ms)
                    .unwrap_or_else(now_ms);
                let flags: Vec<String> = keywords.iter().map(|k| keyword_to_flag(k)).collect();
                let id = self
                    .append_to(&targets, &data, &flags, idate, message_id.as_deref())
                    .await?;
                let (tid, root) = thread_id_of(&headers, &id);
                self.remember_thread(&id, &tid, &root, true);
                ctx.record(cid, &id);
                Ok(json!({ "id": id, "blobId": id, "threadId": tid, "size": data.len() }))
            }
            .await;
            match r {
                Ok(v) => {
                    created.insert(cid.clone(), v);
                }
                Err(e) => {
                    not_created.insert(cid.clone(), e.set_error_json());
                }
            }
        }
        if !created.is_empty() {
            self.folders.invalidate();
            self.invalidate_queries();
            (self.on_change)();
        }
        let mut r = Object::new();
        r.insert("oldState".into(), json!(old_state));
        r.insert("newState".into(), json!(self.folders.email_state().await?));
        r.insert("created".into(), object_or_null(created));
        r.insert("notCreated".into(), object_or_null(not_created));
        Ok(r)
    }

    pub async fn compose_input(
        self: &Arc<Self>,
        obj: &Object,
    ) -> Result<ComposeInput, FacadeError> {
        let addrs = |k: &str| -> Result<Option<Vec<Address>>, FacadeError> {
            match obj.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Array(list)) => Ok(Some(
                    list.iter()
                        .filter_map(|a| {
                            let email = a.get("email")?.as_str()?;
                            Some(Address {
                                name: a.get("name").and_then(Value::as_str).map(String::from),
                                email: email.to_string(),
                            })
                        })
                        .collect(),
                )),
                Some(_) => {
                    Err(
                        SetError::on("invalidProperties", format!("{k} must be an array"), &[k])
                            .into(),
                    )
                }
            }
        };
        let ids = |k: &str| -> Option<Vec<String>> {
            obj.get(k).and_then(Value::as_array).map(|l| {
                l.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
        };
        let empty = Object::new();
        let body_values = as_object(obj.get("bodyValues")).unwrap_or(&empty);
        let value_of = |p: &Value| -> Result<Option<String>, FacadeError> {
            let Some(pid) = p.get("partId").and_then(Value::as_str) else {
                return Ok(None);
            };
            match body_values
                .get(pid)
                .and_then(|v| v.get("value"))
                .and_then(Value::as_str)
            {
                Some(v) => Ok(Some(v.to_string())),
                None => Err(SetError::on(
                    "invalidProperties",
                    format!("missing bodyValues.{pid}"),
                    &["bodyValues"],
                )
                .into()),
            }
        };
        let mut text: Option<String> = None;
        let mut html: Option<String> = None;
        let mut attachments: Vec<Attachment> = Vec::new();
        let list_of = |k: &str| -> Vec<Value> {
            obj.get(k)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let text_body = list_of("textBody");
        let html_body = list_of("htmlBody");
        if !text_body.is_empty() || !html_body.is_empty() {
            for p in &text_body {
                if let Some(v) = value_of(p)? {
                    text.get_or_insert_with(String::new).push_str(&v);
                }
            }
            for p in &html_body {
                if let Some(v) = value_of(p)? {
                    html.get_or_insert_with(String::new).push_str(&v);
                }
            }
        } else if let Some(structure) = obj.get("bodyStructure").filter(|v| v.is_object()) {
            // feuilles dans l'ordre du parcours en profondeur
            let mut leaves: Vec<&Value> = Vec::new();
            let mut stack: Vec<&Value> = vec![structure];
            while let Some(p) = stack.pop() {
                if let Some(subs) = p.get("subParts").and_then(Value::as_array) {
                    stack.extend(subs.iter().rev());
                } else {
                    leaves.push(p);
                }
            }
            for p in leaves {
                let t = p
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_lowercase)
                    .unwrap_or_default();
                if p.get("partId").is_some_and(Value::is_string) {
                    let v = value_of(p)?.unwrap_or_default();
                    if t == "text/html" {
                        html.get_or_insert_with(String::new).push_str(&v);
                    } else {
                        text.get_or_insert_with(String::new).push_str(&v);
                    }
                } else if p.get("blobId").is_some_and(Value::is_string) {
                    attachments.push(self.attachment_of(p).await?);
                }
            }
        }
        for a in list_of("attachments") {
            attachments.push(self.attachment_of(&a).await?);
        }
        let mut headers: Vec<(String, String)> = Vec::new();
        for (k, v) in obj {
            if !k.starts_with("header:") {
                continue;
            }
            let name = k.split(':').nth(1).unwrap_or("");
            if let (false, Some(v)) = (name.is_empty(), v.as_str()) {
                let value = v.trim().to_string();
                match headers.iter_mut().find(|(n, _)| n == name) {
                    Some(h) => h.1 = value,
                    None => headers.push((name.to_string(), value)),
                }
            }
        }
        let from = addrs("from")?;
        let domain = from
            .as_ref()
            .and_then(|f| f.first())
            .and_then(|a| a.email.split('@').nth(1))
            .unwrap_or("localhost")
            .to_string();
        let message_id = ids("messageId")
            .and_then(|l| l.into_iter().next())
            .unwrap_or_else(|| format!("{}@{domain}", uuid::Uuid::new_v4()));
        Ok(ComposeInput {
            from: from.unwrap_or_default(),
            to: addrs("to")?.unwrap_or_default(),
            cc: addrs("cc")?.unwrap_or_default(),
            bcc: addrs("bcc")?.unwrap_or_default(),
            reply_to: addrs("replyTo")?.unwrap_or_default(),
            sender: addrs("sender")?.unwrap_or_default(),
            subject: obj.get("subject").and_then(Value::as_str).map(String::from),
            sent_at: obj
                .get("sentAt")
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok()),
            message_id,
            in_reply_to: ids("inReplyTo").unwrap_or_default(),
            references: ids("references").unwrap_or_default(),
            text,
            html,
            attachments,
            headers,
        })
    }

    async fn attachment_of(self: &Arc<Self>, p: &Value) -> Result<Attachment, FacadeError> {
        let blob_id = p.get("blobId").and_then(Value::as_str).unwrap_or("");
        let Some((data, blob_type)) = self.load_blob(blob_id).await? else {
            return Err(SetError::on(
                "blobNotFound",
                format!("blob {blob_id} not found"),
                &["attachments"],
            )
            .into());
        };
        let cid = p.get("cid").and_then(Value::as_str).map(String::from);
        let disposition = p.get("disposition").and_then(Value::as_str);
        Ok(Attachment {
            filename: p.get("name").and_then(Value::as_str).map(String::from),
            content: data.to_vec(),
            content_type: p
                .get("type")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(String::from)
                .unwrap_or(blob_type),
            inline: disposition == Some("inline")
                || (cid.as_deref().is_some_and(|c| !c.is_empty())
                    && disposition != Some("attachment")),
            cid,
        })
    }

    async fn update(
        self: &Arc<Self>,
        update: &Object,
        ctx: &CreatedIds,
    ) -> Result<(Object, Object), FacadeError> {
        let mut updated = Object::new();
        let mut not_updated = Object::new();
        let folders = self.folders.list(false).await?;
        let mut plans: Vec<Plan> = Vec::new();
        let resolved: Vec<String> = update.keys().map(|k| ctx.resolve(k)).collect();
        let (found, not_found) = self.locate(&resolved).await?;
        for id in not_found {
            let raw = update
                .keys()
                .find(|r| ctx.resolve(r) == id)
                .cloned()
                .unwrap_or(id);
            not_updated.insert(raw, json!({ "type": "notFound" }));
        }
        for (raw, patch) in update {
            let Some(loc) = found.iter().find(|l| l.id == ctx.resolve(raw)) else {
                continue;
            };
            let r: Result<Plan, FacadeError> = (|| {
                let patch = patch
                    .as_object()
                    .ok_or_else(|| SetError::new("invalidPatch"))?;
                let mut plan = Plan {
                    raw: raw.clone(),
                    loc: loc.clone(),
                    add: Vec::new(),
                    remove: Vec::new(),
                    set_all: None,
                    targets: None,
                };
                let mut mb_set: Option<Vec<String>> = None;
                for (k, v) in patch {
                    if k == "keywords" {
                        let o = v.as_object().ok_or_else(|| {
                            SetError::on(
                                "invalidProperties",
                                "keywords must be an object",
                                &["keywords"],
                            )
                        })?;
                        plan.set_all = Some(truthy_keys(o));
                    } else if let Some(rest) = k.strip_prefix("keywords/") {
                        let kw = unescape_pointer_token(rest);
                        if !valid_keyword(&kw) {
                            return Err(SetError::on(
                                "invalidProperties",
                                format!("invalid keyword {kw}"),
                                &["keywords"],
                            )
                            .into());
                        }
                        match v {
                            Value::Bool(true) => push_unique(&mut plan.add, kw),
                            Value::Null | Value::Bool(false) => push_unique(&mut plan.remove, kw),
                            _ => {
                                return Err(SetError::described(
                                    "invalidPatch",
                                    format!("bad value for {k}"),
                                )
                                .into());
                            }
                        }
                    } else if k == "mailboxIds" {
                        let o = v.as_object().ok_or_else(|| {
                            SetError::on(
                                "invalidProperties",
                                "mailboxIds must be an object",
                                &["mailboxIds"],
                            )
                        })?;
                        let mut set = Vec::new();
                        for x in truthy_keys(o) {
                            push_unique(&mut set, ctx.resolve(&x));
                        }
                        mb_set = Some(set);
                    } else if let Some(rest) = k.strip_prefix("mailboxIds/") {
                        let mid = ctx.resolve(&unescape_pointer_token(rest));
                        let set = mb_set.get_or_insert_with(|| vec![loc.folder.id.clone()]);
                        match v {
                            Value::Bool(true) => push_unique(set, mid),
                            Value::Null | Value::Bool(false) => set.retain(|x| *x != mid),
                            _ => {
                                return Err(SetError::described(
                                    "invalidPatch",
                                    format!("bad value for {k}"),
                                )
                                .into());
                            }
                        }
                    } else {
                        let head = k.split('/').next().unwrap_or("");
                        return Err(SetError::on(
                            "invalidProperties",
                            format!("cannot update {k}"),
                            &[head],
                        )
                        .into());
                    }
                }
                if let Some(set) = mb_set {
                    if set.is_empty() {
                        return Err(SetError::on(
                            "invalidProperties",
                            "an email must belong to at least one mailbox",
                            &["mailboxIds"],
                        )
                        .into());
                    }
                    for mid in &set {
                        if !folders.iter().any(|f| &f.id == mid) {
                            return Err(SetError::on(
                                "invalidProperties",
                                format!("mailbox {mid} not found"),
                                &["mailboxIds"],
                            )
                            .into());
                        }
                    }
                    plan.targets = Some(set);
                }
                Ok(plan)
            })();
            match r {
                Ok(p) => plans.push(p),
                Err(e) => {
                    not_updated.insert(raw.clone(), e.set_error_json());
                }
            }
        }

        // par dossier source : mots-clés puis déplacements/copies
        let mut by_source: Vec<Vec<Plan>> = Vec::new();
        for p in plans {
            match by_source
                .iter_mut()
                .find(|g| g[0].loc.folder.id == p.loc.folder.id)
            {
                Some(g) => g.push(p),
                None => by_source.push(vec![p]),
            }
        }
        let outs = futures_util::future::join_all(by_source.into_iter().map(|group| {
            let me = self.clone();
            let folders = folders.clone();
            async move {
                let path = group[0].loc.folder.path.clone();
                self.pool
                    .with_mailbox(&path, false, move |c| {
                        let (me, group, folders) = (me.clone(), group.clone(), folders.clone());
                        Box::pin(async move { me.apply_group(c, &group, &folders).await })
                    })
                    .await
            }
        }))
        .await;
        for out in outs {
            for (raw, result) in out.map_err(imap_err)? {
                match result {
                    None => updated.insert(raw, Value::Null),
                    Some(err) => not_updated.insert(raw, err),
                };
            }
        }
        Ok((updated, not_updated))
    }

    /// Mots-clés puis déplacements d'un groupe du dossier sélectionné : (raw, None si réussi, sinon SetError).
    async fn apply_group(
        &self,
        c: &mut voxel_imap::session::ImapSession,
        group: &[Plan],
        folders: &[Folder],
    ) -> Result<Vec<(String, Option<Value>)>, voxel_imap::ImapError> {
        let folder = &group[0].loc.folder;
        let mut results: Vec<(String, Option<Value>)> = Vec::new();
        if c.selected()
            .is_none_or(|m| m.uid_validity != folder.uid_validity)
        {
            for p in group {
                results.push((p.raw.clone(), Some(json!({ "type": "notFound" }))));
            }
            return Ok(results);
        }
        let mut failed: HashSet<usize> = HashSet::new();
        let fail =
            |results: &mut Vec<(String, Option<Value>)>, raw: &str, e: voxel_imap::ImapError| {
                results.push((raw.to_string(), Some(imap_err(e).set_error_json())));
            };
        // mots-clés : regroupement par (opération, drapeau)
        let mut ops: Vec<(String, Vec<usize>)> = Vec::new();
        let mut add_op =
            |key: String, i: usize, replace: bool| match ops.iter_mut().find(|(k, _)| *k == key) {
                Some((_, l)) if !replace => l.push(i),
                Some((_, l)) => *l = vec![i],
                None => ops.push((key, vec![i])),
            };
        for (i, p) in group.iter().enumerate() {
            if p.set_all.is_some() {
                add_op(format!("set:{}", p.loc.key.uid), i, true);
                continue;
            }
            for kw in &p.add {
                add_op(format!("add:{kw}"), i, false);
            }
            for kw in &p.remove {
                add_op(format!("rem:{kw}"), i, false);
            }
        }
        for (op, ps) in &ops {
            let live: Vec<usize> = ps.iter().copied().filter(|i| !failed.contains(i)).collect();
            if live.is_empty() {
                continue;
            }
            let set = to_seq_set(
                &live
                    .iter()
                    .map(|i| group[*i].loc.key.uid)
                    .collect::<Vec<_>>(),
            );
            let r = if op.starts_with("set:") {
                let flags: Vec<String> = group[live[0]]
                    .set_all
                    .clone()
                    .unwrap_or_default()
                    .iter()
                    .map(|k| keyword_to_flag(k))
                    .collect();
                c.store_flags(&set, FlagOp::Replace, &flags).await
            } else {
                let flag = vec![keyword_to_flag(&op[4..])];
                let how = if op.starts_with("add:") {
                    FlagOp::Add
                } else {
                    FlagOp::Remove
                };
                c.store_flags(&set, how, &flag).await
            };
            if let Err(e) = r {
                for i in live {
                    failed.insert(i);
                    fail(&mut results, &group[i].raw, e.clone());
                }
            }
        }
        // mise à jour locale des drapeaux en cache
        for (i, p) in group.iter().enumerate() {
            if failed.contains(&i) {
                continue;
            }
            let mut flags = lock(&self.flags);
            let Some((_, cur)) = flags.get(&p.loc.current) else {
                continue;
            };
            let mut next = cur.clone();
            if let Some(all) = &p.set_all {
                next.retain(|f| {
                    let low = f.to_lowercase();
                    f.starts_with('\\')
                        && !["\\seen", "\\flagged", "\\answered", "\\draft"].contains(&low.as_str())
                });
                for kw in all {
                    push_unique(&mut next, keyword_to_flag(kw));
                }
            }
            for kw in &p.add {
                push_unique(&mut next, keyword_to_flag(kw));
            }
            for kw in &p.remove {
                let flag = keyword_to_flag(kw).to_lowercase();
                next.retain(|f| f.to_lowercase() != flag);
            }
            flags.insert(p.loc.current.clone(), (String::new(), next));
        }
        // déplacements : dossier final unique → MOVE ; plusieurs → COPY puis éventuellement MOVE
        let mut moves: Vec<(String, Vec<usize>)> = Vec::new();
        let mut copies: Vec<(String, Vec<usize>)> = Vec::new();
        let add_to = |map: &mut Vec<(String, Vec<usize>)>, dest: &str, i: usize| match map
            .iter_mut()
            .find(|(d, _)| d == dest)
        {
            Some((_, l)) => l.push(i),
            None => map.push((dest.to_string(), vec![i])),
        };
        for (i, p) in group.iter().enumerate() {
            let Some(targets) = &p.targets else {
                continue;
            };
            if failed.contains(&i) {
                continue;
            }
            let others: Vec<&String> = targets.iter().filter(|t| **t != folder.id).collect();
            let Some((first, rest)) = others.split_first() else {
                continue;
            };
            let keep = targets.contains(&folder.id);
            for t in rest {
                add_to(&mut copies, t, i);
            }
            if keep {
                add_to(&mut copies, first, i);
            } else {
                add_to(&mut moves, first, i);
            }
        }
        for (dest, ps) in &copies {
            let Some(df) = folders.iter().find(|f| &f.id == dest) else {
                continue;
            };
            let set = to_seq_set(&ps.iter().map(|i| group[*i].loc.key.uid).collect::<Vec<_>>());
            if let Err(e) = c.uid_copy(&set, &df.path).await {
                for i in ps {
                    failed.insert(*i);
                    fail(&mut results, &group[*i].raw, e.clone());
                }
            }
        }
        for (dest, ps) in &moves {
            let live: Vec<usize> = ps.iter().copied().filter(|i| !failed.contains(i)).collect();
            if live.is_empty() {
                continue;
            }
            let Some(df) = folders.iter().find(|f| &f.id == dest) else {
                continue;
            };
            let set = to_seq_set(
                &live
                    .iter()
                    .map(|i| group[*i].loc.key.uid)
                    .collect::<Vec<_>>(),
            );
            match c.uid_move(&set, &df.path).await {
                Ok(Some(map)) => {
                    for i in &live {
                        let p = &group[*i];
                        let Some((_, nu)) = map.pairs.iter().find(|(old, _)| *old == p.loc.key.uid)
                        else {
                            continue;
                        };
                        let new_id = encode_email_id(&df.id, map.uid_validity, *nu);
                        self.add_alias(&p.loc.current, &new_id);
                        if let Some(st) = self.static_of(&p.loc.current) {
                            lock(&self.statics).insert(new_id.clone(), st.clone());
                            let root = self
                                .root_of(&st.thread_id)
                                .unwrap_or_else(|| new_id.clone());
                            self.remember_thread(&new_id, &st.thread_id, &root, false);
                        }
                        let fl = lock(&self.flags).get(&p.loc.current).map(|f| f.1.clone());
                        if let Some(fl) = fl {
                            lock(&self.flags).insert(new_id.clone(), (String::new(), fl));
                        }
                        if let Some(dt) =
                            self.date_get(&folder.id, folder.uid_validity, p.loc.key.uid)
                        {
                            self.date_set(&df.id, map.uid_validity, *nu, dt);
                        }
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    for i in live {
                        failed.insert(i);
                        fail(&mut results, &group[i].raw, e.clone());
                    }
                }
            }
        }
        for (i, p) in group.iter().enumerate() {
            if !failed.contains(&i) {
                results.push((p.raw.clone(), None));
            }
        }
        Ok(results)
    }

    pub async fn destroy(
        self: &Arc<Self>,
        items: &[(String, String)],
    ) -> Result<(Vec<String>, Object), FacadeError> {
        let mut destroyed: Vec<String> = Vec::new();
        let mut not_destroyed = Object::new();
        let ids: Vec<String> = items.iter().map(|(_, id)| id.clone()).collect();
        let (found, not_found) = self.locate(&ids).await?;
        let raw_of = |id: &str| {
            items
                .iter()
                .find(|(_, i)| i == id)
                .map(|(r, _)| r.clone())
                .unwrap_or_else(|| id.to_string())
        };
        for id in not_found {
            not_destroyed.insert(raw_of(&id), json!({ "type": "notFound" }));
        }
        let mut by_folder: Vec<Vec<Located>> = Vec::new();
        for l in found {
            match by_folder.iter_mut().find(|g| g[0].folder.id == l.folder.id) {
                Some(g) => g.push(l),
                None => by_folder.push(vec![l]),
            }
        }
        let outs = futures_util::future::join_all(by_folder.into_iter().map(|group| {
            let path = group[0].folder.path.clone();
            async move {
                self.pool
                    .with_mailbox(&path, false, move |c| {
                        let group = group.clone();
                        Box::pin(async move {
                            // (id, None si détruit, sinon SetError)
                            let mut out: Vec<(String, Option<Value>)> = Vec::new();
                            if c.selected()
                                .is_none_or(|m| m.uid_validity != group[0].folder.uid_validity)
                            {
                                for l in &group {
                                    out.push((l.id.clone(), Some(json!({ "type": "notFound" }))));
                                }
                                return Ok(out);
                            }
                            let uids: Vec<u32> = group.iter().map(|l| l.key.uid).collect();
                            let alive: HashSet<u32> =
                                search_or_empty(c, &SearchKey::Uid(to_seq_set(&uids)))
                                    .await?
                                    .into_iter()
                                    .collect();
                            let live: Vec<&Located> = group
                                .iter()
                                .filter(|l| alive.contains(&l.key.uid))
                                .collect();
                            for l in &group {
                                if !alive.contains(&l.key.uid) {
                                    out.push((l.id.clone(), Some(json!({ "type": "notFound" }))));
                                }
                            }
                            if live.is_empty() {
                                return Ok(out);
                            }
                            let set =
                                to_seq_set(&live.iter().map(|l| l.key.uid).collect::<Vec<_>>());
                            match c.uid_delete(&set).await {
                                Ok(()) => out.extend(live.iter().map(|l| (l.id.clone(), None))),
                                Err(e) => {
                                    let err = imap_err(e).set_error_json();
                                    out.extend(
                                        live.iter().map(|l| (l.id.clone(), Some(err.clone()))),
                                    );
                                }
                            }
                            Ok(out)
                        })
                    })
                    .await
            }
        }))
        .await;
        for out in outs {
            for (id, result) in out.map_err(imap_err)? {
                match result {
                    None => {
                        destroyed.push(raw_of(&id));
                        let current = self.resolve_alias(&id);
                        lock(&self.statics).remove(&current);
                        lock(&self.flags).remove(&current);
                        lock(&self.bodies).remove(&current);
                    }
                    Some(err) => {
                        not_destroyed.insert(raw_of(&id), err);
                    }
                }
            }
        }
        Ok((destroyed, not_destroyed))
    }
}
