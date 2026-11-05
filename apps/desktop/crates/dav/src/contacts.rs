//! Façade CardDAV → JMAP for Contacts (RFC 9610) des boîtes IMAP. Port de `apps/server/src/carddav/facade.ts`.
//!
//! - `AddressBook/get|changes`, `ContactCard/get|changes|query|set|parse` (`AddressBook/set` non pris en charge :
//!   la capacité annonce `mayCreateAddressBook: false`).
//! - Sans état : identifiants dérivés du chemin (`b…` pour un carnet, `c…` pour une fiche, empreinte du href) ;
//!   l'état encode, en base64url opaque, ce qu'il faut pour `…/changes` : par carnet, le jeton `sync-collection`
//!   (RFC 6578) ou, à défaut, l'empreinte de l'ETag de chaque fiche.
//! - Déplacer une fiche d'un carnet à l'autre = écriture dans le nouveau carnet puis suppression de l'ancienne :
//!   son href, donc son identifiant, change.
//! - Conflit d'ETag (412) → `stateMismatch`. Cache mémoire des fiches lues (href → ETag + fiche).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{CallContext, Companion, CompanionCaps};
use voxel_core::jmap::{CreatedIds, FacadeError, MethodError, Object, SetError};
use voxel_core::util::{Lru, base64url_decode, base64url_encode, fold_text, hash_of, now_ms};

use crate::client::{
    DavBook, DavClient, DavError, DavKind, DavMember, DavTransport, DeleteResult, PutResult,
    SyncResult, encode_component,
};
use crate::convert::{card_to_vcard, parse_vcf, vcard_to_card};
use crate::patch::apply_patch;

/// Capacité JMAP Contacts.
const CAP_CONTACTS: &str = "urn:ietf:params:jmap:contacts";

/// Capacité `ContactCard/parse`.
const CAP_CONTACTS_PARSE: &str = "urn:ietf:params:jmap:contacts:parse";

/// Durée maximale de la vérification de `probe`.
const PROBE: Duration = Duration::from_secs(5);

/// Durée de vie de la liste des carnets.
const BOOKS_TTL: Duration = Duration::from_secs(30);

/// Durée de vie de l'instantané carnets + membres (plusieurs appels d'une même requête JMAP).
const SNAPSHOT_TTL: Duration = Duration::from_secs(3);

/// Nombre de fiches gardées en mémoire.
const MAX_CACHE: usize = 5_000;

/// Au-delà, l'état n'est plus qu'une empreinte (`…/changes` impossible).
const MAX_STATE_ENTRIES: usize = 20_000;

/// Taille maximale d'un fichier vCard à analyser.
const MAX_VCF: usize = 5 * 1024 * 1024;

/// Type des vCard écrites.
const VCARD_TYPE: &str = "text/vcard; charset=utf-8";

/// Ordre des composants du nom affiché.
const NAME_ORDER: [&str; 7] = [
    "title",
    "given",
    "given2",
    "surname",
    "surname2",
    "generation",
    "credential",
];

#[derive(Clone)]
struct BookEntry {
    id: String,
    book: DavBook,
    members: Vec<DavMember>,
}

struct Found {
    id: String,
    card: Value,
}

fn book_id_of(href: &str) -> String {
    format!("b{}", hash_of(&format!("book:{href}"), 12))
}

fn card_id_of(href: &str) -> String {
    format!("c{}", hash_of(&format!("card:{href}"), 16))
}

fn etag_key(etag: &str) -> String {
    hash_of(etag, 8)
}

fn encode_state(state: &Value) -> String {
    format!("d{}", base64url_encode(state.to_string().as_bytes()))
}

/// État `d…` → `{v: 1, b: {…}}`, sinon `None`.
pub(crate) fn decode_state(raw: Option<&Value>) -> Option<Object> {
    let raw = raw?.as_str()?.strip_prefix('d')?;
    let bytes = base64url_decode(raw)?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let obj = value.as_object()?;
    (obj.get("v") == Some(&json!(1)) && obj.get("b").is_some_and(Value::is_object))
        .then(|| obj["b"].as_object().cloned())
        .flatten()
}

/// Nom de fichier sûr pour une ressource (`<uid>.<ext>`, caractères limités).
pub(crate) fn file_name_for(uid: &str, ext: &str) -> String {
    let lower = uid.to_ascii_lowercase();
    let bare = if lower.starts_with("urn:uuid:") {
        &uid[9..]
    } else {
        uid
    };
    let base: String = bare
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(120)
        .collect();
    let base = if base.is_empty() {
        hash_of(uid, 16)
    } else {
        base
    };
    format!("{base}.{ext}")
}

/// Liste de chaînes d'un argument (`ids`, `properties`), `None` s'il n'est pas un tableau.
pub(crate) fn string_list(v: Option<&Value>) -> Option<Vec<String>> {
    v.and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect()
    })
}

