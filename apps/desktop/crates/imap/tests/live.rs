//! Tests contre la boîte de test réelle (`.env.test.local`) : connexion, dossiers, dépôt, recherche,
//! lecture, drapeaux, suppression, SMTP et pool concurrent. Sans les variables, chaque test s'arrête
//! sans rien faire. Les identifiants ne sont jamais affichés ; tout ce qui est créé est supprimé.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use voxel_imap::compose::{ComposeInput, compose_mime};
use voxel_imap::headers::{Address, parse_header_block};
use voxel_imap::pool::ImapPool;
use voxel_imap::search::SearchKey;
use voxel_imap::session::{FetchQuery, FlagOp, ImapAccount, ImapSession, PartRequest};
use voxel_imap::smtp::{SmtpAccount, smtp_verify};

/// Délais d'ouverture des tests.
const TIMEOUT: Duration = Duration::from_secs(15);
/// Tests live joués l'un après l'autre : ils ne se disputent pas la boîte de test (C16).
static LIVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct TestEnv {
    user: String,
    password: String,
    imap: (String, u16, bool),
    smtp: (String, u16, bool),
}

/// `host:port:ssl|starttls`.
fn endpoint(v: &str) -> Option<(String, u16, bool)> {
    let mut it = v.rsplitn(3, ':');
    let sec = it.next()?;
    let port = it.next()?.parse().ok()?;
    let host = it.next()?.to_string();
    Some((host, port, sec == "ssl"))
}

impl TestEnv {
    fn load() -> Option<TestEnv> {
        const KEYS: [&str; 4] = [
            "VOXEL_TEST_USER",
            "VOXEL_TEST_PASSWORD",
            "VOXEL_TEST_IMAP",
            "VOXEL_TEST_SMTP",
        ];
        let mut file: Vec<(String, String)> = Vec::new();
        let mut dir = Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        while let Some(d) = dir {
            if let Ok(text) = std::fs::read_to_string(d.join(".env.test.local")) {
                file = text
                    .lines()
                    .filter_map(|l| l.split_once('='))
                    .map(|(k, v)| (k.trim().to_string(), v.trim_end_matches('\r').to_string()))
                    .collect();
                break;
            }
            dir = d.parent().map(|p| p.to_path_buf());
        }
        let get = |k: &str| {
            std::env::var(k)
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| file.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()))
        };
        let values: Vec<String> = KEYS.iter().map(|k| get(k)).collect::<Option<_>>()?;
        Some(TestEnv {
            user: values[0].clone(),
            password: values[1].clone(),
            imap: endpoint(&values[2])?,
            smtp: endpoint(&values[3])?,
        })
    }

    fn imap(&self) -> ImapAccount {
        ImapAccount {
            host: self.imap.0.clone(),
            port: self.imap.1,
            secure: self.imap.2,
            username: self.user.clone(),
            password: self.password.clone(),
        }
    }

    fn smtp(&self) -> SmtpAccount {
        SmtpAccount {
            host: self.smtp.0.clone(),
            port: self.smtp.1,
            secure: self.smtp.2,
            username: self.user.clone(),
            password: self.password.clone(),
        }
    }
}

fn run_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    )
}

#[tokio::test]
async fn ouverture_et_capacites() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let mut s = ImapSession::open(&env.imap(), TIMEOUT, TIMEOUT)
        .await
        .expect("connexion");
    assert!(s.is_usable());
    if s.has("NAMESPACE") {
        // NAMESPACE lu à la main : la session doit rester synchronisée
        assert!(s.namespace().delimiter.is_some());
        s.noop().await.expect("noop après NAMESPACE");
        s.list(false).await.expect("list après NAMESPACE");
    }
    assert!(s.has("IMAP4REV1") || s.has("IMAP4REV2"));
    assert!(s.capabilities().iter().all(|c| *c == c.to_uppercase()));
    s.logout().await;
}

#[tokio::test]
async fn liste_des_dossiers() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let mut s = ImapSession::open(&env.imap(), TIMEOUT, TIMEOUT)
        .await
        .expect("connexion");
    let list = s.list(false).await.expect("list");
    let inbox = list
        .iter()
        .find(|e| e.path.eq_ignore_ascii_case("INBOX"))
        .expect("INBOX");
    assert!(inbox.status.is_some());
    assert!(inbox.status.as_ref().unwrap().uid_validity > 0);
    assert!(
        list.iter()
            .any(|e| matches!(e.special_use.as_deref(), Some("\\Sent") | Some("\\Trash")))
    );
    s.logout().await;
}

