//! Journal des changements d'emails de la façade (port de `changelog.ts`, mémoire uniquement) : permet à
//! Email/changes de renvoyer created / updated / destroyed depuis un état récent, au lieu de toujours répondre
//! cannotCalculateChanges.
//!
//! Chaque relevé des dossiers donne un état `e…`. Quand il change, l'instantané précédent est comparé au
//! nouveau, dossier par dossier, en ne visitant que les dossiers dont l'empreinte a bougé : créations par les
//! UID de [ancien UIDNEXT, nouvel UIDNEXT[, suppressions par différence des ensembles d'UID (seulement si le
//! compte de messages ne s'explique pas par les créations), mots-clés par CONDSTORE (sans lui, seuls les cas
//! où les non-lus s'expliquent par les créations sont calculables). Tout ce qui ne se calcule pas de façon sûre
//! remet le journal à zéro : les états antérieurs deviennent inconnus, comme après un redémarrage.

use std::collections::{BTreeSet, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use voxel_imap::ImapError;
use voxel_imap::pool::ImapPool;
use voxel_imap::search::SearchKey;
use voxel_imap::session::ImapSession;

use crate::folders::{Folder, Folders};
use crate::ids::encode_email_id;

/// Nombre d'étapes conservées.
const MAX_ENTRIES: usize = 200;
/// Au-delà, on ne mémorise pas l'ensemble des UID d'un dossier (ses suppressions ne seront pas calculables).
const MAX_TRACKED: u32 = 20_000;

#[derive(Debug, Clone)]
struct FolderSnap {
    id: String,
    path: String,
    uid_validity: u32,
    uid_next: u32,
    messages: u32,
    unseen: u32,
    highest_modseq: Option<u64>,
    /// UID présents à cet instant, quand on les connaît (nécessaire pour calculer des suppressions).
    uids: Option<BTreeSet<u32>>,
}

#[derive(Debug, Clone)]
struct Snapshot {
    state: String,
    /// dans l'ordre du relevé
    folders: Vec<FolderSnap>,
}

impl Snapshot {
    fn get(&self, id: &str) -> Option<&FolderSnap> {
        self.folders.iter().find(|f| f.id == id)
    }
}

struct Entry {
    from: String,
    to: String,
    created: Vec<String>,
    updated: Vec<String>,
    destroyed: Vec<String>,
}

pub struct ChangesResult {
    pub old_state: String,
    pub new_state: String,
    pub has_more_changes: bool,
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub destroyed: Vec<String>,
}

/// Changement non calculable de façon sûre (ou erreur IMAP pendant le calcul).
enum DiffError {
    Uncomputable,
    Imap,
}

impl From<ImapError> for DiffError {
    fn from(_: ImapError) -> Self {
        DiffError::Imap
    }
}

struct State {
    head: Option<Snapshot>,
    entries: Vec<Entry>,
}

pub struct ChangeLog {
    pool: Arc<ImapPool>,
    active: AtomicBool,
    pending_list: Mutex<Option<Vec<Folder>>>,
    /// relevés observés pas encore intégrés, dans leur ordre d'arrivée
    queue: Mutex<VecDeque<(Vec<Folder>, String)>>,
    /// état du journal ; qui tient ce verrou intègre la file (remplace la chaîne de promesses de Node)
    state: tokio::sync::Mutex<State>,
}

fn stamp_of(f: &FolderSnap) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        f.uid_validity,
        f.uid_next,
        f.messages,
        f.unseen,
        f.highest_modseq.map(|m| m.to_string()).unwrap_or_default()
    )
}

/// UID présents dans le dossier sélectionné, bornés à l'instantané (UID < uidNext).
async fn all_uids(c: &mut ImapSession, uid_next: u32) -> Result<BTreeSet<u32>, ImapError> {
    let found = c.uid_search(&SearchKey::All).await?;
    Ok(found
        .into_iter()
        .filter(|u| uid_next == 0 || *u < uid_next)
        .collect())
}

