//! Dossiers IMAP ↔ objets Mailbox JMAP (port de `folders.ts`) : ids stables gardés dans la table clé-valeur,
//! rôles SPECIAL-USE (et noms usuels), compteurs, états, Mailbox/get|query|set|changes. Le relevé
//! LIST + STATUS est gardé 4 s et une seule relecture tourne à la fois.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};
use voxel_core::jmap::{CreatedIds, FacadeError, MethodError, Object, SetError};
use voxel_core::kv::KvStore;
use voxel_core::util::{fold_text, hash_of, random_base36};
use voxel_imap::pool::ImapPool;
use voxel_imap::session::ListEntry;

use crate::backend::imap_err;
use crate::jmap_json::{as_object, js_string, list_or_null, object_or_null};

#[derive(Debug, Clone)]
pub struct Folder {
    pub id: String,
    pub path: String,
    pub name: String,
    pub delimiter: String,
    pub parent_id: Option<String>,
    pub role: Option<String>,
    pub subscribed: bool,
    pub messages: u32,
    pub unseen: u32,
    pub uid_next: u32,
    pub uid_validity: u32,
    pub highest_modseq: Option<u64>,
}

/// Rôles des attributs SPECIAL-USE (RFC 6154).
const ROLE_BY_USE: [(&str, &str); 9] = [
    ("\\Inbox", "inbox"),
    ("\\Sent", "sent"),
    ("\\Drafts", "drafts"),
    ("\\Trash", "trash"),
    ("\\Junk", "junk"),
    ("\\Archive", "archive"),
    ("\\Flagged", "flagged"),
    ("\\All", "all"),
    ("\\Important", "important"),
];

/// Rôles devinés par le nom quand le serveur n'annonce pas SPECIAL-USE.
static ROLE_BY_NAME: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)^(sent|sent items|sent mail|sent messages|envoy[ée]s|[ée]l[ée]ments envoy[ée]s|messages envoy[ée]s|enviados|gesendet|inviati)$", "sent"),
        (r"(?i)^(drafts?|brouillons?|borradores|entw[üu]rfe|bozze)$", "drafts"),
        (r"(?i)^(trash|deleted|deleted items|deleted messages|corbeille|[ée]l[ée]ments supprim[ée]s|papelera|papierkorb|cestino|bin)$", "trash"),
        (r"(?i)^(junk|junk mail|junk e-mail|spam|courrier ind[ée]sirable|ind[ée]sirables|correo no deseado)$", "junk"),
        (r"(?i)^(archives?|archivo|archiv|archivio)$", "archive"),
    ]
    .into_iter()
    .map(|(re, role)| (Regex::new(re).unwrap(), role))
    .collect()
});

/// Ordre d'affichage des rôles (`sortOrder`) ; 10 pour les autres dossiers.
const ROLE_ORDER: [(&str, u32); 9] = [
    ("inbox", 1),
    ("drafts", 2),
    ("sent", 3),
    ("archive", 4),
    ("junk", 5),
    ("trash", 6),
    ("flagged", 7),
    ("all", 8),
    ("important", 9),
];

/// Propriétés Mailbox connues.
const MB_PROPS: [&str; 11] = [
    "id",
    "name",
    "parentId",
    "role",
    "sortOrder",
    "totalEmails",
    "unreadEmails",
    "totalThreads",
    "unreadThreads",
    "myRights",
    "isSubscribed",
];

/// Durée de vie du relevé des dossiers.
const TTL: Duration = Duration::from_secs(4);

fn role_order(role: Option<&str>) -> u32 {
    role.and_then(|r| ROLE_ORDER.iter().find(|(n, _)| *n == r).map(|(_, o)| *o))
        .unwrap_or(10)
}

type Observer = Arc<dyn Fn(&[Folder]) + Send + Sync>;
/// Dernier relevé et son heure.
type Cached = Option<(Instant, Vec<Folder>)>;

pub struct Folders {
    pool: Arc<ImapPool>,
    kv: Arc<dyn KvStore>,
    cache: Mutex<Cached>,
    generation: AtomicU64,
    refresh: tokio::sync::Mutex<()>,
    observer: Mutex<Option<Observer>>,
}

