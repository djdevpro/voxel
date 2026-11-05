//! Socle du cœur local de Voxel : ce que partagent la façade IMAP, les compagnons (Sieve, DAV), les routes /imap/* et la coque de bureau. Aucune dépendance à Tauri, pour tester sans fenêtre.

pub mod backend;
pub mod dns;
pub mod error;
pub mod http;
pub mod jmap;
pub mod kv;
pub mod log;
pub mod net;
pub mod util;
