//! Messages IMAP ↔ objets Email/Thread JMAP (port de `messages.ts`) : caches, alias de déplacement,
//! clés de fil et récupération IMAP partagée par Email/get|query|set, Thread/get et SearchSnippet/get
//! (répartis dans les sous-modules). Les caches sont derrière des verrous courts, jamais tenus pendant
//! une commande réseau ; les closures du pool reçoivent un `Arc<Messages>`.

mod get;
mod query;
mod set;
mod threads;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use chrono::{DateTime, FixedOffset};
use serde_json::{Map, Value, json};
use voxel_core::jmap::{FacadeError, Object};
use voxel_core::kv::KvStore;
use voxel_core::util::{Lru, hash_of};
use voxel_imap::ImapError;
use voxel_imap::decode::{decode_charset, decode_transfer, make_preview};
use voxel_imap::headers::{
    Address, Envelope, RawHeader, envelope, header_values, parse_header_block, parse_message_ids,
};
use voxel_imap::pool::ImapPool;
use voxel_imap::session::{FetchQuery, FetchedMessage, ImapSession, PartRequest};
use voxel_imap::structure::{BodyPart, Node, find_part, split_body, structure_to_part};

use crate::backend::imap_err;
use crate::blobs::BlobStore;
use crate::changelog::ChangeLog;
use crate::folders::{Folder, Folders};
use crate::ids::{EmailKey, chunk, decode_email_id, encode_email_id, to_seq_set};

// ------------------------------------------------------------------ constantes

/// En-têtes toujours relus avec la structure.
pub const BASE_HEADERS: [&str; 5] = [
    "message-id",
    "in-reply-to",
    "references",
    "list-unsubscribe",
    "list-unsubscribe-post",
];
/// En-têtes des clés de fil.
pub const THREAD_HEADERS: [&str; 3] = ["message-id", "in-reply-to", "references"];
/// En-têtes de l'enveloppe, lus avec la structure (l'ENVELOPE IMAP n'est plus demandée).
pub const ENVELOPE_HEADERS: [&str; 8] = [
    "date", "subject", "from", "sender", "reply-to", "to", "cc", "bcc",
];
/// Taille max d'un dossier indexé en mémoire pour reconstituer les fils (au-delà : SEARCH HEADER).
pub const INDEX_MAX: usize = 5000;

/// Propriétés Email rendues sans `properties`.
pub const DEFAULT_PROPS: [&str; 24] = [
    "id",
    "blobId",
    "threadId",
    "mailboxIds",
    "keywords",
    "size",
    "receivedAt",
    "messageId",
    "inReplyTo",
    "references",
    "sender",
    "from",
    "to",
    "cc",
    "bcc",
    "replyTo",
    "subject",
    "sentAt",
    "hasAttachment",
    "preview",
    "bodyValues",
    "textBody",
    "htmlBody",
    "attachments",
];
/// Propriétés Email connues en plus des propriétés par défaut (et des `header:…`).
pub const KNOWN_PROPS: [&str; 2] = ["bodyStructure", "headers"];
/// Propriétés des parties rendues sans `bodyProperties`.
pub const DEFAULT_BODY_PROPS: [&str; 10] = [
    "partId",
    "blobId",
    "size",
    "name",
    "type",
    "charset",
    "disposition",
    "cid",
    "language",
    "location",
];
/// Propriétés qui demandent la structure du message.
pub const BODY_PROPS_NEEDING_FETCH: [&str; 7] = [
    "bodyValues",
    "textBody",
    "htmlBody",
    "attachments",
    "bodyStructure",
    "hasAttachment",
    "preview",
];

