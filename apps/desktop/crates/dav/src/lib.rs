//! WebDAV, CardDAV et CalDAV : un client léger et deux façades JMAP (Contacts, Calendars). vCard et iCalendar sont lus et écrits par calcard ; convert.rs ramène son JSON au dialecte de l'interface.

pub mod calendars;
pub mod client;
pub mod contacts;
mod convert;
mod patch;
mod recurrence;
mod xml;

pub use calendars::CalDavFacade;
pub use client::{DavTransport, HttpDavTransport};
pub use contacts::CardDavFacade;