#[tokio::test]
async fn depot_recherche_lecture_et_nettoyage() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let run = run_id();
    let message_id = format!("voxel-imap-{run}@voxel.test");
    let subject = format!("Voxel rust {run}");
    let raw = compose_mime(&ComposeInput {
        from: vec![Address {
            name: Some("Voxel test".into()),
            email: env.user.clone(),
        }],
        to: vec![Address {
            name: None,
            email: env.user.clone(),
        }],
        subject: Some(subject.clone()),
        message_id: message_id.clone(),
        text: Some("Bonjour depuis voxel-imap".into()),
        html: Some("<p>Bonjour depuis <b>voxel-imap</b></p>".into()),
        ..ComposeInput::default()
    });
    let mut s = ImapSession::open(&env.imap(), TIMEOUT, TIMEOUT)
        .await
        .expect("connexion");
    let appended = s
        .append(
            "INBOX",
            &["\\Seen".to_string()],
            chrono::Utc::now().fixed_offset(),
            &raw,
        )
        .await
        .expect("append");
    s.select("INBOX", false).await.expect("select");
    let uids = s
        .uid_search(&SearchKey::Header("Subject".into(), Some(subject.clone())))
        .await
        .expect("search");

    let mut fetched = None;
    let mut flagged = None;
    if let Some(uid) = uids.last().copied() {
        let query = FetchQuery {
            flags: true,
            internal_date: true,
            size: true,
            body_structure: true,
            header_fields: Some(vec!["Subject".into(), "Message-ID".into()]),
            parts: vec![PartRequest {
                part: "1".into(),
                max_length: Some(1000),
            }],
        };
        fetched = s.uid_fetch(&uid.to_string(), &query).await.ok();
        let set = s
            .store_flags(&uid.to_string(), FlagOp::Add, &["\\Flagged".to_string()])
            .await;
        let after = s
            .uid_fetch(
                &uid.to_string(),
                &FetchQuery {
                    flags: true,
                    ..FetchQuery::default()
                },
            )
            .await;
        flagged = Some((set, after.map(|m| m.first().and_then(|m| m.flags.clone()))));
    }
    // nettoyage avant toute vérification
    if !uids.is_empty() {
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        s.uid_delete(&set).await.expect("nettoyage");
    }
    let left = s
        .uid_search(&SearchKey::Header("Subject".into(), Some(subject)))
        .await
        .expect("search");
    s.logout().await;

    assert_eq!(uids.len(), 1, "un seul message déposé");
    if let Some((_, uid)) = appended {
        assert_eq!(uid, uids[0]);
    }
    let m = fetched
        .expect("fetch")
        .into_iter()
        .next()
        .expect("message lu");
    assert_eq!(m.uid, uids[0]);
    assert!(m.flags.as_ref().unwrap().iter().any(|f| f == "\\Seen"));
    assert!(m.internal_date.is_some());
    assert!(m.size.unwrap() > 0);
    let st = m.structure.expect("structure");
    assert_eq!(st.content_type, "multipart/alternative");
    assert_eq!(st.children[0].part.as_deref(), Some("1"));
    assert_eq!(st.children[0].content_type, "text/plain");
    let headers = parse_header_block(m.header.as_deref().expect("en-têtes"));
    assert!(
        headers
            .iter()
            .any(|h| h.name.eq_ignore_ascii_case("subject") && h.value.contains(&run))
    );
    let part = String::from_utf8_lossy(m.parts.get("1").expect("partie 1")).to_string();
    assert!(part.contains("Bonjour"));
    let (set, after) = flagged.unwrap();
    set.expect("store");
    assert!(
        after
            .expect("fetch flags")
            .unwrap()
            .iter()
            .any(|f| f == "\\Flagged")
    );
    assert!(left.is_empty(), "message supprimé");
}

#[tokio::test]
async fn verification_smtp() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    smtp_verify(&env.smtp()).await.expect("smtp");
}

#[tokio::test]
async fn pool_concurrent() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let pool = ImapPool::new(env.imap());
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for _ in 0..5 {
        let (pool, active, peak) = (pool.clone(), active.clone(), peak.clone());
        tasks.push(tokio::spawn(async move {
            pool.with_mailbox("INBOX", true, move |s| {
                let (active, peak) = (active.clone(), peak.clone());
                Box::pin(async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    let selected = s.selected().map(|m| m.path.clone());
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(selected)
                })
            })
            .await
        }));
    }
    for t in tasks {
        assert_eq!(
            t.await.unwrap().expect("with_mailbox").as_deref(),
            Some("INBOX")
        );
    }
    assert!(peak.load(Ordering::SeqCst) <= 3, "au plus 3 connexions");
    assert!(pool.capabilities().contains("IMAP4REV1") || pool.capabilities().contains("IMAP4REV2"));
    pool.close().await;
}

