//! Point d'entrée de la façade (port de `index.ts`) : session JMAP, boucle des appels d'une requête avec
//! références arrière, table d'appel des méthodes (Mail, Submission, Quota, et compagnons Sieve, CardDAV,
//! CalDAV), téléversements et téléchargements, push, vérification et fermeture.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use bytes::Bytes;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{
    CallContext, Companion, Companions, DownloadResult, MailAccount, MailBackend, UploadResult,
};
use voxel_core::error::{ApiError, BackendError, ErrorCode};
use voxel_core::jmap::{
    CreatedIds, FacadeError, Invocation, JmapRequest, JmapResponse, MethodError, Object,
    resolve_refs,
};
use voxel_core::kv::KvStore;
use voxel_core::util::hash_of;
use voxel_imap::ImapError;
use voxel_imap::pool::ImapPool;
use voxel_imap::session::ImapAccount;

use crate::blobs::BlobStore;
use crate::changelog::ChangeLog;
use crate::folders::Folders;
use crate::identities::Identities;
use crate::messages::Messages;
use crate::push::{ACCOUNT_ID, Push};
use crate::submissions::Submissions;

const CAP_CORE: &str = "urn:ietf:params:jmap:core";
const CAP_MAIL: &str = "urn:ietf:params:jmap:mail";
const CAP_SUBMISSION: &str = "urn:ietf:params:jmap:submission";
const CAP_QUOTA: &str = "urn:ietf:params:jmap:quota";
/// Seul quota exposé (ressource STORAGE de la racine d'INBOX).
const QUOTA_ID: &str = "q-storage";
/// Taille maximale d'un téléversement.
const MAX_UPLOAD: u64 = 50_000_000;
/// Délai anti-rafale d'une écriture locale avant le relevé du push.
const NOTIFY_DELAY: Duration = Duration::from_millis(150);
/// Attente maximale de la première connexion d'un `probe`.
const PROBE_WAIT: Duration = Duration::from_secs(5);

/// Erreur IMAP → erreur de la façade : authentification et serveur injoignable interrompent la requête,
/// un refus ou une réponse illisible devient `serverFail`.
pub(crate) fn imap_err(e: ImapError) -> FacadeError {
    match e {
        ImapError::Auth(m) => FacadeError::Backend(BackendError::Auth(m)),
        ImapError::Unavailable(m) => FacadeError::Backend(BackendError::Unavailable(m)),
        ImapError::Command(m) | ImapError::Protocol(m) => FacadeError::Fail(m),
    }
}

/// Erreur IMAP hors d'une méthode JMAP (vérification) : tout ce qui n'est pas un refus d'identifiants est
/// un serveur injoignable.
fn backend_err(e: ImapError) -> BackendError {
    match e {
        ImapError::Auth(m) => BackendError::Auth(m),
        other => BackendError::Unavailable(other.to_string()),
    }
}

/// Erreur d'une méthode hors JMAP (téléchargement) : les erreurs du compte passent, le reste est interne.
fn download_err(e: FacadeError) -> BackendError {
    match e {
        FacadeError::Backend(b) => b,
        _ => BackendError::Api(ApiError::new(500, ErrorCode::Internal, "internal error")),
    }
}

