//! Email/query, Email/queryChanges, Email/changes et Thread/changes (port de `messages.ts`) : recherche
//! dans tous les dossiers (trois à la fois), tri par date, regroupement progressif par fil, résultats
//! gardés par état.

use std::collections::HashSet;
use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::{Value, json};
use voxel_core::jmap::{CreatedIds, FacadeError, MethodError, Object};
use voxel_imap::search::SearchKey;

use super::{Messages, QueryEntry, QueryResult, lock, search_or_empty};
use crate::backend::imap_err;
use crate::filter::{Compiled, compile_filter, parse_ms};
use crate::folders::Folder;
use crate::ids::encode_email_id;

/// Bornes de date exactes appliquées après la recherche (seulement au premier niveau du filtre).
pub fn top_level_date_bounds(filter: Option<&Object>) -> (Option<i64>, Option<i64>) {
    let (mut before, mut after): (Option<i64>, Option<i64>) = (None, None);
    let Some(filter) = filter else {
        return (before, after);
    };
    let conds: Vec<&Object> = match filter.get("operator") {
        Some(Value::String(op)) if op == "AND" => filter
            .get("conditions")
            .and_then(Value::as_array)
            .map(|c| c.iter().filter_map(Value::as_object).collect())
            .unwrap_or_default(),
        Some(op) if crate::jmap_json::truthy(op) => Vec::new(),
        _ => vec![filter],
    };
    for c in conds {
        if let Some(t) = c.get("before").and_then(Value::as_str).and_then(parse_ms) {
            before = Some(before.map_or(t, |b| b.min(t)));
        }
        if let Some(t) = c.get("after").and_then(Value::as_str).and_then(parse_ms) {
            after = Some(after.map_or(t, |a| a.max(t)));
        }
    }
    (before, after)
}

/// Nombre JSON entier quand il l'est (comme JSON.stringify).
fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

/// `list.slice(start, start + limit)` de JS (début positif ou nul).
fn window<T: Clone>(list: &[T], start: f64, limit: f64) -> Vec<T> {
    let len = list.len() as f64;
    let s = start.trunc().clamp(0.0, len) as usize;
    let e = (start + limit).trunc().clamp(0.0, len) as usize;
    if e <= s {
        Vec::new()
    } else {
        list[s..e].to_vec()
    }
}