/// Drapeaux système → mots-clés JMAP.
pub const FLAG_TO_KW: [(&str, &str); 4] = [
    ("\\seen", "$seen"),
    ("\\flagged", "$flagged"),
    ("\\answered", "$answered"),
    ("\\draft", "$draft"),
];
/// Mots-clés JMAP → drapeaux IMAP.
pub const KW_TO_FLAG: [(&str, &str); 9] = [
    ("$seen", "\\Seen"),
    ("$flagged", "\\Flagged"),
    ("$answered", "\\Answered"),
    ("$draft", "\\Draft"),
    ("$forwarded", "$Forwarded"),
    ("$junk", "$Junk"),
    ("$notjunk", "$NotJunk"),
    ("$phishing", "$Phishing"),
    ("$mdnsent", "$MDNSent"),
];

pub fn flags_to_keywords(flags: Option<&[String]>) -> Value {
    let mut out = Map::new();
    for f in flags.unwrap_or(&[]) {
        let low = f.to_lowercase();
        if let Some((_, kw)) = FLAG_TO_KW.iter().find(|(fl, _)| *fl == low) {
            out.insert((*kw).into(), Value::Bool(true));
        } else if !low.starts_with('\\') {
            out.insert(low, Value::Bool(true));
        }
    }
    Value::Object(out)
}

pub fn keyword_to_flag(kw: &str) -> String {
    let low = kw.to_lowercase();
    KW_TO_FLAG
        .iter()
        .find(|(k, _)| *k == low)
        .map(|(_, f)| (*f).to_string())
        .unwrap_or_else(|| kw.to_string())
}

pub fn valid_keyword(kw: &str) -> bool {
    let len = kw.len();
    (1..=255).contains(&len)
        && kw.bytes().all(|b| (0x21..=0x7e).contains(&b))
        && !kw.bytes().any(|b| b"()]{%*\"\\".contains(&b))
}

/// Fil d'un message : racine = première référence, sinon In-Reply-To, sinon Message-ID, sinon `fallback`.
pub fn thread_id_of(headers: &[RawHeader], fallback: &str) -> (String, String) {
    let last = |name: &str| header_values(headers, name).last().copied();
    let first = |name: &str| parse_message_ids(last(name)).and_then(|v| v.into_iter().next());
    let root = first("references")
        .or_else(|| first("in-reply-to"))
        .or_else(|| first("message-id"))
        .unwrap_or_else(|| fallback.to_string());
    (format!("T{}", hash_of(&root, 14)), root)
}

/// `UID SEARCH` d'un dossier ; un refus du serveur compte comme « rien trouvé » (`searchFailed` d'imapflow,
/// lu `[]` par Node). Les erreurs de connexion, d'authentification et de lecture restent des erreurs, ainsi que
/// la limitation de débit (C16).
pub async fn search_or_empty(
    c: &mut ImapSession,
    key: &voxel_imap::search::SearchKey,
) -> Result<Vec<u32>, ImapError> {
    match c.uid_search(key).await {
        Err(ImapError::Command(text)) if !is_throttled(&text) => Ok(Vec::new()),
        other => other,
    }
}

/// Refus pour limitation de débit (Microsoft 365, Exchange) : `ETHROTTLE` d'imapflow, qui restait une erreur.
pub fn is_throttled(text: &str) -> bool {
    text.contains("Request is throttled") && text.contains("Backoff Time")
}

pub fn date_of(d: Option<&DateTime<FixedOffset>>) -> i64 {
    d.map(|d| d.timestamp_millis()).unwrap_or(0)
}

// ------------------------------------------------------------------ types internes

