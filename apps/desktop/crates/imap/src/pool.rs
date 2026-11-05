//! Pool de connexions IMAP d'une boîte (port de `pool.ts`) : connexions réutilisées, exclusives le temps
//! d'une opération, une connexion de réserve, fermeture des connexions inactives, refus d'authentification
//! mémorisé (pour ne pas se faire bannir) et plafond de connexions par compte, tous pools confondus.
//! Aucune tâche ne garde un verrou pendant une commande réseau.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Weak};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use tokio::sync::{Mutex, oneshot};

use crate::ImapError;
use crate::session::{ImapAccount, ImapSession};

/// Connexions simultanées par compte (hôte + identifiant), tous pools confondus : beaucoup de serveurs refusent
/// au-delà d'une quinzaine ; un pool ouvre au plus 3 connexions + 1 IDLE.
const ACCOUNT_LIMIT: usize = 30;
/// Attente maximale d'une place de compte.
const SLOT_WAIT: Duration = Duration::from_secs(30);
/// Connexions au plus par pool.
const MAX_CONNECTIONS: usize = 3;
/// Inactivité au-delà de laquelle une connexion libre est fermée.
const IDLE_TIMEOUT: Duration = Duration::from_secs(3 * 60);
/// Période du nettoyage des connexions inactives.
const REAP_EVERY: Duration = Duration::from_secs(30);
/// Durée pendant laquelle un refus d'authentification est rendu sans nouvelle tentative.
const AUTH_FAILURE_MEMORY: Duration = Duration::from_secs(60);
/// Délais d'ouverture et d'accueil (`connectionTimeout`/`greetingTimeout` d'imapflow).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Intervalle minimal entre deux NOOP sur une boîte déjà sélectionnée.
const NOOP_EVERY: Duration = Duration::from_secs(1);

struct AccountSlots {
    used: usize,
    waiters: VecDeque<oneshot::Sender<()>>,
}

/// Places de connexion par compte (`accountKey` → places), partagées par tous les pools du processus.
static ACCOUNT_SLOTS: LazyLock<std::sync::Mutex<HashMap<String, AccountSlots>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn account_key(host: &str, username: &str) -> String {
    format!("{}|{}", host.to_lowercase(), username.to_lowercase())
}

/// Place de compte tenue par une connexion ; rendue (ou transmise à l'attente suivante) à sa destruction.
pub(crate) struct AccountSlot {
    key: String,
}

impl Drop for AccountSlot {
    fn drop(&mut self) {
        let mut map = ACCOUNT_SLOTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(slots) = map.get_mut(&self.key) else {
            return;
        };
        // la place est transmise directement : pas de dépassement par une ouverture concurrente
        while let Some(next) = slots.waiters.pop_front() {
            if next.send(()).is_ok() {
                return;
            }
        }
        slots.used = slots.used.saturating_sub(1);
        if slots.used == 0 {
            map.remove(&self.key);
        }
    }
}

/// Réserve une place de connexion pour le compte (attend au plus 30 s).
async fn take_account_slot(host: &str, username: &str) -> Result<AccountSlot, ImapError> {
    let key = account_key(host, username);
    let rx = {
        let mut map = ACCOUNT_SLOTS.lock().unwrap_or_else(|e| e.into_inner());
        let slots = map.entry(key.clone()).or_insert_with(|| AccountSlots {
            used: 0,
            waiters: VecDeque::new(),
        });
        if slots.used < ACCOUNT_LIMIT {
            slots.used += 1;
            return Ok(AccountSlot { key });
        }
        let (tx, rx) = oneshot::channel();
        slots.waiters.push_back(tx);
        rx
    };
    match tokio::time::timeout(SLOT_WAIT, rx).await {
        Ok(Ok(())) => Ok(AccountSlot { key }),
        _ => Err(ImapError::Unavailable(format!(
            "too many IMAP connections for this account (limit {ACCOUNT_LIMIT})"
        ))),
    }
}

struct Pooled {
    session: ImapSession,
    last_used: Instant,
}

type Waiter = oneshot::Sender<Result<Lease, ImapError>>;

