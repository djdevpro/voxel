//! Façade IMAP/SMTP → JMAP Mail : pour une boîte IMAP, chaque requête JMAP de l'interface est traduite ici en commandes IMAP et SMTP. Les compagnons (ManageSieve, CardDAV, CalDAV) lui sont donnés tout faits.

pub mod backend;
mod blobs;
mod changelog;
mod filter;
mod folders;
mod identities;
mod ids;
mod jmap_json;
mod messages;
mod push;
mod submissions;

pub use backend::ImapBackend;
pub use blobs::BlobTooLarge;
