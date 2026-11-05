//! ManageSieve (RFC 5804) et façade JMAP for Sieve (RFC 9661) : les filtres d'une boîte IMAP.

pub mod client;
pub mod facade;
mod transport;

pub use facade::SieveFacade;