/// Bail d'une connexion prêtée (C15) : il tient la place comptée dans `busy` jusqu'à la remise.
/// Abandonné sans remise (futur annulé pendant `prepare`, `f`, l'attente du verrou ou l'échange
/// `oneshot`), il rend la place, jette la session et relance `grow` pour ceux qui attendent.
struct Lease {
    pool: Weak<ImapPool>,
    conn: Option<Pooled>,
}

impl Lease {
    fn session(&mut self) -> &mut ImapSession {
        &mut self.conn.as_mut().expect("bail déjà rendu").session
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else { return };
        let Some(pool) = self.pool.upgrade() else {
            return;
        };
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        // la session non rendue est jetée tout de suite (sa place de compte avec elle)
        drop(conn);
        rt.spawn(async move {
            let mut st = pool.state.lock().await;
            st.busy -= 1;
            if !st.closed && !st.waiters.is_empty() {
                pool.grow(&mut st);
            }
        });
    }
}

#[derive(Default)]
struct State {
    idle: Vec<Pooled>,
    busy: usize,
    connecting: usize,
    waiters: VecDeque<Waiter>,
    auth_failed_at: Option<(Instant, ImapError)>,
    closed: bool,
    reaping: bool,
}

pub struct ImapPool {
    account: ImapAccount,
    me: Weak<ImapPool>,
    state: Mutex<State>,
    caps: std::sync::Mutex<BTreeSet<String>>,
}

impl ImapPool {
    pub fn new(account: ImapAccount) -> Arc<Self> {
        Arc::new_cyclic(|me| ImapPool {
            account,
            me: me.clone(),
            state: Mutex::new(State::default()),
            caps: std::sync::Mutex::new(BTreeSet::new()),
        })
    }