fn is_script_blob(id: &str) -> bool {
    id.len() == 41
        && id.starts_with('Z')
        && id[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn with_account(r: Object) -> Value {
    let mut out = Object::new();
    out.insert("accountId".into(), json!(ACCOUNT_ID));
    for (k, v) in r {
        out.insert(k, v);
    }
    Value::Object(out)
}

pub struct ImapBackend {
    account: MailAccount,
    pool: Arc<ImapPool>,
    folders: Arc<Folders>,
    messages: Arc<Messages>,
    identities: Identities,
    submissions: Submissions,
    blobs: Arc<BlobStore>,
    push: Arc<Push>,
    companions: Companions,
    /// QUOTA IMAP (RFC 9208) annoncé par le serveur : connu après la première connexion.
    quota_available: AtomicBool,
}

impl ImapBackend {
    pub fn new(
        account: MailAccount,
        kv: Arc<dyn KvStore>,
        blob_dir: PathBuf,
        companions: Companions,
    ) -> Arc<Self> {
        let pool = ImapPool::new(ImapAccount {
            host: account.imap.host.clone(),
            port: account.imap.port,
            secure: account.imap.secure,
            username: account.username.clone(),
            password: account.password.clone(),
        });
        let folders = Arc::new(Folders::new(pool.clone(), kv.clone()));
        let blobs = Arc::new(BlobStore::new(blob_dir, &account.email, MAX_UPLOAD));
        let push_slot: Arc<OnceLock<Weak<Push>>> = Arc::new(OnceLock::new());
        let slot = push_slot.clone();
        let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(push) = slot.get().and_then(Weak::upgrade) {
                push.notify(NOTIFY_DELAY);
            }
        });
        let messages = Arc::new(Messages::new(
            pool.clone(),
            folders.clone(),
            kv.clone(),
            blobs.clone(),
            on_change,
        ));
        // Journal en mémoire des créations / suppressions / changements de mots-clés (Email/changes).
        let changelog = ChangeLog::new(pool.clone());
        let observer = changelog.clone();
        folders.set_observer(Arc::new(move |list| observer.observe(list)));
        messages.set_changelog(changelog.clone());
        let push = Push::new(pool.clone(), folders.clone(), messages.clone(), changelog);
        let _ = push_slot.set(Arc::downgrade(&push));
        Arc::new(ImapBackend {
            identities: Identities::new(kv, &account.email),
            submissions: Submissions::new(&account),
            account,
            pool,
            folders,
            messages,
            blobs,
            push,
            companions,
            quota_available: AtomicBool::new(false),
        })
    }

    fn companion(
        &self,
        which: Option<&Arc<dyn Companion>>,
        label: &str,
    ) -> Result<Arc<dyn Companion>, FacadeError> {
        match which {
            Some(c) if c.available() => Ok(c.clone()),
            _ => Err(MethodError::described(
                "unknownMethod",
                format!("{label} is not available for this mailbox"),
            )
            .into()),
        }
    }

    fn session_json(&self) -> Value {
        let quota = self.quota_available.load(Ordering::SeqCst);
        let caps: Vec<Option<voxel_core::backend::CompanionCaps>> = [
            &self.companions.sieve,
            &self.companions.contacts,
            &self.companions.calendars,
        ]
        .iter()
        .map(|c| c.as_ref().and_then(|c| c.capabilities()))
        .collect();
        let mut capabilities = Object::new();
        capabilities.insert(
            CAP_CORE.into(),
            json!({
                "maxSizeUpload": MAX_UPLOAD,
                "maxConcurrentUpload": 4,
                "maxSizeRequest": 10_000_000,
                "maxConcurrentRequests": 4,
                "maxCallsInRequest": 32,
                "maxObjectsInGet": 500,
                "maxObjectsInSet": 500,
                "collationAlgorithms": ["i;ascii-casemap", "i;unicode-casemap"],
            }),
        );
        capabilities.insert(CAP_MAIL.into(), json!({}));
        capabilities.insert(CAP_SUBMISSION.into(), json!({}));
        let mut account_caps = Object::new();
        account_caps.insert(
            CAP_MAIL.into(),
            json!({
                "maxMailboxesPerEmail": null,
                "maxMailboxDepth": 10,
                "maxSizeMailboxName": 200,
                "maxSizeAttachmentsPerEmail": 25_000_000,
                "emailQuerySortOptions": ["receivedAt"],
                "mayCreateTopLevelMailbox": true,
            }),
        );
        account_caps.insert(
            CAP_SUBMISSION.into(),
            json!({ "maxDelayedSend": 0, "submissionExtensions": {} }),
        );
        let mut primary = Object::new();
        primary.insert(CAP_MAIL.into(), json!(ACCOUNT_ID));
        primary.insert(CAP_SUBMISSION.into(), json!(ACCOUNT_ID));
        // ordre de Node : Sieve, puis quota, puis CardDAV et CalDAV
        let add = |c: &voxel_core::backend::CompanionCaps,
                   capabilities: &mut Object,
                   account_caps: &mut Object,
                   primary: &mut Object| {
            for (k, v) in &c.core {
                capabilities.insert(k.clone(), v.clone());
                primary.insert(k.clone(), json!(ACCOUNT_ID));
            }
            for (k, v) in &c.account {
                account_caps.insert(k.clone(), v.clone());
            }
        };
        if let Some(c) = &caps[0] {
            add(c, &mut capabilities, &mut account_caps, &mut primary);
        }
        if quota {
            capabilities.insert(CAP_QUOTA.into(), json!({}));
            account_caps.insert(CAP_QUOTA.into(), json!({}));
            primary.insert(CAP_QUOTA.into(), json!(ACCOUNT_ID));
        }
        for c in caps[1..].iter().flatten() {
            add(c, &mut capabilities, &mut account_caps, &mut primary);
        }
        json!({
            "capabilities": capabilities,
            "accounts": {
                ACCOUNT_ID: {
                    "name": self.account.email,
                    "isPersonal": true,
                    "isReadOnly": false,
                    "accountCapabilities": account_caps,
                },
            },
            "primaryAccounts": primary,
            "username": self.account.email,
            "apiUrl": "/imap/api",
            "downloadUrl": "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
            "uploadUrl": "/jmap/upload/{accountId}/",
            "eventSourceUrl": "/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
            "state": self.session_state(),
        })
    }

    fn session_state(&self) -> String {
        format!(
            "j{}",
            hash_of(&format!("{}|imap|1", self.account.email), 10)
        )
    }

    async fn run_api(&self, req: JmapRequest) -> Result<JmapResponse, BackendError> {
        let mut responses: Vec<Invocation> = Vec::new();
        let mut created = CreatedIds(req.created_ids.clone().unwrap_or_default());
        for Invocation(name, raw_args, call_id) in &req.method_calls {
            let empty = Object::new();
            let raw = raw_args.as_object().unwrap_or(&empty);
            let result: Result<Vec<(String, Value)>, FacadeError> = async {
                let args = resolve_refs(raw, &responses)?;
                if let Some(a) = args.get("accountId")
                    && a.as_str() != Some(ACCOUNT_ID)
                    && name != "Core/echo"
                {
                    return Err(MethodError::new("accountNotFound").into());
                }
                self.call(name, args, &mut created).await
            }
            .await;
            match result {
                Ok(out) => {
                    for (n, body) in out {
                        responses.push(Invocation(n, body, call_id.clone()));
                    }
                }
                Err(FacadeError::Backend(
                    e @ (BackendError::Auth(_) | BackendError::Unavailable(_)),
                )) => {
                    return Err(e);
                }
                Err(e) => {
                    let body = match e {
                        FacadeError::Method(m) => m.to_json(),
                        FacadeError::Set(s) => {
                            json!({ "type": "serverFail", "description": s.description.unwrap_or(s.kind) })
                        }
                        FacadeError::Backend(b) => {
                            json!({ "type": "serverFail", "description": b.to_string() })
                        }
                        FacadeError::Fail(m) => json!({ "type": "serverFail", "description": m }),
                    };
                    responses.push(Invocation("error".into(), body, call_id.clone()));
                }
            }
        }
        Ok(JmapResponse {
            method_responses: responses,
            session_state: self.session_state(),
            created_ids: req.created_ids.as_ref().map(|_| created.0),
        })
    }

    async fn call(
        &self,
        name: &str,
        args: Object,
        ctx: &mut CreatedIds,
    ) -> Result<Vec<(String, Value)>, FacadeError> {
        let one = |r: Object| Ok(vec![(name.to_string(), with_account(r))]);
        let cannot = || Err(MethodError::new("cannotCalculateChanges").into());
        match name {
            "Core/echo" => Ok(vec![(name.to_string(), Value::Object(args))]),
            "Mailbox/get" => one(self.folders.get(&args).await?),
            "Mailbox/query" => one(self.folders.query(&args).await?),
            "Mailbox/changes" => one(self.folders.changes(&args).await?),
            "Mailbox/set" => {
                let r = self.folders.set(&args, ctx).await?;
                let touched = ["created", "updated", "destroyed"]
                    .iter()
                    .any(|k| r.get(*k).is_some_and(|v| !v.is_null()));
                if touched {
                    self.messages.invalidate_queries();
                    self.push.notify(NOTIFY_DELAY);
                }
                one(r)
            }
            "Email/get" => one(self.messages.get(&args).await?),
            "Email/query" => one(self.messages.query(&args).await?),
            "Email/queryChanges" => one(self.messages.query_changes(&args).await?),
            "Email/changes" => one(self.messages.changes(&args).await?),
            "Email/set" => one(self.messages.set(&args, ctx).await?),
            "Email/import" => one(self.messages.import_emails(&args, ctx).await?),
            "Thread/get" => one(self.messages.threads(&args).await?),
            "Thread/changes" => one(self.messages.thread_changes(&args).await?),
            "SearchSnippet/get" => one(self.messages.snippets(&args).await?),
            "Identity/get" => one(self.identities.get(&args)?),
            "Identity/set" => one(self.identities.set(&args, ctx)?),
            "Identity/changes" => one(self.identities.changes(&args)?),
            "EmailSubmission/get" => one(self.submissions.get(&args)),
            "EmailSubmission/changes" => cannot(),
            "EmailSubmission/set" => {
                let r = self
                    .submissions
                    .set(&args, ctx, &self.messages, &self.identities)
                    .await?;
                let mut out = vec![(name.to_string(), with_account(r.response))];
                match r.email_set {
                    Some(email_set) => {
                        out.push((
                            "Email/set".into(),
                            with_account(self.messages.set(&email_set, ctx).await?),
                        ));
                    }
                    None => self.push.notify(NOTIFY_DELAY),
                }
                Ok(out)
            }
            "SieveScript/changes"
            | "ContactCard/queryChanges"
            | "CalendarEvent/queryChanges"
            | "Quota/changes" => cannot(),
            "SieveScript/get"
            | "SieveScript/query"
            | "SieveScript/validate"
            | "SieveScript/set" => {
                let c = self.companion(self.companions.sieve.as_ref(), "ManageSieve")?;
                one(self.companion_call(&c, name, args, ctx).await?)
            }
            "AddressBook/get"
            | "AddressBook/changes"
            | "ContactCard/get"
            | "ContactCard/query"
            | "ContactCard/changes"
            | "ContactCard/set"
            | "ContactCard/parse" => {
                let c = self.companion(self.companions.contacts.as_ref(), "CardDAV")?;
                one(self.companion_call(&c, name, args, ctx).await?)
            }
            "Calendar/get"
            | "Calendar/changes"
            | "CalendarEvent/get"
            | "CalendarEvent/query"
            | "CalendarEvent/changes"
            | "CalendarEvent/set"
            | "CalendarEvent/parse" => {
                let c = self.companion(self.companions.calendars.as_ref(), "CalDAV")?;
                one(self.companion_call(&c, name, args, ctx).await?)
            }
            "Quota/get" => one(self.quota_get(&args).await?),
            _ => Err(MethodError::described(
                "unknownMethod",
                format!("{name} is not supported for IMAP mailboxes"),
            )
            .into()),
        }
    }

    async fn companion_call(
        &self,
        c: &Arc<dyn Companion>,
        name: &str,
        args: Object,
        ctx: &mut CreatedIds,
    ) -> Result<Object, FacadeError> {
        c.call(
            name,
            args,
            CallContext {
                created: ctx,
                uploads: &*self.blobs,
            },
        )
        .await
    }

    /// QUOTA IMAP (RFC 9208) → `Quota/get` (RFC 9425) : `GETQUOTAROOT INBOX`, ressource STORAGE.
    async fn quota_get(&self, args: &Object) -> Result<Object, FacadeError> {
        if !self.quota_available.load(Ordering::SeqCst) {
            return Err(MethodError::described(
                "unknownMethod",
                "QUOTA is not available for this mailbox",
            )
            .into());
        }
        let storage = self
            .pool
            .with_conn(|c| Box::pin(async move { c.quota_root_storage("INBOX").await }))
            .await
            .map_err(imap_err)?;
        let list: Vec<(u64, u64, Value)> = match storage {
            Some((used, limit)) if limit > 0 => vec![(
                used,
                limit,
                json!({
                    "id": QUOTA_ID,
                    "resourceType": "octets",
                    "used": used,
                    "hardLimit": limit,
                    "scope": "account",
                    "name": self.account.email,
                    "types": ["Email"],
                    "warnLimit": null,
                    "softLimit": null,
                    "description": null,
                }),
            )],
            _ => Vec::new(),
        };
        let pairs: Vec<Value> = list.iter().map(|(u, l, _)| json!([u, l])).collect();
        let ids: Option<Vec<Value>> = args.get("ids").and_then(Value::as_array).cloned();
        let items: Vec<Value> = list.into_iter().map(|(_, _, v)| v).collect();
        let (shown, not_found): (Vec<Value>, Vec<Value>) = match &ids {
            Some(ids) => (
                items
                    .iter()
                    .filter(|x| ids.contains(&x["id"]))
                    .cloned()
                    .collect(),
                ids.iter()
                    .filter(|id| !items.iter().any(|x| x["id"] == **id))
                    .cloned()
                    .collect(),
            ),
            None => (items, Vec::new()),
        };
        let mut r = Object::new();
        r.insert(
            "state".into(),
            json!(format!(
                "q{}",
                hash_of(&Value::Array(pairs).to_string(), 12)
            )),
        );
        r.insert("list".into(), Value::Array(shown));
        r.insert("notFound".into(), Value::Array(not_found));
        Ok(r)
    }
}