impl ChangeLog {
    pub fn new(pool: Arc<ImapPool>) -> Arc<Self> {
        Arc::new(ChangeLog {
            pool,
            active: AtomicBool::new(false),
            pending_list: Mutex::new(None),
            queue: Mutex::new(VecDeque::new()),
            state: tokio::sync::Mutex::new(State {
                head: None,
                entries: Vec::new(),
            }),
        })
    }

    /// Active le journal (abonné au push ou premier Email/changes). Tant qu'il est inactif, aucun coût IMAP.
    pub fn activate(self: &Arc<Self>) {
        if self.active.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = self
            .pending_list
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(list) = pending {
            self.observe(&list);
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Nouveau relevé des dossiers (appelé à chaque LIST/STATUS).
    pub fn observe(self: &Arc<Self>, list: &[Folder]) {
        if !self.is_active() {
            *self.pending_list.lock().unwrap_or_else(|e| e.into_inner()) = Some(list.to_vec());
            return;
        }
        *self.pending_list.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let state = Folders::email_state_of(list);
        self.queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back((list.to_vec(), state));
        let me = self.clone();
        tokio::spawn(async move { me.settle().await });
    }

    /// Attend que tous les relevés observés soient intégrés.
    pub async fn settle(&self) {
        let mut st = self.state.lock().await;
        self.drain(&mut st).await;
    }

    /// Intègre les relevés en file, dans leur ordre d'arrivée (verrou d'état tenu).
    async fn drain(&self, st: &mut State) {
        loop {
            let next = self
                .queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_front();
            let Some((list, state)) = next else {
                break;
            };
            self.advance(st, &list, state).await;
        }
    }

    fn snapshot(list: &[Folder], state: String) -> Snapshot {
        Snapshot {
            state,
            folders: list
                .iter()
                .map(|f| FolderSnap {
                    id: f.id.clone(),
                    path: f.path.clone(),
                    uid_validity: f.uid_validity,
                    uid_next: f.uid_next,
                    messages: f.messages,
                    unseen: f.unseen,
                    highest_modseq: f.highest_modseq,
                    uids: None,
                })
                .collect(),
        }
    }

    async fn advance(&self, st: &mut State, list: &[Folder], state: String) {
        let Some(head) = st.head.clone() else {
            let mut snap = Self::snapshot(list, state);
            self.prime(&mut snap, None).await;
            st.head = Some(snap);
            return;
        };
        if state == head.state {
            return;
        }
        let mut next = Self::snapshot(list, state);
        match self.diff(&head, &mut next).await {
            Ok(entry) => {
                st.entries.push(entry);
                if st.entries.len() > MAX_ENTRIES {
                    let extra = st.entries.len() - MAX_ENTRIES;
                    st.entries.drain(..extra);
                }
            }
            Err(_) => {
                // Rupture : les anciens états ne sont plus calculables ; on repart de cet instantané.
                st.entries.clear();
                self.prime(&mut next, Some(&head)).await;
            }
        }
        st.head = Some(next);
    }

    /// Mémorise les UID des dossiers qui n'en ont pas encore (reprend ceux d'un instantané précédent inchangé).
    async fn prime(&self, snap: &mut Snapshot, previous: Option<&Snapshot>) {
        for f in snap.folders.iter_mut() {
            if let Some(old) = previous.and_then(|p| p.get(&f.id))
                && old.uids.is_some()
                && stamp_of(old) == stamp_of(f)
            {
                f.uids = old.uids.clone();
                continue;
            }
            if f.messages == 0 {
                f.uids = Some(BTreeSet::new());
                continue;
            }
            if f.messages > MAX_TRACKED {
                continue;
            }
            let uid_next = f.uid_next;
            f.uids = self
                .pool
                .with_mailbox(&f.path, true, move |c| Box::pin(all_uids(c, uid_next)))
                .await
                .ok();
        }
    }

    async fn diff(&self, prev: &Snapshot, next: &mut Snapshot) -> Result<Entry, DiffError> {
        let mut created = Vec::new();
        let mut updated = Vec::new();
        let mut destroyed = Vec::new();
        for old in &prev.folders {
            if next.get(&old.id).is_some() {
                continue;
            }
            // Dossier supprimé (ou renommé hors de notre vue) : tous ses messages disparaissent.
            if old.messages == 0 {
                continue;
            }
            let Some(uids) = &old.uids else {
                return Err(DiffError::Uncomputable);
            };
            for uid in uids {
                destroyed.push(encode_email_id(&old.id, old.uid_validity, *uid));
            }
        }
        for cur in next.folders.iter_mut() {
            let Some(old) = prev.get(&cur.id) else {
                // Nouveau dossier.
                if cur.messages == 0 {
                    cur.uids = Some(BTreeSet::new());
                    continue;
                }
                if cur.messages > MAX_TRACKED {
                    return Err(DiffError::Uncomputable);
                }
                let uid_next = cur.uid_next;
                let uids = self
                    .pool
                    .with_mailbox(&cur.path, true, move |c| Box::pin(all_uids(c, uid_next)))
                    .await?;
                for uid in &uids {
                    created.push(encode_email_id(&cur.id, cur.uid_validity, *uid));
                }
                cur.uids = Some(uids);
                continue;
            };
            if stamp_of(old) == stamp_of(cur) {
                cur.uids = old.uids.clone();
                continue;
            }
            self.diff_folder(old, cur, &mut created, &mut updated, &mut destroyed)
                .await?;
        }
        Ok(Entry {
            from: prev.state.clone(),
            to: next.state.clone(),
            created,
            updated,
            destroyed,
        })
    }

    async fn diff_folder(
        &self,
        old: &FolderSnap,
        cur: &mut FolderSnap,
        created: &mut Vec<String>,
        updated: &mut Vec<String>,
        destroyed: &mut Vec<String>,
    ) -> Result<(), DiffError> {
        if old.uid_validity != cur.uid_validity
            || old.uid_next == 0
            || cur.uid_next == 0
            || cur.uid_next < old.uid_next
        {
            return Err(DiffError::Uncomputable);
        }
        let use_modseq = old.highest_modseq.is_some() && cur.highest_modseq.is_some();
        let (old_c, cur_c) = (old.clone(), cur.clone());
        /// Résultat d'un dossier : (nouveaux UID, UID partis, UID modifiés, ensemble courant).
        type Out = Result<(Vec<u32>, Vec<u32>, Vec<u32>, Option<BTreeSet<u32>>), DiffError>;
        let out: Out = self
            .pool
            .with_mailbox(&cur.path, true, move |c| {
                let (old, cur) = (old_c.clone(), cur_c.clone());
                Box::pin(async move { Ok(diff_in(c, &old, &cur, use_modseq).await) })
            })
            .await?;
        let (fresh, gone, changed, uids) = out?;
        cur.uids = uids;
        for u in changed {
            updated.push(encode_email_id(&cur.id, cur.uid_validity, u));
        }
        for u in fresh {
            created.push(encode_email_id(&cur.id, cur.uid_validity, u));
        }
        for u in gone {
            destroyed.push(encode_email_id(&cur.id, cur.uid_validity, u));
        }
        Ok(())
    }

    /// Changements depuis `since` (None : état inconnu, trop ancien ou antérieur au démarrage).
    /// Les étapes sont fusionnées : créé puis détruit dans la fenêtre ⇒ absent ; créé puis modifié ⇒ créé.
    pub async fn changes(&self, since: &str, max_changes: Option<usize>) -> Option<ChangesResult> {
        let mut st = self.state.lock().await;
        self.drain(&mut st).await;
        let head = st.head.as_ref()?;
        if since == head.state {
            return Some(ChangesResult {
                old_state: since.into(),
                new_state: since.into(),
                has_more_changes: false,
                created: Vec::new(),
                updated: Vec::new(),
                destroyed: Vec::new(),
            });
        }
        let start = st.entries.iter().rposition(|e| e.from == since)?;
        let mut created: Vec<String> = Vec::new();
        let mut updated: Vec<String> = Vec::new();
        let mut destroyed: Vec<String> = Vec::new();
        let mut new_state = since.to_string();
        for e in &st.entries[start..] {
            let size = created.len()
                + updated.len()
                + destroyed.len()
                + e.created.len()
                + e.updated.len()
                + e.destroyed.len();
            if let Some(max) = max_changes.filter(|m| *m > 0)
                && size > max
            {
                if new_state != since {
                    break;
                }
                return None;
            }
            for id in &e.created {
                if !created.contains(id) {
                    created.push(id.clone());
                }
            }
            for id in &e.updated {
                if !created.contains(id) && !updated.contains(id) {
                    updated.push(id.clone());
                }
            }
            for id in &e.destroyed {
                if let Some(i) = created.iter().position(|x| x == id) {
                    created.remove(i);
                    continue;
                }
                updated.retain(|x| x != id);
                if !destroyed.contains(id) {
                    destroyed.push(id.clone());
                }
            }
            new_state = e.to.clone();
        }
        Some(ChangesResult {
            old_state: since.into(),
            has_more_changes: new_state != head.state,
            new_state,
            created,
            updated,
            destroyed,
        })
    }
}

/// Calcul d'un dossier dans sa boîte sélectionnée (lecture seule).
async fn diff_in(
    c: &mut ImapSession,
    old: &FolderSnap,
    cur: &FolderSnap,
    use_modseq: bool,
) -> Result<(Vec<u32>, Vec<u32>, Vec<u32>, Option<BTreeSet<u32>>), DiffError> {
    // Créations : UID attribués depuis le relevé précédent et encore présents.
    let mut fresh: Vec<u32> = Vec::new();
    if cur.uid_next > old.uid_next {
        let found = c
            .uid_search(&SearchKey::Uid(format!(
                "{}:{}",
                old.uid_next,
                cur.uid_next - 1
            )))
            .await?;
        fresh = found
            .into_iter()
            .filter(|u| *u >= old.uid_next && *u < cur.uid_next)
            .collect();
    }
    // Suppressions : seulement si le compte ne s'explique pas par les créations.
    let lost = old.messages as i64 + fresh.len() as i64 - cur.messages as i64;
    let mut gone: Vec<u32> = Vec::new();
    let uids: Option<BTreeSet<u32>>;
    if lost < 0 {
        return Err(DiffError::Uncomputable);
    }
    if lost > 0 {
        let Some(old_uids) = &old.uids else {
            return Err(DiffError::Uncomputable);
        };
        let now = all_uids(c, cur.uid_next).await?;
        gone = old_uids
            .iter()
            .copied()
            .filter(|u| !now.contains(u))
            .collect();
        uids = Some(now);
    } else if let Some(old_uids) = &old.uids {
        let mut set = old_uids.clone();
        set.extend(fresh.iter().copied());
        uids = Some(set);
    } else if cur.messages <= MAX_TRACKED {
        uids = Some(all_uids(c, cur.uid_next).await?);
    } else {
        uids = None;
    }
    let fresh_set: HashSet<u32> = fresh.iter().copied().collect();
    let gone_set: HashSet<u32> = gone.iter().copied().collect();
    let mut changed: Vec<u32> = Vec::new();
    // Mots-clés.
    if use_modseq {
        let (Some(old_ms), Some(cur_ms)) = (old.highest_modseq, cur.highest_modseq) else {
            return Err(DiffError::Uncomputable);
        };
        if cur.messages > 0 && cur_ms > old_ms {
            for uid in c.changed_since(old_ms).await? {
                if uid == 0
                    || uid >= cur.uid_next
                    || fresh_set.contains(&uid)
                    || gone_set.contains(&uid)
                {
                    continue;
                }
                changed.push(uid);
            }
        }
    } else {
        // Sans CONDSTORE : calculable seulement si les non-lus s'expliquent par les créations (aucune suppression).
        let mut unseen_fresh = 0i64;
        if !fresh.is_empty() {
            let list = fresh
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let seen = c
                .uid_search(&SearchKey::And(vec![
                    SearchKey::Uid(list),
                    SearchKey::Seen(false),
                ]))
                .await?;
            unseen_fresh = seen.len() as i64;
        }
        if !gone.is_empty() || cur.unseen as i64 - old.unseen as i64 != unseen_fresh {
            return Err(DiffError::Uncomputable);
        }
    }
    Ok((fresh, gone, changed, uids))
}
