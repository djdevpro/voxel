//! Façade ManageSieve → JMAP for Sieve (RFC 9661) pour les boîtes IMAP. Port de `apps/server/src/sieve/facade.ts`.
//!
//! - `SieveScript/get|query|set|validate` ; `VacationResponse` n'est pas annoncé (répondeur par le script géré).
//! - Identifiants dérivés du nom (`s` + empreinte), blobs dérivés du contenu (`Z` + empreinte hexadécimale) :
//!   rien n'est écrit côté serveur ; un blob inconnu est retrouvé en relisant les scripts.
//! - État (`state`) : empreinte de la liste (noms, script actif, contenus).
//! - Connexion ManageSieve mutualisée (une par façade), fermée après une minute d'inactivité.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{CallContext, Companion, CompanionCaps, Endpoint};
use voxel_core::jmap::{FacadeError, MethodError, Object, SetError};
use voxel_core::util::{fold_text, hash_of, sha256_hex};

use crate::client::{ManageSieveClient, SieveCapabilities, SieveConnector, SieveError};

/// Capacité JMAP for Sieve.
const CAP_SIEVE: &str = "urn:ietf:params:jmap:sieve";

/// Inactivité au bout de laquelle la connexion est fermée.
const IDLE: Duration = Duration::from_secs(60);

/// Durée maximale de la vérification de `probe`.
const PROBE: Duration = Duration::from_secs(5);

/// Taille maximale d'un script téléversé.
const MAX_SCRIPT: usize = 1024 * 1024;

/// Nom du script géré par le répondeur, réservé.
const VACATION_NAME: &str = "vacation";

/// Nombre de contenus de scripts gardés en mémoire.
const BLOB_CACHE: usize = 64;

/// Type des blobs de scripts.
const SIEVE_TYPE: &str = "application/sieve";

#[derive(Clone)]
struct Listed {
    id: String,
    name: String,
    is_active: bool,
    blob_id: String,
    content: String,
}

fn script_id(name: &str) -> String {
    format!("s{}", hash_of(&format!("sieve:{name}"), 16))
}

fn blob_id_of(content: &str) -> String {
    format!("Z{}", &sha256_hex(content.as_bytes())[..40])
}

/// Comparaison des chaînes de JavaScript (unités UTF-16).
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn state_of(list: &[Listed]) -> String {
    let mut rows: Vec<(String, Value)> = list
        .iter()
        .map(|s| {
            (
                format!("{},{},{}", s.name, s.is_active, s.blob_id),
                json!([s.name, s.is_active, s.blob_id]),
            )
        })
        .collect();
    rows.sort_by(|a, b| js_cmp(&a.0, &b.0));
    let rows: Vec<Value> = rows.into_iter().map(|(_, v)| v).collect();
    let text = serde_json::to_string(&rows).unwrap_or_default();
    format!("v{}", hash_of(&text, 16))
}

/// Vérité au sens de JavaScript.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Échec interne d'une opération : erreur d'objet ou erreur du serveur ManageSieve.
enum Failure {
    Set(SetError),
    Sieve(SieveError),
}

impl From<SieveError> for Failure {
    fn from(e: SieveError) -> Self {
        Failure::Sieve(e)
    }
}

impl From<SetError> for Failure {
    fn from(e: SetError) -> Self {
        Failure::Set(e)
    }
}

fn fail(e: SieveError) -> FacadeError {
    FacadeError::Fail(e.to_string())
}

/// `toSetErr` : erreur d'objet, ou erreur de réponse du serveur traduite ; le reste fait échouer l'appel.
fn to_set_err(e: Failure) -> Result<Value, FacadeError> {
    match e {
        Failure::Set(e) => Ok(e.to_json()),
        Failure::Sieve(SieveError::Response { code, message, .. }) => {
            let code = code.map(|c| c.to_uppercase());
            let kind = match code.as_deref() {
                Some(c) if c.starts_with("QUOTA") => "overQuota",
                Some("ALREADYEXISTS") => "alreadyExists",
                _ => "invalidScript",
            };
            Ok(json!({ "type": kind, "description": message }))
        }
        Failure::Sieve(e) => Err(fail(e)),
    }
}

