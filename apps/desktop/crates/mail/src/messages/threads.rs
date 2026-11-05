//! Thread/get et SearchSnippet/get (port de `messages.ts`) : un fil se reconstitue à partir de sa racine,
//! cherchée dans les Envoyés et dans les dossiers de ses membres connus, avec un index des clés de fil
//! par dossier (jusqu'à `INDEX_MAX` messages ; au-delà, recherche `HEADER` par paquets de 20).

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Value, json};
use voxel_core::jmap::{FacadeError, MethodError, Object};
use voxel_imap::ImapError;
use voxel_imap::search::SearchKey;
use voxel_imap::session::ImapSession;

use super::{INDEX_MAX, Messages, lock, search_or_empty};
use crate::backend::imap_err;
use crate::folders::{Folder, Folders};
use crate::ids::{chunk, decode_email_id, encode_email_id};
use crate::jmap_json::js_string;

impl Messages {
    /// UID d'un dossier dont les clés de fil sont connues (mis à jour seulement si le dossier a changé).
    pub async fn ensure_index(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
    ) -> Result<Vec<u32>, ImapError> {
        let stamp = Folders::stamp(folder);
        if let Some((s, uids)) = lock(&self.folder_index).get(&folder.id)
            && *s == stamp
        {
            return Ok(uids.clone());
        }
        let mut uids = search_or_empty(c, &SearchKey::All).await?;
        uids.sort_unstable();
        if uids.len() > INDEX_MAX {
            uids = uids[uids.len() - INDEX_MAX..].to_vec();
        }
        self.fetch_keys(c, folder, &uids, true).await?;
        lock(&self.folder_index).insert(folder.id.clone(), (stamp, uids.clone()));
        Ok(uids)
    }

