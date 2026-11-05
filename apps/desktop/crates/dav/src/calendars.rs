//! Façade CalDAV → JMAP for Calendars (draft-ietf-jmap-calendars) des boîtes IMAP. Port de
//! `apps/server/src/caldav/facade.ts`.
//!
//! - `Calendar/get|changes`, `CalendarEvent/get|changes|query|set|parse` (`Calendar/set` non pris en charge :
//!   la capacité annonce `mayCreateCalendar: false`). Même client WebDAV que les contacts.
//! - Une ressource CalDAV (un VCALENDAR, une série et ses exceptions) = un événement JMAP ; conversion par calcard
//!   et l'adaptateur de `convert.rs` (propriétés inconnues gardées dans `iCalendar.properties`).
//! - Sans état : identifiants dérivés du chemin (`k…` agenda, `e…` événement) ; `state` en base64url opaque, comme
//!   les contacts.
//! - `CalendarEvent/query` : `inCalendar`, `after` / `before` (REPORT `calendar-query` avec `time-range`, puis
//!   développement des récurrences en mémoire), `text`, `title`, `description`, `location`, `uid` ;
//!   `expandRecurrences: true` → une entrée par occurrence (id `<événement>_<AAAAMMJJTHHMMSS>`), lisible par
//!   `CalendarEvent/get` ; modifier ou supprimer une occurrence ajoute une exception à la série.
//! - Pas d'iTIP : `sendSchedulingMessages` est ignoré. Conflit d'ETag (412) → `stateMismatch`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{CallContext, Companion, CompanionCaps};
use voxel_core::jmap::{CreatedIds, FacadeError, MethodError, Object, SetError};
use voxel_core::util::{Lru, base64url_encode, hash_of, now_ms, utc_date};

use crate::client::{
    DavBook, DavClient, DavError, DavKind, DavMember, DavTransport, DeleteResult, PutResult,
    SyncResult, encode_component, percent_decode,
};
use crate::contacts::{
    Failure, decode_rows, decode_state, fail, file_name_for, list_or_null, or_null, pick,
    rows_changes, rows_state, string_list, truthy, window,
};
use crate::convert::{event_to_ics, ics_to_events};
use crate::patch::apply_patch;
use crate::recurrence::{event_span, expand, occurrence_of, parse_utc};

/// Capacité JMAP Calendars.
const CAP_CALENDARS: &str = "urn:ietf:params:jmap:calendars";

/// Capacité `CalendarEvent/parse`.
const CAP_CALENDARS_PARSE: &str = "urn:ietf:params:jmap:calendars:parse";

/// Durée maximale de la vérification de `probe`.
const PROBE: Duration = Duration::from_secs(5);

/// Durée de vie de la liste des agendas.
const CALS_TTL: Duration = Duration::from_secs(30);

/// Durée de vie de l'instantané agendas + membres.
const SNAPSHOT_TTL: Duration = Duration::from_secs(3);

/// Nombre d'événements gardés en mémoire.
const MAX_CACHE: usize = 5_000;

/// Au-delà, l'état n'est plus qu'une empreinte (`…/changes` impossible).
const MAX_STATE_ENTRIES: usize = 20_000;

/// Taille maximale d'un fichier iCalendar à analyser.
const MAX_ICS: usize = 5 * 1024 * 1024;

/// Nombre maximal d'occurrences d'un `CalendarEvent/query` développé.
const MAX_EXPANDED: usize = 5_000;

/// Type des ressources écrites.
const CONTENT_TYPE: &str = "text/calendar; charset=utf-8";

/// Marge des requêtes sans borne : 50 ans de part et d'autre.
const FIFTY_YEARS_MS: f64 = 50.0 * 365.25 * 86_400_000.0;

#[derive(Clone)]
struct CalEntry {
    id: String,
    cal: DavBook,
    members: Vec<DavMember>,
}

/// Événement en cache : ETag, JSON et iCalendar de la ressource.
#[derive(Clone)]
struct Cached {
    etag: String,
    ev: Value,
    ics: String,
}

struct Found {
    id: String,
    ev: Value,
    ics: String,
}

fn cal_id_of(href: &str) -> String {
    format!("k{}", hash_of(&format!("cal:{href}"), 12))
}

fn event_id_of(href: &str) -> String {
    format!("e{}", hash_of(&format!("event:{href}"), 16))
}

fn etag_key(etag: &str) -> String {
    hash_of(etag, 8)
}

/// Id d'une occurrence développée : `<id>_<AAAAMMJJTHHMMSS>`.
fn occurrence_id(id: &str, rid: &str) -> String {
    format!("{id}_{}", rid.replace(['-', ':'], ""))
}

