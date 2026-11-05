//! IMAP, MIME et SMTP pour la façade IMAP → JMAP de Voxel : connexions TLS, session async-imap complétée des extensions qui lui manquent, pool par compte, structure et décodage des messages, composition et envoi. Aucune notion JMAP ici : la façade (voxel-mail) s'en charge.

pub mod compose;
pub mod connect;
pub mod decode;
pub mod error;
pub mod headers;
pub mod idle;
pub mod names;
pub mod pool;
pub mod search;
pub mod session;
pub mod smtp;
pub mod structure;

pub use error::ImapError;
