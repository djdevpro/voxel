//! Façade IMAP/SMTP → JMAP de bout en bout contre la boîte de test réelle (`.env.test.local`) : les scénarios
//! de `facade.test.ts`, `integration-b1.test.ts` et `integration-c.test.ts`, adaptés à une seule boîte
//! (l'expéditeur s'écrit à lui-même). Sans les variables, le test s'arrête sans rien faire. Les identifiants
//! ne sont jamais affichés ; messages et dossiers créés (sujets et noms `Voxel rust <run>`) sont détruits à
//! la fin, même en cas d'échec.

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::FutureExt;
use serde_json::{Value, json};
use voxel_core::backend::{Companions, Endpoint, MailAccount, MailBackend};
use voxel_core::error::BackendError;
use voxel_core::jmap::{Invocation, JmapRequest};
use voxel_core::kv::{KvStore, MemoryKv};
use voxel_mail::ImapBackend;

/// Capacités demandées par les requêtes du test.
const USING: [&str; 3] = [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail",
    "urn:ietf:params:jmap:submission",
];

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
        let mut dir = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
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

    fn account(&self, password: &str) -> MailAccount {
        let ep = |e: &(String, u16, bool)| Endpoint {
            host: e.0.clone(),
            port: e.1,
            secure: e.2,
        };
        MailAccount {
            email: self.user.clone(),
            username: self.user.clone(),
            password: password.to_string(),
            imap: ep(&self.imap),
            smtp: ep(&self.smtp),
            sieve: None,
            carddav: None,
            caldav: None,
        }
    }
}

/// Contexte partagé du scénario.
struct Ctx {
    env: TestEnv,
    run: String,
    blob_dir: PathBuf,
    kv: Arc<MemoryKv>,
    me: Arc<ImapBackend>,
}

impl Ctx {
    fn backend(&self, kv: Arc<dyn KvStore>) -> Arc<ImapBackend> {
        ImapBackend::new(
            self.env.account(&self.env.password),
            kv,
            self.blob_dir.clone(),
            Companions::default(),
        )
    }

    fn tag(&self) -> String {
        format!("Voxel rust {}", self.run)
    }
}

async fn api(b: &ImapBackend, calls: Vec<(&str, Value, &str)>) -> Vec<Invocation> {
    let req = JmapRequest {
        using: USING.iter().map(|s| s.to_string()).collect(),
        method_calls: calls
            .into_iter()
            .map(|(n, a, id)| Invocation(n.into(), a, id.into()))
            .collect(),
        created_ids: None,
    };
    b.api(req).await.expect("requête JMAP").method_responses
}

fn pick(res: &[Invocation], call_id: &str, name: &str) -> Value {
    let r = res
        .iter()
        .find(|Invocation(n, _, id)| id == call_id && n == name)
        .unwrap_or_else(|| {
            panic!(
                "réponse {call_id}/{name} absente : {}",
                short(&json!(res.iter().map(|i| (&i.0, &i.1)).collect::<Vec<_>>()))
            )
        });
    r.1.clone()
}

fn short(v: &Value) -> String {
    v.to_string().chars().take(600).collect()
}

async fn one(b: &ImapBackend, name: &str, mut args: Value) -> Value {
    if let Some(o) = args.as_object_mut() {
        o.insert("accountId".into(), json!("a"));
    }
    let res = api(b, vec![(name, args, "x")]).await;
    let Invocation(n, body, _) = &res[0];
    assert_ne!(n, "error", "{name} : {}", short(body));
    body.clone()
}

async fn wait_for<T, F, Fut>(label: &str, timeout: Duration, every: Duration, mut f: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let t0 = Instant::now();
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(t0.elapsed() < timeout, "délai dépassé : {label}");
        tokio::time::sleep(every).await;
    }
}