fn check_name(name: Option<&Value>) -> Result<String, SetError> {
    let invalid = || SetError::on("invalidProperties", "invalid name", &["name"]);
    let Some(Value::String(name)) = name else {
        return Err(invalid());
    };
    if name.trim().is_empty()
        || name.encode_utf16().count() > 512
        || name.contains(['\0', '\r', '\n'])
    {
        return Err(invalid());
    }
    if name == VACATION_NAME {
        return Err(SetError::on("forbidden", "reserved name", &["name"]));
    }
    Ok(name.clone())
}

#[derive(Default)]
struct State {
    client: Option<ManageSieveClient>,
    blobs: HashMap<String, String>,
    order: VecDeque<String>,
}

impl State {
    fn remember(&mut self, content: &str) -> String {
        let id = blob_id_of(content);
        if self.blobs.len() > BLOB_CACHE
            && let Some(oldest) = self.order.pop_front()
        {
            self.blobs.remove(&oldest);
        }
        if self.blobs.insert(id.clone(), content.to_string()).is_none() {
            self.order.push_back(id.clone());
        }
        id
    }
}

pub struct SieveFacade {
    me: Weak<SieveFacade>,
    connector: Arc<SieveConnector>,
    username: String,
    password: String,
    state: tokio::sync::Mutex<State>,
    idle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Résultat de la vérification de `probe` (`None` : pas encore vérifié).
    available: Mutex<Option<bool>>,
    caps: Mutex<Option<SieveCapabilities>>,
}

/// Port de `use` : connexion à la demande, une seule reconnexion si la connexion est tombée entre deux requêtes,
/// minuterie d'inactivité réarmée après chaque opération.
macro_rules! with_client {
    ($self:ident, $st:ident, |$c:ident| $body:expr) => {{
        $self.stop_idle();
        let mut attempt = 0;
        loop {
            if let Err(e) = $self.ensure($st).await {
                break Err(e);
            }
            let $c = $st.client.as_mut().expect("client connecté");
            let r = $body;
            let retry = attempt == 0
                && matches!(&r, Err(e) if !matches!(e, SieveError::Response { .. } | SieveError::Auth(_)))
                && !$c.connected();
            $self.arm_idle();
            if retry {
                attempt += 1;
                continue;
            }
            break r;
        }
    }};
}

impl SieveFacade {
    pub fn new(endpoint: Endpoint, username: String, password: String) -> Arc<Self> {
        Self::with_connector(crate::transport::connector(&endpoint), username, password)
    }