    /// Capacités du serveur (vides avant la première connexion).
    pub fn capabilities(&self) -> BTreeSet<String> {
        self.caps.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Ouvre une nouvelle connexion authentifiée, hors pool (vérification, IDLE), avec sa place de compte.
    pub async fn open(&self) -> Result<ImapSession, ImapError> {
        {
            let mut st = self.state.lock().await;
            if st.closed {
                return Err(ImapError::Unavailable("backend closed".into()));
            }
            if let Some((at, _)) = &st.auth_failed_at {
                if at.elapsed() < AUTH_FAILURE_MEMORY {
                    return Err(ImapError::Auth(
                        "IMAP authentication failed (cached)".into(),
                    ));
                }
                st.auth_failed_at = None;
            }
        }
        let slot = take_account_slot(&self.account.host, &self.account.username).await?;
        match ImapSession::open(&self.account, CONNECT_TIMEOUT, CONNECT_TIMEOUT).await {
            Ok(mut s) => {
                s.slot = Some(slot);
                self.state.lock().await.auth_failed_at = None;
                *self.caps.lock().unwrap_or_else(|e| e.into_inner()) = s.capabilities().clone();
                Ok(s)
            }
            Err(e) => {
                drop(slot);
                if matches!(e, ImapError::Auth(_)) {
                    self.state.lock().await.auth_failed_at = Some((Instant::now(), e.clone()));
                }
                Err(e)
            }
        }
    }

    /// Ouvre une connexion en arrière-plan ; elle sert la première attente (ou reste libre).
    fn grow(&self, st: &mut State) {
        if st.closed || st.idle.len() + st.busy + st.connecting >= MAX_CONNECTIONS {
            return;
        }
        let Some(pool) = self.me.upgrade() else {
            return;
        };
        st.connecting += 1;
        tokio::spawn(async move {
            let opened = pool.open().await;
            let mut st = pool.state.lock().await;
            st.connecting -= 1;
            match opened {
                Ok(session) => {
                    if st.closed {
                        drop(st);
                        session.logout().await;
                        return;
                    }
                    st.busy += 1;
                    pool.start_reaper(&mut st);
                    pool.release_locked(
                        &mut st,
                        Pooled {
                            session,
                            last_used: Instant::now(),
                        },
                    );
                    // une connexion de réserve évite d'attendre une ouverture lors des opérations parallèles
                    if st.idle.len() + st.busy < 2 {
                        pool.grow(&mut st);
                    }
                }
                Err(e) => {
                    if st.idle.len() + st.busy == 0 && st.connecting == 0 {
                        for w in st.waiters.drain(..) {
                            let _ = w.send(Err(e.clone()));
                        }
                    }
                }
            }
        });
    }

    fn start_reaper(&self, st: &mut State) {
        if st.reaping {
            return;
        }
        st.reaping = true;
        let me = self.me.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(REAP_EVERY).await;
                let Some(pool) = me.upgrade() else { return };
                let expired: Vec<Pooled> = {
                    let mut st = pool.state.lock().await;
                    let (old, keep): (Vec<Pooled>, Vec<Pooled>) = st
                        .idle
                        .drain(..)
                        .partition(|c| c.last_used.elapsed() > IDLE_TIMEOUT);
                    st.idle = keep;
                    if st.idle.is_empty() && st.busy == 0 {
                        st.reaping = false;
                        drop(st);
                        for c in old {
                            c.session.logout().await;
                        }
                        return;
                    }
                    old
                };
                for c in expired {
                    c.session.logout().await;
                }
            }
        });
    }

    fn lease(&self, c: Pooled) -> Lease {
        Lease {
            pool: self.me.clone(),
            conn: Some(c),
        }
    }

    async fn acquire(&self) -> Result<Lease, ImapError> {
        let rx = {
            let mut st = self.state.lock().await;
            if st.closed {
                return Err(ImapError::Unavailable("backend closed".into()));
            }
            st.idle.retain(|c| c.session.is_usable());
            if let Some(free) = st.idle.pop() {
                st.busy += 1;
                return Ok(self.lease(free));
            }
            let (tx, rx) = oneshot::channel();
            st.waiters.push_back(tx);
            self.grow(&mut st);
            rx
        };
        rx.await
            .unwrap_or_else(|_| Err(ImapError::Unavailable("backend closed".into())))
    }

    /// Rend une connexion prêtée : à la première attente, sinon libre ; tombée, elle est jetée.
    fn release_locked(&self, st: &mut State, mut c: Pooled) {
        c.last_used = Instant::now();
        if st.closed || !c.session.is_usable() {
            st.busy -= 1;
            if !st.closed && !st.waiters.is_empty() {
                self.grow(st);
            }
            if c.session.is_usable() {
                tokio::spawn(c.session.logout());
            }
            return;
        }
        while let Some(w) = st.waiters.pop_front() {
            match w.send(Ok(self.lease(c))) {
                Ok(()) => return,
                // attente abandonnée : la connexion revient, sans passer par le `Drop` du bail
                Err(back) => match back.ok().and_then(|mut l| l.conn.take()) {
                    Some(p) => c = p,
                    None => return,
                },
            }
        }
        st.busy -= 1;
        st.idle.push(c);
    }

    /// Remise du bail ; la connexion ne quitte le bail qu'une fois le verrou pris.
    async fn release(&self, mut lease: Lease) {
        let mut st = self.state.lock().await;
        if let Some(c) = lease.conn.take() {
            self.release_locked(&mut st, c);
        }
    }

    async fn run<T, F>(&self, mailbox: Option<(&str, bool)>, mut f: F) -> Result<T, ImapError>
    where
        F: for<'a> FnMut(&'a mut ImapSession) -> BoxFuture<'a, Result<T, ImapError>> + Send,
        T: Send,
    {
        let mut attempt = 0;
        loop {
            let mut c = self.acquire().await?;
            let before = c.session().responses();
            let r = match mailbox {
                None => f(c.session()).await,
                Some((path, read_only)) => match prepare(c.session(), path, read_only).await {
                    Ok(()) => f(c.session()).await,
                    Err(e) => Err(e),
                },
            };
            match r {
                Ok(v) => {
                    self.release(c).await;
                    return Ok(v);
                }
                Err(e) => {
                    let conn = matches!(e, ImapError::Unavailable(_)) || !c.session().is_usable();
                    if conn {
                        c.session().mark_unusable();
                    }
                    let untouched = c.session().responses() == before;
                    self.release(c).await;
                    // une connexion tombée avant toute réponse est rouverte une fois
                    if conn && untouched && attempt == 0 {
                        attempt += 1;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    }

    /// Exécute `f` avec une connexion exclusive.
    pub async fn with_conn<T, F>(&self, f: F) -> Result<T, ImapError>
    where
        F: for<'a> FnMut(&'a mut ImapSession) -> BoxFuture<'a, Result<T, ImapError>> + Send,
        T: Send,
    {
        self.run(None, f).await
    }

    /// Exécute `f` avec une connexion exclusive où `path` est sélectionné (et synchronisé).
    pub async fn with_mailbox<T, F>(
        &self,
        path: &str,
        read_only: bool,
        f: F,
    ) -> Result<T, ImapError>
    where
        F: for<'a> FnMut(&'a mut ImapSession) -> BoxFuture<'a, Result<T, ImapError>> + Send,
        T: Send,
    {
        self.run(Some((path, read_only)), f).await
    }

    pub async fn close(&self) {
        let all = {
            let mut st = self.state.lock().await;
            st.closed = true;
            for w in st.waiters.drain(..) {
                let _ = w.send(Err(ImapError::Unavailable("backend closed".into())));
            }
            std::mem::take(&mut st.idle)
        };
        for c in all {
            c.session.logout().await;
        }
    }
}

/// Sélectionne `path` si besoin ; déjà sélectionné, un NOOP (au plus une fois par seconde et par connexion)
/// met à jour la vue, que le serveur ne synchronise pas pendant FETCH/STORE/SEARCH.
async fn prepare(s: &mut ImapSession, path: &str, read_only: bool) -> Result<(), ImapError> {
    let was_selected = s
        .selected()
        .is_some_and(|m| m.path == path && m.read_only == read_only);
    if !was_selected {
        s.select(path, read_only).await?;
    } else {
        let fresh = s
            .synced
            .as_ref()
            .is_some_and(|(p, at)| p == path && at.elapsed() <= NOOP_EVERY);
        if !fresh {
            s.noop().await?;
        }
    }
    s.synced = Some((path.to_string(), Instant::now()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn places_de_compte_transmises() {
        let host = "slots.test";
        let mut held = Vec::new();
        for _ in 0..ACCOUNT_LIMIT {
            held.push(take_account_slot(host, "U").await.unwrap());
        }
        let waiting =
            tokio::spawn(async move { take_account_slot("SLOTS.test", "u").await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());
        drop(held.pop());
        assert_eq!(waiting.await.unwrap(), Ok(()));
        let used = ACCOUNT_SLOTS
            .lock()
            .unwrap()
            .get(&account_key(host, "u"))
            .map(|s| s.used);
        assert_eq!(used, Some(ACCOUNT_LIMIT - 1));
        held.clear();
        assert!(
            ACCOUNT_SLOTS
                .lock()
                .unwrap()
                .get(&account_key(host, "u"))
                .is_none()
        );
    }

    #[tokio::test]
    async fn ferme_puis_refuse() {
        let pool = ImapPool::new(ImapAccount {
            host: "127.0.0.1".into(),
            port: 1,
            secure: true,
            username: "u".into(),
            password: "p".into(),
        });
        assert!(pool.capabilities().is_empty());
        pool.close().await;
        let e = pool
            .with_conn(|s| Box::pin(async move { Ok(s.is_usable()) }))
            .await
            .unwrap_err();
        assert_eq!(e, ImapError::Unavailable("backend closed".into()));
        assert_eq!(
            pool.open().await.err().unwrap(),
            ImapError::Unavailable("backend closed".into())
        );
    }

    #[tokio::test]
    async fn serveur_injoignable() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let pool = ImapPool::new(ImapAccount {
            host: "127.0.0.1".into(),
            port,
            secure: true,
            username: "u".into(),
            password: "p".into(),
        });
        let e = pool
            .with_conn(|s| Box::pin(async move { Ok(s.is_usable()) }))
            .await
            .unwrap_err();
        assert!(matches!(e, ImapError::Unavailable(_)), "{e:?}");
    }
}