impl Folders {
    pub fn new(pool: Arc<ImapPool>, kv: Arc<dyn KvStore>) -> Self {
        Folders {
            pool,
            kv,
            cache: Mutex::new(None),
            generation: AtomicU64::new(0),
            refresh: tokio::sync::Mutex::new(()),
            observer: Mutex::new(None),
        }
    }

    pub fn set_observer(&self, observer: Observer) {
        *self.observer.lock().unwrap_or_else(|e| e.into_inner()) = Some(observer);
    }

    // ---------------------------------------------------------------- ids stables

    pub fn id_for_path(&self, path: &str) -> String {
        let k = format!("mb:p:{path}");
        if let Some(existing) = self.kv.get(&k).filter(|v| !v.is_empty()) {
            return existing;
        }
        let mut id;
        loop {
            id = format!("m{}", random_base36(5));
            if self.kv.get(&format!("mb:i:{id}")).is_none() {
                break;
            }
        }
        self.kv.set(&k, &id);
        self.kv.set(&format!("mb:i:{id}"), path);
        id
    }

    fn move_path(&self, old_path: &str, new_path: &str, delimiter: &str) {
        // le dossier et ses descendants gardent leur id
        if let Some(id) = self
            .kv
            .get(&format!("mb:p:{old_path}"))
            .filter(|v| !v.is_empty())
        {
            self.kv.delete(&format!("mb:p:{old_path}"));
            self.kv.set(&format!("mb:p:{new_path}"), &id);
            self.kv.set(&format!("mb:i:{id}"), new_path);
        }
        let list = self.cached().unwrap_or_default();
        let prefix = format!("{old_path}{delimiter}");
        for f in list {
            if f.path.starts_with(&prefix) {
                let np = format!("{new_path}{}", &f.path[old_path.len()..]);
                self.kv.delete(&format!("mb:p:{}", f.path));
                self.kv.set(&format!("mb:p:{np}"), &f.id);
                self.kv.set(&format!("mb:i:{}", f.id), &np);
            }
        }
    }

    fn forget(&self, path: &str) {
        let id = self.kv.get(&format!("mb:p:{path}"));
        self.kv.delete(&format!("mb:p:{path}"));
        if let Some(id) = id.filter(|v| !v.is_empty()) {
            self.kv.delete(&format!("mb:i:{id}"));
        }
    }

    // ---------------------------------------------------------------- liste

