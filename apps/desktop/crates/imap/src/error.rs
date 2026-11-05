//! Erreur unique de la crate : quatre familles que la façade traduit en erreurs de backend
//! (authentification, serveur injoignable, refus d'une commande, réponse illisible).
//! Les textes ne portent jamais l'identifiant ni le mot de passe : ils peuvent remonter au client.

use std::fmt;

/// Longueur gardée du `Debug` d'une erreur de lecture (assez pour diagnostiquer, sans recopier une réponse entière).
const PROTOCOL_TEXT_MAX: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub enum ImapError {
    /// Identifiants refusés par le serveur (IMAP ou SMTP).
    Auth(String),
    /// Serveur injoignable, TLS refusé, délai dépassé ou connexion tombée.
    Unavailable(String),
    /// Le serveur a répondu NO ou BAD à une commande.
    Command(String),
    /// Réponse que la session ne sait pas lire.
    Protocol(String),
}

impl fmt::Display for ImapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImapError::Auth(t)
            | ImapError::Unavailable(t)
            | ImapError::Command(t)
            | ImapError::Protocol(t) => f.write_str(t),
        }
    }
}

impl std::error::Error for ImapError {}

impl From<async_imap::error::Error> for ImapError {
    fn from(e: async_imap::error::Error) -> Self {
        use async_imap::error::Error;
        match e {
            Error::Io(_) | Error::ConnectionLost => {
                ImapError::Unavailable("IMAP connection lost".into())
            }
            Error::No(t) | Error::Bad(t) => ImapError::Command(t),
            other => ImapError::Protocol(short_debug(&other)),
        }
    }
}

/// `Debug` coupé à `PROTOCOL_TEXT_MAX` caractères.
pub(crate) fn short_debug(e: &impl fmt::Debug) -> String {
    let s = format!("{e:?}");
    if s.chars().count() > PROTOCOL_TEXT_MAX {
        s.chars().take(PROTOCOL_TEXT_MAX).collect()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversion_depuis_async_imap() {
        use async_imap::error::Error;
        assert_eq!(
            ImapError::from(Error::ConnectionLost),
            ImapError::Unavailable("IMAP connection lost".into())
        );
        assert_eq!(
            ImapError::from(Error::Io(std::io::Error::other("x"))),
            ImapError::Unavailable("IMAP connection lost".into())
        );
        assert_eq!(
            ImapError::from(Error::No("refus".into())),
            ImapError::Command("refus".into())
        );
        assert_eq!(
            ImapError::from(Error::Bad("mal".into())),
            ImapError::Command("mal".into())
        );
        assert!(matches!(
            ImapError::from(Error::Append),
            ImapError::Protocol(_)
        ));
        assert_eq!(
            ImapError::Auth("IMAP authentication failed".into()).to_string(),
            "IMAP authentication failed"
        );
    }
}
