//! Contrats entre la passerelle et les backends : un backend de messagerie parle JMAP (façade IMAP ou serveur JMAP),
//! les compagnons (Sieve, contacts, agendas) ajoutent leurs méthodes et leurs capacités à la session.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde::Serialize;

use crate::error::BackendError;
use crate::jmap::{CreatedIds, FacadeError, JmapRequest, JmapResponse, Object};
use crate::kv::KvStore;

/// Serveur joint par IMAP, SMTP ou ManageSieve.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// TLS implicite ; sinon STARTTLS.
    pub secure: bool,
}

impl Endpoint {
    /// `{host}:{port}:{ssl|starttls}`, forme des en-têtes `X-Voxel-*`.
    pub fn header_value(&self) -> String {
        format!(
            "{}:{}:{}",
            self.host,
            self.port,
            if self.secure { "ssl" } else { "starttls" }
        )
    }
}

#[derive(Debug, Clone)]
pub struct MailAccount {
    pub email: String,
    pub username: String,
    pub password: String,
    pub imap: Endpoint,
    pub smtp: Endpoint,
    pub sieve: Option<Endpoint>,
    pub carddav: Option<String>,
    pub caldav: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub account_id: String,
    pub blob_id: String,
    #[serde(rename = "type")]
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub body: bytes::Bytes,
    pub content_type: String,
}

pub trait MailBackend: Send + Sync {
    fn session(&self) -> BoxFuture<'_, Result<serde_json::Value, BackendError>>;
    fn api(&self, request: JmapRequest) -> BoxFuture<'_, Result<JmapResponse, BackendError>>;
    fn upload(
        &self,
        account_id: String,
        body: bytes::Bytes,
        content_type: String,
    ) -> BoxFuture<'_, Result<UploadResult, BackendError>>;
    fn download(
        &self,
        account_id: String,
        blob_id: String,
        content_type: Option<String>,
    ) -> BoxFuture<'_, Result<DownloadResult, BackendError>>;
    /// Objets StateChange tant que le récepteur vit ; le lâcher arrête l'abonnement.
    fn events(
        &self,
        types: Vec<String>,
    ) -> BoxFuture<'_, Result<tokio::sync::mpsc::Receiver<serde_json::Value>, BackendError>>;
    fn verify(&self) -> BoxFuture<'_, Result<(), BackendError>>;
    fn probe(&self) -> BoxFuture<'_, ()>;
    fn close(&self) -> BoxFuture<'_, ()>;
}

pub trait BackendFactory: Send + Sync {
    fn create(&self, account: MailAccount, kv: Arc<dyn KvStore>) -> Arc<dyn MailBackend>;
}

pub trait UploadSource: Send + Sync {
    fn load<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<bytes::Bytes>>;
}

pub struct CallContext<'a> {
    pub created: &'a mut CreatedIds,
    pub uploads: &'a dyn UploadSource,
}

/// Capacités d'un compagnon : URN → valeur.
#[derive(Debug, Clone, Default)]
pub struct CompanionCaps {
    pub core: Object,
    pub account: Object,
}

pub trait Companion: Send + Sync {
    fn probe(&self) -> BoxFuture<'_, ()>;
    fn available(&self) -> bool;
    /// `None` tant qu'indisponible.
    fn capabilities(&self) -> Option<CompanionCaps>;
    fn call<'a>(
        &'a self,
        method: &'a str,
        args: Object,
        ctx: CallContext<'a>,
    ) -> BoxFuture<'a, Result<Object, FacadeError>>;
    /// Contenu et type ; `None` si inconnu.
    fn blob<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<(bytes::Bytes, String)>>;
    fn close(&self);
}

#[derive(Clone, Default)]
pub struct Companions {
    pub sieve: Option<Arc<dyn Companion>>,
    pub contacts: Option<Arc<dyn Companion>>,
    pub calendars: Option<Arc<dyn Companion>>,
}