    fn cached(&self) -> Option<Vec<Folder>> {
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|(_, l)| l.clone())
    }

    pub fn invalidate(&self) {
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn list(&self, force: bool) -> Result<Vec<Folder>, FacadeError> {
        let fresh = |at: &Instant| at.elapsed() < TTL;
        if !force
            && let Some((at, l)) = &*self.cache.lock().unwrap_or_else(|e| e.into_inner())
            && fresh(at)
        {
            return Ok(l.clone());
        }
        let asked = Instant::now();
        // une seule relecture à la fois : qui attend reprend le relevé fait pendant son attente
        let _guard = self.refresh.lock().await;
        if let Some((at, l)) = &*self.cache.lock().unwrap_or_else(|e| e.into_inner())
            && (*at >= asked || (!force && fresh(at)))
        {
            return Ok(l.clone());
        }
        let gen_before = self.generation.load(Ordering::SeqCst);
        let raw = self
            .pool
            .with_conn(|c| {
                Box::pin(async move {
                    let condstore = c.has("CONDSTORE") || c.has("QRESYNC");
                    // STATUS du dossier sélectionné sur cette connexion = sa vue (Dovecot), en retard sur les
                    // écritures des autres connexions : NOOP d'abord pour que le relevé soit exact.
                    if c.selected().is_some() {
                        c.noop().await?;
                    }
                    c.list(condstore).await
                })
            })
            .await
            .map_err(imap_err)?;
        let list = self.build(raw);
        if gen_before == self.generation.load(Ordering::SeqCst) {
            *self.cache.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((Instant::now(), list.clone()));
        }
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(o) = observer {
            // le journal ne doit jamais faire échouer une lecture
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| o(&list)));
        }
        Ok(list)
    }

    fn build(&self, raw: Vec<ListEntry>) -> Vec<Folder> {
        // Comme folders.ts : `hasFlag(r.flags, '\Noselect')` y compare « noselect » (le `\N` de la chaîne JS
        // ne garde que `N`) aux attributs `\Noselect` du serveur ; aucun dossier n'est donc écarté.
        let selectable: Vec<ListEntry> = raw
            .into_iter()
            .filter(|r| !has_flag(&r.flags, "Noselect") && !has_flag(&r.flags, "NonExistent"))
            .collect();
        let by_path: HashSet<&str> = selectable.iter().map(|r| r.path.as_str()).collect();
        let mut used_roles: HashSet<&str> = HashSet::new();
        // rôles : d'abord SPECIAL-USE annoncé par le serveur, puis noms usuels
        let mut roles: HashMap<String, String> = HashMap::new();
        let mut sorted: Vec<&ListEntry> = selectable.iter().collect();
        sorted.sort_by_key(|r| source_rank(r));
        for r in sorted {
            let role: Option<&str> = if r.path.to_uppercase() == "INBOX" {
                Some("inbox")
            } else if let Some(role) = r.special_use.as_deref().and_then(|u| {
                ROLE_BY_USE
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(u))
                    .map(|(_, v)| *v)
            }) {
                Some(role)
            } else if r.parent_path.is_none()
                || r.parent_path
                    .as_deref()
                    .is_some_and(|p| p.eq_ignore_ascii_case("INBOX"))
            {
                ROLE_BY_NAME
                    .iter()
                    .find(|(re, _)| re.is_match(&r.name))
                    .map(|(_, role)| *role)
            } else {
                None
            };
            if let Some(role) = role
                && used_roles.insert(role)
            {
                roles.insert(r.path.clone(), role.to_string());
            }
        }
        let mut out = Vec::new();
        for r in &selectable {
            // parent sélectionnable le plus proche (un parent non sélectionnable est sauté)
            let delim = r.delimiter.clone().filter(|d| !d.is_empty());
            let segs: Vec<&str> = match (&r.parent_path, &delim) {
                (Some(p), Some(d)) => p.split(d.as_str()).collect(),
                (Some(p), None) => vec![p.as_str()],
                (None, _) => Vec::new(),
            };
            let join = delim.clone().unwrap_or_default();
            let mut parent_id = None;
            for n in (1..=segs.len()).rev() {
                let pp = segs[..n].join(&join);
                if by_path.contains(pp.as_str()) {
                    parent_id = Some(self.id_for_path(&pp));
                    break;
                }
            }
            let st = r.status.clone().unwrap_or_default();
            let inbox = r.path.to_uppercase() == "INBOX";
            out.push(Folder {
                id: self.id_for_path(&r.path),
                path: r.path.clone(),
                name: if inbox {
                    "Inbox".into()
                } else {
                    r.name.clone()
                },
                delimiter: delim.unwrap_or_else(|| "/".into()),
                parent_id,
                role: roles.get(&r.path).cloned(),
                // comme folders.ts (`r.subscribed !== false`) : imapflow ne rendait jamais `false`
                subscribed: true,
                messages: st.messages,
                unseen: st.unseen,
                uid_next: st.uid_next,
                uid_validity: st.uid_validity,
                highest_modseq: st.highest_modseq,
            });
        }
        out
    }

    /// Repris de folders.ts (sans appelant dans la façade, comme en Node).
    #[allow(dead_code)]
    pub async fn by_id(&self, id: &str) -> Result<Option<Folder>, FacadeError> {
        Ok(self.list(false).await?.into_iter().find(|f| f.id == id))
    }

    #[allow(dead_code)]
    pub async fn by_role(&self, role: &str) -> Result<Option<Folder>, FacadeError> {
        Ok(self
            .list(false)
            .await?
            .into_iter()
            .find(|f| f.role.as_deref() == Some(role)))
    }

    /// Empreinte d'un dossier (change dès qu'un message arrive, part ou change de drapeaux).
    pub fn stamp(f: &Folder) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            f.uid_validity,
            f.uid_next,
            f.messages,
            f.unseen,
            f.highest_modseq.map(|m| m.to_string()).unwrap_or_default()
        )
    }

    /// État Email d'un relevé de dossiers (même calcul pour emailState et le journal des changements).
    pub fn email_state_of(list: &[Folder]) -> String {
        let text = list
            .iter()
            .map(|f| format!("{}|{}", f.path, Self::stamp(f)))
            .collect::<Vec<_>>()
            .join("\n");
        format!("e{}", hash_of(&text, 12))
    }

    pub async fn email_state(&self) -> Result<String, FacadeError> {
        Ok(Self::email_state_of(&self.list(false).await?))
    }

    pub async fn mailbox_state(&self) -> Result<String, FacadeError> {
        let list = self.list(false).await?;
        let text = list
            .iter()
            .map(|f| {
                format!(
                    "{}|{}|{}|{}|{}|{}",
                    f.id,
                    f.path,
                    f.role.as_deref().unwrap_or("null"),
                    f.subscribed,
                    f.messages,
                    f.unseen
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(format!("b{}", hash_of(&text, 12)))
    }

    pub fn to_jmap(f: &Folder, properties: Option<&[String]>) -> Value {
        let not_inbox = f.role.as_deref() != Some("inbox");
        let full = json!({
            "id": f.id,
            "name": f.name,
            "parentId": f.parent_id,
            "role": f.role,
            "sortOrder": role_order(f.role.as_deref()),
            "totalEmails": f.messages,
            "unreadEmails": f.unseen,
            "totalThreads": f.messages,
            "unreadThreads": f.unseen,
            "myRights": {
                "mayReadItems": true,
                "mayAddItems": true,
                "mayRemoveItems": true,
                "maySetSeen": true,
                "maySetKeywords": true,
                "mayCreateChild": true,
                "mayRename": not_inbox,
                "mayDelete": not_inbox,
                "maySubmit": true,
            },
            "isSubscribed": f.subscribed,
        });
        let Some(props) = properties else {
            return full;
        };
        let mut out = Object::new();
        out.insert("id".into(), json!(f.id));
        for p in props {
            if let Some(v) = full.get(p) {
                out.insert(p.clone(), v.clone());
            }
        }
        Value::Object(out)
    }

    // ---------------------------------------------------------------- méthodes JMAP

    pub async fn get(&self, args: &Object) -> Result<Object, FacadeError> {
        let list = self.list(false).await?;
        let props: Option<Vec<String>> = args
            .get("properties")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js_string).collect());
        if let Some(props) = &props {
            for p in props {
                if !MB_PROPS.contains(&p.as_str()) {
                    return Err(MethodError::described(
                        "invalidArguments",
                        format!("unknown property {p}"),
                    )
                    .into());
                }
            }
        }
        let mut found: Vec<&Folder> = Vec::new();
        let mut not_found: Vec<Value> = Vec::new();
        match args.get("ids") {
            None | Some(Value::Null) => found = list.iter().collect(),
            Some(Value::Array(ids)) => {
                for id in ids {
                    match list.iter().find(|x| Some(x.id.as_str()) == id.as_str()) {
                        Some(f) => found.push(f),
                        None => not_found.push(id.clone()),
                    }
                }
            }
            Some(_) => {
                return Err(MethodError::described(
                    "invalidArguments",
                    "ids must be an array or null",
                )
                .into());
            }
        }
        let out: Vec<Value> = found
            .iter()
            .map(|f| Self::to_jmap(f, props.as_deref()))
            .collect();
        let mut r = Object::new();
        r.insert("state".into(), json!(self.mailbox_state().await?));
        r.insert("list".into(), Value::Array(out));
        r.insert("notFound".into(), Value::Array(not_found));
        Ok(r)
    }

    pub async fn query(&self, args: &Object) -> Result<Object, FacadeError> {
        let list = self.list(false).await?;
        let empty = Object::new();
        let filter = as_object(args.get("filter")).unwrap_or(&empty);
        let mut res: Vec<&Folder> = list
            .iter()
            .filter(|f| {
                if let Some(v) = filter.get("parentId")
                    && json!(f.parent_id) != *v
                {
                    return false;
                }
                if let Some(v) = filter.get("role")
                    && json!(f.role) != *v
                {
                    return false;
                }
                if let Some(v) = filter.get("hasAnyRole")
                    && json!(f.role.is_some()) != *v
                {
                    return false;
                }
                if let Some(v) = filter.get("isSubscribed")
                    && json!(f.subscribed) != *v
                {
                    return false;
                }
                if let Some(name) = filter.get("name").and_then(Value::as_str)
                    && !f.name.to_lowercase().contains(&name.to_lowercase())
                {
                    return false;
                }
                true
            })
            .collect();
        res.sort_by(|a, b| {
            role_order(a.role.as_deref())
                .cmp(&role_order(b.role.as_deref()))
                .then_with(|| fold_text(&a.path).cmp(&fold_text(&b.path)))
                .then_with(|| a.path.cmp(&b.path))
        });
        let total = res.len();
        let position = args
            .get("position")
            .and_then(Value::as_f64)
            .map_or(0.0, |p| p.max(0.0));
        let limit = args
            .get("limit")
            .and_then(Value::as_f64)
            .unwrap_or(total as f64);
        let ids = slice(&res, position, position + limit)
            .iter()
            .map(|f| json!(f.id))
            .collect::<Vec<_>>();
        let mut r = Object::new();
        r.insert("queryState".into(), json!(self.mailbox_state().await?));
        r.insert("canCalculateChanges".into(), json!(false));
        r.insert("position".into(), num(position));
        r.insert("ids".into(), Value::Array(ids));
        r.insert("total".into(), json!(total));
        Ok(r)
    }

    pub async fn changes(&self, args: &Object) -> Result<Object, FacadeError> {
        let state = self.mailbox_state().await?;
        if args.get("sinceState").and_then(Value::as_str) == Some(state.as_str()) {
            let r = json!({ "oldState": state, "newState": state, "hasMoreChanges": false, "created": [], "updated": [], "destroyed": [], "updatedProperties": null });
            return Ok(r.as_object().cloned().unwrap_or_default());
        }
        Err(MethodError::described(
            "cannotCalculateChanges",
            "IMAP facade cannot compute mailbox changes",
        )
        .into())
    }

    pub async fn set(&self, args: &Object, ctx: &mut CreatedIds) -> Result<Object, FacadeError> {
        let old_state = self.mailbox_state().await?;
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

        // création (les parents créés dans la même requête sont référencés par #id)
        if let Some(create) = as_object(args.get("create")) {
            for (cid, obj) in create {
                match self.create_one(obj, ctx).await {
                    Ok(id) => {
                        ctx.record(cid, &id);
                        let subscribed = obj.get("isSubscribed") != Some(&Value::Bool(false));
                        created.insert(
                            cid.clone(),
                            json!({ "id": id, "role": null, "sortOrder": 10, "totalEmails": 0, "unreadEmails": 0, "totalThreads": 0, "unreadThreads": 0, "isSubscribed": subscribed }),
                        );
                    }
                    Err(e) => {
                        not_created.insert(cid.clone(), e.set_error_json());
                    }
                }
            }
        }

        if let Some(update) = as_object(args.get("update")) {
            for (raw_id, patch) in update {
                let id = ctx.resolve(raw_id);
                match self.update_one(&id, patch, ctx).await {
                    Ok(()) => {
                        updated.insert(id, Value::Null);
                    }
                    Err(e) => {
                        not_updated.insert(raw_id.clone(), e.set_error_json());
                    }
                }
            }
        }

        let to_destroy: Vec<String> = args
            .get("destroy")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js_string).collect())
            .unwrap_or_default();
        let resolved: Vec<String> = to_destroy.iter().map(|r| ctx.resolve(r)).collect();
        let remove_emails = args
            .get("onDestroyRemoveEmails")
            .is_some_and(crate::jmap_json::truthy);
        for raw_id in &to_destroy {
            let id = ctx.resolve(raw_id);
            let r: Result<(), FacadeError> = async {
                let list = self.list(true).await?;
                let f = list
                    .iter()
                    .find(|x| x.id == id)
                    .ok_or_else(|| SetError::new("notFound"))?;
                if f.role.as_deref() == Some("inbox") {
                    return Err(SetError::described("forbidden", "cannot delete the inbox").into());
                }
                let child_alive = list.iter().any(|x| {
                    x.parent_id.as_deref() == Some(f.id.as_str()) && !resolved.contains(&x.id)
                });
                if child_alive {
                    return Err(SetError::new("mailboxHasChild").into());
                }
                if f.messages > 0 && !remove_emails {
                    return Err(SetError::new("mailboxHasEmail").into());
                }
                let path = f.path.clone();
                self.pool
                    .with_conn(|c| {
                        let path = path.clone();
                        Box::pin(async move {
                            let _ = c.unsubscribe(&path).await;
                            c.delete(&path).await
                        })
                    })
                    .await
                    .map_err(imap_err)?;
                self.forget(&f.path);
                self.invalidate();
                Ok(())
            }
            .await;
            match r {
                Ok(()) => destroyed.push(id),
                Err(e) => {
                    not_destroyed.insert(raw_id.clone(), e.set_error_json());
                }
            }
        }

        // les destructions demandées dans l'ordre parent → enfant échouent : on réessaie dans l'ordre inverse
        let retry: Vec<String> = not_destroyed
            .iter()
            .filter(|(_, v)| v.get("type").and_then(Value::as_str) == Some("mailboxHasChild"))
            .map(|(k, _)| k.clone())
            .collect();
        if !retry.is_empty() && !destroyed.is_empty() {
            for raw_id in retry {
                let id = ctx.resolve(&raw_id);
                let r: Result<(), FacadeError> = async {
                    let list = self.list(true).await?;
                    let f = list
                        .iter()
                        .find(|x| x.id == id)
                        .ok_or_else(|| SetError::new("notFound"))?;
                    if list
                        .iter()
                        .any(|x| x.parent_id.as_deref() == Some(f.id.as_str()))
                    {
                        return Err(SetError::new("mailboxHasChild").into());
                    }
                    if f.messages > 0 && !remove_emails {
                        return Err(SetError::new("mailboxHasEmail").into());
                    }
                    let path = f.path.clone();
                    self.pool
                        .with_conn(|c| {
                            let path = path.clone();
                            Box::pin(async move { c.delete(&path).await })
                        })
                        .await
                        .map_err(imap_err)?;
                    self.forget(&f.path);
                    self.invalidate();
                    Ok(())
                }
                .await;
                match r {
                    Ok(()) => {
                        destroyed.push(id);
                        not_destroyed.remove(&raw_id);
                    }
                    Err(e) => {
                        not_destroyed.insert(raw_id.clone(), e.set_error_json());
                    }
                }
            }
        }

        let mut r = Object::new();
        r.insert("oldState".into(), json!(old_state));
        r.insert("newState".into(), json!(self.mailbox_state().await?));
        r.insert("created".into(), object_or_null(created));
        r.insert("updated".into(), object_or_null(updated));
        r.insert("destroyed".into(), list_or_null(destroyed));
        r.insert("notCreated".into(), object_or_null(not_created));
        r.insert("notUpdated".into(), object_or_null(not_updated));
        r.insert("notDestroyed".into(), object_or_null(not_destroyed));
        Ok(r)
    }

    async fn create_one(&self, obj: &Value, ctx: &CreatedIds) -> Result<String, FacadeError> {
        let obj = obj
            .as_object()
            .ok_or_else(|| SetError::described("invalidProperties", "object expected"))?;
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            return Err(SetError::on("invalidProperties", "name required", &["name"]).into());
        }
        let list = self.list(false).await?;
        let parent_id = obj
            .get("parentId")
            .and_then(Value::as_str)
            .map(|p| ctx.resolve(p));
        let parent = parent_id
            .as_ref()
            .and_then(|pid| list.iter().find(|f| &f.id == pid));
        if parent_id.as_deref().is_some_and(|p| !p.is_empty()) && parent.is_none() {
            return Err(
                SetError::on("invalidProperties", "parent not found", &["parentId"]).into(),
            );
        }
        let delimiter = parent
            .map(|p| p.delimiter.clone())
            .or_else(|| list.first().map(|f| f.delimiter.clone()))
            .unwrap_or_else(|| "/".into());
        if name.contains(&delimiter) {
            return Err(SetError::on(
                "invalidProperties",
                format!("name cannot contain \"{delimiter}\""),
                &["name"],
            )
            .into());
        }
        let path = match parent {
            Some(p) => format!("{}{delimiter}{name}", p.path),
            None => name,
        };
        if list
            .iter()
            .any(|f| f.path.to_lowercase() == path.to_lowercase())
        {
            return Err(SetError::on(
                "alreadyExists",
                "a mailbox with this name exists",
                &["name"],
            )
            .into());
        }
        let subscribe = obj.get("isSubscribed") != Some(&Value::Bool(false));
        self.pool
            .with_conn(|c| {
                let path = path.clone();
                Box::pin(async move {
                    c.create(&path).await?;
                    if subscribe {
                        let _ = c.subscribe(&path).await;
                    }
                    Ok(())
                })
            })
            .await
            .map_err(imap_err)?;
        self.invalidate();
        Ok(self.id_for_path(&path))
    }

    async fn update_one(
        &self,
        id: &str,
        patch: &Value,
        ctx: &CreatedIds,
    ) -> Result<(), FacadeError> {
        let patch = patch
            .as_object()
            .ok_or_else(|| SetError::new("invalidPatch"))?;
        let list = self.list(true).await?;
        let f = list
            .iter()
            .find(|x| x.id == id)
            .ok_or_else(|| SetError::new("notFound"))?;
        let mut new_name = f.name.clone();
        let mut new_parent = f.parent_id.clone();
        for (k, v) in patch {
            match k.as_str() {
                "name" => {
                    let n = v.as_str().map(str::trim).unwrap_or("");
                    if n.is_empty() {
                        return Err(
                            SetError::on("invalidProperties", "invalid name", &["name"]).into()
                        );
                    }
                    new_name = n.to_string();
                }
                "parentId" => new_parent = v.as_str().map(|p| ctx.resolve(p)),
                "isSubscribed" => {
                    let on = crate::jmap_json::truthy(v);
                    let path = f.path.clone();
                    self.pool
                        .with_conn(|c| {
                            let path = path.clone();
                            Box::pin(async move {
                                if on {
                                    c.subscribe(&path).await
                                } else {
                                    c.unsubscribe(&path).await
                                }
                            })
                        })
                        .await
                        .map_err(imap_err)?;
                }
                // non persistant en IMAP : ignoré
                "sortOrder" | "role" => {}
                _ => {
                    return Err(SetError::on(
                        "invalidProperties",
                        format!("cannot update {k}"),
                        &[k],
                    )
                    .into());
                }
            }
        }
        if new_name != f.name || new_parent != f.parent_id {
            if f.role.as_deref() == Some("inbox") {
                return Err(SetError::described("forbidden", "cannot rename the inbox").into());
            }
            let parent = new_parent
                .as_ref()
                .and_then(|p| list.iter().find(|x| &x.id == p));
            if new_parent.as_deref().is_some_and(|p| !p.is_empty()) && parent.is_none() {
                return Err(
                    SetError::on("invalidProperties", "parent not found", &["parentId"]).into(),
                );
            }
            if let Some(p) = parent
                && (p.id == f.id || p.path.starts_with(&format!("{}{}", f.path, f.delimiter)))
            {
                return Err(SetError::on(
                    "invalidProperties",
                    "cannot move a mailbox into itself",
                    &["parentId"],
                )
                .into());
            }
            if new_name.contains(&f.delimiter) {
                return Err(SetError::on(
                    "invalidProperties",
                    format!("name cannot contain \"{}\"", f.delimiter),
                    &["name"],
                )
                .into());
            }
            let new_path = match parent {
                Some(p) => format!("{}{}{new_name}", p.path, f.delimiter),
                None => new_name.clone(),
            };
            if list
                .iter()
                .any(|x| x.id != f.id && x.path.to_lowercase() == new_path.to_lowercase())
            {
                return Err(SetError::on(
                    "alreadyExists",
                    "a mailbox with this name exists",
                    &["name"],
                )
                .into());
            }
            let old_path = f.path.clone();
            self.pool
                .with_conn(|c| {
                    let (from, to) = (old_path.clone(), new_path.clone());
                    Box::pin(async move {
                        c.rename(&from, &to).await?;
                        let _ = c.subscribe(&to).await;
                        Ok(())
                    })
                })
                .await
                .map_err(imap_err)?;
            self.move_path(&f.path, &new_path, &f.delimiter);
        }
        self.invalidate();
        Ok(())
    }
}

