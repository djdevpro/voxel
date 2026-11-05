//! Envoi SMTP avec lettre : vérification du compte et envoi d'une source déjà composée (port de
//! `submission.ts`). Toujours chiffré : TLS implicite ou STARTTLS obligatoire, jamais de clair.
//! Un transport par appel, comme côté Node : aucune connexion SMTP ne reste ouverte.

use std::net::Ipv4Addr;
use std::time::Duration;

use lettre::address::Envelope;
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use crate::ImapError;

/// Délai de chaque échange SMTP (`socketTimeout` de nodemailer).
const SMTP_TIMEOUT: Duration = Duration::from_secs(60);
/// Code SMTP d'un refus d'authentification.
const AUTH_FAILED: u16 = 535;

#[derive(Debug, Clone)]
pub struct SmtpAccount {
    pub host: String,
    pub port: u16,
    pub secure: bool,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SendError {
    /// Le serveur a refusé le message (ou un destinataire) ; `permanent` : code 5xx.
    Rejected { permanent: bool, message: String },
    /// Le compte ou le serveur est en cause : la méthode s'interrompt.
    Fatal(ImapError),
}

fn transport(account: &SmtpAccount) -> Result<AsyncSmtpTransport<Tokio1Executor>, ImapError> {
    let params = TlsParameters::new(account.host.clone())
        .map_err(|_| ImapError::Unavailable("SMTP server unreachable (tls)".into()))?;
    let tls = if account.secure {
        Tls::Wrapper(params)
    } else {
        Tls::Required(params)
    };
    Ok(
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(account.host.as_str())
            .port(account.port)
            .tls(tls)
            .credentials(Credentials::new(
                account.username.clone(),
                account.password.clone(),
            ))
            .hello_name(ClientId::Ipv4(Ipv4Addr::LOCALHOST))
            .timeout(Some(SMTP_TIMEOUT))
            .build(),
    )
}

fn code(e: &lettre::transport::smtp::Error) -> Option<u16> {
    e.status().map(u16::from)
}

fn is_auth_failure(e: &lettre::transport::smtp::Error) -> bool {
    code(e) == Some(AUTH_FAILED) || e.to_string().to_lowercase().contains("authentication")
}

fn kind(e: &lettre::transport::smtp::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else if e.is_tls() {
        "tls"
    } else {
        "connection"
    }
}

/// Traduit une erreur lettre en erreur de compte ou de serveur (`mapSmtpError`).
fn map_error(e: &lettre::transport::smtp::Error) -> ImapError {
    if is_auth_failure(e) {
        ImapError::Auth(format!("SMTP authentication failed ({AUTH_FAILED})"))
    } else {
        ImapError::Unavailable(format!("SMTP server unreachable ({})", kind(e)))
    }
}

/// Ouvre une session SMTP authentifiée puis la ferme.
pub async fn smtp_verify(account: &SmtpAccount) -> Result<(), ImapError> {
    let t = transport(account)?;
    match t.test_connection().await {
        Ok(true) => Ok(()),
        Ok(false) => Err(ImapError::Unavailable(
            "SMTP server unreachable (connection)".into(),
        )),
        Err(e) => Err(map_error(&e)),
    }
}

/// Envoie `raw` tel quel (la façade a déjà retiré le Bcc).
pub async fn smtp_send(
    account: &SmtpAccount,
    mail_from: &str,
    recipients: &[String],
    raw: &[u8],
) -> Result<(), SendError> {
    let bad_address = |what: &str| SendError::Rejected {
        permanent: true,
        message: format!("invalid {what} address"),
    };
    let from = mail_from.parse().map_err(|_| bad_address("sender"))?;
    let rcpts = recipients
        .iter()
        .map(|r| r.parse())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| bad_address("recipient"))?;
    let envelope = Envelope::new(Some(from), rcpts).map_err(|_| bad_address("recipient"))?;
    let t = transport(account).map_err(SendError::Fatal)?;
    match t.send_raw(&envelope, raw).await {
        Ok(_) => Ok(()),
        Err(e) if is_auth_failure(&e) => Err(SendError::Fatal(map_error(&e))),
        Err(e) if e.is_permanent() || e.is_transient() => Err(SendError::Rejected {
            permanent: code(&e).is_some_and(|c| c >= 500),
            message: e.to_string(),
        }),
        Err(e) => Err(SendError::Fatal(map_error(&e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serveur_injoignable() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let account = SmtpAccount {
            host: "127.0.0.1".into(),
            port,
            secure: true,
            username: "u".into(),
            password: "p".into(),
        };
        let e = smtp_verify(&account).await.unwrap_err();
        assert!(
            matches!(e, ImapError::Unavailable(ref t) if t.starts_with("SMTP server unreachable (")),
            "{e:?}"
        );
        let e = smtp_send(
            &account,
            "a@ex.fr",
            &["b@ex.fr".into()],
            b"Subject: x\r\n\r\ny",
        )
        .await
        .unwrap_err();
        assert!(
            matches!(e, SendError::Fatal(ImapError::Unavailable(_))),
            "{e:?}"
        );
        let e = smtp_send(&account, "pas une adresse", &[], b"")
            .await
            .unwrap_err();
        assert!(matches!(
            e,
            SendError::Rejected {
                permanent: true,
                ..
            }
        ));
    }
}
