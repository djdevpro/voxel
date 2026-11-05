//! Veille IMAP IDLE sur INBOX (port de la partie IDLE de `push.ts`) : une connexion dédiée, hors pool mais
//! avec sa place de compte, signale chaque changement possible ; la façade vérifie alors ses états.
//! L'IDLE est relancé toutes les 4 minutes pour garder la connexion vivante ; après une erreur, nouvel
//! essai avec un délai doublé (2 s → 60 s).

use std::sync::Arc;
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use async_imap::imap_proto::{MailboxDatum, Response};
use tokio::sync::{Notify, mpsc};

use crate::pool::ImapPool;
use crate::session::ImapSession;

/// Durée d'une attente IDLE avant DONE puis nouvel IDLE.
const IDLE_RENEW: Duration = Duration::from_secs(4 * 60);
/// Premier délai avant un nouvel essai.
const RETRY_FIRST: Duration = Duration::from_secs(2);
/// Délai maximal entre deux essais.
const RETRY_MAX: Duration = Duration::from_secs(60);

pub struct IdleWatcher {
    stop: Arc<Notify>,
}

/// Fin d'une veille sur une connexion : arrêt demandé, serveur sans IDLE, ou erreur (nouvel essai).
enum Outcome {
    Stopped,
    NoIdle,
    Failed,
}

/// Données qui annoncent un changement de la boîte : EXISTS, EXPUNGE ou FETCH (drapeaux).
fn is_change(r: &Response<'_>) -> bool {
    matches!(
        r,
        Response::MailboxData(MailboxDatum::Exists(_))
            | Response::Expunge(_)
            | Response::Fetch(..)
            | Response::Vanished { .. }
    )
}

async fn watch(session: &mut ImapSession, changed: &mpsc::Sender<()>, stop: &Notify) -> Outcome {
    if !session.has("IDLE") {
        return Outcome::NoIdle;
    }
    if session.select("INBOX", false).await.is_err() {
        return Outcome::Failed;
    }
    loop {
        let Some(inner) = session.take_session() else {
            return Outcome::Failed;
        };
        let mut handle = inner.idle();
        if handle.init().await.is_err() {
            session.mark_unusable();
            return Outcome::Failed;
        }
        let (event, stopped) = {
            let (wait, _interrupt) = handle.wait_with_timeout(IDLE_RENEW);
            tokio::select! {
                r = wait => (Some(r), false),
                _ = stop.notified() => (None, true),
            }
        };
        let notify =
            matches!(&event, Some(Ok(IdleResponse::NewData(data))) if is_change(data.parsed()));
        let failed = matches!(event, Some(Err(_)));
        match handle.done().await {
            Ok(inner) => session.put_session(inner),
            Err(_) => {
                session.mark_unusable();
                return if stopped {
                    Outcome::Stopped
                } else {
                    Outcome::Failed
                };
            }
        }
        if stopped {
            return Outcome::Stopped;
        }
        if failed {
            return Outcome::Failed;
        }
        if notify && changed.try_send(()).is_err() && changed.is_closed() {
            return Outcome::Stopped;
        }
    }
}

impl IdleWatcher {
    /// Ouvre une connexion dédiée (hors pool, avec place de compte), sélectionne INBOX et y attend en IDLE ;
    /// chaque EXISTS, EXPUNGE ou FETCH (drapeaux) reçu envoie `()` sur `changed`.
    pub fn start(pool: Arc<ImapPool>, changed: tokio::sync::mpsc::Sender<()>) -> Self {
        let stop = Arc::new(Notify::new());
        let signal = stop.clone();
        tokio::spawn(async move {
            let mut delay = RETRY_FIRST;
            loop {
                let opened = tokio::select! {
                    r = pool.open() => r,
                    _ = signal.notified() => return,
                };
                if let Ok(mut session) = opened {
                    delay = RETRY_FIRST;
                    let outcome = watch(&mut session, &changed, &signal).await;
                    session.logout().await;
                    match outcome {
                        Outcome::Stopped | Outcome::NoIdle => return,
                        Outcome::Failed => {}
                    }
                }
                if changed.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = signal.notified() => return,
                }
                delay = (delay * 2).min(RETRY_MAX);
            }
        });
        IdleWatcher { stop }
    }

    /// Arrête la veille (DONE puis LOGOUT au mieux).
    pub fn stop(self) {
        self.stop.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changements_reconnus() {
        let parse = |raw: &'static [u8]| async_imap::imap_proto::Response::parse(raw).unwrap().1;
        assert!(is_change(&parse(b"* 3 EXISTS\r\n")));
        assert!(is_change(&parse(b"* 2 EXPUNGE\r\n")));
        assert!(is_change(&parse(b"* 1 FETCH (FLAGS (\\Seen))\r\n")));
        assert!(!is_change(&parse(b"* 1 RECENT\r\n")));
    }
}