impl Messages {
    pub async fn query(self: &Arc<Self>, args: &Object) -> Result<Object, FacadeError> {
        let sort = args
            .get("sort")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for s in &sort {
            let p = s.get("property");
            if p != Some(&json!("receivedAt")) && p != Some(&json!("sentAt")) {
                let name = p.map_or("undefined".to_string(), crate::jmap_json::js_string);
                return Err(MethodError::described(
                    "unsupportedSort",
                    format!("cannot sort by {name}"),
                )
                .into());
            }
        }
        let asc = sort.first().and_then(|s| s.get("isAscending")) == Some(&Value::Bool(true));
        let collapse = args.get("collapseThreads") == Some(&Value::Bool(true));
        let filter = args.get("filter").cloned().unwrap_or(Value::Null);
        let state = self.folders.email_state().await?;
        let key = format!(
            "{state}|{}",
            json!({ "filter": filter, "asc": asc, "collapse": collapse })
        );
        let cached = lock(&self.queries).get(&key).cloned();
        let q = match cached {
            Some(q) => q,
            None => {
                let entries = self.run_search(filter.as_object(), asc).await?;
                let q = Arc::new(tokio::sync::Mutex::new(QueryResult {
                    entries,
                    collapsed: collapse.then(Vec::new),
                    raw_cursor: 0,
                    seen_threads: HashSet::new(),
                    complete: !collapse,
                }));
                lock(&self.queries).insert(key, q.clone());
                q
            }
        };
        let mut q = q.lock().await;
        let mut position = args
            .get("position")
            .and_then(Value::as_f64)
            .map_or(0.0, f64::trunc);
        let limit = args
            .get("limit")
            .and_then(Value::as_f64)
            .filter(|l| *l >= 0.0)
            .map_or(256.0, |l| l.trunc().min(1000.0));
        let anchor = args
            .get("anchor")
            .and_then(Value::as_str)
            .map(|a| self.resolve_alias(a));
        let anchor_offset = args
            .get("anchorOffset")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let calculate_total = args.get("calculateTotal") == Some(&Value::Bool(true));

        let ids: Vec<String>;
        let total: usize;
        if collapse {
            // dépliage progressif par lots ; complet si la liste est raisonnable (total exact)
            let want = if anchor.is_some() || position < 0.0 {
                usize::MAX
            } else {
                (position + limit) as usize
            };
            let full = calculate_total && q.entries.len() <= 3000;
            self.collapse_until(&mut q, if full { usize::MAX } else { want })
                .await?;
            let list = q.collapsed.clone().unwrap_or_default();
            total = if q.complete {
                list.len()
            } else {
                q.entries.len()
            };
            if let Some(anchor) = &anchor {
                let idx = list
                    .iter()
                    .position(|x| x == anchor)
                    .ok_or_else(|| MethodError::new("anchorNotFound"))?;
                position = (idx as f64 + anchor_offset).max(0.0);
            } else if position < 0.0 {
                position = (list.len() as f64 + position).max(0.0);
            }
            ids = window(&list, position, limit);
        } else {
            let list = &q.entries;
            total = list.len();
            if let Some(anchor) = &anchor {
                let idx = list
                    .iter()
                    .position(|e| &e.id == anchor)
                    .ok_or_else(|| MethodError::new("anchorNotFound"))?;
                position = (idx as f64 + anchor_offset).max(0.0);
            } else if position < 0.0 {
                position = (total as f64 + position).max(0.0);
            }
            ids = window(list, position, limit)
                .into_iter()
                .map(|e| e.id)
                .collect();
        }
        let mut r = Object::new();
        r.insert("queryState".into(), json!(state));
        r.insert("canCalculateChanges".into(), json!(false));
        r.insert("position".into(), num(position));
        r.insert("ids".into(), json!(ids));
        if calculate_total {
            r.insert("total".into(), json!(total));
        }
        if args.get("limit").is_some_and(Value::is_number) {
            r.insert("limit".into(), num(limit));
        }
        Ok(r)
    }

    pub async fn collapse_until(
        self: &Arc<Self>,
        q: &mut QueryResult,
        want: usize,
    ) -> Result<(), FacadeError> {
        while !q.complete && q.collapsed.as_ref().map_or(0, Vec::len) < want {
            let end = (q.raw_cursor + 300).min(q.entries.len());
            let batch: Vec<QueryEntry> = q.entries[q.raw_cursor.min(end)..end].to_vec();
            if batch.is_empty() {
                q.complete = true;
                break;
            }
            // clés de fil manquantes, par dossier
            let mut by_folder: Vec<(Folder, Vec<u32>)> = Vec::new();
            for e in &batch {
                if lock(&self.thread_of_email).contains(&e.id) {
                    continue;
                }
                match by_folder.iter_mut().find(|(f, _)| f.id == e.folder.id) {
                    Some((_, l)) => l.push(e.uid),
                    None => by_folder.push((e.folder.clone(), vec![e.uid])),
                }
            }
            let results =
                futures_util::future::join_all(by_folder.into_iter().map(|(folder, uids)| {
                    let me = self.clone();
                    async move {
                        let path = folder.path.clone();
                        self.pool
                            .with_mailbox(&path, false, move |c| {
                                let (me, folder, uids) = (me.clone(), folder.clone(), uids.clone());
                                Box::pin(
                                    async move { me.fetch_keys(c, &folder, &uids, true).await },
                                )
                            })
                            .await
                    }
                }))
                .await;
            for r in results {
                r.map_err(imap_err)?;
            }
            let mut collapsed = q.collapsed.take().unwrap_or_default();
            for e in &batch {
                q.raw_cursor += 1;
                let t = lock(&self.thread_of_email)
                    .get(&e.id)
                    .cloned()
                    .unwrap_or_else(|| e.id.clone());
                if q.seen_threads.contains(&t) {
                    continue;
                }
                q.seen_threads.insert(t);
                collapsed.push(e.id.clone());
                if collapsed.len() >= want {
                    break;
                }
            }
            q.collapsed = Some(collapsed);
            if q.raw_cursor >= q.entries.len() {
                q.complete = true;
            }
        }
        Ok(())
    }