#[derive(Debug, Clone)]
pub struct StaticInfo {
    pub internal_date: i64,
    pub size: u64,
    pub envelope: Envelope,
    pub root: BodyPart,
    pub text_body: Vec<BodyPart>,
    pub html_body: Vec<BodyPart>,
    pub attachments: Vec<BodyPart>,
    pub headers: Vec<RawHeader>,
    pub header_names: HashSet<String>,
    pub thread_id: String,
    pub preview: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Located {
    /// id demandé
    pub id: String,
    /// id après résolution des alias
    pub current: String,
    pub key: EmailKey,
    pub folder: Folder,
}

#[derive(Debug, Clone)]
pub struct QueryEntry {
    pub id: String,
    pub date: i64,
    pub uid: u32,
    pub folder: Folder,
}

pub struct QueryResult {
    pub entries: Vec<QueryEntry>,
    pub collapsed: Option<Vec<String>>,
    pub raw_cursor: usize,
    pub seen_threads: HashSet<String>,
    pub complete: bool,
}

/// En-têtes d'adressage d'un message (pour l'enveloppe SMTP ; Node non plus ne lit pas tous les champs).
#[allow(dead_code)]
pub struct EmailEnvelopeInfo {
    pub from: Vec<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub sender: Vec<Address>,
    pub message_id: Option<String>,
}

/// Valeurs de corps décodées d'un message, dans l'ordre de lecture (partId → texte).
pub type BodyMap = Vec<(String, String)>;

type Shared<T> = Mutex<T>;
/// Aperçus à lire pour une même partie : partId → (uid, id d'email, partie).
type PreviewGroup = (String, Vec<(u32, String, BodyPart)>);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------ classe principale

pub struct Messages {
    pool: Arc<ImapPool>,
    folders: Arc<Folders>,
    kv: Arc<dyn KvStore>,
    blobs: Arc<BlobStore>,
    on_change: Arc<dyn Fn() + Send + Sync>,
    statics: Shared<Lru<String, StaticInfo>>,
    bodies: Shared<Lru<String, BodyMap>>,
    flags: Shared<HashMap<String, (String, Vec<String>)>>,
    /// `<mbId>|<uidValidity>` → uid → date
    dates: Shared<HashMap<String, HashMap<u32, i64>>>,
    thread_of_email: Shared<Lru<String, String>>,
    thread_roots: Shared<Lru<String, String>>,
    thread_members: Shared<Lru<String, Vec<String>>>,
    thread_cache: Shared<Lru<String, (String, Vec<String>)>>,
    queries: Shared<Lru<String, Arc<tokio::sync::Mutex<QueryResult>>>>,
    aliases: Shared<Lru<String, String>>,
    folder_index: Shared<HashMap<String, (String, Vec<u32>)>>,
    /// Journal des changements (branché par la façade) ; sans lui, seul « aucun changement » est calculable.
    changelog: Shared<Option<Arc<ChangeLog>>>,
}

impl Messages {
    pub fn new(
        pool: Arc<ImapPool>,
        folders: Arc<Folders>,
        kv: Arc<dyn KvStore>,
        blobs: Arc<BlobStore>,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Messages {
            pool,
            folders,
            kv,
            blobs,
            on_change,
            statics: Mutex::new(Lru::new(3000)),
            bodies: Mutex::new(Lru::new(200)),
            flags: Mutex::new(HashMap::new()),
            dates: Mutex::new(HashMap::new()),
            thread_of_email: Mutex::new(Lru::new(50_000)),
            thread_roots: Mutex::new(Lru::new(20_000)),
            thread_members: Mutex::new(Lru::new(5_000)),
            thread_cache: Mutex::new(Lru::new(500)),
            queries: Mutex::new(Lru::new(40)),
            aliases: Mutex::new(Lru::new(5_000)),
            folder_index: Mutex::new(HashMap::new()),
            changelog: Mutex::new(None),
        }
    }

    pub fn set_changelog(&self, changelog: Arc<ChangeLog>) {
        *lock(&self.changelog) = Some(changelog);
    }

    fn changelog(&self) -> Option<Arc<ChangeLog>> {
        lock(&self.changelog).clone()
    }

    // ---------------------------------------------------------------- ids, alias, threads

    /// Suit les alias créés par les déplacements (un MOVE change l'UID et le dossier).
    pub fn resolve_alias(&self, id: &str) -> String {
        let mut cur = id.to_string();
        for _ in 0..8 {
            let cached = lock(&self.aliases).get(&cur).cloned();
            let next = cached.or_else(|| self.kv.get(&format!("al:{cur}")));
            let Some(next) = next.filter(|n| !n.is_empty() && *n != cur) else {
                break;
            };
            let mut aliases = lock(&self.aliases);
            if !aliases.contains(&cur) {
                aliases.insert(cur.clone(), next.clone());
            }
            drop(aliases);
            cur = next;
        }
        cur
    }

