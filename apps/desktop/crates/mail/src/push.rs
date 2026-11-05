//! Push (port de `push.ts`) : veille IMAP IDLE sur INBOX (connexion dédiée, ouverte tant qu'un abonné existe)
//! et relevé périodique des dossiers ; émet des StateChange JMAP `{ changed: { a: { Email, Mailbox, Thread } } }`.
//! Les pings de la connexion SSE sont l'affaire de la passerelle.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{Notify, mpsc};
use voxel_imap::idle::IdleWatcher;
use voxel_imap::pool::ImapPool;

use crate::changelog::ChangeLog;
use crate::folders::Folders;
use crate::messages::Messages;

pub const ACCOUNT_ID: &str = "a";

/// Période du relevé des états quand quelqu'un écoute.
const POLL_EVERY: Duration = Duration::from_secs(45);
/// Événements en attente par abonné.
const SUBSCRIBER_CAPACITY: usize = 64;
/// Délai anti-rafale après un signal IDLE.
const IDLE_DELAY: Duration = Duration::from_millis(300);

struct Subscriber {
    types: Vec<String>,
    tx: mpsc::Sender<Value>,
}

/// Veille en cours : IDLE et sondage, arrêtés ensemble.
struct Running {
    watcher: IdleWatcher,
    /// réveille la boucle de sondage pour qu'elle s'arrête entre deux relevés
    stop: Arc<Notify>,
    halted: Arc<AtomicBool>,
}

/// Abonnés et veille sous un même verrou : décider de démarrer ou d'arrêter et le faire ne se séparent pas (C15).
#[derive(Default)]
struct State {
    subscribers: Vec<Subscriber>,
    running: Option<Running>,
}

impl State {
    fn stop(&mut self) {
        if let Some(r) = self.running.take() {
            r.halted.store(true, Ordering::SeqCst);
            r.stop.notify_one();
            r.watcher.stop();
        }
    }
}

pub struct Push {
    pool: Arc<ImapPool>,
    folders: Arc<Folders>,
    messages: Arc<Messages>,
    changelog: Arc<ChangeLog>,
    me: Weak<Push>,
    state: Mutex<State>,
    /// derniers états diffusés (Email, Thread, Mailbox)
    last: Mutex<Vec<(String, String)>>,
    generation: AtomicU64,
    stopped: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Push {
    pub fn new(
        pool: Arc<ImapPool>,
        folders: Arc<Folders>,
        messages: Arc<Messages>,
        changelog: Arc<ChangeLog>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Push {
            pool,
            folders,
            messages,
            changelog,
            me: me.clone(),
            state: Mutex::new(State::default()),
            last: Mutex::new(Vec::new()),
            generation: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
        })
    }

    /// Signale un changement possible (écriture locale, IDLE) : vérifie les états puis diffuse.
    pub fn notify(self: &Arc<Self>, delay: Duration) {
        if lock(&self.state).subscribers.is_empty() {
            self.folders.invalidate();
            return;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if me.generation.load(Ordering::SeqCst) == generation {
                me.check().await;
            }
        });
    }

    async fn check(&self) {
        self.folders.invalidate();
        let (email, mailbox) =
            futures_util::join!(self.folders.email_state(), self.folders.mailbox_state());
        // serveur momentanément indisponible : prochain relevé
        let (Ok(email), Ok(mailbox)) = (email, mailbox) else {
            return;
        };
        let next = vec![
            ("Email".to_string(), email.clone()),
            ("Thread".to_string(), email),
            ("Mailbox".to_string(), mailbox),
        ];
        let (changed, had_baseline) = {
            let mut last = lock(&self.last);
            let changed: Vec<(String, String)> = next
                .iter()
                .filter(|(k, v)| !last.iter().any(|(lk, lv)| lk == k && lv == v))
                .cloned()
                .collect();
            if changed.is_empty() {
                return;
            }
            let had_baseline = !last.is_empty();
            *last = next;
            (changed, had_baseline)
        };
        if changed.iter().any(|(k, _)| k == "Email") {
            self.messages.invalidate_queries();
        }
        if had_baseline {
            self.broadcast(&changed);
        }
    }

    fn broadcast(&self, changed: &[(String, String)]) {
        let mut st = lock(&self.state);
        st.subscribers.retain(|s| {
            let want = |t: &str| s.types.is_empty() || s.types.iter().any(|x| x == "*" || x == t);
            let filtered: Map<String, Value> = changed
                .iter()
                .filter(|(k, _)| want(k))
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect();
            if filtered.is_empty() {
                return !s.tx.is_closed();
            }
            let event = json!({ "@type": "StateChange", "changed": { ACCOUNT_ID: filtered } });
            !matches!(s.tx.try_send(event), Err(TrySendError::Closed(_)))
        });
        if st.subscribers.is_empty() {
            st.stop();
        }
    }

    /// Démarre IDLE et le sondage (verrou d'état tenu).
    fn start_locked(&self, st: &mut State) {
        if self.stopped.load(Ordering::SeqCst) || st.running.is_some() {
            return;
        }
        let (tx, mut rx) = mpsc::channel::<()>(16);
        let watcher = IdleWatcher::start(self.pool.clone(), tx);
        let me = self.me.clone();
        tokio::spawn(async move {
            while rx.recv().await.is_some() {
                let Some(push) = me.upgrade() else {
                    return;
                };
                push.notify(IDLE_DELAY);
            }
        });
        let stop = Arc::new(Notify::new());
        let halted = Arc::new(AtomicBool::new(false));
        let (me, stop_rx, halted_rx) = (self.me.clone(), stop.clone(), halted.clone());
        // jamais interrompue pendant un relevé : un relevé coupé laisserait une place du pool prise
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(POLL_EVERY);
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tick.tick() => {}
                    _ = stop_rx.notified() => return,
                }
                if halted_rx.load(Ordering::SeqCst) {
                    return;
                }
                let Some(push) = me.upgrade() else {
                    return;
                };
                {
                    let mut st = lock(&push.state);
                    if halted_rx.load(Ordering::SeqCst) {
                        return;
                    }
                    st.subscribers.retain(|s| !s.tx.is_closed());
                    if st.subscribers.is_empty() {
                        st.stop();
                        return;
                    }
                }
                push.check().await;
            }
        });
        st.running = Some(Running {
            watcher,
            stop,
            halted,
        });
    }

    /// Abonnement immédiat : aucun changement n'est perdu entre l'appel et la première lecture.
    pub async fn events(self: &Arc<Self>, types: Vec<String>) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel(SUBSCRIBER_CAPACITY);
        let first = {
            let mut st = lock(&self.state);
            st.subscribers.retain(|s| !s.tx.is_closed());
            st.subscribers.push(Subscriber { types, tx });
            let first = st.subscribers.len() == 1;
            self.start_locked(&mut st);
            first
        };
        // Un abonné au push lira Email/changes : le journal doit suivre les relevés dès maintenant.
        self.changelog.activate();
        if first {
            let me = self.clone();
            tokio::spawn(async move { me.check().await });
        }
        rx
    }

    pub fn close(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut st = lock(&self.state);
        st.subscribers.clear();
        st.stop();
    }
}