impl MailBackend for ImapBackend {
    fn session(&self) -> BoxFuture<'_, Result<Value, BackendError>> {
        Box::pin(async move { Ok(self.session_json()) })
    }

    fn api(&self, request: JmapRequest) -> BoxFuture<'_, Result<JmapResponse, BackendError>> {
        Box::pin(self.run_api(request))
    }

    fn upload(
        &self,
        account_id: String,
        body: Bytes,
        content_type: String,
    ) -> BoxFuture<'_, Result<UploadResult, BackendError>> {
        Box::pin(async move {
            if account_id != ACCOUNT_ID {
                return Err(BackendError::BlobNotFound(account_id));
            }
            let (blob_id, size, t) = self
                .blobs
                .put(body, &content_type)
                .await
                .map_err(|_| BackendError::BlobTooLarge)?;
            Ok(UploadResult {
                account_id,
                blob_id,
                content_type: t,
                size,
            })
        })
    }

    fn download(
        &self,
        account_id: String,
        blob_id: String,
        content_type: Option<String>,
    ) -> BoxFuture<'_, Result<DownloadResult, BackendError>> {
        Box::pin(async move {
            if account_id != ACCOUNT_ID {
                return Err(BackendError::BlobNotFound(blob_id));
            }
            let wanted = content_type.filter(|t| !t.is_empty());
            if let Some(sieve) = &self.companions.sieve
                && is_script_blob(&blob_id)
            {
                let Some((body, t)) = sieve.blob(&blob_id).await else {
                    return Err(BackendError::BlobNotFound(blob_id));
                };
                return Ok(DownloadResult {
                    body,
                    content_type: wanted.unwrap_or(t),
                });
            }
            match self
                .messages
                .load_blob(&blob_id)
                .await
                .map_err(download_err)?
            {
                Some((body, t)) => Ok(DownloadResult {
                    body,
                    content_type: wanted.unwrap_or(t),
                }),
                None => Err(BackendError::BlobNotFound(blob_id)),
            }
        })
    }

    fn events(
        &self,
        types: Vec<String>,
    ) -> BoxFuture<'_, Result<tokio::sync::mpsc::Receiver<Value>, BackendError>> {
        Box::pin(async move { Ok(self.push.events(types).await) })
    }

    fn verify(&self) -> BoxFuture<'_, Result<(), BackendError>> {
        Box::pin(async move {
            let session = self.pool.open().await.map_err(backend_err)?;
            session.logout().await;
            self.submissions.verify().await
        })
    }

    fn probe(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let companions = [
                &self.companions.sieve,
                &self.companions.contacts,
                &self.companions.calendars,
            ];
            let probes = companions.into_iter().flatten().map(|c| c.probe());
            let imap = async {
                if self.pool.capabilities().is_empty() {
                    // aucune connexion encore ouverte : on en ouvre une (capacités IMAP), 5 s au plus
                    let _ = tokio::time::timeout(
                        PROBE_WAIT,
                        self.pool.with_conn(|_| Box::pin(async { Ok(()) })),
                    )
                    .await;
                }
                self.quota_available
                    .store(self.pool.capabilities().contains("QUOTA"), Ordering::SeqCst);
            };
            futures_util::join!(futures_util::future::join_all(probes), imap);
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.push.close();
            for c in [
                &self.companions.sieve,
                &self.companions.contacts,
                &self.companions.calendars,
            ]
            .into_iter()
            .flatten()
            {
                c.close();
            }
            self.pool.close().await;
        })
    }
}