    pub fn add_alias(&self, old_id: &str, new_id: &str) {
        lock(&self.aliases).insert(old_id.to_string(), new_id.to_string());
        self.kv.set(&format!("al:{old_id}"), new_id);
    }

    pub fn remember_thread(&self, email_id: &str, thread_id: &str, root: &str, persist: bool) {
        lock(&self.thread_of_email).insert(email_id.to_string(), thread_id.to_string());
        {
            let mut members = lock(&self.thread_members);
            let mut set = members
                .get(&thread_id.to_string())
                .cloned()
                .unwrap_or_default();
            if !set.iter().any(|m| m == email_id) {
                set.push(email_id.to_string());
            }
            members.insert(thread_id.to_string(), set);
        }
        let known = lock(&self.thread_roots).contains(&thread_id.to_string());
        let key = format!("th:{thread_id}");
        if !known {
            lock(&self.thread_roots).insert(thread_id.to_string(), root.to_string());
            if persist && self.kv.get(&key).as_deref() != Some(root) {
                self.kv.set(&key, root);
            }
        } else if persist && self.kv.get(&key).is_none() {
            self.kv.set(&key, root);
        }
    }

    pub fn root_of(&self, thread_id: &str) -> Option<String> {
        let cached = lock(&self.thread_roots)
            .get(&thread_id.to_string())
            .cloned();
        let r = cached
            .or_else(|| self.kv.get(&format!("th:{thread_id}")))
            .filter(|r| !r.is_empty())?;
        lock(&self.thread_roots).insert(thread_id.to_string(), r.clone());
        Some(r)
    }

    fn date_key(folder_id: &str, uid_validity: u32) -> String {
        format!("{folder_id}|{uid_validity}")
    }

    /// Date connue d'un UID (dossier, UIDVALIDITY).
    pub fn date_map(&self, folder: &Folder) -> HashMap<u32, i64> {
        lock(&self.dates)
            .get(&Self::date_key(&folder.id, folder.uid_validity))
            .cloned()
            .unwrap_or_default()
    }

    fn date_get(&self, folder_id: &str, uid_validity: u32, uid: u32) -> Option<i64> {
        lock(&self.dates)
            .get(&Self::date_key(folder_id, uid_validity))
            .and_then(|m| m.get(&uid).copied())
    }

    fn date_set(&self, folder_id: &str, uid_validity: u32, uid: u32, date: i64) {
        lock(&self.dates)
            .entry(Self::date_key(folder_id, uid_validity))
            .or_default()
            .insert(uid, date);
    }

    pub async fn locate(&self, ids: &[String]) -> Result<(Vec<Located>, Vec<String>), FacadeError> {
        let list = self.folders.list(false).await?;
        let mut found = Vec::new();
        let mut not_found = Vec::new();
        for id in ids {
            let current = self.resolve_alias(id);
            let key = decode_email_id(&current);
            let folder = key
                .as_ref()
                .and_then(|k| list.iter().find(|f| f.id == k.mb_id));
            match (key, folder) {
                (Some(key), Some(folder)) if folder.uid_validity == key.uid_validity => {
                    found.push(Located {
                        id: id.clone(),
                        current,
                        key,
                        folder: folder.clone(),
                    })
                }
                _ => not_found.push(id.clone()),
            }
        }
        Ok((found, not_found))
    }

    pub fn invalidate_queries(&self) {
        lock(&self.queries).clear();
        lock(&self.thread_cache).clear();
    }

    fn static_of(&self, id: &str) -> Option<StaticInfo> {
        lock(&self.statics).get(&id.to_string()).cloned()
    }

    fn set_preview(&self, id: &str, preview: String) {
        if let Some(st) = lock(&self.statics).get_mut(&id.to_string()) {
            st.preview = Some(preview);
        }
    }