    pub fn with_connector(
        connector: SieveConnector,
        username: String,
        password: String,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| SieveFacade {
            me: me.clone(),
            connector: Arc::new(connector),
            username,
            password,
            state: tokio::sync::Mutex::new(State::default()),
            idle: Mutex::new(None),
            available: Mutex::new(None),
            caps: Mutex::new(None),
        })
    }

    /// `^Z[0-9a-f]{40}$`.
    pub fn is_script_blob(id: &str) -> bool {
        id.len() == 41
            && id.starts_with('Z')
            && id[1..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    fn new_connector(&self) -> SieveConnector {
        let shared = self.connector.clone();
        SieveConnector {
            connect: Box::new(move || (shared.connect)()),
            upgrade: self.connector.upgrade.clone(),
        }
    }

    fn stop_idle(&self) {
        if let Some(h) = self.idle.lock().unwrap_or_else(|p| p.into_inner()).take() {
            h.abort();
        }
    }

    fn arm_idle(&self) {
        let me = self.me.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(IDLE).await;
            if let Some(facade) = me.upgrade() {
                facade.shutdown().await;
            }
        });
        if let Some(old) = self
            .idle
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .replace(task)
        {
            old.abort();
        }
    }

    async fn ensure(&self, st: &mut State) -> Result<(), SieveError> {
        if st.client.as_ref().is_some_and(|c| c.connected()) {
            return Ok(());
        }
        let mut client = ManageSieveClient::new(
            self.new_connector(),
            self.username.clone(),
            self.password.clone(),
        );
        match client.connect().await {
            Ok(caps) => {
                *self.caps.lock().unwrap_or_else(|p| p.into_inner()) = Some(caps);
                st.client = Some(client);
                Ok(())
            }
            Err(e) => {
                client.destroy();
                st.client = None;
                Err(e)
            }
        }
    }

    /// Fermeture : la connexion est rendue par LOGOUT.
    async fn shutdown(&self) {
        self.stop_idle();
        let client = self.state.lock().await.client.take();
        if let Some(mut c) = client {
            c.logout().await;
        }
    }

    async fn list(&self, st: &mut State) -> Result<Vec<Listed>, SieveError> {
        let raw: Vec<(String, bool, String)> = with_client!(self, st, |c| {
            async {
                let scripts = c.list_scripts().await?;
                let mut out = Vec::new();
                for s in scripts {
                    let content = c.get_script(&s.name).await?;
                    out.push((s.name, s.active, content));
                }
                Ok::<_, SieveError>(out)
            }
            .await
        })?;
        Ok(raw
            .into_iter()
            .map(|(name, active, content)| Listed {
                id: script_id(&name),
                blob_id: st.remember(&content),
                name,
                is_active: active,
                content,
            })
            .collect())
    }

    /// Contenu d'un blob de script (cache, sinon relecture des scripts).
    async fn script_content(
        &self,
        st: &mut State,
        blob_id: &str,
    ) -> Result<Option<String>, SieveError> {
        if let Some(cached) = st.blobs.get(blob_id) {
            return Ok(Some(cached.clone()));
        }
        if !Self::is_script_blob(blob_id) {
            return Ok(None);
        }
        Ok(self
            .list(st)
            .await?
            .into_iter()
            .find(|s| s.blob_id == blob_id)
            .map(|s| s.content))
    }

    /// Texte d'un blob : script existant ou fichier téléversé.
    async fn blob_text(
        &self,
        st: &mut State,
        blob_id: Option<&Value>,
        ctx: &CallContext<'_>,
    ) -> Result<String, Failure> {
        let Some(Value::String(blob_id)) = blob_id else {
            return Err(SetError::on("invalidProperties", "blobId required", &["blobId"]).into());
        };
        if Self::is_script_blob(blob_id)
            && let Some(script) = self.script_content(st, blob_id).await?
        {
            return Ok(script);
        }
        let Some(up) = ctx.uploads.load(blob_id).await else {
            return Err(SetError::on(
                "blobNotFound",
                format!("blob {blob_id} not found"),
                &["blobId"],
            )
            .into());
        };
        if up.len() > MAX_SCRIPT {
            return Err(SetError::on("tooLarge", "script too large", &["blobId"]).into());
        }
        Ok(String::from_utf8_lossy(&up).into_owned())
    }

    // ---------------------------------------------------------------- méthodes JMAP

    async fn get(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut guard = self.state.lock().await;
        let st = &mut *guard;
        let list = self.list(st).await.map_err(fail)?;
        let ids: Option<Vec<String>> = args.get("ids").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        });
        let props: Option<Vec<String>> =
            args.get("properties").and_then(Value::as_array).map(|a| {
                let mut p = vec!["id".to_string()];
                p.extend(a.iter().filter_map(|v| v.as_str().map(str::to_string)));
                p
            });
        let pick = |s: &Listed| {
            let mut full = Object::new();
            full.insert("id".into(), json!(s.id));
            full.insert("name".into(), json!(s.name));
            full.insert("blobId".into(), json!(s.blob_id));
            full.insert("isActive".into(), json!(s.is_active));
            if let Some(props) = &props {
                full.retain(|k, _| props.contains(k));
            }
            Value::Object(full)
        };
        let found: Vec<Value> = list
            .iter()
            .filter(|s| ids.as_ref().is_none_or(|ids| ids.contains(&s.id)))
            .map(pick)
            .collect();
        let not_found: Vec<Value> = ids
            .as_ref()
            .map(|ids| {
                ids.iter()
                    .filter(|id| !list.iter().any(|s| &s.id == *id))
                    .map(|id| json!(id))
                    .collect()
            })
            .unwrap_or_default();
        let mut out = Object::new();
        out.insert("state".into(), json!(state_of(&list)));
        out.insert("list".into(), Value::Array(found));
        out.insert("notFound".into(), Value::Array(not_found));
        Ok(out)
    }

    async fn query(&self, args: &Object) -> Result<Object, FacadeError> {
        let mut guard = self.state.lock().await;
        let st = &mut *guard;
        let list = self.list(st).await.map_err(fail)?;
        let filter = args.get("filter").and_then(Value::as_object);
        let mut out: Vec<&Listed> = list.iter().collect();
        if let Some(name) = filter.and_then(|f| f.get("name")).and_then(Value::as_str) {
            let needle = name.to_lowercase();
            out.retain(|s| s.name.to_lowercase().contains(&needle));
        }
        if let Some(active) = filter
            .and_then(|f| f.get("isActive"))
            .and_then(Value::as_bool)
        {
            out.retain(|s| s.is_active == active);
        }
        out.sort_by(|a, b| {
            fold_text(&a.name)
                .cmp(&fold_text(&b.name))
                .then_with(|| a.name.cmp(&b.name))
        });
        let number = |key: &str| {
            args.get(key)
                .and_then(Value::as_f64)
                .map(|n| n.max(0.0) as usize)
        };
        let position = number("position").unwrap_or(0);
        let limit = number("limit").unwrap_or(out.len());
        let ids: Vec<Value> = out
            .iter()
            .skip(position)
            .take(limit)
            .map(|s| json!(s.id))
            .collect();
        let mut res = Object::new();
        res.insert("queryState".into(), json!(state_of(&list)));
        res.insert("canCalculateChanges".into(), json!(false));
        res.insert("position".into(), json!(position));
        res.insert("ids".into(), Value::Array(ids));
        res.insert("total".into(), json!(out.len()));
        Ok(res)
    }

    async fn validate(&self, args: &Object, ctx: &CallContext<'_>) -> Result<Object, FacadeError> {
        let mut guard = self.state.lock().await;
        let st = &mut *guard;
        let text = match self.blob_text(st, args.get("blobId"), ctx).await {
            Ok(t) => t,
            Err(Failure::Set(e)) => {
                let message = e.description.clone().unwrap_or(e.kind.clone());
                return Err(MethodError::described("invalidArguments", message).into());
            }
            Err(Failure::Sieve(e)) => return Err(fail(e)),
        };
        let err = with_client!(self, st, |c| c.check_script(&text).await).map_err(fail)?;
        let mut out = Object::new();
        out.insert(
            "error".into(),
            match err {
                None => Value::Null,
                Some(d) => json!({ "type": "invalidScript", "description": d }),
            },
        );
        Ok(out)
    }

    async fn set(&self, args: &Object, ctx: CallContext<'_>) -> Result<Object, FacadeError> {
        let mut guard = self.state.lock().await;
        let st = &mut *guard;
        let before = self.list(st).await.map_err(fail)?;
        if let Some(Value::String(s)) = args.get("ifInState")
            && *s != state_of(&before)
        {
            return Err(MethodError::new("stateMismatch").into());
        }
        let mut by_id: Vec<Listed> = before.clone();
        let mut created = Object::new();
        let mut not_created = Object::new();
        let mut updated = Object::new();
        let mut not_updated = Object::new();
        let mut destroyed: Vec<Value> = Vec::new();
        let mut not_destroyed = Object::new();
        let mut created_ids: Vec<(String, String)> = Vec::new();

        let empty = Object::new();
        let create = args
            .get("create")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        for (cid, raw) in create {
            let result: Result<(), Failure> = async {
                let Some(raw) = raw.as_object() else {
                    return Err(SetError::new("invalidProperties").into());
                };
                let name = check_name(raw.get("name"))?;
                if by_id.iter().any(|s| s.name == name) {
                    return Err(SetError::on(
                        "alreadyExists",
                        "a script with this name exists",
                        &["name"],
                    )
                    .into());
                }
                let text = self.blob_text(st, raw.get("blobId"), &ctx).await?;
                with_client!(self, st, |c| c.put_script(&name, &text).await)?;
                let id = script_id(&name);
                let blob_id = st.remember(&text);
                by_id.push(Listed {
                    id: id.clone(),
                    name,
                    is_active: false,
                    blob_id,
                    content: text.clone(),
                });
                created_ids.push((cid.clone(), id.clone()));
                ctx.created.record(cid, &id);
                created.insert(
                    cid.clone(),
                    json!({ "id": id, "blobId": blob_id_of(&text), "isActive": false }),
                );
                Ok(())
            }
            .await;
            if let Err(e) = result {
                not_created.insert(cid.clone(), to_set_err(e)?);
            }
        }

        let update = args
            .get("update")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        for (raw_id, patch) in update {
            let id = ctx.created.resolve(raw_id);
            let result: Result<(), Failure> = async {
                let Some(pos) = by_id.iter().position(|s| s.id == id) else {
                    return Err(SetError::new("notFound").into());
                };
                let Some(patch) = patch.as_object() else {
                    return Err(SetError::new("invalidPatch").into());
                };
                if by_id[pos].name == VACATION_NAME {
                    return Err(SetError::described("forbidden", "reserved script").into());
                }
                let cur_name = by_id[pos].name.clone();
                let mut new_blob = None;
                if patch.contains_key("blobId") {
                    let text = self.blob_text(st, patch.get("blobId"), &ctx).await?;
                    with_client!(self, st, |c| c.put_script(&cur_name, &text).await)?;
                    by_id[pos].blob_id = st.remember(&text);
                    by_id[pos].content = text;
                    new_blob = Some(by_id[pos].blob_id.clone());
                }
                let mut out: Option<Object> = None;
                if let Some(new_name) = patch.get("name")
                    && *new_name != Value::String(cur_name.clone())
                {
                    let name = check_name(Some(new_name))?;
                    with_client!(self, st, |c| c.rename_script(&cur_name, &name).await)?;
                    let nid = script_id(&name);
                    let mut moved = by_id.remove(pos);
                    moved.id = nid.clone();
                    moved.name = name;
                    by_id.push(moved);
                    let mut o = Object::new();
                    o.insert("id".into(), json!(nid));
                    out = Some(o);
                }
                let value = match new_blob {
                    Some(blob_id) => {
                        let mut o = out.unwrap_or_default();
                        o.insert("blobId".into(), json!(blob_id));
                        Value::Object(o)
                    }
                    None => out.map(Value::Object).unwrap_or(Value::Null),
                };
                updated.insert(id.clone(), value);
                Ok(())
            }
            .await;
            if let Err(e) = result {
                not_updated.insert(id.clone(), to_set_err(e)?);
            }
        }

        let no_destroy = Vec::new();
        let destroy = args
            .get("destroy")
            .and_then(Value::as_array)
            .unwrap_or(&no_destroy);
        for raw_id in destroy.iter().filter_map(Value::as_str) {
            let id = ctx.created.resolve(raw_id);
            let result: Result<(), Failure> = async {
                let Some(pos) = by_id.iter().position(|s| s.id == id) else {
                    return Err(SetError::new("notFound").into());
                };
                if by_id[pos].is_active {
                    return Err(SetError::described(
                        "scriptIsActive",
                        "an active script cannot be destroyed",
                    )
                    .into());
                }
                let name = by_id[pos].name.clone();
                with_client!(self, st, |c| c.delete_script(&name).await)?;
                by_id.remove(pos);
                destroyed.push(json!(id));
                Ok(())
            }
            .await;
            if let Err(e) = result {
                not_destroyed.insert(id.clone(), to_set_err(e)?);
            }
        }

        // activation après les écritures (RFC 9661 §2.2)
        let any_success = created.len() + updated.len() + destroyed.len() > 0
            || (!truthy(args.get("create"))
                && !truthy(args.get("update"))
                && !truthy(args.get("destroy")));
        if any_success {
            if let Some(Value::String(act)) = args.get("onSuccessActivateScript") {
                let id = match act.strip_prefix('#') {
                    Some(cid) => created_ids
                        .iter()
                        .find(|(c, _)| c == cid)
                        .map(|(_, sid)| sid.clone())
                        .unwrap_or_else(|| ctx.created.resolve(act)),
                    None => act.clone(),
                };
                if let Some(target) = by_id.iter().find(|s| s.id == id).cloned() {
                    with_client!(self, st, |c| c.set_active(&target.name).await).map_err(fail)?;
                    for s in by_id.iter_mut() {
                        let was = s.is_active;
                        s.is_active = s.id == target.id;
                        if was == s.is_active {
                            continue;
                        }
                        let cid = created_ids
                            .iter()
                            .find(|(_, sid)| *sid == s.id)
                            .map(|(c, _)| c);
                        let (table, key) = match cid {
                            Some(cid) => (&mut created, cid.clone()),
                            None => (&mut updated, s.id.clone()),
                        };
                        let mut entry = table
                            .get(&key)
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        entry.insert("isActive".into(), json!(s.is_active));
                        table.insert(key, Value::Object(entry));
                    }
                }
            } else if args.get("onSuccessDeactivateScript") == Some(&Value::Bool(true)) {
                with_client!(self, st, |c| c.set_active("").await).map_err(fail)?;
                for s in by_id.iter_mut() {
                    if s.is_active {
                        let mut entry = updated
                            .get(&s.id)
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        entry.insert("isActive".into(), json!(false));
                        updated.insert(s.id.clone(), Value::Object(entry));
                    }
                    s.is_active = false;
                }
            }
        }

        let or_null = |o: Object| {
            if o.is_empty() {
                Value::Null
            } else {
                Value::Object(o)
            }
        };
        let mut res = Object::new();
        res.insert("oldState".into(), json!(state_of(&before)));
        res.insert("newState".into(), json!(state_of(&by_id)));
        res.insert("created".into(), or_null(created));
        res.insert("updated".into(), or_null(updated));
        res.insert(
            "destroyed".into(),
            if destroyed.is_empty() {
                Value::Null
            } else {
                Value::Array(destroyed)
            },
        );
        res.insert("notCreated".into(), or_null(not_created));
        res.insert("notUpdated".into(), or_null(not_updated));
        res.insert("notDestroyed".into(), or_null(not_destroyed));
        Ok(res)
    }
}