    pub async fn threads(self: &Arc<Self>, args: &Object) -> Result<Object, FacadeError> {
        let state = self.folders.email_state().await?;
        let Some(raw_ids) = args.get("ids").and_then(Value::as_array) else {
            return Err(MethodError::described("invalidArguments", "ids must be an array").into());
        };
        let mut ids: Vec<String> = Vec::new();
        for id in raw_ids.iter().map(js_string) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        let folders = self.folders.list(false).await?;
        let sent = folders.iter().find(|f| f.role.as_deref() == Some("sent"));
        let inbox = folders.iter().find(|f| f.role.as_deref() == Some("inbox"));
        let mut result: Vec<(String, Vec<String>)> = Vec::new();
        let mut not_found: Vec<String> = Vec::new();
        // dossier → fils cherchés
        let mut to_search: Vec<(String, HashSet<String>)> = Vec::new();
        let mut roots: Vec<(String, String)> = Vec::new();
        for tid in &ids {
            let cached = lock(&self.thread_cache).get(tid).cloned();
            if let Some((s, email_ids)) = cached
                && s == state
            {
                result.push((tid.clone(), email_ids));
                continue;
            }
            let Some(root) = self.root_of(tid) else {
                not_found.push(tid.clone());
                continue;
            };
            roots.push((tid.clone(), root));
            let mut fids: Vec<String> = Vec::new();
            if let Some(s) = sent {
                fids.push(s.id.clone());
            }
            let members: Vec<String> = lock(&self.thread_members)
                .get(tid)
                .cloned()
                .unwrap_or_default();
            let keys: Vec<_> = members
                .iter()
                .filter_map(|m| decode_email_id(&self.resolve_alias(m)))
                .collect();
            for k in &keys {
                if !fids.contains(&k.mb_id) {
                    fids.push(k.mb_id.clone());
                }
            }
            if keys.is_empty()
                && let Some(i) = inbox
                && !fids.contains(&i.id)
            {
                fids.push(i.id.clone());
            }
            for fid in fids {
                match to_search.iter_mut().find(|(f, _)| *f == fid) {
                    Some((_, s)) => {
                        s.insert(tid.clone());
                    }
                    None => to_search.push((fid, HashSet::from([tid.clone()]))),
                }
            }
        }
        let searches = to_search.into_iter().filter_map(|(fid, tids)| {
            let folder = folders.iter().find(|f| f.id == fid)?.clone();
            if folder.messages == 0 {
                return None;
            }
            let tid_roots: Vec<(String, String)> = roots
                .iter()
                .filter(|(t, _)| tids.contains(t))
                .cloned()
                .collect();
            let me = self.clone();
            Some(async move {
                let path = folder.path.clone();
                self.pool
                    .with_mailbox(&path, false, move |c| {
                        let (me, folder, tids, tid_roots) =
                            (me.clone(), folder.clone(), tids.clone(), tid_roots.clone());
                        Box::pin(
                            async move { me.search_threads(c, &folder, &tids, &tid_roots).await },
                        )
                    })
                    .await
            })
        });
        let mut found_by: Vec<(String, Vec<(String, i64)>)> = Vec::new();
        for r in futures_util::future::join_all(searches).await {
            for (tid, id, date) in r.map_err(imap_err)? {
                match found_by.iter_mut().find(|(t, _)| *t == tid) {
                    Some((_, l)) => l.push((id, date)),
                    None => found_by.push((tid, vec![(id, date)])),
                }
            }
        }
        for (tid, _) in &roots {
            let mut list: Vec<(String, i64)> = found_by
                .iter()
                .find(|(t, _)| t == tid)
                .map(|(_, l)| l.clone())
                .unwrap_or_default();
            if list.is_empty() {
                // repli : membres connus encore présents
                let members: Vec<String> = lock(&self.thread_members)
                    .get(tid)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|m| self.resolve_alias(m))
                    .collect();
                let (found, _) = self.locate(&members).await?;
                list = found
                    .iter()
                    .map(|f| {
                        let date = self
                            .date_map(&f.folder)
                            .get(&f.key.uid)
                            .copied()
                            .unwrap_or(0);
                        (f.current.clone(), date)
                    })
                    .collect();
            }
            if list.is_empty() {
                not_found.push(tid.clone());
                continue;
            }
            // dédoublonnage comme `new Map` (place de la première occurrence, valeur de la dernière) puis tri par date
            let mut uniq: Vec<(String, i64)> = Vec::new();
            for (id, date) in list {
                match uniq.iter_mut().find(|(i, _)| *i == id) {
                    Some(e) => e.1 = date,
                    None => uniq.push((id, date)),
                }
            }
            uniq.sort_by_key(|(_, d)| *d);
            let email_ids: Vec<String> = uniq.into_iter().map(|(id, _)| id).collect();
            lock(&self.thread_cache).insert(tid.clone(), (state.clone(), email_ids.clone()));
            result.push((tid.clone(), email_ids));
        }
        let list: Vec<Value> = ids
            .iter()
            .filter_map(|t| {
                result
                    .iter()
                    .find(|(r, _)| r == t)
                    .map(|(_, e)| json!({ "id": t, "emailIds": e }))
            })
            .collect();
        let mut r = Object::new();
        r.insert("state".into(), json!(state));
        r.insert("list".into(), Value::Array(list));
        r.insert("notFound".into(), json!(not_found));
        Ok(r)
    }

    /// Membres des fils `tids` dans le dossier sélectionné : (fil, id d'email, date).
    async fn search_threads(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
        tids: &HashSet<String>,
        roots: &[(String, String)],
    ) -> Result<Vec<(String, String, i64)>, ImapError> {
        let mut uids: Vec<u32> = Vec::new();
        if folder.messages as usize <= INDEX_MAX {
            // index des clés de fil du dossier (incrémental, en cache) : évite les SEARCH HEADER, lents
            uids = self.ensure_index(c, folder).await?;
        } else {
            for part in chunk(roots, 20) {
                let mut conds: Vec<SearchKey> = Vec::new();
                for (_, root) in &part {
                    let term = root.strip_prefix('<').unwrap_or(root);
                    let term = term.strip_suffix('>').unwrap_or(term).to_string();
                    conds.push(SearchKey::Header("message-id".into(), Some(term.clone())));
                    conds.push(SearchKey::Header("references".into(), Some(term.clone())));
                    conds.push(SearchKey::Header("in-reply-to".into(), Some(term)));
                }
                let key = if conds.len() == 1 {
                    conds.remove(0)
                } else {
                    SearchKey::Or(conds)
                };
                for u in search_or_empty(c, &key).await? {
                    if !uids.contains(&u) {
                        uids.push(u);
                    }
                }
            }
        }
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        self.fetch_keys(c, folder, &uids, true).await?;
        let dm = self.date_map(folder);
        let mut out = Vec::new();
        for uid in uids {
            let id = encode_email_id(&folder.id, folder.uid_validity, uid);
            let Some(tid) = lock(&self.thread_of_email).get(&id).cloned() else {
                continue;
            };
            if !tids.contains(&tid) {
                continue;
            }
            out.push((tid, id, dm.get(&uid).copied().unwrap_or(0)));
        }
        Ok(out)
    }

    pub async fn snippets(self: &Arc<Self>, args: &Object) -> Result<Object, FacadeError> {
        let ids = args
            .get("emailIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut q = Object::new();
        q.insert("ids".into(), Value::Array(ids));
        q.insert("properties".into(), json!(["id", "subject", "preview"]));
        let r = self.get(&q).await?;
        let list: Vec<Value> = r
            .get("list")
            .and_then(Value::as_array)
            .map(|l| {
                l.iter()
                    .map(|e| {
                        let preview = e
                            .get("preview")
                            .and_then(Value::as_str)
                            .filter(|p| !p.is_empty());
                        json!({ "emailId": e.get("id"), "subject": null, "preview": preview })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Object::new();
        out.insert(
            "filter".into(),
            args.get("filter").cloned().unwrap_or(Value::Null),
        );
        out.insert("list".into(), Value::Array(list));
        out.insert(
            "notFound".into(),
            r.get("notFound").cloned().unwrap_or(json!([])),
        );
        Ok(out)
    }
}