    pub async fn run_search(
        self: &Arc<Self>,
        filter: Option<&Object>,
        asc: bool,
    ) -> Result<Vec<QueryEntry>, FacadeError> {
        let folders = self.folders.list(false).await?;
        let (before, after) = top_level_date_bounds(filter);
        let mut tasks = Vec::new();
        for folder in folders {
            let compiled = match filter {
                Some(f) => compile_filter(f, &folder, &CreatedIds::default())?,
                None => Compiled::All,
            };
            let key = match compiled {
                Compiled::Nothing => continue,
                _ if folder.messages == 0 => continue,
                Compiled::All => SearchKey::All,
                Compiled::Key(k) => k,
            };
            tasks.push((folder, key));
        }
        let results: Vec<Result<Vec<QueryEntry>, FacadeError>> =
            futures_util::stream::iter(tasks.into_iter().map(|(folder, key)| {
                let me = self.clone();
                async move {
                    let path = folder.path.clone();
                    self.pool
                        .with_mailbox(&path, false, move |c| {
                            let (me, folder, key) = (me.clone(), folder.clone(), key.clone());
                            Box::pin(async move {
                                // vue en retard sur le relevé STATUS (messages arrivés par une autre connexion) : resynchronisation
                                if c.selected().is_some_and(|m| m.exists != folder.messages) {
                                    c.noop().await?;
                                }
                                let mb = c.selected().cloned();
                                let mut live = folder.clone();
                                if let Some(m) = &mb
                                    && m.uid_validity != folder.uid_validity
                                {
                                    live.uid_validity = m.uid_validity;
                                }
                                if mb.as_ref().is_some_and(|m| m.exists == 0) {
                                    return Ok(Vec::new());
                                }
                                let mut uids = search_or_empty(c, &key).await?;
                                if uids.len() > 20_000 {
                                    uids.sort_unstable_by(|a, b| b.cmp(a));
                                    uids.truncate(20_000);
                                }
                                me.fetch_keys(c, &live, &uids, false).await?;
                                let dm = me.date_map(&live);
                                Ok(uids
                                    .into_iter()
                                    .map(|uid| QueryEntry {
                                        id: encode_email_id(&live.id, live.uid_validity, uid),
                                        uid,
                                        date: dm.get(&uid).copied().unwrap_or(0),
                                        folder: live.clone(),
                                    })
                                    .collect())
                            })
                        })
                        .await
                        .map_err(imap_err)
                }
            }))
            // parallélisme limité à la taille du pool
            .buffer_unordered(3)
            .collect()
            .await;
        let mut entries = Vec::new();
        for r in results {
            entries.extend(r?);
        }
        if let Some(b) = before {
            entries.retain(|e| e.date < b);
        }
        if let Some(a) = after {
            entries.retain(|e| e.date >= a);
        }
        entries.sort_by(|a, b| {
            if asc {
                a.date.cmp(&b.date).then(a.uid.cmp(&b.uid))
            } else {
                b.date.cmp(&a.date).then(b.uid.cmp(&a.uid))
            }
        });
        Ok(entries)
    }