impl Companion for SieveFacade {
    /// Vérification (connexion + authentification), 5 s au plus ; échec silencieux = capacité absente.
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
            let check = async {
                let mut guard = self.state.lock().await;
                let st = &mut *guard;
                with_client!(self, st, |c| {
                    let _ = c;
                    Ok::<(), SieveError>(())
                })
            };
            let ok = matches!(tokio::time::timeout(PROBE, check).await, Ok(Ok(())));
            *self.available.lock().unwrap_or_else(|p| p.into_inner()) = Some(ok);
            if !ok {
                self.close();
            }
        })
    }

    fn available(&self) -> bool {
        *self.available.lock().unwrap_or_else(|p| p.into_inner()) == Some(true)
    }

    fn capabilities(&self) -> Option<CompanionCaps> {
        if !self.available() {
            return None;
        }
        let caps = self
            .caps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()?;
        let mut extensions = caps.sieve.clone();
        extensions.sort();
        let mut core = Object::new();
        core.insert(CAP_SIEVE.into(), json!({}));
        let mut account = Object::new();
        account.insert(
            CAP_SIEVE.into(),
            json!({
                "maxSizeScriptName": 512,
                "maxSizeScript": caps.max_script_size,
                "maxNumberScripts": null,
                "maxNumberRedirects": caps.max_redirects,
                "sieveExtensions": extensions,
                "notificationMethods": null,
                "externalLists": null,
            }),
        );
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
                "SieveScript/get" => self.get(&args).await,
                "SieveScript/query" => self.query(&args).await,
                "SieveScript/validate" => self.validate(&args, &ctx).await,
                "SieveScript/set" => self.set(&args, ctx).await,
                _ => Err(MethodError::described(
                    "unknownMethod",
                    format!("{method} is not supported for IMAP mailboxes"),
                )
                .into()),
            }
        })
    }

    fn blob<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<(bytes::Bytes, String)>> {
        Box::pin(async move {
            let mut guard = self.state.lock().await;
            let content = self.script_content(&mut guard, blob_id).await.ok()??;
            Some((bytes::Bytes::from(content), SIEVE_TYPE.to_string()))
        })
    }

    fn close(&self) {
        self.stop_idle();
        let client = match self.state.try_lock() {
            Ok(mut st) => st.client.take(),
            Err(_) => {
                // opération en cours : la fermeture attend sa fin
                if let (Ok(rt), Some(me)) =
                    (tokio::runtime::Handle::try_current(), self.me.upgrade())
                {
                    rt.spawn(async move { me.shutdown().await });
                }
                return;
            }
        };
        let Some(mut client) = client else { return };
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move { client.logout().await });
            }
            Err(_) => client.destroy(),
        }
    }
}
