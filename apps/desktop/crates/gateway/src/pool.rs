//! Pool des façades (port de `backend/pool.ts`) : une façade par empreinte des identifiants et des serveurs,
//! gardée tant qu'elle sert, fermée après 5 min d'inactivité sauf flux d'événements ouvert.
//! Plafond de 200 façades ; pas de plafond par adresse IP, il n'y a qu'un utilisateur sur le poste.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures_util::future::BoxFuture;
use voxel_core::backend::{BackendFactory, DownloadResult, MailBackend, UploadResult};
use voxel_core::error::{ApiError, BackendError, ErrorCode};
use voxel_core::jmap::{JmapRequest, JmapResponse};
use voxel_core::kv::mailbox_key;
use voxel_core::util::{now_ms, sha256_hex};

use crate::routes::KvProvider;
use crate::target::GatewayTarget;

/// Inactivité au-delà de laquelle une façade sans flux est fermée.
const IDLE_MS: i64 = 5 * 60 * 1000;

/// Nombre maximal de façades ouvertes.
const MAX_TOTAL: usize = 200;

/// Période du balayage des façades inactives.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Capacité du canal des événements relayés par l'enveloppe.
const EVENTS_CAPACITY: usize = 16;

struct Entry {
    backend: Arc<dyn MailBackend>,
    last_used: AtomicI64,
    active: AtomicUsize,
    /// Identifiants déjà vérifiés (LOGIN IMAP + AUTH SMTP).
    verified: AtomicBool,
}

impl Entry {
    fn touch(&self) -> &Arc<dyn MailBackend> {
        self.last_used.store(now_ms(), Ordering::Relaxed);
        &self.backend
    }
}

pub fn fingerprint(target: &GatewayTarget) -> String {
    let ep = |e: &voxel_core::backend::Endpoint| {
        format!(
            "{}:{}:{}",
            e.host.to_lowercase(),
            e.port,
            if e.secure { "ssl" } else { "starttls" }
        )
    };
    let key = serde_json::json!([
        ep(&target.imap),
        ep(&target.smtp),
        target.username,
        target.password,
        target.email.as_deref().unwrap_or(&target.username),
        target.sieve.as_ref().map(ep),
        target.carddav,
        target.caldav,
    ]);
    sha256_hex(key.to_string().as_bytes())
}

/// Enveloppe qui tient à jour la date de dernière utilisation et le nombre de flux actifs.
struct PooledBackend {
    entry: Arc<Entry>,
}

impl MailBackend for PooledBackend {
    fn session(&self) -> BoxFuture<'_, Result<serde_json::Value, BackendError>> {
        self.entry.touch().session()
    }

    fn api(&self, request: JmapRequest) -> BoxFuture<'_, Result<JmapResponse, BackendError>> {
        self.entry.touch().api(request)
    }

    fn upload(
        &self,
        account_id: String,
        body: bytes::Bytes,
        content_type: String,
    ) -> BoxFuture<'_, Result<UploadResult, BackendError>> {
        self.entry.touch().upload(account_id, body, content_type)
    }

    fn download(
        &self,
        account_id: String,
        blob_id: String,
        content_type: Option<String>,
    ) -> BoxFuture<'_, Result<DownloadResult, BackendError>> {
        self.entry
            .touch()
            .download(account_id, blob_id, content_type)
    }

    fn events(
        &self,
        types: Vec<String>,
    ) -> BoxFuture<'_, Result<tokio::sync::mpsc::Receiver<serde_json::Value>, BackendError>> {
        Box::pin(async move {
            let mut inner = self.entry.touch().events(types).await?;
            let entry = self.entry.clone();
            entry.active.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = tokio::sync::mpsc::channel(EVENTS_CAPACITY);
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        event = inner.recv() => {
                            let Some(event) = event else { break };
                            entry.last_used.store(now_ms(), Ordering::Relaxed);
                            if tx.send(event).await.is_err() {
                                break;
                            }
                        }
                        _ = tx.closed() => break,
                    }
                }
                // Le récepteur de la façade est lâché ici : désabonnement.
                drop(inner);
                entry.active.fetch_sub(1, Ordering::Relaxed);
                entry.last_used.store(now_ms(), Ordering::Relaxed);
            });
            Ok(rx)
        })
    }

    fn verify(&self) -> BoxFuture<'_, Result<(), BackendError>> {
        self.entry.touch().verify()
    }

    fn probe(&self) -> BoxFuture<'_, ()> {
        self.entry.touch().probe()
    }

    /// La fermeture est gérée par le pool.
    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