/// `^(e[A-Za-z0-9_-]{16})_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$` → (id, date locale).
fn split_occurrence_id(id: &str) -> Option<(String, String)> {
    let b = id.as_bytes();
    if b.len() != 33 || b[0] != b'e' || b[17] != b'_' || b[26] != b'T' {
        return None;
    }
    let base_ok = b[1..17]
        .iter()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'));
    let digits_ok = b[18..26].iter().chain(&b[27..33]).all(u8::is_ascii_digit);
    if !base_ok || !digits_ok {
        return None;
    }
    let d = &id[18..];
    Some((
        id[..17].to_string(),
        format!(
            "{}-{}-{}T{}:{}:{}",
            &d[0..4],
            &d[4..6],
            &d[6..8],
            &d[9..11],
            &d[11..13],
            &d[13..15]
        ),
    ))
}

/// Minuscules sans diacritiques (sans retrait des espaces, comme `fold` de la façade Node).
fn fold(s: &str) -> String {
    let t = voxel_core::util::fold_text(&format!("\u{1}{s}\u{1}"));
    t.trim_start_matches('\u{1}')
        .trim_end_matches('\u{1}')
        .to_string()
}

fn participant_email(p: &Value) -> Option<String> {
    if let Some(email) = p
        .get("email")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
    {
        return Some(email.to_lowercase());
    }
    let address = p.get("calendarAddress").and_then(Value::as_str)?;
    address
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("mailto:"))
        .then(|| percent_decode(&address[7..]).to_lowercase())
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn table(ev: &Value, key: &str) -> Vec<Value> {
    ev.get(key)
        .and_then(Value::as_object)
        .map(|t| t.values().cloned().collect())
        .unwrap_or_default()
}

/// Texte de recherche : titre, description, lieux, participants.
fn event_search_text(ev: &Value) -> String {
    let mut parts = vec![
        str_of(ev, "title").to_string(),
        str_of(ev, "description").to_string(),
    ];
    for l in table(ev, "locations") {
        parts.push(str_of(&l, "name").to_string());
    }
    for p in table(ev, "participants") {
        parts.push(str_of(&p, "name").to_string());
        parts.push(participant_email(&p).unwrap_or_default());
    }
    fold(&parts.join(" "))
}