    // ---------------------------------------------------------------- récupération IMAP

    pub fn store_static(
        &self,
        folder: &Folder,
        m: &FetchedMessage,
        header_names: &[String],
    ) -> StaticInfo {
        let id = encode_email_id(&folder.id, folder.uid_validity, m.uid);
        let size = m.size.unwrap_or(0);
        let node = m.structure.clone().unwrap_or_else(|| Node {
            content_type: "text/plain".into(),
            part: Some("1".into()),
            size,
            ..Node::default()
        });
        let root = structure_to_part(&node, &id, true);
        let split = split_body(&root);
        let block = m.header.clone().unwrap_or_default();
        let wanted: HashSet<String> = header_names.iter().map(|h| h.to_lowercase()).collect();
        // seuls les en-têtes demandés restent (comme le FETCH HEADER.FIELDS de Node) ; l'enveloppe lit tout
        let headers: Vec<RawHeader> = parse_header_block(&block)
            .into_iter()
            .filter(|h| wanted.contains(&h.name.to_lowercase()))
            .collect();
        let (thread_id, troot) = thread_id_of(&headers, &id);
        let prev_preview = self.static_of(&id).and_then(|p| p.preview);
        let info = StaticInfo {
            internal_date: date_of(m.internal_date.as_ref()),
            size: size as u64,
            envelope: envelope(&block),
            root,
            text_body: split.text_body,
            html_body: split.html_body,
            attachments: split.attachments,
            headers,
            header_names: header_names.iter().cloned().collect(),
            thread_id: thread_id.clone(),
            preview: prev_preview,
        };
        lock(&self.statics).insert(id.clone(), info.clone());
        self.date_set(&folder.id, folder.uid_validity, m.uid, info.internal_date);
        self.remember_thread(&id, &thread_id, &troot, true);
        if let Some(flags) = &m.flags {
            lock(&self.flags).insert(id, (Folders::stamp(folder), flags.clone()));
        }
        info
    }

    pub async fn fetch_static(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
        uids: &[u32],
        header_names: &[String],
    ) -> Result<HashSet<u32>, ImapError> {
        let mut got = HashSet::new();
        let mut fields: Vec<String> = header_names.to_vec();
        for h in ENVELOPE_HEADERS {
            if !fields.iter().any(|f| f == h) {
                fields.push(h.to_string());
            }
        }
        let query = FetchQuery {
            flags: true,
            internal_date: true,
            size: true,
            body_structure: true,
            header_fields: Some(fields),
            parts: Vec::new(),
        };
        for part in chunk(uids, 200) {
            for m in c.uid_fetch(&to_seq_set(&part), &query).await? {
                self.store_static(folder, &m, header_names);
                got.insert(m.uid);
            }
        }
        Ok(got)
    }

    pub async fn fetch_flags(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
        uids: &[u32],
    ) -> Result<HashSet<u32>, ImapError> {
        let mut got = HashSet::new();
        let stamp = Folders::stamp(folder);
        let query = FetchQuery {
            flags: true,
            ..FetchQuery::default()
        };
        for part in chunk(uids, 500) {
            for m in c.uid_fetch(&to_seq_set(&part), &query).await? {
                lock(&self.flags).insert(
                    encode_email_id(&folder.id, folder.uid_validity, m.uid),
                    (stamp.clone(), m.flags.unwrap_or_default()),
                );
                got.insert(m.uid);
            }
        }
        Ok(got)
    }