/// `list.slice(start, end)` de JS pour des bornes positives (fractions tronquées).
fn slice<T>(list: &[T], start: f64, end: f64) -> &[T] {
    let len = list.len();
    let clamp = |x: f64| -> usize {
        if x.is_nan() || x <= 0.0 {
            0
        } else {
            (x.trunc() as usize).min(len)
        }
    };
    let (s, e) = (clamp(start), clamp(end));
    if e <= s { &[] } else { &list[s..e] }
}

/// Nombre JSON entier quand il l'est (comme JSON.stringify).
fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

fn has_flag(flags: &[String], flag: &str) -> bool {
    flags.iter().any(|f| f.eq_ignore_ascii_case(flag))
}

fn source_rank(r: &ListEntry) -> u8 {
    if r.special_use.is_some() { 1 } else { 3 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use voxel_core::kv::MemoryKv;
    use voxel_imap::session::{ImapAccount, MailboxStatus};

    fn entry(path: &str, parent: Option<&str>, special: Option<&str>) -> ListEntry {
        ListEntry {
            path: path.into(),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            delimiter: Some("/".into()),
            parent_path: parent.map(String::from),
            flags: Vec::new(),
            special_use: special.map(String::from),
            subscribed: true,
            status: Some(MailboxStatus {
                messages: 2,
                unseen: 1,
                uid_next: 5,
                uid_validity: 7,
                highest_modseq: None,
            }),
        }
    }

    fn folders() -> Folders {
        let pool = ImapPool::new(ImapAccount {
            host: "h".into(),
            port: 993,
            secure: true,
            username: "u".into(),
            password: "p".into(),
        });
        Folders::new(pool, Arc::new(MemoryKv::default()))
    }

    #[test]
    fn roles_parents_et_etats() {
        let f = folders();
        let list = f.build(vec![
            entry("INBOX", None, None),
            entry("INBOX/Envoyés", Some("INBOX"), None),
            entry("Sent", None, Some("\\Sent")),
            entry("Projets/Brouillons", Some("Projets"), None),
            entry("Corbeille", None, None),
        ]);
        let role = |p: &str| list.iter().find(|x| x.path == p).unwrap().role.clone();
        assert_eq!(role("INBOX").as_deref(), Some("inbox"));
        assert_eq!(role("Sent").as_deref(), Some("sent"));
        assert_eq!(role("INBOX/Envoyés"), None);
        assert_eq!(role("Projets/Brouillons"), None);
        assert_eq!(role("Corbeille").as_deref(), Some("trash"));
        let inbox = &list[0];
        assert_eq!(inbox.name, "Inbox");
        assert_eq!(list[1].parent_id.as_deref(), Some(inbox.id.as_str()));
        assert_eq!(list[3].parent_id, None);
        assert_eq!(f.id_for_path("Sent"), list[2].id);
        assert!(
            list.iter()
                .all(|x| x.id.len() == 6 && x.id.starts_with('m'))
        );
        assert_eq!(Folders::stamp(inbox), "7|5|2|1|");
        assert!(Folders::email_state_of(&list).starts_with('e'));
        let j = Folders::to_jmap(inbox, Some(&["role".to_string()]));
        assert_eq!(j, json!({ "id": inbox.id, "role": "inbox" }));
    }

    #[test]
    fn decoupe_comme_js() {
        let l = [1, 2, 3, 4];
        assert_eq!(slice(&l, 1.0, 3.0), &[2, 3]);
        assert_eq!(slice(&l, 2.0, 1.0), &[] as &[i32]);
        assert_eq!(slice(&l, 0.0, 99.0), &l);
    }
}