fn event_location(ev: &Value) -> String {
    table(ev, "locations")
        .iter()
        .map(|l| str_of(l, "name").to_string())
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Bornes `after` / `before` d'un filtre (seulement au premier niveau ou dans un AND).
fn range_of(filter: Option<&Value>) -> (Option<i64>, Option<i64>) {
    let Some(f) = filter.and_then(Value::as_object) else {
        return (None, None);
    };
    if f.get("operator") == Some(&json!("AND"))
        && let Some(conds) = f.get("conditions").and_then(Value::as_array)
    {
        let (mut after, mut before): (Option<i64>, Option<i64>) = (None, None);
        for c in conds {
            let (a, b) = range_of(Some(c));
            if let Some(a) = a {
                after = Some(after.map_or(a, |x| x.max(a)));
            }
            if let Some(b) = b {
                before = Some(before.map_or(b, |x| x.min(b)));
            }
        }
        return (after, before);
    }
    let bound = |k: &str| {
        f.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .and_then(parse_utc)
    };
    (bound("after"), bound("before"))
}

/// Filtre `CalendarEvent/query` (conditions et opérateurs) sur un événement, hors bornes de dates.
fn matches(ev: &Value, filter: Option<&Value>) -> bool {
    let Some(f) = filter.and_then(Value::as_object) else {
        return true;
    };
    if let (Some(Value::String(op)), Some(Value::Array(subs))) =
        (f.get("operator"), f.get("conditions"))
    {
        return match op.as_str() {
            "AND" => subs.iter().all(|x| matches(ev, Some(x))),
            "OR" => subs.iter().any(|x| matches(ev, Some(x))),
            "NOT" => !subs.iter().any(|x| matches(ev, Some(x))),
            _ => false,
        };
    }
    let cond = |k: &str| f.get(k).and_then(Value::as_str);
    if let Some(cal) = cond("inCalendar")
        && !truthy(ev.get("calendarIds").and_then(|c| c.get(cal)))
    {
        return false;
    }
    if let Some(uid) = cond("uid")
        && ev.get("uid").and_then(Value::as_str) != Some(uid)
    {
        return false;
    }
    if let Some(text) = cond("text")
        && !event_search_text(ev).contains(&fold(text))
    {
        return false;
    }
    for (key, value) in [
        ("title", str_of(ev, "title").to_string()),
        ("description", str_of(ev, "description").to_string()),
        ("location", event_location(ev)),
    ] {
        if let Some(needle) = cond(key)
            && !fold(&value).contains(&fold(needle))
        {
            return false;
        }
    }
    true
}

/// Retire ce que `CalendarEvent/parse` renvoie mais que `CalendarEvent/set` refuse.
fn clean_parsed_event(ev: &Value) -> Value {
    let Some(map) = ev.as_object() else {
        return ev.clone();
    };
    Value::Object(
        map.iter()
            .filter(|(k, v)| {
                !v.is_null()
                    && !matches!(k.as_str(), "method" | "id" | "baseEventId" | "calendarIds")
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// Événement sans `id`, `calendarIds`, `baseEventId` ni `method`.
fn strip(ev: &Value) -> Value {
    let mut map = ev.as_object().cloned().unwrap_or_default();
    for k in ["id", "calendarIds", "baseEventId", "method"] {
        map.remove(k);
    }
    Value::Object(map)
}

fn jmap_event(id: &str, cal_id: &str, ev: &Value) -> Value {
    let mut out = ev.as_object().cloned().unwrap_or_default();
    out.insert("id".into(), json!(id));
    out.insert("calendarIds".into(), json!({ cal_id: true }));
    out.insert("baseEventId".into(), Value::Null);
    Value::Object(out)
}

fn cals_rows(cals: &[DavBook]) -> Vec<(String, String)> {
    cals.iter()
        .map(|c| {
            let sig = json!([c.name, c.description, c.may_write, c.color]).to_string();
            (cal_id_of(&c.href), hash_of(&sig, 8))
        })
        .collect()
}

fn cal_json(id: &str, cal: &DavBook, i: usize) -> Value {
    let w = cal.may_write;
    json!({
        "id": id,
        "name": cal.name,
        "description": cal.description,
        "color": cal.color,
        "sortOrder": i,
        "isDefault": i == 0,
        "isSubscribed": true,
        "isVisible": true,
        "includeInAvailability": "all",
        "timeZone": null,
        "shareWith": null,
        "myRights": {"mayReadFreeBusy": true, "mayReadItems": true, "mayWriteAll": w, "mayWriteOwn": w, "mayUpdatePrivate": w, "mayRSVP": w, "mayShare": false, "mayDelete": false},
    })
}

fn state_of(list: &[CalEntry]) -> String {
    let mut b = Object::new();
    let mut n = 0;
    for e in list {
        if e.cal.supports_sync
            && let Some(token) = &e.cal.sync_token
        {
            b.insert(e.id.clone(), json!({ "t": token }));
        } else {
            let tags: Object = e
                .members
                .iter()
                .map(|m| (event_id_of(&m.href), json!(etag_key(&m.etag))))
                .collect();
            b.insert(e.id.clone(), json!({ "e": tags }));
            n += e.members.len();
        }
    }
    if n > MAX_STATE_ENTRIES {
        return format!("h{}", hash_of(&Value::Object(b).to_string(), 20));
    }
    format!(
        "d{}",
        base64url_encode(json!({ "v": 1, "b": b }).to_string().as_bytes())
    )
}

#[derive(Default)]
struct Inner {
    cals: Option<(Instant, Vec<DavBook>)>,
    snap: Option<(Instant, Vec<CalEntry>)>,
    events: Option<Lru<String, Cached>>,
}

impl Inner {
    fn events(&mut self) -> &mut Lru<String, Cached> {
        self.events.get_or_insert_with(|| Lru::new(MAX_CACHE))
    }
}

pub struct CalDavFacade {
    dav: DavClient,
    inner: tokio::sync::Mutex<Inner>,
    /// Résultat de la vérification de `probe` (`None` : pas encore vérifié).
    available: Mutex<Option<bool>>,
}

impl CalDavFacade {
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

    async fn list_cals(&self, st: &mut Inner, fresh: bool) -> Result<Vec<DavBook>, DavError> {
        if !fresh
            && let Some((at, list)) = &st.cals
            && at.elapsed() < CALS_TTL
        {
            return Ok(list.clone());
        }
        let list = self
            .dav
            .discover(DavKind::Cal, crate::client::TIMEOUT)
            .await?;
        st.cals = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    async fn snapshot(&self, st: &mut Inner, fresh: bool) -> Result<Vec<CalEntry>, DavError> {
        if !fresh
            && let Some((at, list)) = &st.snap
            && at.elapsed() < SNAPSHOT_TTL
        {
            return Ok(list.clone());
        }
        let cals = self.list_cals(st, fresh).await?;
        let mut list = Vec::new();
        for cal in cals {
            let members = self.dav.list_members(&cal.href).await?;
            list.push(CalEntry {
                id: cal_id_of(&cal.href),
                cal,
                members,
            });
        }
        st.snap = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    fn invalidate(st: &mut Inner) {
        st.snap = None;
        if let Some((at, _)) = &mut st.cals {
            *at = Instant::now() - CALS_TTL;
        }
    }

    /// Événements des ressources demandées : cache si l'ETag n'a pas changé, sinon `calendar-multiget`.
    async fn load_events(
        &self,
        st: &mut Inner,
        entry: &CalEntry,
        members: &[DavMember],
    ) -> Result<Vec<(String, Cached)>, DavError> {
        let mut out = Vec::new();
        let mut missing = Vec::new();
        for m in members {
            match st.events().get(&m.href) {
                Some(hit) if hit.etag == m.etag => out.push((m.href.clone(), hit.clone())),
                _ => missing.push(m.href.clone()),
            }
        }
        if !missing.is_empty() {
            for (href, etag, data) in self
                .dav
                .multiget(&entry.cal.href, &missing, DavKind::Cal)
                .await?
            {
                // iCalendar illisible : ignoré
                let Some(ev) = ics_to_events(&data).into_iter().next() else {
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
                let cached = Cached {
                    etag,
                    ev,
                    ics: data,
                };
                st.events().insert(href.clone(), cached.clone());
                out.push((href, cached));
            }
        }
        Ok(out)
    }

    async fn events_of(
        &self,
        st: &mut Inner,
        list: &[CalEntry],
        ids: Option<&[String]>,
    ) -> Result<Vec<Found>, DavError> {
        let mut out = Vec::new();
        for entry in list {
            let members: Vec<DavMember> = entry
                .members
                .iter()
                .filter(|m| ids.is_none_or(|ids| ids.contains(&event_id_of(&m.href))))
                .cloned()
                .collect();
            if members.is_empty() {
                continue;
            }
            let loaded = self.load_events(st, entry, &members).await?;
            for m in &members {
                let Some((_, c)) = loaded.iter().find(|(h, _)| *h == m.href) else {
                    continue;
                };
                let id = event_id_of(&m.href);
                out.push(Found {
                    ev: jmap_event(&id, &entry.id, &c.ev),
                    ics: c.ics.clone(),
                    id,
                });
            }
        }
        Ok(out)
    }

    // ---------------------------------------------------------------- Calendar

    async fn calendar_get(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut st = self.inner.lock().await;
        let cals = self.list_cals(&mut st, false).await.map_err(fail)?;
        let ids = string_list(args.get("ids"));
        let props = string_list(args.get("properties")).map(|mut p| {
            p.insert(0, "id".into());
            p
        });
        let rows = cals_rows(&cals);
        let list: Vec<Value> = cals
            .iter()
            .enumerate()
            .map(|(i, c)| cal_json(&rows[i].0, c, i))
            .filter(|c| {
                ids.as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| c["id"] == json!(id)))
            })
            .map(|c| pick(&c, props.as_ref()))
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

    async fn calendar_changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let (since, old) = decode_rows(args.get("sinceState"))
            .ok_or_else(|| MethodError::new("cannotCalculateChanges"))?;
        let mut st = self.inner.lock().await;
        let cals = self.list_cals(&mut st, true).await.map_err(fail)?;
        let rows = cals_rows(&cals);
        Ok(rows_changes(since, &old, &rows, rows_state(&rows)))
    }

    // ---------------------------------------------------------------- CalendarEvent

    async fn get(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let list = self.snapshot(st, false).await.map_err(fail)?;
        let ids = string_list(args.get("ids"));
        let props = string_list(args.get("properties")).map(|mut p| {
            p.insert(0, "id".into());
            p
        });
        // occurrences développées : on lit leur série
        let base_ids: Option<Vec<String>> = ids.as_ref().map(|ids| {
            let mut out: Vec<String> = Vec::new();
            for id in ids {
                let base = split_occurrence_id(id).map_or_else(|| id.clone(), |(b, _)| b);
                if !out.contains(&base) {
                    out.push(base);
                }
            }
            out
        });
        let found = self
            .events_of(st, &list, base_ids.as_deref())
            .await
            .map_err(fail)?;
        let wanted: Vec<String> = ids
            .clone()
            .unwrap_or_else(|| found.iter().map(|f| f.id.clone()).collect());
        let mut out_list = Vec::new();
        let mut not_found = Vec::new();
        for id in wanted {
            let Some((base, rid)) = split_occurrence_id(&id) else {
                match found.iter().find(|f| f.id == id) {
                    Some(f) => out_list.push(pick(&f.ev, props.as_ref())),
                    None => not_found.push(json!(id)),
                }
                continue;
            };
            let f = found.iter().find(|f| f.id == base);
            let Some((f, inst)) = f.and_then(|f| occurrence_of(&f.ev, &rid).map(|i| (f, i))) else {
                not_found.push(json!(id));
                continue;
            };
            let mut inst = inst.as_object().cloned().unwrap_or_default();
            inst.insert("id".into(), json!(id));
            inst.insert(
                "calendarIds".into(),
                f.ev.get("calendarIds").cloned().unwrap_or(Value::Null),
            );
            inst.insert("baseEventId".into(), json!(base));
            inst.insert("recurrenceId".into(), json!(rid));
            out_list.push(pick(&Value::Object(inst), props.as_ref()));
        }
        let mut out = Object::new();
        out.insert("state".into(), json!(state_of(&list)));
        out.insert("list".into(), Value::Array(out_list));
        out.insert(
            "notFound".into(),
            Value::Array(if ids.is_some() { not_found } else { Vec::new() }),
        );
        Ok(out)
    }

    async fn query(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let list = self.snapshot(st, false).await.map_err(fail)?;
        let (after, before) = range_of(args.get("filter"));
        let mut entries = list.clone();
        // plage : on ne lit que les ressources que le serveur trouve dans la plage (calendar-query + time-range)
        if after.is_some() || before.is_some() {
            for e in entries.iter_mut() {
                let hits = self
                    .dav
                    .calendar_query(&e.cal.href, after, before)
                    .await
                    .map_err(fail)?;
                e.members.retain(|m| hits.iter().any(|h| h.href == m.href));
            }
        }
        let all = self.events_of(st, &entries, None).await.map_err(fail)?;
        let now = now_ms() as f64;
        let from = after.unwrap_or((now - FIFTY_YEARS_MS) as i64);
        let to = before.unwrap_or((now + FIFTY_YEARS_MS) as i64);
        let ranged = after.is_some() || before.is_some();
        let mut rows: Vec<(String, i64)> = Vec::new();
        for f in &all {
            if !matches(&f.ev, args.get("filter")) {
                continue;
            }
            if args.get("expandRecurrences") == Some(&Value::Bool(true)) {
                if after.is_none() || before.is_none() {
                    return Err(MethodError::described(
                        "cannotExpand",
                        "expandRecurrences needs after and before",
                    )
                    .into());
                }
                for o in expand(&f.ics, &f.ev, from, to, None) {
                    let id = match &o.recurrence_id {
                        Some(rid) => occurrence_id(&f.id, rid),
                        None => f.id.clone(),
                    };
                    rows.push((id, o.start_ms));
                    if rows.len() > MAX_EXPANDED {
                        return Err(MethodError::described(
                            "tooManyResults",
                            "too many occurrences",
                        )
                        .into());
                    }
                }
            } else if ranged {
                let Some(first) = expand(&f.ics, &f.ev, from, to, Some(1)).into_iter().next()
                else {
                    continue;
                };
                rows.push((f.id.clone(), first.start_ms));
            } else {
                rows.push((f.id.clone(), event_span(&f.ev).0));
            }
        }
        rows.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        let sort = args
            .get("sort")
            .and_then(Value::as_array)
            .and_then(|s| s.first());
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
                    .map(|r| json!(r.0))
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
        let cals = self.list_cals(st, true).await.map_err(fail)?;
        let (mut created, mut updated, mut destroyed) = (Vec::new(), Vec::new(), Vec::new());
        let mut next = Object::new();
        for cal in &cals {
            let id = cal_id_of(&cal.href);
            let prev = old.get(&id).and_then(Value::as_object);
            if let Some(token) = prev
                .and_then(|p| p.get("t"))
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                && cal.supports_sync
            {
                match self
                    .dav
                    .sync_collection(&cal.href, token)
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
                        updated.extend(changed.iter().map(|m| event_id_of(&m.href)));
                        destroyed.extend(removed.iter().map(|h| event_id_of(h)));
                        let t = new_token
                            .or_else(|| cal.sync_token.clone())
                            .unwrap_or_else(|| token.to_string());
                        next.insert(id, json!({ "t": t }));
                    }
                }
                continue;
            }
            let members = self.dav.list_members(&cal.href).await.map_err(fail)?;
            let now: Object = members
                .iter()
                .map(|m| (event_id_of(&m.href), json!(etag_key(&m.etag))))
                .collect();
            let empty = Object::new();
            let before = prev
                .and_then(|p| p.get("e"))
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            for (eid, tag) in &now {
                match before.get(eid) {
                    None => created.push(eid.clone()),
                    Some(b) if b != tag => updated.push(eid.clone()),
                    _ => {}
                }
            }
            destroyed.extend(before.keys().filter(|k| !now.contains_key(*k)).cloned());
            match (&cal.sync_token, cal.supports_sync) {
                (Some(t), true) => next.insert(id, json!({ "t": t })),
                _ => next.insert(id, json!({ "e": now })),
            };
        }
        for (cid, prev) in &old {
            if cals.iter().any(|c| cal_id_of(&c.href) == *cid) {
                continue;
            }
            let Some(e) = prev.get("e").and_then(Value::as_object) else {
                return Err(MethodError::new("cannotCalculateChanges").into());
            };
            destroyed.extend(e.keys().cloned());
        }
        st.snap = None;
        let updated: Vec<String> = updated
            .into_iter()
            .filter(|id| !created.contains(id))
            .collect();
        let mut out = Object::new();
        out.insert(
            "oldState".into(),
            args.get("sinceState").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            "newState".into(),
            json!(format!(
                "d{}",
                base64url_encode(json!({ "v": 1, "b": next }).to_string().as_bytes())
            )),
        );
        out.insert("hasMoreChanges".into(), json!(false));
        out.insert("created".into(), json!(created));
        out.insert("updated".into(), json!(updated));
        out.insert("destroyed".into(), json!(destroyed));
        out.insert("updatedProperties".into(), Value::Null);
        Ok(out)
    }

    fn target_cal<'a>(
        before: &'a [CalEntry],
        ids: Option<&Value>,
        created: &CreatedIds,
    ) -> Result<&'a CalEntry, SetError> {
        let ids = match ids {
            None | Some(Value::Null) => {
                return before
                    .iter()
                    .find(|e| e.cal.may_write)
                    .or_else(|| before.first())
                    .ok_or_else(|| {
                        SetError::on("invalidProperties", "no calendar", &["calendarIds"])
                    });
            }
            Some(v) => v.as_object().ok_or_else(|| {
                SetError::on(
                    "invalidProperties",
                    "calendarIds must be an object",
                    &["calendarIds"],
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
                "exactly one calendar is supported",
                &["calendarIds"],
            ));
        }
        let e = before.iter().find(|e| e.id == on[0]).ok_or_else(|| {
            SetError::on("invalidProperties", "unknown calendar", &["calendarIds"])
        })?;
        if !e.cal.may_write {
            return Err(SetError::on(
                "forbidden",
                "calendar is read-only",
                &["calendarIds"],
            ));
        }
        Ok(e)
    }

    /// Crée la ressource (nom tiré de l'uid ; nom aléatoire si le nom est déjà pris).
    async fn create_in(
        &self,
        entry: &CalEntry,
        raw: &Value,
    ) -> Result<(String, Option<String>, Value, String), Failure> {
        let mut ev = strip(raw);
        let uid = match ev.get("uid") {
            Some(Value::String(u)) if !u.is_empty() => u.clone(),
            _ => uuid::Uuid::new_v4().to_string(),
        };
        if let Some(map) = ev.as_object_mut() {
            map.insert("uid".into(), json!(uid));
            map.insert("@type".into(), json!("Event"));
        }
        let text = event_to_ics(&ev)
            .ok_or_else(|| SetError::described("invalidProperties", "invalid calendar event"))?;
        let base = url::Url::parse(&entry.cal.href)
            .map_err(|_| DavError::Network("invalid calendar href".into()))?;
        let mut name = file_name_for(&uid, "ics");
        for attempt in 0..3 {
            let href = self
                .dav
                .resolve(&encode_component(&name), Some(&base))?
                .as_str()
                .to_string();
            match self.dav.put(&href, &text, None, CONTENT_TYPE).await? {
                PutResult::Written { etag } => return Ok((href, etag, ev, text)),
                PutResult::Conflict => {
                    name = format!(
                        "{}.ics",
                        hash_of(&format!("{uid}:{}:{attempt}", now_ms()), 12)
                    );
                }
            }
        }
        Err(SetError::described("alreadyExists", "could not create the event").into())
    }

    /// Réécrit la ressource : `sequence` + 1 et `updated` à maintenant ; l'ETag du membre suit l'écriture.
    async fn write_back(
        &self,
        st: &mut Inner,
        cal_href: &str,
        member: &mut DavMember,
        ev: &Value,
    ) -> Result<(), Failure> {
        let mut next = ev.as_object().cloned().unwrap_or_default();
        let sequence = next.get("sequence").and_then(Value::as_i64).unwrap_or(0);
        next.insert("updated".into(), json!(utc_date(now_ms())));
        next.insert("sequence".into(), json!(sequence + 1));
        let next = Value::Object(next);
        let text = event_to_ics(&next)
            .ok_or_else(|| SetError::described("invalidProperties", "invalid calendar event"))?;
        let etag = Some(member.etag.as_str()).filter(|e| !e.is_empty());
        let written = match self
            .dav
            .put(&member.href, &text, etag, CONTENT_TYPE)
            .await?
        {
            PutResult::Conflict => {
                return Err(SetError::described(
                    "stateMismatch",
                    "the event was changed on the server (ETag)",
                )
                .into());
            }
            PutResult::Written { etag } => etag,
        };
        match &written {
            Some(etag) => st.events().insert(
                member.href.clone(),
                Cached {
                    etag: etag.clone(),
                    ev: next,
                    ics: text,
                },
            ),
            None => {
                st.events().remove(&member.href);
            }
        }
        // plusieurs écritures sur la même ressource dans un même appel : l'ETag suivant doit être le nouveau
        member.etag = match written {
            Some(e) => e,
            None => self
                .dav
                .list_members(cal_href)
                .await?
                .into_iter()
                .find(|m| m.href == member.href)
                .map(|m| m.etag)
                .unwrap_or_default(),
        };
        Ok(())
    }

    async fn set(&self, args: &Object, ctx: CallContext<'_>) -> Result<Object, FacadeError> {
        let mut guard = self.inner.lock().await;
        let st = &mut *guard;
        let mut before = self.snapshot(st, true).await.map_err(fail)?;
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
        let locate = |before: &[CalEntry], id: &str| {
            before.iter().enumerate().find_map(|(ei, e)| {
                e.members
                    .iter()
                    .position(|m| event_id_of(&m.href) == id)
                    .map(|mi| (ei, mi))
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
                if !map.get("start").is_some_and(Value::is_string) {
                    return Err(SetError::on("invalidProperties", "start is required", &["start"]).into());
                }
                let entry = Self::target_cal(&before, map.get("calendarIds"), ctx.created)?;
                let (href, etag, ev, ics) = self.create_in(entry, raw).await?;
                let id = event_id_of(&href);
                if let Some(etag) = etag {
                    st.events().insert(href.clone(), Cached { etag, ev: ev.clone(), ics });
                }
                ctx.created.record(cid, &id);
                created.insert(
                    cid.clone(),
                    json!({ "id": id, "uid": ev["uid"], "calendarIds": { entry.id.clone(): true } }),
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
                let occ = split_occurrence_id(&id);
                let base_id = occ.as_ref().map_or(id.as_str(), |(b, _)| b.as_str());
                let Some((ei, mi)) = locate(&before, base_id) else {
                    return Err(SetError::new("notFound").into());
                };
                let single = CalEntry {
                    members: vec![before[ei].members[mi].clone()],
                    ..before[ei].clone()
                };
                let current = self
                    .events_of(st, std::slice::from_ref(&single), None)
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
                let next = match &occ {
                    // une occurrence : le patch devient une exception de la série
                    Some((_, rid)) => {
                        let mut merged = current
                            .ev
                            .get("recurrenceOverrides")
                            .and_then(|o| o.get(rid))
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        for (k, v) in patch {
                            if k != "calendarIds" {
                                merged.insert(k.clone(), v.clone());
                            }
                        }
                        let mut p = Object::new();
                        p.insert(format!("recurrenceOverrides/{rid}"), Value::Object(merged));
                        apply_patch(&current.ev, &p)
                    }
                    None => apply_patch(&current.ev, patch),
                }
                .map_err(|_| SetError::new("invalidPatch"))?;
                let dest = Self::target_cal(&before, next.get("calendarIds"), ctx.created)?;
                if dest.id == before[ei].id {
                    let cal_href = before[ei].cal.href.clone();
                    let mut member = before[ei].members[mi].clone();
                    let written = self
                        .write_back(st, &cal_href, &mut member, &strip(&next))
                        .await;
                    before[ei].members[mi].etag = member.etag;
                    written?;
                    updated.insert(id.clone(), Value::Null);
                } else {
                    // changement d'agenda : écriture dans le nouvel agenda, puis suppression de l'ancienne ressource
                    let dest = dest.clone();
                    let member = before[ei].members[mi].clone();
                    let (href, etag, ev, ics) = self.create_in(&dest, &next).await?;
                    let old_etag = Some(member.etag.as_str()).filter(|e| !e.is_empty());
                    if let DeleteResult::Conflict = self.dav.delete(&member.href, old_etag).await? {
                        let _ = self.dav.delete(&href, etag.as_deref()).await;
                        return Err(SetError::described(
                            "stateMismatch",
                            "the event was changed on the server (ETag)",
                        )
                        .into());
                    }
                    st.events().remove(&member.href);
                    if let Some(etag) = etag {
                        st.events().insert(href.clone(), Cached { etag, ev, ics });
                    }
                    updated.insert(id.clone(), json!({ "id": event_id_of(&href) }));
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
                let occ = split_occurrence_id(&id);
                let base_id = occ.as_ref().map_or(id.as_str(), |(b, _)| b.as_str());
                let Some((ei, mi)) = locate(&before, base_id) else {
                    return Err(SetError::new("notFound").into());
                };
                if let Some((_, rid)) = &occ {
                    // supprimer une occurrence : exception `excluded`
                    let single = CalEntry {
                        members: vec![before[ei].members[mi].clone()],
                        ..before[ei].clone()
                    };
                    let current = self
                        .events_of(st, std::slice::from_ref(&single), None)
                        .await?
                        .into_iter()
                        .next()
                        .ok_or_else(|| SetError::new("notFound"))?;
                    let mut p = Object::new();
                    p.insert(
                        format!("recurrenceOverrides/{rid}"),
                        json!({ "excluded": true }),
                    );
                    let next = apply_patch(&current.ev, &p).map_err(|e| {
                        Failure::Dav(DavError::Network(e.description.unwrap_or(e.kind)))
                    })?;
                    let cal_href = before[ei].cal.href.clone();
                    let mut member = before[ei].members[mi].clone();
                    let written = self
                        .write_back(st, &cal_href, &mut member, &strip(&next))
                        .await;
                    before[ei].members[mi].etag = member.etag;
                    written?;
                } else {
                    let member = before[ei].members[mi].clone();
                    let etag = Some(member.etag.as_str()).filter(|e| !e.is_empty());
                    if let DeleteResult::Conflict = self.dav.delete(&member.href, etag).await? {
                        return Err(SetError::described(
                            "stateMismatch",
                            "the event was changed on the server (ETag)",
                        )
                        .into());
                    }
                    st.events().remove(&member.href);
                }
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

    /// `CalendarEvent/parse` : fichiers `.ics` téléversés → événements (tableau par blob, comme Stalwart).
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
            if buf.len() > MAX_ICS {
                not_parsable.push(json!(id));
                continue;
            }
            let events = ics_to_events(&String::from_utf8_lossy(&buf));
            if events.is_empty() {
                not_parsable.push(json!(id));
                continue;
            }
            let shaped: Vec<Value> = events
                .iter()
                .map(|e| pick(&clean_parsed_event(e), props.as_ref()))
                .collect();
            parsed.insert(id, Value::Array(shaped));
        }
        let mut out = Object::new();
        out.insert("parsed".into(), or_null(parsed));
        out.insert("notParsable".into(), list_or_null(not_parsable));
        out.insert("notFound".into(), list_or_null(not_found));
        Ok(out)
    }
}

impl Companion for CalDavFacade {
    /// Vérification (découverte des agendas, authentifiée), 5 s au plus ; échec silencieux = capacité absente.
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
            let found = tokio::time::timeout(PROBE, self.dav.discover(DavKind::Cal, PROBE)).await;
            let ok = match found {
                Ok(Ok(list)) => {
                    let ok = !list.is_empty();
                    self.inner.lock().await.cals = Some((Instant::now(), list));
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
        core.insert(CAP_CALENDARS.into(), json!({}));
        core.insert(CAP_CALENDARS_PARSE.into(), json!({}));
        let mut account = Object::new();
        account.insert(
            CAP_CALENDARS.into(),
            json!({
                "maxCalendarsPerEvent": 1,
                "mayCreateCalendar": false,
                "maxExpandedQueryDuration": "P400D",
                "maxParticipantsPerEvent": null,
            }),
        );
        account.insert(CAP_CALENDARS_PARSE.into(), json!({}));
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
                "Calendar/get" => self.calendar_get(&args).await,
                "Calendar/changes" => self.calendar_changes(&args).await,
                "CalendarEvent/get" => self.get(&args).await,
                "CalendarEvent/query" => self.query(&args).await,
                "CalendarEvent/changes" => self.changes(&args).await,
                "CalendarEvent/set" => self.set(&args, ctx).await,
                "CalendarEvent/parse" => self.parse(&args, &ctx).await,
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
            st.events = None;
            st.snap = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occurrence_ids_and_fold() {
        let id = "eAbCdEfGh_-123456";
        let occ = occurrence_id(id, "2026-11-12T09:00:00");
        assert_eq!(occ, "eAbCdEfGh_-123456_20261112T090000");
        assert_eq!(
            split_occurrence_id(&occ),
            Some((id.to_string(), "2026-11-12T09:00:00".to_string()))
        );
        assert_eq!(split_occurrence_id("eabc_20261112T090000"), None);
        assert_eq!(fold(" Réunion "), " reunion ");
    }

    #[test]
    fn non_ascii_address_does_not_panic() {
        let ev = json!({"participants": {"p": {"calendarAddress": "sip:abé@example.com"}, "q": {"calendarAddress": "MAILTO:Bé@x.fr"}}});
        assert_eq!(participant_email(&ev["participants"]["p"]), None);
        assert_eq!(
            participant_email(&ev["participants"]["q"]).as_deref(),
            Some("bé@x.fr")
        );
        assert!(matches(&ev, Some(&json!({"text": "bé"}))));
    }
}