    /// Dates de réception + clés de fil (en-têtes légers) ; mis en cache (immuables pour un UID).
    pub async fn fetch_keys(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
        uids: &[u32],
        with_threads: bool,
    ) -> Result<(), ImapError> {
        let need: Vec<u32> = uids
            .iter()
            .copied()
            .filter(|u| {
                self.date_get(&folder.id, folder.uid_validity, *u).is_none()
                    || (with_threads
                        && !lock(&self.thread_of_email).contains(&encode_email_id(
                            &folder.id,
                            folder.uid_validity,
                            *u,
                        )))
            })
            .collect();
        let query = FetchQuery {
            internal_date: true,
            header_fields: with_threads
                .then(|| THREAD_HEADERS.iter().map(|h| h.to_string()).collect()),
            ..FetchQuery::default()
        };
        for part in chunk(&need, 1000) {
            for m in c.uid_fetch(&to_seq_set(&part), &query).await? {
                self.date_set(
                    &folder.id,
                    folder.uid_validity,
                    m.uid,
                    date_of(m.internal_date.as_ref()),
                );
                if with_threads {
                    let id = encode_email_id(&folder.id, folder.uid_validity, m.uid);
                    let (tid, root) =
                        thread_id_of(&parse_header_block(&m.header.unwrap_or_default()), &id);
                    self.remember_thread(&id, &tid, &root, false);
                }
            }
        }
        Ok(())
    }

    pub fn preview_part(st: &StaticInfo) -> Option<BodyPart> {
        st.text_body
            .iter()
            .find(|p| p.content_type == "text/plain")
            .or_else(|| st.html_body.iter().find(|p| p.content_type == "text/html"))
            .or_else(|| {
                st.text_body
                    .iter()
                    .find(|p| p.content_type.starts_with("text/"))
            })
            .cloned()
    }

    pub async fn fetch_previews(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
        uids: &[u32],
    ) -> Result<(), ImapError> {
        let mut groups: Vec<PreviewGroup> = Vec::new();
        for uid in uids {
            let id = encode_email_id(&folder.id, folder.uid_validity, *uid);
            let Some(st) = self.static_of(&id) else {
                continue;
            };
            if st.preview.is_some() {
                continue;
            }
            let Some(part) = Self::preview_part(&st).filter(|p| p.part_id.is_some()) else {
                self.set_preview(&id, String::new());
                continue;
            };
            let pid = part.part_id.clone().unwrap_or_default();
            match groups.iter_mut().find(|(k, _)| *k == pid) {
                Some((_, list)) => list.push((*uid, id, part)),
                None => groups.push((pid, vec![(*uid, id, part)])),
            }
        }
        for (part_id, items) in groups {
            let mut done: HashSet<u32> = HashSet::new();
            let query = FetchQuery {
                parts: vec![PartRequest {
                    part: part_id.clone(),
                    max_length: Some(4096),
                }],
                ..FetchQuery::default()
            };
            let all: Vec<u32> = items.iter().map(|i| i.0).collect();
            for part in chunk(&all, 200) {
                for m in c.uid_fetch(&to_seq_set(&part), &query).await? {
                    let Some((_, id, p)) = items.iter().find(|i| i.0 == m.uid) else {
                        continue;
                    };
                    done.insert(m.uid);
                    let raw = m
                        .parts
                        .get(&part_id)
                        .or_else(|| m.parts.get(&part_id.to_uppercase()))
                        .or_else(|| m.parts.values().next());
                    let Some(raw) = raw else {
                        self.set_preview(id, String::new());
                        continue;
                    };
                    let decoded = decode_charset(
                        &decode_transfer(raw, p.encoding.as_deref(), true),
                        p.charset.as_deref(),
                    );
                    self.set_preview(id, make_preview(&decoded, p.content_type == "text/html"));
                }
            }
            for (uid, id, _) in &items {
                if !done.contains(uid) && self.static_of(id).is_some_and(|s| s.preview.is_none()) {
                    self.set_preview(id, String::new());
                }
            }
        }
        Ok(())
    }