pub struct PoolHandle {
    pub backend: Arc<dyn MailBackend>,
    /// Identifiants déjà vérifiés pour cette empreinte.
    pub verified: bool,
    entry: Arc<Entry>,
    key: String,
    pool: Weak<BackendPool>,
}

impl PoolHandle {
    pub fn mark_verified(&self) {
        self.entry.verified.store(true, Ordering::Relaxed);
    }

    /// Retire et ferme la façade (identifiants refusés).
    pub fn discard(&self) {
        if let Some(pool) = self.pool.upgrade() {
            let mut entries = pool.entries.lock().expect("pool");
            if entries
                .get(&self.key)
                .is_some_and(|e| Arc::ptr_eq(e, &self.entry))
            {
                entries.remove(&self.key);
            }
        }
        close_later(self.entry.backend.clone());
    }
}

fn close_later(backend: Arc<dyn MailBackend>) {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move { backend.close().await });
    }
}

pub struct BackendPool {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    factory: Arc<dyn BackendFactory>,
    kv: KvProvider,
    sweeping: AtomicBool,
}

impl BackendPool {
    pub fn new(factory: Arc<dyn BackendFactory>, kv: KvProvider) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            factory,
            kv,
            sweeping: AtomicBool::new(false),
        })
    }

    /// Façade mutualisée pour ces identifiants.
    pub fn get(self: &Arc<Self>, target: &GatewayTarget) -> Result<PoolHandle, ApiError> {
        self.start_sweep();
        let key = fingerprint(target);
        let entry = {
            let mut entries = self.entries.lock().expect("pool");
            match entries.get(&key) {
                Some(entry) => entry.clone(),
                None => {
                    if entries.len() >= MAX_TOTAL {
                        return Err(ApiError::new(
                            429,
                            ErrorCode::RateLimited,
                            "gateway is full",
                        ));
                    }
                    let kv = (self.kv)(&mailbox_key(&target.username, &target.imap.host));
                    let entry = Arc::new(Entry {
                        backend: self.factory.create(target.account(), kv),
                        last_used: AtomicI64::new(now_ms()),
                        active: AtomicUsize::new(0),
                        verified: AtomicBool::new(false),
                    });
                    entries.insert(key.clone(), entry.clone());
                    entry
                }
            }
        };
        Ok(PoolHandle {
            backend: Arc::new(PooledBackend {
                entry: entry.clone(),
            }),
            verified: entry.verified.load(Ordering::Relaxed),
            entry,
            key,
            pool: Arc::downgrade(self),
        })
    }

    /// Balayage toutes les 60 s, lancé au premier `get` ; s'arrête avec le pool.
    fn start_sweep(self: &Arc<Self>) {
        if self.sweeping.swap(true, Ordering::Relaxed) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.sweeping.store(false, Ordering::Relaxed);
            return;
        };
        let pool = Arc::downgrade(self);
        handle.spawn(async move {
            let mut ticks = tokio::time::interval(SWEEP_EVERY);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let Some(pool) = pool.upgrade() else { break };
                pool.sweep();
            }
        });
    }

    fn sweep(&self) {
        let now = now_ms();
        let mut entries = self.entries.lock().expect("pool");
        entries.retain(|_, entry| {
            let idle = entry.active.load(Ordering::Relaxed) == 0
                && now - entry.last_used.load(Ordering::Relaxed) > IDLE_MS;
            if idle {
                close_later(entry.backend.clone());
            }
            !idle
        });
    }

    pub async fn close_all(&self) {
        let entries: Vec<Arc<Entry>> = self
            .entries
            .lock()
            .expect("pool")
            .drain()
            .map(|(_, e)| e)
            .collect();
        futures_util::future::join_all(entries.iter().map(|e| e.backend.close())).await;
    }
}