pub(crate) fn pick(obj: &Value, props: Option<&Vec<String>>) -> Value {
    match (obj.as_object(), props) {
        (Some(map), Some(props)) => Value::Object(
            map.iter()
                .filter(|(k, _)| props.contains(k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        _ => obj.clone(),
    }
}

/// Vérité au sens de JavaScript.
pub(crate) fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub(crate) fn or_null(o: Object) -> Value {
    if o.is_empty() {
        Value::Null
    } else {
        Value::Object(o)
    }
}

pub(crate) fn list_or_null(v: Vec<Value>) -> Value {
    if v.is_empty() {
        Value::Null
    } else {
        Value::Array(v)
    }
}

/// `position` et `limit` d'une requête.
pub(crate) fn window(args: &Object, total: usize) -> (usize, usize) {
    let number = |key: &str| {
        args.get(key)
            .and_then(Value::as_f64)
            .map(|n| n.max(0.0) as usize)
    };
    (
        number("position").unwrap_or(0),
        number("limit").unwrap_or(total),
    )
}

/// Ancien état des collections (`a…`), pour `AddressBook/changes` et `Calendar/changes`.
pub(crate) fn decode_rows(raw: Option<&Value>) -> Option<(String, Vec<(String, String)>)> {
    let since = raw?.as_str()?;
    let body = since.strip_prefix('a')?;
    let rows: Value = serde_json::from_slice(&base64url_decode(body)?).ok()?;
    let rows = rows
        .as_array()?
        .iter()
        .filter_map(|r| {
            Some((
                r.get(0)?.as_str()?.to_string(),
                r.get(1)?.as_str()?.to_string(),
            ))
        })
        .collect();
    Some((since.to_string(), rows))
}

/// Réponse de `…/changes` des collections.
pub(crate) fn rows_changes(
    since: String,
    old: &[(String, String)],
    now: &[(String, String)],
    new_state: String,
) -> Object {
    let before = |id: &str| old.iter().find(|(k, _)| k == id).map(|(_, v)| v);
    let after = |id: &str| now.iter().find(|(k, _)| k == id).map(|(_, v)| v);
    let created: Vec<Value> = now
        .iter()
        .filter(|(id, _)| before(id).is_none())
        .map(|(id, _)| json!(id))
        .collect();
    let updated: Vec<Value> = now
        .iter()
        .filter(|(id, tag)| before(id).is_some_and(|b| b != tag))
        .map(|(id, _)| json!(id))
        .collect();
    let destroyed: Vec<Value> = old
        .iter()
        .filter(|(id, _)| after(id).is_none())
        .map(|(id, _)| json!(id))
        .collect();
    let mut out = Object::new();
    out.insert("oldState".into(), json!(since));
    out.insert("newState".into(), json!(new_state));
    out.insert("hasMoreChanges".into(), json!(false));
    out.insert("created".into(), Value::Array(created));
    out.insert("updated".into(), Value::Array(updated));
    out.insert("destroyed".into(), Value::Array(destroyed));
    out
}

pub(crate) fn rows_state(rows: &[(String, String)]) -> String {
    let rows: Vec<Value> = rows.iter().map(|(a, b)| json!([a, b])).collect();
    format!(
        "a{}",
        base64url_encode(Value::Array(rows).to_string().as_bytes())
    )
}

/// Échec interne d'une opération : erreur d'objet, ou erreur DAV qui fait échouer l'appel.
pub(crate) enum Failure {
    Set(SetError),
    Dav(DavError),
}

impl From<SetError> for Failure {
    fn from(e: SetError) -> Self {
        Failure::Set(e)
    }
}

impl From<DavError> for Failure {
    fn from(e: DavError) -> Self {
        Failure::Dav(e)
    }
}

pub(crate) fn fail(e: DavError) -> FacadeError {
    FacadeError::Fail(e.to_string())
}

// ---------------------------------------------------------------- @voxel/jmap/jscontact

fn new_card_uid() -> String {
    format!("urn:uuid:{}", uuid::Uuid::new_v4())
}

fn values(card: &Value, table: &str) -> Vec<Value> {
    card.get(table)
        .and_then(Value::as_object)
        .map(|t| t.values().cloned().collect())
        .unwrap_or_default()
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn name_components(card: &Value) -> Vec<Value> {
    card.get("name")
        .and_then(|n| n.get("components"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn by_pref(card: &Value, table: &str) -> Vec<Value> {
    let mut list = values(card, table);
    list.sort_by(|a, b| {
        let p = |v: &Value| v.get("pref").and_then(Value::as_f64).unwrap_or(101.0);
        p(a).partial_cmp(&p(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    list
}

fn name_component(card: &Value, kind: &str) -> String {
    name_components(card)
        .iter()
        .filter(|c| str_of(c, "kind") == kind)
        .map(|c| str_of(c, "value").to_string())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn card_display_name(card: &Value) -> String {
    let full = card
        .get("name")
        .map(|n| str_of(n, "full").trim())
        .unwrap_or("");
    if !full.is_empty() {
        return full.to_string();
    }
    let mut comps: Vec<Value> = name_components(card)
        .into_iter()
        .filter(|c| str_of(c, "kind") != "separator" && !str_of(c, "value").trim().is_empty())
        .collect();
    if !comps.is_empty() {
        let ordered = card.get("name").and_then(|n| n.get("isOrdered")) == Some(&Value::Bool(true));
        if !ordered {
            let rank = |c: &Value| {
                NAME_ORDER
                    .iter()
                    .position(|k| *k == str_of(c, "kind"))
                    .map_or(-1, |i| i as i64)
            };
            comps.sort_by_key(rank);
        }
        return comps
            .iter()
            .map(|c| str_of(c, "value").trim())
            .collect::<Vec<_>>()
            .join(" ");
    }
    for table in ["nicknames", "organizations"] {
        if let Some(first) = values(card, table).first() {
            let name = str_of(first, "name").trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    by_pref(card, "emails")
        .first()
        .map(|e| str_of(e, "address").to_string())
        .unwrap_or_default()
}

fn card_emails(card: &Value) -> Vec<String> {
    by_pref(card, "emails")
        .iter()
        .map(|e| str_of(e, "address").trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

fn card_sort_key(card: &Value) -> String {
    let surname = name_component(card, "surname");
    let given = name_component(card, "given");
    fold_text(&if surname.is_empty() {
        card_display_name(card)
    } else {
        format!("{surname} {given}")
    })
}

fn card_search_text(card: &Value) -> String {
    let mut parts = vec![card_display_name(card)];
    for c in name_components(card) {
        parts.push(str_of(&c, "value").to_string());
    }
    for (table, key) in [
        ("nicknames", "name"),
        ("emails", "address"),
        ("phones", "number"),
        ("organizations", "name"),
        ("titles", "name"),
        ("notes", "note"),
    ] {
        for v in values(card, table) {
            parts.push(str_of(&v, key).to_string());
        }
    }
    parts.retain(|p| !p.is_empty());
    fold_text(&parts.join(" "))
}

/// Filtre `ContactCard/query` (conditions et opérateurs AND / OR / NOT) sur une fiche.
fn matches(card: &Value, filter: Option<&Value>) -> bool {
    let Some(f) = filter.and_then(Value::as_object) else {
        return true;
    };
    if let (Some(Value::String(op)), Some(Value::Array(subs))) =
        (f.get("operator"), f.get("conditions"))
    {
        return match op.as_str() {
            "AND" => subs.iter().all(|x| matches(card, Some(x))),
            "OR" => subs.iter().any(|x| matches(card, Some(x))),
            "NOT" => !subs.iter().any(|x| matches(card, Some(x))),
            _ => false,
        };
    }
    let cond = |k: &str| f.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    if let Some(book) = cond("inAddressBook")
        && card.get("addressBookIds").and_then(|b| b.get(book)) != Some(&Value::Bool(true))
    {
        return false;
    }
    if let Some(kind) = cond("kind")
        && card
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("individual")
            != kind
    {
        return false;
    }
    if let Some(uid) = cond("uid")
        && card.get("uid").and_then(Value::as_str) != Some(uid)
    {
        return false;
    }
    if let Some(member) = cond("hasMember")
        && !truthy(card.get("members").and_then(|m| m.get(member)))
    {
        return false;
    }
    if let Some(text) = cond("text")
        && !card_search_text(card).contains(&fold_text(text))
    {
        return false;
    }
    if let Some(name) = cond("name") {
        let mut parts = vec![
            card.get("name")
                .map(|n| str_of(n, "full").to_string())
                .unwrap_or_default(),
        ];
        parts.extend(
            name_components(card)
                .iter()
                .map(|c| str_of(c, "value").to_string()),
        );
        if !fold_text(&parts.join(" ")).contains(&fold_text(name)) {
            return false;
        }
    }
    if let Some(email) = cond("email") {
        let needle = email.to_lowercase();
        if !card_emails(card)
            .iter()
            .any(|e| e.to_lowercase().contains(&needle))
        {
            return false;
        }
    }
    if let Some(phone) = cond("phone") {
        let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        let needle = squash(phone);
        if !values(card, "phones")
            .iter()
            .any(|p| squash(str_of(p, "number")).contains(&needle))
        {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------- façade

#[derive(Default)]
struct Inner {
    books: Option<(Instant, Vec<DavBook>)>,
    snap: Option<(Instant, Vec<BookEntry>)>,
    cards: Option<Lru<String, (String, Value)>>,
}

impl Inner {
    fn cards(&mut self) -> &mut Lru<String, (String, Value)> {
        self.cards.get_or_insert_with(|| Lru::new(MAX_CACHE))
    }
}

pub struct CardDavFacade {
    dav: DavClient,
    inner: tokio::sync::Mutex<Inner>,
    /// Résultat de la vérification de `probe` (`None` : pas encore vérifié).
    available: Mutex<Option<bool>>,
}

fn book_json(e: (&str, &DavBook), i: usize) -> Value {
    json!({
        "id": e.0,
        "name": e.1.name,
        "description": e.1.description,
        "sortOrder": i,
        "isDefault": i == 0,
        "isSubscribed": true,
        "shareWith": null,
        "myRights": {"mayRead": true, "mayWrite": e.1.may_write, "mayDelete": false, "mayShare": false},
    })
}

fn books_rows(books: &[DavBook]) -> Vec<(String, String)> {
    books
        .iter()
        .map(|b| {
            let sig = json!([b.name, b.description, b.may_write]).to_string();
            (book_id_of(&b.href), hash_of(&sig, 8))
        })
        .collect()
}

fn state_of(list: &[BookEntry]) -> String {
    let mut b = Object::new();
    let mut n = 0;
    for e in list {
        if e.book.supports_sync
            && let Some(token) = &e.book.sync_token
        {
            b.insert(e.id.clone(), json!({ "t": token }));
        } else {
            let tags: Object = e
                .members
                .iter()
                .map(|m| (card_id_of(&m.href), json!(etag_key(&m.etag))))
                .collect();
            b.insert(e.id.clone(), json!({ "e": tags }));
            n += e.members.len();
        }
    }
    // trop de fiches sans sync-collection : état réduit à une empreinte (…/changes impossible)
    if n > MAX_STATE_ENTRIES {
        return format!("h{}", hash_of(&Value::Object(b).to_string(), 20));
    }
    encode_state(&json!({ "v": 1, "b": b }))
}

fn jmap_card(id: &str, book_id: &str, card: &Value) -> Value {
    let mut out = card.as_object().cloned().unwrap_or_default();
    out.insert("id".into(), json!(id));
    out.insert("addressBookIds".into(), json!({ book_id: true }));
    Value::Object(out)
}

/// Fiche sans `id` ni `addressBookIds`, et son texte vCard.
fn to_vcard(card: &Value) -> Result<(String, Value), SetError> {
    let mut rest = card.as_object().cloned().unwrap_or_default();
    rest.remove("id");
    rest.remove("addressBookIds");
    let rest = Value::Object(rest);
    let text = card_to_vcard(&rest)
        .ok_or_else(|| SetError::described("invalidProperties", "invalid contact card"))?;
    Ok((text, rest))
}

impl CardDavFacade {
    pub fn new(
        service_url: url::Url,
        username: String,
        password: String,
        transport: Arc<dyn DavTransport>,
    ) -> Arc<Self> {
        Arc::new(Self {
            dav: DavClient::new(service_url, &username, &password, transport),
            inner: tokio::sync::Mutex::new(Inner::default()),
            available: Mutex::new(None),
        })
    }

    async fn list_books(&self, st: &mut Inner, fresh: bool) -> Result<Vec<DavBook>, DavError> {
        if !fresh
            && let Some((at, list)) = &st.books
            && at.elapsed() < BOOKS_TTL
        {
            return Ok(list.clone());
        }
        let list = self
            .dav
            .discover(DavKind::Card, crate::client::TIMEOUT)
            .await?;
        st.books = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    /// Carnets et membres (href + ETag), gardés 3 s.
    async fn snapshot(&self, st: &mut Inner, fresh: bool) -> Result<Vec<BookEntry>, DavError> {
        if !fresh
            && let Some((at, list)) = &st.snap
            && at.elapsed() < SNAPSHOT_TTL
        {
            return Ok(list.clone());
        }
        let books = self.list_books(st, fresh).await?;
        let mut list = Vec::new();
        for book in books {
            let members = self.dav.list_members(&book.href).await?;
            list.push(BookEntry {
                id: book_id_of(&book.href),
                book,
                members,
            });
        }
        st.snap = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    fn invalidate(st: &mut Inner) {
        st.snap = None;
        if let Some((at, _)) = &mut st.books {
            *at = Instant::now() - BOOKS_TTL;
        }
    }

    /// Fiches des membres demandés : cache si l'ETag n'a pas changé, sinon `addressbook-multiget`.
    async fn load_cards(
        &self,
        st: &mut Inner,
        entry: &BookEntry,
        members: &[DavMember],
    ) -> Result<Vec<(String, Value)>, DavError> {
        let mut out = Vec::new();
        let mut missing = Vec::new();
        for m in members {
            match st.cards().get(&m.href) {
                Some((etag, card)) if *etag == m.etag => out.push((m.href.clone(), card.clone())),
                _ => missing.push(m.href.clone()),
            }
        }
        if !missing.is_empty() {
            for (href, etag, data) in self
                .dav
                .multiget(&entry.book.href, &missing, DavKind::Card)
                .await?
            {
                // vCard illisible : ignorée
                let Some(card) = vcard_to_card(&data) else {
                    continue;
                };
                let etag = if etag.is_empty() {
                    members
                        .iter()
                        .find(|m| m.href == href)
                        .map(|m| m.etag.clone())
                        .unwrap_or_default()
                } else {
                    etag
                };
                st.cards().insert(href.clone(), (etag, card.clone()));
                out.push((href, card));
            }
        }
        Ok(out)
    }

    /// Toutes les fiches (ou celles des ids demandés), au format JMAP.
    async fn cards_of(
        &self,
        st: &mut Inner,
        list: &[BookEntry],
        ids: Option<&[String]>,
    ) -> Result<Vec<Found>, DavError> {
        let mut out = Vec::new();
        for entry in list {
            let members: Vec<DavMember> = entry
                .members
                .iter()
                .filter(|m| ids.is_none_or(|ids| ids.contains(&card_id_of(&m.href))))
                .cloned()
                .collect();
            if members.is_empty() {
                continue;
            }
            let loaded = self.load_cards(st, entry, &members).await?;
            for m in &members {
                let Some((_, card)) = loaded.iter().find(|(h, _)| *h == m.href) else {
                    continue;
                };
                let id = card_id_of(&m.href);
                out.push(Found {
                    card: jmap_card(&id, &entry.id, card),
                    id,
                });
            }
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- AddressBook

    async fn address_book_get(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut st = self.inner.lock().await;
        let books = self.list_books(&mut st, false).await.map_err(fail)?;
        let ids = string_list(args.get("ids"));
        let props = string_list(args.get("properties")).map(|mut p| {
            p.insert(0, "id".into());
            p
        });
        let rows = books_rows(&books);
        let list: Vec<Value> = books
            .iter()
            .enumerate()
            .map(|(i, b)| book_json((&rows[i].0, b), i))
            .filter(|b| {
                ids.as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| b["id"] == json!(id)))
            })
            .map(|b| pick(&b, props.as_ref()))
            .collect();
        let not_found: Vec<Value> = ids
            .as_ref()
            .map(|ids| {
                ids.iter()
                    .filter(|id| !rows.iter().any(|(r, _)| r == *id))
                    .map(|id| json!(id))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Object::new();
        out.insert("state".into(), json!(rows_state(&rows)));
        out.insert("list".into(), Value::Array(list));
        out.insert("notFound".into(), Value::Array(not_found));
        Ok(out)
    }

    async fn address_book_changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let (since, old) = decode_rows(args.get("sinceState"))
            .ok_or_else(|| MethodError::new("cannotCalculateChanges"))?;
        let mut st = self.inner.lock().await;
        let books = self.list_books(&mut st, true).await.map_err(fail)?;
        let rows = books_rows(&books);
        Ok(rows_changes(since, &old, &rows, rows_state(&rows)))
    }

    // ---------------------------------------------------------------- ContactCard

    async fn get(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let list = self.snapshot(st, false).await.map_err(fail)?;
        let ids = string_list(args.get("ids"));
        let props = string_list(args.get("properties")).map(|mut p| {
            p.insert(0, "id".into());
            p
        });
        let found = self
            .cards_of(st, &list, ids.as_deref())
            .await
            .map_err(fail)?;
        let not_found: Vec<Value> = ids
            .as_ref()
            .map(|ids| {
                ids.iter()
                    .filter(|id| !found.iter().any(|f| f.id == **id))
                    .map(|id| json!(id))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Object::new();
        out.insert("state".into(), json!(state_of(&list)));
        out.insert(
            "list".into(),
            Value::Array(
                found
                    .iter()
                    .map(|f| pick(&f.card, props.as_ref()))
                    .collect(),
            ),
        );
        out.insert("notFound".into(), Value::Array(not_found));
        Ok(out)
    }

    async fn query(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let list = self.snapshot(st, false).await.map_err(fail)?;
        let all = self.cards_of(st, &list, None).await.map_err(fail)?;
        // filtre « text » et autres conditions évalués en mémoire sur les carnets
        let mut rows: Vec<&Found> = all
            .iter()
            .filter(|f| matches(&f.card, args.get("filter")))
            .collect();
        let sort = args
            .get("sort")
            .and_then(Value::as_array)
            .and_then(|s| s.first());
        let property = sort.and_then(|s| s.get("property")).and_then(Value::as_str);
        let key = |f: &Found| match property {
            Some("updated") | Some("created") => match f.card.get("updated") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            },
            _ => card_sort_key(&f.card),
        };
        rows.sort_by(|a, b| {
            let (ka, kb) = (key(a), key(b));
            fold_text(&ka)
                .cmp(&fold_text(&kb))
                .then_with(|| ka.cmp(&kb))
                .then_with(|| a.id.cmp(&b.id))
        });
        if sort.and_then(|s| s.get("isAscending")) == Some(&Value::Bool(false)) {
            rows.reverse();
        }
        let (position, limit) = window(args, rows.len());
        let mut out = Object::new();
        out.insert("queryState".into(), json!(state_of(&list)));
        out.insert("canCalculateChanges".into(), json!(false));
        out.insert("position".into(), json!(position));
        out.insert(
            "ids".into(),
            Value::Array(
                rows.iter()
                    .skip(position)
                    .take(limit)
                    .map(|r| json!(r.id))
                    .collect(),
            ),
        );
        if truthy(args.get("calculateTotal")) {
            out.insert("total".into(), json!(rows.len()));
        }
        Ok(out)
    }

    async fn changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let old = decode_state(args.get("sinceState"))
            .ok_or_else(|| MethodError::new("cannotCalculateChanges"))?;
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let books = self.list_books(st, true).await.map_err(fail)?;
        let (mut created, mut updated, mut destroyed) = (Vec::new(), Vec::new(), Vec::new());
        let mut next = Object::new();
        for book in &books {
            let id = book_id_of(&book.href);
            let prev = old.get(&id).and_then(Value::as_object);
            if let Some(token) = prev
                .and_then(|p| p.get("t"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                && book.supports_sync
            {
                match self
                    .dav
                    .sync_collection(&book.href, token)
                    .await
                    .map_err(fail)?
                {
                    SyncResult::InvalidToken => {
                        return Err(MethodError::new("cannotCalculateChanges").into());
                    }
                    SyncResult::Changes {
                        changed,
                        removed,
                        token: new_token,
                    } => {
                        // sync-collection ne distingue pas création et modification : tout est rendu dans `updated`
                        updated.extend(changed.iter().map(|m| card_id_of(&m.href)));
                        destroyed.extend(removed.iter().map(|h| card_id_of(h)));
                        let t = new_token
                            .or_else(|| book.sync_token.clone())
                            .unwrap_or_else(|| token.to_string());
                        next.insert(id, json!({ "t": t }));
                    }
                }
                continue;
            }
            let members = self.dav.list_members(&book.href).await.map_err(fail)?;
            let now: Object = members
                .iter()
                .map(|m| (card_id_of(&m.href), json!(etag_key(&m.etag))))
                .collect();
            let empty = Object::new();
            let before = prev
                .and_then(|p| p.get("e"))
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            for (cid, tag) in &now {
                match before.get(cid) {
                    None => created.push(cid.clone()),
                    Some(b) if b != tag => updated.push(cid.clone()),
                    _ => {}
                }
            }
            destroyed.extend(before.keys().filter(|k| !now.contains_key(*k)).cloned());
            match (&book.sync_token, book.supports_sync) {
                (Some(t), true) => next.insert(id, json!({ "t": t })),
                _ => next.insert(id, json!({ "e": now })),
            };
        }
        for (bid, prev) in &old {
            if books.iter().any(|b| book_id_of(&b.href) == *bid) {
                continue;
            }
            // carnet disparu : ses fiches ne sont connues que sans jeton de synchronisation
            let Some(e) = prev.get("e").and_then(Value::as_object) else {
                return Err(MethodError::new("cannotCalculateChanges").into());
            };
            destroyed.extend(e.keys().cloned());
        }
        st.snap = None;
        let mut out = Object::new();
        out.insert(
            "oldState".into(),
            args.get("sinceState").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            "newState".into(),
            json!(encode_state(&json!({ "v": 1, "b": next }))),
        );
        out.insert("hasMoreChanges".into(), json!(false));
        let updated: Vec<String> = updated
            .into_iter()
            .filter(|id| !created.contains(id))
            .collect();
        out.insert("created".into(), json!(created));
        out.insert("updated".into(), json!(updated));
        out.insert("destroyed".into(), json!(destroyed));
        out.insert("updatedProperties".into(), Value::Null);
        Ok(out)
    }

    fn target_book<'a>(
        before: &'a [BookEntry],
        ids: Option<&Value>,
        created: &CreatedIds,
    ) -> Result<&'a BookEntry, SetError> {
        let ids = match ids {
            None | Some(Value::Null) => {
                return before.first().ok_or_else(|| {
                    SetError::on("invalidProperties", "no address book", &["addressBookIds"])
                });
            }
            Some(v) => v.as_object().ok_or_else(|| {
                SetError::on(
                    "invalidProperties",
                    "addressBookIds must be an object",
                    &["addressBookIds"],
                )
            })?,
        };
        let on: Vec<String> = ids
            .iter()
            .filter(|(_, v)| **v == Value::Bool(true))
            .map(|(k, _)| created.resolve(k))
            .collect();
        if on.len() != 1 {
            return Err(SetError::on(
                "invalidProperties",
                "exactly one address book is supported",
                &["addressBookIds"],
            ));
        }
        let e = before.iter().find(|e| e.id == on[0]).ok_or_else(|| {
            SetError::on(
                "invalidProperties",
                "unknown address book",
                &["addressBookIds"],
            )
        })?;
        if !e.book.may_write {
            return Err(SetError::on(
                "forbidden",
                "address book is read-only",
                &["addressBookIds"],
            ));
        }
        Ok(e)
    }

    /// Crée la ressource (nom tiré de l'uid ; nom aléatoire si le nom est déjà pris).
    async fn create_in(
        &self,
        entry: &BookEntry,
        card: &Value,
    ) -> Result<(String, Option<String>, Value), Failure> {
        let (_, mut rest) = to_vcard(card)?;
        let uid = match rest.get("uid") {
            Some(Value::String(u)) if !u.is_empty() => u.clone(),
            _ => new_card_uid(),
        };
        if let Some(map) = rest.as_object_mut() {
            map.insert("uid".into(), json!(uid));
        }
        let text = card_to_vcard(&rest)
            .ok_or_else(|| SetError::described("invalidProperties", "invalid contact card"))?;
        let base = url::Url::parse(&entry.book.href)
            .map_err(|_| DavError::Network("invalid address book href".into()))?;
        let mut name = file_name_for(&uid, "vcf");
        for attempt in 0..3 {
            let href = self
                .dav
                .resolve(&encode_component(&name), Some(&base))?
                .as_str()
                .to_string();
            match self.dav.put(&href, &text, None, VCARD_TYPE).await? {
                PutResult::Written { etag } => return Ok((href, etag, rest)),
                PutResult::Conflict => {
                    name = format!(
                        "{}.vcf",
                        hash_of(&format!("{uid}:{}:{attempt}", now_ms()), 12)
                    );
                }
            }
        }
        Err(SetError::described("alreadyExists", "could not create the contact").into())
    }

    async fn set(&self, args: &Object, ctx: CallContext<'_>) -> Result<Object, FacadeError> {
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let before = self.snapshot(st, true).await.map_err(fail)?;
        let old_state = state_of(&before);
        if let Some(Value::String(s)) = args.get("ifInState")
            && *s != old_state
        {
            return Err(MethodError::new("stateMismatch").into());
        }
        let (mut created, mut not_created, mut updated, mut not_updated) =
            (Object::new(), Object::new(), Object::new(), Object::new());
        let mut destroyed: Vec<Value> = Vec::new();
        let mut not_destroyed = Object::new();
        let locate = |id: &str| {
            before.iter().find_map(|e| {
                e.members
                    .iter()
                    .find(|m| card_id_of(&m.href) == id)
                    .map(|m| (e, m.clone()))
            })
        };
        let set_err = |e: Failure| match e {
            Failure::Set(e) => Ok(e.to_json()),
            Failure::Dav(e) => Err(fail(e)),
        };

        let empty = Object::new();
        for (cid, raw) in args
            .get("create")
            .and_then(Value::as_object)
            .unwrap_or(&empty)
        {
            let result: Result<(), Failure> = async {
                let Some(map) = raw.as_object() else {
                    return Err(SetError::new("invalidProperties").into());
                };
                if map.contains_key("id") {
                    return Err(SetError::on("invalidProperties", "id is server-set", &["id"]).into());
                }
                let entry = Self::target_book(&before, map.get("addressBookIds"), ctx.created)?;
                let (href, etag, card) = self.create_in(entry, raw).await?;
                let id = card_id_of(&href);
                if let Some(etag) = etag {
                    st.cards().insert(href.clone(), (etag, card.clone()));
                }
                ctx.created.record(cid, &id);
                created.insert(
                    cid.clone(),
                    json!({ "id": id, "uid": card["uid"], "addressBookIds": { entry.id.clone(): true } }),
                );
                Ok(())
            }
            .await;
            if let Err(e) = result {
                not_created.insert(cid.clone(), set_err(e)?);
            }
        }

        for (raw_id, patch) in args
            .get("update")
            .and_then(Value::as_object)
            .unwrap_or(&empty)
        {
            let id = ctx.created.resolve(raw_id);
            let result: Result<(), Failure> = async {
                let Some(patch) = patch.as_object() else {
                    return Err(SetError::new("invalidPatch").into());
                };
                let Some((entry, member)) = locate(&id) else {
                    return Err(SetError::new("notFound").into());
                };
                let single = BookEntry {
                    members: vec![member.clone()],
                    ..entry.clone()
                };
                let current = self
                    .cards_of(
                        st,
                        std::slice::from_ref(&single),
                        Some(std::slice::from_ref(&id)),
                    )
                    .await?
                    .into_iter()
                    .next()
                    .ok_or_else(|| SetError::new("notFound"))?;
                if patch.contains_key("id") || patch.contains_key("uid") {
                    let which = if patch.contains_key("id") {
                        "id"
                    } else {
                        "uid"
                    };
                    return Err(SetError::on(
                        "invalidProperties",
                        "id and uid are immutable",
                        &[which],
                    )
                    .into());
                }
                let next = apply_patch(&current.card, patch)?;
                let dest = Self::target_book(&before, next.get("addressBookIds"), ctx.created)?;
                if dest.id == entry.id {
                    let (text, card) = to_vcard(&next)?;
                    let etag = Some(member.etag.as_str()).filter(|e| !e.is_empty());
                    match self.dav.put(&member.href, &text, etag, VCARD_TYPE).await? {
                        PutResult::Conflict => {
                            return Err(SetError::described(
                                "stateMismatch",
                                "the contact was changed on the server (ETag)",
                            )
                            .into());
                        }
                        PutResult::Written { etag: Some(etag) } => {
                            st.cards().insert(member.href.clone(), (etag, card));
                        }
                        PutResult::Written { etag: None } => {
                            st.cards().remove(&member.href);
                        }
                    }
                    updated.insert(id.clone(), Value::Null);
                } else {
                    // déplacement : écriture dans le carnet cible, puis suppression de l'ancienne ressource (même ETag)
                    let (href, etag, card) = self.create_in(dest, &next).await?;
                    let old_etag = Some(member.etag.as_str()).filter(|e| !e.is_empty());
                    if let DeleteResult::Conflict = self.dav.delete(&member.href, old_etag).await? {
                        let _ = self.dav.delete(&href, etag.as_deref()).await;
                        return Err(SetError::described(
                            "stateMismatch",
                            "the contact was changed on the server (ETag)",
                        )
                        .into());
                    }
                    st.cards().remove(&member.href);
                    if let Some(etag) = etag {
                        st.cards().insert(href.clone(), (etag, card));
                    }
                    updated.insert(id.clone(), json!({ "id": card_id_of(&href) }));
                }
                Ok(())
            }
            .await;
            if let Err(e) = result {
                not_updated.insert(id.clone(), set_err(e)?);
            }
        }

        let no_destroy = Vec::new();
        for raw_id in args
            .get("destroy")
            .and_then(Value::as_array)
            .unwrap_or(&no_destroy)
            .iter()
            .filter_map(Value::as_str)
        {
            let id = ctx.created.resolve(raw_id);
            let result: Result<(), Failure> = async {
                let Some((_, member)) = locate(&id) else {
                    return Err(SetError::new("notFound").into());
                };
                let etag = Some(member.etag.as_str()).filter(|e| !e.is_empty());
                if let DeleteResult::Conflict = self.dav.delete(&member.href, etag).await? {
                    return Err(SetError::described(
                        "stateMismatch",
                        "the contact was changed on the server (ETag)",
                    )
                    .into());
                }
                st.cards().remove(&member.href);
                destroyed.push(json!(id));
                Ok(())
            }
            .await;
            if let Err(e) = result {
                not_destroyed.insert(id.clone(), set_err(e)?);
            }
        }

        Self::invalidate(st);
        let changed = created.len() + updated.len() + destroyed.len() > 0;
        let new_state = if changed {
            state_of(&self.snapshot(st, true).await.map_err(fail)?)
        } else {
            old_state.clone()
        };
        let mut out = Object::new();
        out.insert("oldState".into(), json!(old_state));
        out.insert("newState".into(), json!(new_state));
        out.insert("created".into(), or_null(created));
        out.insert("updated".into(), or_null(updated));
        out.insert("destroyed".into(), list_or_null(destroyed));
        out.insert("notCreated".into(), or_null(not_created));
        out.insert("notUpdated".into(), or_null(not_updated));
        out.insert("notDestroyed".into(), or_null(not_destroyed));
        Ok(out)
    }

    /// `ContactCard/parse` : vCard téléversées → fiches (sans les créer). Une vCard : la fiche ; plusieurs : un
    /// tableau (RFC 9610) ; aucune : `notParsable`.
    async fn parse(&self, args: &Object, ctx: &CallContext<'_>) -> Result<Object, FacadeError> {
        let ids = string_list(args.get("blobIds")).unwrap_or_default();
        let props = string_list(args.get("properties"));
        let mut parsed = Object::new();
        let (mut not_parsable, mut not_found) = (Vec::new(), Vec::new());
        for id in ids {
            let Some(buf) = ctx.uploads.load(&id).await else {
                not_found.push(json!(id));
                continue;
            };
            if buf.len() > MAX_VCF {
                not_parsable.push(json!(id));
                continue;
            }
            let (cards, _) = parse_vcf(&String::from_utf8_lossy(&buf));
            if cards.is_empty() {
                not_parsable.push(json!(id));
                continue;
            }
            let mut shaped: Vec<Value> = cards.iter().map(|c| pick(c, props.as_ref())).collect();
            let value = if shaped.len() == 1 {
                shaped.remove(0)
            } else {
                Value::Array(shaped)
            };
            parsed.insert(id, value);
        }
        let mut out = Object::new();
        out.insert("parsed".into(), or_null(parsed));
        out.insert("notParsable".into(), list_or_null(not_parsable));
        out.insert("notFound".into(), list_or_null(not_found));
        Ok(out)
    }
}

impl Companion for CardDavFacade {
    /// Vérification (découverte des carnets, authentifiée), 5 s au plus ; échec silencieux = capacité absente.
    fn probe(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self
                .available
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some()
            {
                return;
            }
            let found = tokio::time::timeout(PROBE, self.dav.discover(DavKind::Card, PROBE)).await;
            let ok = match found {
                Ok(Ok(list)) => {
                    let ok = !list.is_empty();
                    self.inner.lock().await.books = Some((Instant::now(), list));
                    ok
                }
                _ => false,
            };
            *self.available.lock().unwrap_or_else(|p| p.into_inner()) = Some(ok);
        })
    }

    fn available(&self) -> bool {
        *self.available.lock().unwrap_or_else(|p| p.into_inner()) == Some(true)
    }

    fn capabilities(&self) -> Option<CompanionCaps> {
        if !self.available() {
            return None;
        }
        let mut core = Object::new();
        core.insert(CAP_CONTACTS.into(), json!({}));
        core.insert(CAP_CONTACTS_PARSE.into(), json!({}));
        let mut account = Object::new();
        account.insert(
            CAP_CONTACTS.into(),
            json!({ "maxAddressBooksPerCard": 1, "mayCreateAddressBook": false }),
        );
        account.insert(CAP_CONTACTS_PARSE.into(), json!({}));
        Some(CompanionCaps { core, account })
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        args: Object,
        ctx: CallContext<'a>,
    ) -> BoxFuture<'a, Result<Object, FacadeError>> {
        Box::pin(async move {
            match method {
                "AddressBook/get" => self.address_book_get(&args).await,
                "AddressBook/changes" => self.address_book_changes(&args).await,
                "ContactCard/get" => self.get(&args).await,
                "ContactCard/query" => self.query(&args).await,
                "ContactCard/changes" => self.changes(&args).await,
                "ContactCard/set" => self.set(&args, ctx).await,
                "ContactCard/parse" => self.parse(&args, &ctx).await,
                _ => Err(MethodError::described(
                    "unknownMethod",
                    format!("{method} is not supported for IMAP mailboxes"),
                )
                .into()),
            }
        })
    }

    fn blob<'a>(&'a self, _blob_id: &'a str) -> BoxFuture<'a, Option<(bytes::Bytes, String)>> {
        Box::pin(async { None })
    }

    fn close(&self) {
        if let Ok(mut st) = self.inner.try_lock() {
            st.cards = None;
            st.snap = None;
        }
    }
}