    pub async fn fetch_body_values(
        &self,
        c: &mut ImapSession,
        folder: &Folder,
        uid: u32,
        parts: &[BodyPart],
    ) -> Result<BodyMap, ImapError> {
        let id = encode_email_id(&folder.id, folder.uid_validity, uid);
        let mut cache = lock(&self.bodies).get(&id).cloned().unwrap_or_default();
        let missing: Vec<&BodyPart> = parts
            .iter()
            .filter(|p| {
                p.part_id
                    .as_ref()
                    .is_some_and(|pid| !cache.iter().any(|(k, _)| k == pid))
            })
            .collect();
        if !missing.is_empty() {
            let query = FetchQuery {
                parts: missing
                    .iter()
                    .map(|p| PartRequest {
                        part: p.part_id.clone().unwrap_or_default(),
                        max_length: None,
                    })
                    .collect(),
                ..FetchQuery::default()
            };
            for m in c.uid_fetch(&uid.to_string(), &query).await? {
                for p in &missing {
                    let pid = p.part_id.clone().unwrap_or_default();
                    let raw = m
                        .parts
                        .get(&pid)
                        .or_else(|| m.parts.get(&pid.to_uppercase()));
                    let text = raw
                        .map(|r| {
                            decode_charset(
                                &decode_transfer(r, p.encoding.as_deref(), false),
                                p.charset.as_deref(),
                            )
                        })
                        .unwrap_or_default();
                    match cache.iter_mut().find(|(k, _)| *k == pid) {
                        Some(e) => e.1 = text,
                        None => cache.push((pid, text)),
                    }
                }
            }
            lock(&self.bodies).insert(id.clone(), cache.clone());
        }
        if let Some(st) = self.static_of(&id)
            && st.preview.is_none()
            && let Some(pp) = Self::preview_part(&st)
            && let Some(pid) = &pp.part_id
            && let Some((_, text)) = cache.iter().find(|(k, _)| k == pid)
        {
            self.set_preview(&id, make_preview(text, pp.content_type == "text/html"));
        }
        Ok(cache)
    }

    // ---------------------------------------------------------------- blobs

    /// Contenu d'un blob (téléversé, message entier ou partie).
    pub async fn load_blob(
        self: &Arc<Self>,
        blob_id: &str,
    ) -> Result<Option<(Bytes, String)>, FacadeError> {
        if let Some(up) = self.blobs.get(blob_id).await {
            return Ok(Some(up));
        }
        let (email_part, part_id) = match blob_id.find('.') {
            Some(dot) if dot > 0 => (&blob_id[..dot], Some(blob_id[dot + 1..].to_string())),
            _ => (blob_id, None),
        };
        if let Some(pid) = &part_id
            && !valid_part_id(pid)
        {
            return Ok(None);
        }
        let (found, _) = self.locate(&[email_part.to_string()]).await?;
        let Some(l) = found.into_iter().next() else {
            return Ok(None);
        };
        let me = self.clone();
        let path = l.folder.path.clone();
        self.pool
            .with_mailbox(&path, false, move |c| {
                let (me, l, part_id) = (me.clone(), l.clone(), part_id.clone());
                Box::pin(async move {
                    if c.selected()
                        .is_none_or(|m| m.uid_validity != l.folder.uid_validity)
                    {
                        return Ok(None);
                    }
                    let Some(part_id) = part_id else {
                        return Ok(c
                            .fetch_raw(l.key.uid)
                            .await?
                            .map(|d| (Bytes::from(d), "message/rfc822".to_string())));
                    };
                    let mut st = me.static_of(&l.current);
                    if st.is_none() {
                        let base: Vec<String> =
                            BASE_HEADERS.iter().map(|h| h.to_string()).collect();
                        me.fetch_static(c, &l.folder, &[l.key.uid], &base).await?;
                        st = me.static_of(&l.current);
                    }
                    let part = st
                        .as_ref()
                        .and_then(|s| find_part(&s.root, &part_id).cloned());
                    if st.is_some() && part.is_none() {
                        return Ok(None);
                    }
                    let Some(data) = c.fetch_part(l.key.uid, &part_id).await? else {
                        return Ok(None);
                    };
                    // comme le téléchargement d'imapflow : contenu décodé de son Content-Transfer-Encoding
                    let data = match &part {
                        Some(p) => decode_transfer(&data, p.encoding.as_deref(), false),
                        None => data,
                    };
                    let t = part
                        .map(|p| p.content_type)
                        .unwrap_or_else(|| "application/octet-stream".into());
                    Ok(Some((Bytes::from(data), t)))
                })
            })
            .await
            .map_err(imap_err)
    }

