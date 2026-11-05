//! Fabrique des façades IMAP du bureau : la passerelle lui demande une façade par boîte, et elle y branche seulement les compagnons que la boîte demande (ManageSieve, CardDAV, CalDAV).

use std::path::PathBuf;
use std::sync::Arc;

use voxel_core::backend::{BackendFactory, Companions, MailAccount, MailBackend};
use voxel_core::kv::KvStore;
use voxel_core::net::{HttpClient, parse_dav_url};
use voxel_dav::{CalDavFacade, CardDavFacade, HttpDavTransport};
use voxel_mail::ImapBackend;
use voxel_sieve::SieveFacade;

pub(crate) struct DesktopFactory {
    blob_dir: PathBuf,
    http: HttpClient,
}

impl DesktopFactory {
    pub(crate) fn new(blob_dir: PathBuf, http: HttpClient) -> Self {
        Self { blob_dir, http }
    }
}

impl BackendFactory for DesktopFactory {
    fn create(&self, account: MailAccount, kv: Arc<dyn KvStore>) -> Arc<dyn MailBackend> {
        let mut companions = Companions::default();
        if let Some(endpoint) = account.sieve.clone() {
            companions.sieve = Some(SieveFacade::new(
                endpoint,
                account.username.clone(),
                account.password.clone(),
            ));
        }
        if let Some(url) = account.carddav.as_deref().and_then(parse_dav_url) {
            companions.contacts = Some(CardDavFacade::new(
                url,
                account.username.clone(),
                account.password.clone(),
                Arc::new(HttpDavTransport {
                    client: self.http.clone(),
                }),
            ));
        }
        if let Some(url) = account.caldav.as_deref().and_then(parse_dav_url) {
            companions.calendars = Some(CalDavFacade::new(
                url,
                account.username.clone(),
                account.password.clone(),
                Arc::new(HttpDavTransport {
                    client: self.http.clone(),
                }),
            ));
        }
        ImapBackend::new(account, kv, self.blob_dir.clone(), companions)
    }
}