#[tokio::test]
async fn dossier_accentue() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let run = run_id();
    let first = format!("Voxel é & ü {run}");
    let renamed = format!("Voxel renommé ü {run}");
    let mut s = ImapSession::open(&env.imap(), TIMEOUT, TIMEOUT)
        .await
        .expect("connexion");
    let created = s.create(&first).await;
    let listed = s.list(false).await;
    let path = listed
        .as_ref()
        .ok()
        .and_then(|l| l.iter().find(|e| e.name == first))
        .map(|e| {
            (
                e.path.clone(),
                e.subscribed,
                e.parent_path.clone(),
                e.delimiter.clone(),
            )
        });
    let mut steps = Vec::new();
    let mut new_path = None;
    if let Some((p, _, parent, delimiter)) = &path {
        steps.push(s.select(p, false).await.map(|_| ()));
        let raw = compose_mime(&ComposeInput {
            from: vec![Address {
                name: None,
                email: env.user.clone(),
            }],
            subject: Some(format!("Voxel rust {run}")),
            message_id: format!("voxel-dossier-{run}@voxel.test"),
            text: Some("x".into()),
            ..ComposeInput::default()
        });
        steps.push(
            s.append(p, &[], chrono::Utc::now().fixed_offset(), &raw)
                .await
                .map(|_| ()),
        );
        let target = match (parent, delimiter) {
            (Some(parent), Some(d)) => format!("{parent}{d}{renamed}"),
            _ => renamed.clone(),
        };
        steps.push(s.rename(p, &target).await);
        new_path = Some(target);
    }
    let after = s.list(false).await;
    // nettoyage même en cas d'échec : les deux noms possibles
    let deleted = match &new_path {
        Some(p) => s.delete(p).await,
        None => Ok(()),
    };
    for leftover in after
        .iter()
        .flatten()
        .filter(|e| e.name == first || e.name == renamed)
    {
        if Some(&leftover.path) != new_path.as_ref() {
            let _ = s.delete(&leftover.path).await;
        }
    }
    let end = s.list(false).await;
    s.logout().await;

    created.expect("create");
    let (_, subscribed, _, _) = path.expect("dossier listé sous son nom décodé");
    assert!(subscribed, "abonné après CREATE");
    for st in steps {
        st.expect("select, append, rename");
    }
    let after = after.expect("list");
    assert!(after.iter().any(|e| e.name == renamed));
    assert!(!after.iter().any(|e| e.name == first));
    deleted.expect("delete");
    assert!(
        !end.expect("list").iter().any(|e| e.name.contains(&run)),
        "aucun dossier restant"
    );
}

#[tokio::test]
async fn pool_annulation_rend_la_place() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let pool = ImapPool::new(env.imap());
    // connexion de chauffe : les tours suivants ne dépendent plus d'une ouverture réseau réussie
    pool.with_conn(|s| Box::pin(async move { s.noop().await }))
        .await
        .expect("chauffe");
    // plus d'abandons que de places : sans bail, le pool resterait figé
    for round in 0..4 {
        let mut retries = 0;
        loop {
            // la fermeture abandonnée n'envoie aucune commande : elle attend seulement
            let pending = pool.with_conn(|_s| {
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(())
                })
            });
            match tokio::time::timeout(Duration::from_millis(1500), pending).await {
                Err(_) => break,
                Ok(Err(voxel_imap::ImapError::Unavailable(_))) if retries < 3 => retries += 1,
                Ok(other) => panic!("tour {round} : résultat précoce inattendu {other:?}"),
            }
        }
    }
    let noop = || async {
        tokio::time::timeout(
            Duration::from_secs(30),
            pool.with_conn(|s| Box::pin(async move { s.noop().await })),
        )
        .await
    };
    let mut after = noop().await;
    if matches!(after, Ok(Err(voxel_imap::ImapError::Unavailable(_)))) {
        after = noop().await;
    }
    pool.close().await;
    after.expect("place rendue après annulation").expect("noop");
}

#[tokio::test]
async fn fetch_refuse_et_recherche_non_ascii() {
    let Some(env) = TestEnv::load() else { return };
    let _serial = LIVE.lock().await;
    let mut s = ImapSession::open(&env.imap(), TIMEOUT, TIMEOUT)
        .await
        .expect("connexion");
    // aucune boîte sélectionnée : le serveur refuse, ce n'est jamais une liste vide
    let refused = s
        .uid_fetch(
            "1:*",
            &FetchQuery {
                flags: true,
                ..FetchQuery::default()
            },
        )
        .await;
    let injected = s
        .uid_search(&SearchKey::Subject("x\r\nV9 LOGOUT".into()))
        .await;
    s.select("INBOX", true).await.expect("select");
    let accented = s
        .uid_search(&SearchKey::Subject("Réunion été".into()))
        .await;
    s.noop().await.expect("session toujours synchronisée");
    s.logout().await;
    assert!(
        matches!(refused, Err(voxel_imap::ImapError::Command(_))),
        "{refused:?}"
    );
    assert!(matches!(injected, Err(voxel_imap::ImapError::Command(_))));
    accented.expect("recherche en littéral");
}