    pub async fn query_changes(self: &Arc<Self>, args: &Object) -> Result<Object, FacadeError> {
        let state = self.folders.email_state().await?;
        if args.get("sinceQueryState").and_then(Value::as_str) == Some(state.as_str()) {
            let mut q = args.clone();
            q.insert("position".into(), json!(0));
            q.insert("limit".into(), json!(0));
            q.insert("calculateTotal".into(), json!(true));
            let r = self.query(&q).await?;
            let mut out = Object::new();
            out.insert("oldQueryState".into(), json!(state));
            out.insert("newQueryState".into(), json!(state));
            out.insert("removed".into(), json!([]));
            out.insert("added".into(), json!([]));
            if args
                .get("calculateTotal")
                .is_some_and(crate::jmap_json::truthy)
            {
                out.insert(
                    "total".into(),
                    r.get("total").cloned().unwrap_or(Value::Null),
                );
            }
            return Ok(out);
        }
        Err(MethodError::described(
            "cannotCalculateChanges",
            "IMAP facade cannot compute query changes",
        )
        .into())
    }

    pub async fn changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let Some(since) = args.get("sinceState").and_then(Value::as_str) else {
            return Err(MethodError::described("invalidArguments", "sinceState required").into());
        };
        let max = match args.get("maxChanges") {
            None | Some(Value::Null) => None,
            Some(v) => {
                let n = match v {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.trim().parse::<f64>().ok(),
                    _ => None,
                };
                match n {
                    Some(n) if n.fract() == 0.0 && n > 0.0 => Some(n as usize),
                    _ => {
                        return Err(MethodError::described(
                            "invalidArguments",
                            "maxChanges must be a positive integer",
                        )
                        .into());
                    }
                }
            }
        };
        // Un client qui demande des changements veut être tenu à jour : on active le journal (sans effet s'il l'est déjà).
        let changelog = self.changelog();
        if let Some(cl) = &changelog {
            cl.activate();
        }
        let state = self.folders.email_state().await?;
        if since == state {
            let r = json!({ "oldState": state, "newState": state, "hasMoreChanges": false, "created": [], "updated": [], "destroyed": [] });
            return Ok(r.as_object().cloned().unwrap_or_default());
        }
        if let Some(cl) = changelog
            && let Some(r) = cl.changes(since, max).await
        {
            let r = json!({
                "oldState": r.old_state,
                "newState": r.new_state,
                "hasMoreChanges": r.has_more_changes,
                "created": r.created,
                "updated": r.updated,
                "destroyed": r.destroyed,
            });
            return Ok(r.as_object().cloned().unwrap_or_default());
        }
        Err(MethodError::described(
            "cannotCalculateChanges",
            "state too old or unknown to the IMAP facade (restart or outside the change log)",
        )
        .into())
    }

    pub async fn thread_changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let state = self.folders.email_state().await?;
        if args.get("sinceState").and_then(Value::as_str) == Some(state.as_str()) {
            let r = json!({ "oldState": state, "newState": state, "hasMoreChanges": false, "created": [], "updated": [], "destroyed": [] });
            return Ok(r.as_object().cloned().unwrap_or_default());
        }
        Err(MethodError::described(
            "cannotCalculateChanges",
            "IMAP facade cannot compute thread changes",
        )
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bornes_de_date_du_premier_niveau() {
        let f = json!({ "operator": "AND", "conditions": [
            { "before": "2025-01-10T00:00:00Z" }, { "before": "2025-01-05T00:00:00Z" }, { "after": "2025-01-01T00:00:00Z" }
        ] });
        let (b, a) = top_level_date_bounds(f.as_object());
        assert_eq!(b, parse_ms("2025-01-05T00:00:00Z"));
        assert_eq!(a, parse_ms("2025-01-01T00:00:00Z"));
        let or = json!({ "operator": "OR", "conditions": [{ "before": "2025-01-10T00:00:00Z" }] });
        assert_eq!(top_level_date_bounds(or.as_object()), (None, None));
        assert_eq!(top_level_date_bounds(None), (None, None));
        assert_eq!(window(&[1, 2, 3], 1.0, 5.0), vec![2, 3]);
    }
}