    /// En-têtes d'adressage d'un message (pour l'enveloppe SMTP).
    pub async fn envelope_of(
        self: &Arc<Self>,
        email_id: &str,
    ) -> Result<Option<EmailEnvelopeInfo>, FacadeError> {
        let mut args = Object::new();
        args.insert("ids".into(), json!([email_id]));
        args.insert(
            "properties".into(),
            json!(["from", "to", "cc", "bcc", "sender", "messageId"]),
        );
        let r = self.get(&args).await?;
        let Some(e) = r
            .get("list")
            .and_then(Value::as_array)
            .and_then(|l| l.first())
        else {
            return Ok(None);
        };
        let a = |k: &str| -> Vec<Address> {
            e.get(k)
                .and_then(Value::as_array)
                .map(|l| {
                    l.iter()
                        .map(|x| Address {
                            name: x.get("name").and_then(Value::as_str).map(String::from),
                            email: x
                                .get("email")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok(Some(EmailEnvelopeInfo {
            from: a("from"),
            to: a("to"),
            cc: a("cc"),
            bcc: a("bcc"),
            sender: a("sender"),
            message_id: e
                .get("messageId")
                .and_then(Value::as_array)
                .and_then(|l| l.first())
                .and_then(Value::as_str)
                .map(String::from),
        }))
    }
}

fn valid_part_id(p: &str) -> bool {
    !p.is_empty()
        && p.split('.')
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

fn flatten_leaves(p: &BodyPart) -> Vec<BodyPart> {
    match &p.sub_parts {
        Some(subs) => subs.iter().flat_map(flatten_leaves).collect(),
        None => vec![p.clone()],
    }
}

fn unique_parts(parts: Vec<BodyPart>) -> Vec<BodyPart> {
    let mut seen = HashSet::new();
    parts
        .into_iter()
        .filter(|p| {
            p.part_id
                .as_ref()
                .is_some_and(|pid| seen.insert(pid.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mots_cles_et_drapeaux() {
        let flags = vec![
            "\\Seen".to_string(),
            "\\Recent".into(),
            "$Forwarded".into(),
            "Perso".into(),
        ];
        assert_eq!(
            flags_to_keywords(Some(&flags)),
            json!({ "$seen": true, "$forwarded": true, "perso": true })
        );
        assert_eq!(keyword_to_flag("$Flagged"), "\\Flagged");
        assert_eq!(keyword_to_flag("$mdnsent"), "$MDNSent");
        assert_eq!(keyword_to_flag("Perso"), "Perso");
        assert!(valid_keyword("$seen"));
        assert!(!valid_keyword("a b"));
        assert!(!valid_keyword("a(b"));
        assert!(!valid_keyword(""));
    }

    #[test]
    fn limitation_de_debit() {
        assert!(is_throttled(
            "Request is throttled. Suggested Backoff Time: 196 milliseconds"
        ));
        assert!(!is_throttled("Request is throttled"));
        assert!(!is_throttled("[BADCHARSET] unsupported charset"));
    }

    #[test]
    fn fil_et_parties() {
        let hs = vec![
            RawHeader {
                name: "Message-ID".into(),
                value: "<c@x>".into(),
            },
            RawHeader {
                name: "References".into(),
                value: "<a@x> <b@x>".into(),
            },
        ];
        let (tid, root) = thread_id_of(&hs, "fb");
        assert_eq!(root, "a@x");
        assert_eq!(tid, format!("T{}", hash_of("a@x", 14)));
        assert_eq!(thread_id_of(&[], "fb").1, "fb");
        assert!(valid_part_id("1.2"));
        assert!(!valid_part_id("1."));
        assert!(!valid_part_id("a"));
    }
}