fn ids_of(v: &Value) -> Vec<String> {
    v["ids"]
        .as_array()
        .map(|l| {
            l.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// Dossiers par rôle d'une façade.
async fn roles(b: &ImapBackend) -> std::collections::HashMap<String, String> {
    let r = one(b, "Mailbox/get", json!({ "ids": null })).await;
    r["list"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| {
            Some((
                m["role"].as_str()?.to_string(),
                m["id"].as_str()?.to_string(),
            ))
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scenario() {
    let Some(env) = TestEnv::load() else {
        eprintln!("boîte de test absente (.env.test.local) : scénario sauté");
        return;
    };
    let run: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
    let blob_dir = std::env::temp_dir().join(format!("voxel-mail-facade-{run}"));
    let kv = Arc::new(MemoryKv::default());
    let me = ImapBackend::new(
        env.account(&env.password),
        kv.clone(),
        blob_dir.clone(),
        Companions::default(),
    );
    let ctx = Arc::new(Ctx {
        env,
        run,
        blob_dir,
        kv,
        me,
    });
    let folders: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let t0 = Instant::now();
    let outcome = AssertUnwindSafe(steps(ctx.clone(), folders.clone()))
        .catch_unwind()
        .await;
    let cleaned = AssertUnwindSafe(cleanup(ctx.clone(), folders.clone()))
        .catch_unwind()
        .await;
    ctx.me.close().await;
    let _ = std::fs::remove_dir_all(&ctx.blob_dir);
    eprintln!("scénario de la façade : {} s", t0.elapsed().as_secs());
    if let Err(p) = outcome {
        std::panic::resume_unwind(p);
    }
    if let Err(p) = cleaned {
        std::panic::resume_unwind(p);
    }
}

/// Détruit tout message `Voxel rust <run>` encore présent, puis les dossiers créés ; vérifie qu'il ne reste rien.
async fn cleanup(ctx: Arc<Ctx>, folders: Arc<Mutex<Vec<String>>>) {
    let b = &ctx.me;
    let tag = ctx.tag();
    for _ in 0..2 {
        let list = one(b, "Mailbox/get", json!({ "ids": null })).await;
        let mut doomed: Vec<String> = Vec::new();
        for m in list["list"].as_array().unwrap() {
            if m["totalEmails"].as_u64() == Some(0) {
                continue;
            }
            let res = api(
                b,
                vec![
                    (
                        "Email/query",
                        json!({ "accountId": "a", "filter": { "inMailbox": m["id"] }, "sort": [{ "property": "receivedAt", "isAscending": false }], "limit": 300 }),
                        "q",
                    ),
                    (
                        "Email/get",
                        json!({ "accountId": "a", "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" }, "properties": ["id", "subject"] }),
                        "g",
                    ),
                ],
            )
            .await;
            if let Some(l) = res.iter().find(|i| i.2 == "g" && i.0 == "Email/get") {
                for e in l.1["list"].as_array().into_iter().flatten() {
                    if e["subject"].as_str().is_some_and(|s| s.contains(&tag)) {
                        doomed.push(e["id"].as_str().unwrap().to_string());
                    }
                }
            }
        }
        if doomed.is_empty() {
            break;
        }
        let d = one(b, "Email/set", json!({ "destroy": doomed })).await;
        assert!(
            d["notDestroyed"].is_null(),
            "nettoyage des messages : {}",
            short(&d)
        );
    }
    let ids: Vec<String> = folders.lock().unwrap().clone();
    if !ids.is_empty() {
        let d = one(
            b,
            "Mailbox/set",
            json!({ "destroy": ids, "onDestroyRemoveEmails": true }),
        )
        .await;
        assert!(
            d["notDestroyed"]
                .as_object()
                .is_none_or(|o| o.values().all(|v| v["type"] == "notFound")),
            "nettoyage des dossiers : {}",
            short(&d)
        );
    }
    let left = one(b, "Mailbox/get", json!({ "ids": null })).await;
    assert!(
        !left["list"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["name"].as_str().is_some_and(|n| n.contains(&tag))),
        "un dossier du test reste"
    );
}

async fn steps(ctx: Arc<Ctx>, folders: Arc<Mutex<Vec<String>>>) {
    let b = ctx.me.clone();
    let me_addr = ctx.env.user.clone();
    let run = ctx.run.clone();
    let tag = ctx.tag();

    // ---------------------------------------------------------------- session() et verify()
    let s = b.session().await.unwrap();
    assert_eq!(
        s["primaryAccounts"]["urn:ietf:params:jmap:mail"],
        json!("a")
    );
    assert!(s["capabilities"]["urn:ietf:params:jmap:submission"].is_object());
    assert!(
        s["capabilities"]
            .get("urn:ietf:params:jmap:vacationresponse")
            .is_none()
    );
    b.verify().await.expect("verify");

    // ---------------------------------------------------------------- mauvais mot de passe
    {
        let bad = ImapBackend::new(
            ctx.env.account(&format!("wrong-{run}")),
            Arc::new(MemoryKv::default()),
            ctx.blob_dir.clone(),
            Companions::default(),
        );
        let r = bad.verify().await;
        bad.close().await;
        assert!(
            matches!(r, Err(BackendError::Auth(_))),
            "refus d'authentification attendu"
        );
    }

    // ---------------------------------------------------------------- erreurs JMAP standard
    let res = api(
        &b,
        vec![
            ("VacationResponse/get", json!({ "accountId": "a", "ids": null }), "v"),
            ("Email/get", json!({ "accountId": "a", "#ids": { "resultOf": "nope", "name": "Email/query", "path": "/ids" } }), "r"),
            ("Email/changes", json!({ "accountId": "a", "sinceState": "old" }), "c"),
            ("Email/get", json!({ "accountId": "zz", "ids": [] }), "z"),
        ],
    )
    .await;
    assert_eq!(pick(&res, "v", "error")["type"], "unknownMethod");
    assert_eq!(pick(&res, "r", "error")["type"], "invalidResultReference");
    assert_eq!(pick(&res, "c", "error")["type"], "cannotCalculateChanges");
    assert_eq!(pick(&res, "z", "error")["type"], "accountNotFound");
    let st = one(&b, "Email/get", json!({ "ids": [] })).await["state"].clone();
    let ch = one(&b, "Email/changes", json!({ "sinceState": st })).await;
    assert_eq!(ch["created"], json!([]));

    // ---------------------------------------------------------------- Mailbox/get et Mailbox/set
    let roles = roles(&b).await;
    for role in ["inbox", "sent", "drafts", "trash"] {
        assert!(roles.contains_key(role), "rôle {role} absent");
    }
    let mb = one(&b, "Mailbox/get", json!({ "ids": null })).await;
    assert_eq!(
        mb["list"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "inbox")
            .count(),
        1
    );
    let inbox = roles["inbox"].clone();
    let name = format!("{tag} dossier");
    let c = one(
        &b,
        "Mailbox/set",
        json!({ "create": { "n": { "name": name, "parentId": null, "isSubscribed": true } } }),
    )
    .await;
    let fid = c["created"]["n"]["id"]
        .as_str()
        .expect("dossier créé")
        .to_string();
    folders.lock().unwrap().push(fid.clone());
    let u = one(
        &b,
        "Mailbox/set",
        json!({ "update": { fid.clone(): { "name": format!("{name} renommé") } } }),
    )
    .await;
    assert!(
        u["updated"].get(&fid).is_some(),
        "{}",
        short(&u["notUpdated"])
    );
    let g = one(&b, "Mailbox/get", json!({ "ids": [fid] })).await;
    assert_eq!(g["list"][0]["name"], json!(format!("{name} renommé")));
    let d = one(&b, "Mailbox/set", json!({ "destroy": [fid] })).await;
    assert_eq!(d["destroyed"], json!([fid]));
    folders.lock().unwrap().retain(|x| *x != fid);
    let g2 = one(&b, "Mailbox/get", json!({ "ids": [fid] })).await;
    assert_eq!(g2["notFound"], json!([fid]));
    let fb = one(
        &b,
        "Mailbox/set",
        json!({ "create": { "b": { "name": format!("{tag} B"), "parentId": null } } }),
    )
    .await;
    let folder_b = fb["created"]["b"]["id"]
        .as_str()
        .expect("dossier B")
        .to_string();
    folders.lock().unwrap().push(folder_b.clone());

    // ---------------------------------------------------------------- dépôt de messages
    let attach: Vec<u8> = format!("[{tag}] pièce jointe\n").repeat(20).into_bytes();
    let up = b
        .upload("a".into(), Bytes::from(attach.clone()), "text/plain".into())
        .await
        .unwrap();
    let base = chrono::Utc::now() - chrono::Duration::minutes(3);
    let mk = |n: i64, extra: Value| {
        let received = (base + chrono::Duration::minutes(n))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let mut o = json!({
            "mailboxIds": { inbox.clone(): true },
            "keywords": if n == 2 { json!({}) } else { json!({ "$seen": true }) },
            "from": [{ "name": format!("Seed {n}"), "email": format!("seed{n}.{run}@example.test") }],
            "to": [{ "name": null, "email": me_addr }],
            "subject": format!("{tag} seed {n}"),
            "receivedAt": received,
            "bodyValues": { "t": { "value": format!("Texte du message {n} {run}") }, "h": { "value": format!("<p>HTML du <b>message {n}</b> {run}</p>") } },
            "textBody": [{ "partId": "t", "type": "text/plain" }],
            "htmlBody": [{ "partId": "h", "type": "text/html" }],
        });
        if let (Some(o), Some(e)) = (o.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        o
    };
    let r = one(
        &b,
        "Email/set",
        json!({ "create": {
            "s1": mk(1, json!({})),
            "s2": mk(2, json!({})),
            "s3": mk(3, json!({ "attachments": [{ "blobId": up.blob_id, "name": format!("note-{run}.txt"), "type": "text/plain", "disposition": "attachment" }] })),
        } }),
    )
    .await;
    let mut seeds: Vec<String> = ["s1", "s2", "s3"]
        .iter()
        .map(|k| {
            r["created"][k]["id"]
                .as_str()
                .unwrap_or_else(|| panic!("{}", short(&r["notCreated"])))
                .to_string()
        })
        .collect();

    // ---------------------------------------------------------------- Email/query + Email/get + Thread/get chaînés
    let page = |b: Arc<ImapBackend>, filter: Value, position: u64, limit: u64| async move {
        api(
            &b,
            vec![
                ("Email/query", json!({ "accountId": "a", "filter": filter, "sort": [{ "property": "receivedAt", "isAscending": false }], "collapseThreads": true, "position": position, "limit": limit, "calculateTotal": true }), "q"),
                ("Email/get", json!({ "accountId": "a", "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" }, "properties": ["id", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "from", "to", "cc", "subject", "sentAt", "hasAttachment", "preview"] }), "g"),
                ("Thread/get", json!({ "accountId": "a", "#ids": { "resultOf": "g", "name": "Email/get", "path": "/list/*/threadId" } }), "t"),
                ("Email/get", json!({ "accountId": "a", "#ids": { "resultOf": "t", "name": "Thread/get", "path": "/list/*/emailIds" }, "properties": ["id", "threadId", "mailboxIds", "keywords", "from", "receivedAt"] }), "m"),
            ],
        )
        .await
    };
    {
        // nouvelle instance (aucun cache), comme un client qui ouvre la boîte
        let fresh = ctx.backend(ctx.kv.clone());
        let fp = page(fresh.clone(), json!({ "inMailbox": inbox }), 0, 50).await;
        assert!(!ids_of(&pick(&fp, "q", "Email/query")).is_empty());
        fresh.close().await;
    }
    let p1 = page(b.clone(), json!({ "inMailbox": inbox }), 0, 2).await;
    let q1 = pick(&p1, "q", "Email/query");
    let g1 = pick(&p1, "g", "Email/get");
    let t1 = pick(&p1, "t", "Thread/get");
    let m1 = pick(&p1, "m", "Email/get");
    assert_eq!(ids_of(&q1).len(), 2);
    assert!(q1["total"].as_u64().unwrap() >= 3);
    let g1l = g1["list"].as_array().unwrap();
    assert_eq!(g1l.len(), 2);
    assert!(
        g1l[0]["receivedAt"].as_str() >= g1l[1]["receivedAt"].as_str(),
        "tri receivedAt desc"
    );
    assert_eq!(t1["list"].as_array().unwrap().len(), 2);
    assert!(
        t1["list"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| !t["emailIds"].as_array().unwrap().is_empty())
    );
    assert!(m1["list"].as_array().unwrap().len() >= 2);
    let p2 = page(b.clone(), json!({ "inMailbox": inbox }), 2, 2).await;
    let q2 = pick(&p2, "q", "Email/query");
    assert_eq!(q2["position"], json!(2));
    assert!(
        ids_of(&q2).iter().all(|id| !ids_of(&q1).contains(id)),
        "pages disjointes"
    );
    // la boîte de test peut recevoir d'autres messages pendant le test : la tête se vérifie sur les seeds
    let own = page(
        b.clone(),
        json!({ "operator": "AND", "conditions": [{ "inMailbox": inbox }, { "subject": tag }] }),
        0,
        10,
    )
    .await;
    let own_g = pick(&own, "g", "Email/get");
    assert_eq!(own_g["list"][0]["id"], json!(seeds[2]));
    assert!(
        own_g["list"][0]["preview"]
            .as_str()
            .unwrap()
            .contains(&format!("message 3 {run}"))
    );

    // filtres (l'index plein texte du serveur peut être en retard : on réessaie)
    let q = |b: Arc<ImapBackend>, filter: Value| async move {
        ids_of(&one(&b, "Email/query", json!({ "filter": filter, "sort": [{ "property": "receivedAt", "isAscending": false }], "calculateTotal": true })).await)
    };
    let mut others: Vec<String> = vec![roles["trash"].clone()];
    if let Some(j) = roles.get("junk") {
        others.push(j.clone());
    }
    let by_text = wait_for("filtre text", Duration::from_secs(30), Duration::from_millis(1500), || {
        let (b, others, run) = (b.clone(), others.clone(), run.clone());
        async move {
            let ids = q(b, json!({ "operator": "AND", "conditions": [{ "inMailboxOtherThan": others }, { "text": run }] })).await;
            (ids.len() >= 3).then_some(ids)
        }
    })
    .await;
    assert_eq!(sorted(by_text), sorted(seeds.clone()));
    let seed1 = format!("seed1.{run}@example.test");
    let seed2 = format!("seed2.{run}@example.test");
    let by_from = wait_for(
        "filtre from",
        Duration::from_secs(30),
        Duration::from_millis(1500),
        || {
            let (b, seed1) = (b.clone(), seed1.clone());
            async move {
                let ids = q(b, json!({ "from": seed1 })).await;
                (!ids.is_empty()).then_some(ids)
            }
        },
    )
    .await;
    assert_eq!(by_from, vec![seeds[0].clone()]);
    let unread = q(b.clone(), json!({ "operator": "AND", "conditions": [{ "inMailbox": inbox }, { "notKeyword": "$seen" }, { "text": run }] })).await;
    assert_eq!(unread, vec![seeds[1].clone()]);
    let ored = q(b.clone(), json!({ "operator": "AND", "conditions": [{ "inMailbox": inbox }, { "operator": "OR", "conditions": [{ "from": seed1 }, { "from": seed2 }] }] })).await;
    assert_eq!(
        sorted(ored),
        sorted(vec![seeds[0].clone(), seeds[1].clone()])
    );
    let notted = q(b.clone(), json!({ "operator": "AND", "conditions": [{ "inMailbox": inbox }, { "text": run }, { "operator": "NOT", "conditions": [{ "hasKeyword": "$seen" }] }] })).await;
    assert_eq!(notted, vec![seeds[1].clone()]);

    // ---------------------------------------------------------------- id toujours renvoyé
    let r = one(
        &b,
        "Email/get",
        json!({ "ids": [seeds[0]], "properties": ["subject", "mailboxIds"] }),
    )
    .await;
    assert_eq!(r["list"][0]["id"], json!(seeds[0]));
    assert!(r["list"][0]["subject"].is_string());

    // ---------------------------------------------------------------- corps, pièces jointes, téléchargement
    let props = json!([
        "id",
        "threadId",
        "subject",
        "from",
        "messageId",
        "bodyValues",
        "textBody",
        "htmlBody",
        "attachments",
        "hasAttachment",
        "header:List-Unsubscribe:asURLs",
        "bodyStructure"
    ]);
    let res = api(
        &b,
        vec![
            ("Email/get", json!({ "accountId": "a", "ids": [seeds[2]], "properties": ["threadId"] }), "h"),
            ("Thread/get", json!({ "accountId": "a", "#ids": { "resultOf": "h", "name": "Email/get", "path": "/list/*/threadId" } }), "t"),
            ("Email/get", json!({ "accountId": "a", "#ids": { "resultOf": "t", "name": "Thread/get", "path": "/list/*/emailIds" }, "properties": props, "fetchHTMLBodyValues": true, "fetchTextBodyValues": true, "maxBodyValueBytes": 1_500_000 }), "g"),
        ],
    )
    .await;
    let list = pick(&res, "g", "Email/get")["list"].clone();
    let e = list
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(seeds[2]))
        .expect("message 3 trouvé via Thread/get")
        .clone();
    assert_eq!(e["subject"], json!(format!("{tag} seed 3")));
    assert_eq!(e["hasAttachment"], json!(true));
    let html = e["htmlBody"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["type"] == "text/html")
        .expect("partie HTML")
        .clone();
    let text = e["textBody"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["type"] == "text/plain")
        .expect("partie texte")
        .clone();
    assert!(
        e["bodyValues"][html["partId"].as_str().unwrap()]["value"]
            .as_str()
            .unwrap()
            .contains(&format!("<b>message 3</b> {run}"))
    );
    assert!(
        e["bodyValues"][text["partId"].as_str().unwrap()]["value"]
            .as_str()
            .unwrap()
            .contains(&format!("Texte du message 3 {run}"))
    );
    assert_eq!(e["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(
        e["attachments"][0]["name"],
        json!(format!("note-{run}.txt"))
    );
    assert_eq!(e["header:List-Unsubscribe:asURLs"], Value::Null);
    assert_eq!(e["bodyStructure"]["type"], json!("multipart/mixed"));
    let dl = b
        .download(
            "a".into(),
            e["attachments"][0]["blobId"].as_str().unwrap().into(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        dl.body.as_ref(),
        attach.as_slice(),
        "pièce jointe identique"
    );
    let tr = one(&b, "Email/get", json!({ "ids": [seeds[2]], "properties": ["bodyValues"], "fetchHTMLBodyValues": true, "maxBodyValueBytes": 10 })).await;
    let bv = tr["list"][0]["bodyValues"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    assert_eq!(bv["isTruncated"], json!(true));
    let src = b
        .download("a".into(), seeds[2].clone(), None)
        .await
        .unwrap();
    assert_eq!(src.content_type, "message/rfc822");
    assert!(String::from_utf8_lossy(&src.body).contains(&format!("Subject: {tag} seed 3")));

    // ---------------------------------------------------------------- mots-clés, déplacement aller-retour, destroy
    let id = seeds[0].clone();
    let kw = |b: Arc<ImapBackend>, eid: String| async move {
        one(
            &b,
            "Email/get",
            json!({ "ids": [eid], "properties": ["keywords", "mailboxIds"] }),
        )
        .await["list"][0]
            .clone()
    };
    let r = one(
        &b,
        "Email/set",
        json!({ "update": { id.clone(): { "keywords/$seen": null, "keywords/$flagged": true } } }),
    )
    .await;
    assert!(
        r["updated"].get(&id).is_some(),
        "{}",
        short(&r["notUpdated"])
    );
    let k = kw(b.clone(), id.clone()).await;
    assert!(k["keywords"].get("$seen").is_none());
    assert_eq!(k["keywords"]["$flagged"], json!(true));
    one(
        &b,
        "Email/set",
        json!({ "update": { id.clone(): { "keywords/$seen": true, "keywords/$flagged": null } } }),
    )
    .await;
    let k = kw(b.clone(), id.clone()).await;
    assert_eq!(k["keywords"]["$seen"], json!(true));
    assert!(k["keywords"].get("$flagged").is_none());
    let r = one(&b, "Email/set", json!({ "update": { id.clone(): { format!("mailboxIds/{inbox}"): null, format!("mailboxIds/{folder_b}"): true } } })).await;
    assert!(
        r["updated"].get(&id).is_some(),
        "{}",
        short(&r["notUpdated"])
    );
    assert_eq!(
        ids_of(
            &one(
                &b,
                "Email/query",
                json!({ "filter": { "inMailbox": folder_b } })
            )
            .await
        )
        .len(),
        1
    );
    let moved = kw(b.clone(), id.clone()).await;
    assert_eq!(moved["mailboxIds"], json!({ folder_b.clone(): true }));
    let r = one(
        &b,
        "Email/set",
        json!({ "update": { id.clone(): { "mailboxIds": { inbox.clone(): true } } } }),
    )
    .await;
    assert!(
        r["updated"].get(&id).is_some(),
        "{}",
        short(&r["notUpdated"])
    );
    assert!(
        ids_of(
            &one(
                &b,
                "Email/query",
                json!({ "filter": { "inMailbox": folder_b } })
            )
            .await
        )
        .is_empty()
    );
    let back = one(
        &b,
        "Email/get",
        json!({ "ids": [id], "properties": ["id", "mailboxIds", "subject"] }),
    )
    .await["list"][0]
        .clone();
    assert_eq!(back["mailboxIds"], json!({ inbox.clone(): true }));
    assert_eq!(back["subject"], json!(format!("{tag} seed 1")));
    seeds[0] = back["id"].as_str().unwrap().to_string();
    let d = one(&b, "Email/set", json!({ "destroy": [seeds[1]] })).await;
    assert_eq!(d["destroyed"], json!([seeds[1]]));
    let g = one(
        &b,
        "Email/get",
        json!({ "ids": [seeds[1]], "properties": ["id"] }),
    )
    .await;
    assert_eq!(g["notFound"], json!([seeds[1]]));

    // ---------------------------------------------------------------- Identity/get puis set d'une signature
    let g = one(&b, "Identity/get", json!({ "ids": null })).await;
    let def = g["list"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["email"] == json!(me_addr))
        .expect("identité par défaut")
        .clone();
    let def_id = def["id"].as_str().unwrap().to_string();
    let initial =
        json!({ "textSignature": def["textSignature"], "htmlSignature": def["htmlSignature"] });
    let sig = json!({ "textSignature": format!("[{tag}] signature"), "htmlSignature": format!("<p>[{tag}] signature</p>") });
    let u = one(
        &b,
        "Identity/set",
        json!({ "update": { def_id.clone(): sig } }),
    )
    .await;
    assert!(u["updated"].get(&def_id).is_some());
    let after = one(&b, "Identity/get", json!({ "ids": [def_id] })).await["list"][0].clone();
    assert_eq!(after["textSignature"], sig["textSignature"]);
    assert_eq!(after["htmlSignature"], sig["htmlSignature"]);
    {
        let again = ctx.backend(ctx.kv.clone());
        let g3 = one(&again, "Identity/get", json!({ "ids": [def_id] })).await;
        assert_eq!(g3["list"][0]["textSignature"], sig["textSignature"]);
        again.close().await;
    }
    one(
        &b,
        "Identity/set",
        json!({ "update": { def_id.clone(): initial } }),
    )
    .await;
    let g4 = one(&b, "Identity/get", json!({ "ids": [def_id] })).await;
    assert_eq!(g4["list"][0]["textSignature"], initial["textSignature"]);
    let del = one(&b, "Identity/set", json!({ "destroy": [def_id] })).await;
    assert_eq!(del["notDestroyed"][&def_id]["type"], json!("forbidden"));

    // ---------------------------------------------------------------- upload → brouillon → EmailSubmission/set
    let content = format!("[{tag}] PJ envoyée {}", "x".repeat(300)).into_bytes();
    let up = b
        .upload(
            "a".into(),
            Bytes::from(content.clone()),
            "text/plain".into(),
        )
        .await
        .unwrap();
    assert_eq!(up.size, content.len() as u64);
    let subject = format!("{tag} envoi");
    let (drafts, sent) = (roles["drafts"].clone(), roles["sent"].clone());
    let email = json!({
        "mailboxIds": { drafts.clone(): true },
        "keywords": { "$draft": true, "$seen": true },
        "from": [{ "name": "Sender", "email": me_addr }],
        "to": [{ "name": "Recipient", "email": me_addr }],
        "subject": subject,
        "bodyValues": { "text": { "value": format!("Bonjour, test de la façade IMAP {run}.") }, "html": { "value": format!("<p>Bonjour, test de la <b>façade IMAP</b> {run}.</p>") } },
        "textBody": [{ "partId": "text", "type": "text/plain" }],
        "htmlBody": [{ "partId": "html", "type": "text/html" }],
        "attachments": [{ "blobId": up.blob_id, "name": format!("envoi-{run}.txt"), "type": "text/plain", "size": up.size, "disposition": "attachment" }],
    });
    let res = api(
        &b,
        vec![
            ("Email/set", json!({ "accountId": "a", "create": { "msg": email } }), "o0"),
            (
                "EmailSubmission/set",
                json!({
                    "accountId": "a",
                    "create": { "sub": { "identityId": def_id, "emailId": "#msg", "envelope": { "mailFrom": { "email": me_addr, "parameters": null }, "rcptTo": [{ "email": me_addr }] } } },
                    "onSuccessUpdateEmail": { "#sub": { "keywords/$draft": null, format!("mailboxIds/{drafts}"): null, format!("mailboxIds/{sent}"): true } },
                }),
                "o1",
            ),
        ],
    )
    .await;
    let draft_id = pick(&res, "o0", "Email/set")["created"]["msg"]["id"]
        .as_str()
        .expect("brouillon créé")
        .to_string();
    let sub = pick(&res, "o1", "EmailSubmission/set");
    assert!(
        sub["created"]["sub"]["id"].is_string(),
        "{}",
        short(&sub["notCreated"])
    );
    let implicit: Vec<&Invocation> = res
        .iter()
        .filter(|i| i.0 == "Email/set" && i.2 == "o1")
        .collect();
    assert_eq!(implicit.len(), 1, "Email/set implicite présent");
    assert_eq!(implicit[0].1["updated"][&draft_id], Value::Null);
    assert!(implicit[0].1["updated"].get(&draft_id).is_some());
    assert!(
        !ids_of(
            &one(
                &b,
                "Email/query",
                json!({ "filter": { "inMailbox": drafts } })
            )
            .await
        )
        .contains(&draft_id)
    );
    let copy = one(
        &b,
        "Email/get",
        json!({ "ids": [draft_id], "properties": ["id", "mailboxIds", "keywords", "subject"] }),
    )
    .await["list"][0]
        .clone();
    assert_eq!(copy["mailboxIds"], json!({ sent.clone(): true }));
    assert!(copy["keywords"].get("$draft").is_none());
    assert_eq!(copy["subject"], json!(subject));
    let received = wait_for("réception dans INBOX", Duration::from_secs(90), Duration::from_secs(2), || {
        let (b, inbox, subject) = (b.clone(), inbox.clone(), subject.clone());
        async move {
            let r = api(
                &b,
                vec![
                    ("Email/query", json!({ "accountId": "a", "filter": { "inMailbox": inbox }, "sort": [{ "property": "receivedAt", "isAscending": false }], "limit": 15 }), "q"),
                    ("Email/get", json!({ "accountId": "a", "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" }, "properties": ["id", "subject", "attachments", "from"] }), "g"),
                ],
            )
            .await;
            pick(&r, "g", "Email/get")["list"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["subject"] == json!(subject))
                .cloned()
        }
    })
    .await;
    assert_eq!(received["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(
        received["attachments"][0]["name"],
        json!(format!("envoi-{run}.txt"))
    );
    let dl = b
        .download(
            "a".into(),
            received["attachments"][0]["blobId"]
                .as_str()
                .unwrap()
                .into(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        dl.body.as_ref(),
        content.as_slice(),
        "pièce jointe reçue identique"
    );

    // ---------------------------------------------------------------- events() : StateChange à l'arrivée d'un message
    {
        let mut rx = b.events(vec!["*".into()]).await.unwrap();
        // laisse le temps à la connexion IDLE et à l'état de référence
        tokio::time::sleep(Duration::from_secs(3)).await;
        let other = ctx.backend(Arc::new(MemoryKv::default()));
        let other_roles = roles_of(&other).await;
        one(
            &other,
            "Email/set",
            json!({ "create": { "e": {
                "mailboxIds": { other_roles["inbox"].clone(): true },
                "from": [{ "name": "Push", "email": format!("push.{run}@example.test") }],
                "subject": format!("{tag} push"),
                "bodyValues": { "t": { "value": "push" } },
                "textBody": [{ "partId": "t", "type": "text/plain" }],
            } } }),
        )
        .await;
        other.close().await;
        // le serveur de test signale parfois l'arrivée en IDLE avec ~30 s de retard ; le relevé périodique
        // (45 s) prend alors le relais
        let ev = tokio::time::timeout(Duration::from_secs(75), rx.recv())
            .await
            .ok()
            .flatten()
            .expect("StateChange reçu");
        assert_eq!(ev["@type"], json!("StateChange"));
        assert!(ev["changed"]["a"]["Email"].is_string(), "{}", short(&ev));
    }

    // ---------------------------------------------------------------- Email/changes (autre client sur la même boîte)
    {
        let mut rx = b.events(vec!["*".into()]).await.unwrap();
        let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
        tokio::time::sleep(Duration::from_secs(3)).await;
        let other = ctx.backend(ctx.kv.clone());
        let changes_since =
            |since: String,
             label: &'static str,
             want: Box<dyn Fn(&Value) -> bool + Send + Sync>| {
                let b = b.clone();
                let want = Arc::new(want);
                async move {
                    wait_for(label, Duration::from_secs(45), Duration::from_secs(2), || {
                    let (b, since, want) = (b.clone(), since.clone(), want.clone());
                    async move {
                        let res = api(&b, vec![("Email/changes", json!({ "accountId": "a", "sinceState": since, "maxChanges": 500 }), "c")]).await;
                        assert_ne!(res[0].0, "error", "{label} : {}", short(&res[0].1));
                        want(&res[0].1).then(|| res[0].1.clone())
                    }
                })
                .await
                }
            };
        let has = |v: &Value, k: &str, id: &str| v[k].as_array().unwrap().iter().any(|x| x == id);
        let s0 = one(&b, "Email/get", json!({ "ids": [] })).await["state"]
            .as_str()
            .unwrap()
            .to_string();
        let cr = one(
            &other,
            "Email/set",
            json!({ "create": { "e": {
                "mailboxIds": { inbox.clone(): true },
                "from": [{ "name": "Journal", "email": format!("journal.{run}@example.test") }],
                "subject": format!("{tag} journal"),
                "bodyValues": { "t": { "value": "journal" } },
                "textBody": [{ "partId": "t", "type": "text/plain" }],
            } } }),
        )
        .await;
        let jid = cr["created"]["e"]["id"].as_str().unwrap().to_string();
        let j = jid.clone();
        let c1 = changes_since(
            s0.clone(),
            "création visible",
            Box::new(move |c| has(c, "created", &j)),
        )
        .await;
        assert!(
            !has(&c1, "updated", &jid) && !has(&c1, "destroyed", &jid),
            "{}",
            short(&c1)
        );
        let g = one(&b, "Email/get", json!({ "ids": c1["created"], "properties": ["id", "mailboxIds", "keywords", "subject"] })).await;
        let mine = g["list"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == json!(jid))
            .expect("créé relu")
            .clone();
        assert_eq!(mine["mailboxIds"][&inbox], json!(true));
        assert!(mine["keywords"].get("$seen").is_none());
        let s1 = c1["newState"].as_str().unwrap().to_string();
        one(
            &other,
            "Email/set",
            json!({ "update": { jid.clone(): { "keywords/$seen": true } } }),
        )
        .await;
        let j = jid.clone();
        let c2 = changes_since(
            s1.clone(),
            "mot-clé visible",
            Box::new(move |c| has(c, "updated", &j)),
        )
        .await;
        assert!(
            !has(&c2, "created", &jid) && !has(&c2, "destroyed", &jid),
            "{}",
            short(&c2)
        );
        let s2 = c2["newState"].as_str().unwrap().to_string();
        one(&other, "Email/set", json!({ "destroy": [jid] })).await;
        let j = jid.clone();
        let c3 = changes_since(
            s2,
            "suppression visible",
            Box::new(move |c| has(c, "destroyed", &j)),
        )
        .await;
        assert!(!has(&c3, "created", &jid), "{}", short(&c3));
        let all = changes_since(s0, "fusion depuis s0", Box::new(|_| true)).await;
        assert!(
            !has(&all, "created", &jid)
                && !has(&all, "updated", &jid)
                && !has(&all, "destroyed", &jid),
            "{}",
            short(&all)
        );
        let fresh = ctx.backend(ctx.kv.clone());
        let r = api(
            &fresh,
            vec![(
                "Email/changes",
                json!({ "accountId": "a", "sinceState": s1 }),
                "c",
            )],
        )
        .await;
        fresh.close().await;
        assert_eq!(r[0].0, "error");
        assert_eq!(r[0].1["type"], json!("cannotCalculateChanges"));
        other.close().await;
        drain.abort();
    }

    // ---------------------------------------------------------------- méthodes annexes
    let echo = api(&b, vec![("Core/echo", json!({ "hello": run }), "e")]).await;
    assert_eq!(pick(&echo, "e", "Core/echo"), json!({ "hello": run }));
    let mq = one(
        &b,
        "Mailbox/query",
        json!({ "filter": { "role": "inbox" } }),
    )
    .await;
    assert_eq!(mq["ids"], json!([inbox]));
    let sn = one(
        &b,
        "SearchSnippet/get",
        json!({ "filter": { "text": run }, "emailIds": [seeds[2]] }),
    )
    .await;
    assert!(
        sn["list"][0]["preview"]
            .as_str()
            .unwrap_or("")
            .contains(&run)
    );
    let qr = one(
        &b,
        "Email/query",
        json!({ "filter": { "inMailbox": inbox }, "limit": 5 }),
    )
    .await;
    let qc = one(
        &b,
        "Email/queryChanges",
        json!({ "filter": { "inMailbox": inbox }, "sinceQueryState": qr["queryState"] }),
    )
    .await;
    assert_eq!(qc["added"], json!([]));
    let c = one(&b, "Identity/set", json!({ "create": { "n": { "name": "Voxel test", "email": me_addr, "textSignature": format!("[{tag}]") } } })).await;
    let nid = c["created"]["n"]["id"].as_str().unwrap().to_string();
    let d = one(&b, "Identity/set", json!({ "destroy": [nid] })).await;
    assert_eq!(d["destroyed"], json!([nid]));
    let sg = one(&b, "EmailSubmission/get", json!({ "ids": ["nope"] })).await;
    assert_eq!(sg["notFound"], json!(["nope"]));
    assert!(
        b.download("a".into(), format!("{}.../etc", seeds[2]), None)
            .await
            .is_err()
    );

    // ---------------------------------------------------------------- QUOTA et compagnons absents
    b.probe().await;
    let s = b.session().await.unwrap();
    let has_quota = s["capabilities"]
        .get("urn:ietf:params:jmap:quota")
        .is_some();
    assert!(
        s["capabilities"]
            .get("urn:ietf:params:jmap:sieve")
            .is_none()
    );
    let res = api(
        &b,
        vec![
            ("Quota/get", json!({ "accountId": "a", "ids": null }), "q"),
            (
                "SieveScript/get",
                json!({ "accountId": "a", "ids": null }),
                "s",
            ),
        ],
    )
    .await;
    if has_quota {
        assert_eq!(res[0].0, "Quota/get", "{}", short(&res[0].1));
        for x in res[0].1["list"].as_array().unwrap() {
            assert_eq!(x["resourceType"], json!("octets"));
            assert!(x["hardLimit"].as_u64().unwrap() > 0);
        }
    } else {
        assert_eq!(res[0].0, "error");
    }
    assert_eq!(res[1].0, "error");
    assert_eq!(res[1].1["type"], json!("unknownMethod"));

    // ---------------------------------------------------------------- Email/import d'un .eml
    let raw = format!(
        "From: {me_addr}\r\nTo: {me_addr}\r\nSubject: {tag} import\r\nDate: Tue, 03 Nov 2026 10:00:00 +0000\r\nMessage-ID: <voxel-rust-{run}@voxel-test>\r\nX-Priority: 1 (Highest)\r\nImportance: high\r\nDisposition-Notification-To: {me_addr}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBonjour\r\n"
    );
    let up = b
        .upload(
            "a".into(),
            Bytes::from(raw.into_bytes()),
            "message/rfc822".into(),
        )
        .await
        .unwrap();
    let r = one(&b, "Email/import", json!({ "emails": { "i": { "blobId": up.blob_id, "mailboxIds": { folder_b.clone(): true }, "keywords": { "$seen": true }, "receivedAt": "2026-11-03T10:00:00Z" } } })).await;
    let iid = r["created"]["i"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", short(&r["notCreated"])))
        .to_string();
    let g = one(&b, "Email/get", json!({ "ids": [iid], "properties": ["subject", "keywords", "receivedAt", "mailboxIds", "header:X-Priority:asText", "header:Importance:asText", "header:Disposition-Notification-To:asAddresses"] })).await;
    let e = g["list"][0].clone();
    assert_eq!(e["subject"], json!(format!("{tag} import")));
    assert_eq!(e["keywords"]["$seen"], json!(true));
    assert_eq!(e["receivedAt"], json!("2026-11-03T10:00:00Z"));
    assert_eq!(e["header:X-Priority:asText"], json!("1 (Highest)"));
    assert_eq!(e["header:Importance:asText"], json!("high"));
    assert_eq!(
        e["header:Disposition-Notification-To:asAddresses"],
        json!([{ "name": null, "email": me_addr }])
    );
    let bad = one(&b, "Email/import", json!({ "emails": { "z": { "blobId": "inexistant", "mailboxIds": { folder_b.clone(): true } } } })).await;
    assert_eq!(bad["notCreated"]["z"]["type"], json!("blobNotFound"));

    // ---------------------------------------------------------------- accusé de lecture importé puis envoyé à soi
    let mdn_subject = format!("Lu : {tag} accusé");
    let boundary = format!("voxel-mdn-{run}");
    let mdn = format!(
        "From: {me_addr}\r\nTo: {me_addr}\r\nSubject: {mdn_subject}\r\nDate: Tue, 03 Nov 2026 10:05:00 +0000\r\nMessage-ID: <voxel-rust-mdn-{run}@voxel-test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=disposition-notification; boundary=\"{boundary}\"\r\n\r\n--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nVotre message a été affiché.\r\n--{boundary}\r\nContent-Type: message/disposition-notification\r\n\r\nReporting-UA: Voxel\r\nFinal-Recipient: rfc822;{me_addr}\r\nOriginal-Message-ID: <voxel-rust-{run}@voxel-test>\r\nDisposition: automatic-action/MDN-sent-automatically; displayed\r\n--{boundary}--\r\n"
    );
    let up = b
        .upload(
            "a".into(),
            Bytes::from(mdn.into_bytes()),
            "message/rfc822".into(),
        )
        .await
        .unwrap();
    let res = api(
        &b,
        vec![
            ("Email/import", json!({ "accountId": "a", "emails": { "mdn": { "blobId": up.blob_id, "mailboxIds": { folder_b.clone(): true }, "keywords": { "$seen": true } } } }), "a"),
            ("EmailSubmission/set", json!({ "accountId": "a", "create": { "s": { "identityId": def_id, "emailId": "#mdn", "envelope": { "mailFrom": { "email": me_addr, "parameters": null }, "rcptTo": [{ "email": me_addr, "parameters": null }] } } } }), "b"),
        ],
    )
    .await;
    let sub = pick(&res, "b", "EmailSubmission/set");
    assert!(sub["created"]["s"]["id"].is_string(), "{}", short(&sub));
    let got = wait_for("accusé reçu", Duration::from_secs(90), Duration::from_secs(2), || {
        let (b, inbox, subject) = (b.clone(), inbox.clone(), mdn_subject.clone());
        async move {
            let q = one(&b, "Email/query", json!({ "filter": { "operator": "AND", "conditions": [{ "inMailbox": inbox }, { "subject": subject }] } })).await;
            ids_of(&q).into_iter().next()
        }
    })
    .await;
    let g = one(
        &b,
        "Email/get",
        json!({ "ids": [got], "properties": ["header:Content-Type:asText"] }),
    )
    .await;
    let ct = g["list"][0]["header:Content-Type:asText"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(regex_like_report(&ct), "Content-Type de l'accusé : {ct}");
}

async fn roles_of(b: &ImapBackend) -> std::collections::HashMap<String, String> {
    roles(b).await
}

/// `multipart/report;\s*report-type=disposition-notification`.
fn regex_like_report(ct: &str) -> bool {
    let Some(rest) = ct.strip_prefix("multipart/report;") else {
        return false;
    };
    rest.trim_start()
        .starts_with("report-type=disposition-notification")
}
