//! Façades CardDAV et CalDAV contre la boîte de test dédiée (`.env.test.local`, ou les variables `VOXEL_TEST_*`).
//! Port de `apps/server/test/integration-b2.test.ts` et `integration-b3.test.ts` : service
//! `https://<hôte IMAP>/.well-known/carddav` (et `caldav`). Sans variables de test, chaque test s'arrête aussitôt.
//! Tout ce qui porte un uid `voxel-test-` ou un nom `Voxel Test` est supprimé à la fin, même en cas d'échec.
//! Les identifiants ne sont jamais affichés.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{CallContext, Companion, UploadSource};
use voxel_core::jmap::{CreatedIds, Object};
use voxel_core::net::{HttpClient, HttpRequest};
use voxel_dav::client::{DavClient, DavError, DavHttpResponse, DavKind, PutResult};
use voxel_dav::{CalDavFacade, CardDavFacade, DavTransport, HttpDavTransport};

struct TestEnv {
    user: String,
    password: String,
    imap_host: String,
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
        // `host:port:ssl|starttls`
        let imap_host = values[2].rsplitn(3, ':').nth(2)?.to_string();
        Some(TestEnv {
            user: values[0].clone(),
            password: values[1].clone(),
            imap_host,
        })
    }

    fn service(&self, kind: &str) -> url::Url {
        url::Url::parse(&format!("https://{}/.well-known/{kind}", self.imap_host)).unwrap()
    }
}

/// Les deux tests jouent l'un après l'autre : la boîte de test limite le nombre de requêtes HTTP.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Attente maximale lue dans `Retry-After`.
const MAX_RETRY_AFTER: u64 = 120;

/// Attente quand `Retry-After` manque.
const DEFAULT_RETRY_AFTER: u64 = 10;

/// Nombre maximal d'essais d'une requête.
const MAX_ATTEMPTS: usize = 6;

/// Transport de test : `HttpDavTransport`, qui réessaie une requête refusée en 429 après `Retry-After`.
struct RetryTransport(HttpDavTransport);

impl DavTransport for RetryTransport {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<DavHttpResponse, DavError>> {
        Box::pin(async move {
            let mut attempt = 1;
            loop {
                let copy = HttpRequest {
                    method: request.method.clone(),
                    url: request.url.clone(),
                    headers: request.headers.clone(),
                    body: request.body.clone(),
                };
                let res = self.0.send(copy, timeout).await?;
                if res.status != 429 || attempt >= MAX_ATTEMPTS {
                    return Ok(res);
                }
                let wait = res
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("retry-after"))
                    .and_then(|(_, v)| v.trim().parse::<u64>().ok())
                    .unwrap_or(DEFAULT_RETRY_AFTER)
                    .min(MAX_RETRY_AFTER);
                eprintln!("429 : nouvel essai dans {wait} s");
                tokio::time::sleep(Duration::from_secs(wait)).await;
                attempt += 1;
            }
        })
    }
}

fn transport() -> Arc<dyn DavTransport> {
    Arc::new(RetryTransport(HttpDavTransport {
        client: HttpClient::new().unwrap(),
    }))
}

fn tag() -> String {
    format!("voxel-test-{}", chrono::Utc::now().timestamp_millis())
}

#[derive(Default)]
struct Uploads(Mutex<BTreeMap<String, Vec<u8>>>);

impl UploadSource for Uploads {
    fn load<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<bytes::Bytes>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .get(blob_id)
                .cloned()
                .map(bytes::Bytes::from)
        })
    }
}

async fn api(
    f: &dyn Companion,
    method: &str,
    args: Value,
    created: &mut CreatedIds,
    uploads: &Uploads,
) -> Value {
    let args: Object = args.as_object().cloned().unwrap_or_default();
    match f.call(method, args, CallContext { created, uploads }).await {
        Ok(o) => Value::Object(o),
        Err(e) => panic!("{method} : {e:?}"),
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Supprime directement en DAV toute ressource de test restante ; renvoie le nombre de ressources supprimées.
async fn cleanup(env: &TestEnv, kind: DavKind) -> usize {
    let service = env.service(if kind == DavKind::Card {
        "carddav"
    } else {
        "caldav"
    });
    let dav = DavClient::new(service, &env.user, &env.password, transport());
    let mut left = 0;
    let Ok(books) = dav.discover(kind, Duration::from_secs(15)).await else {
        return 0;
    };
    for book in books {
        let Ok(members) = dav.list_members(&book.href).await else {
            continue;
        };
        if members.is_empty() {
            continue;
        }
        let hrefs: Vec<String> = members.iter().map(|m| m.href.clone()).collect();
        for (href, etag, data) in dav
            .multiget(&book.href, &hrefs, kind)
            .await
            .unwrap_or_default()
        {
            let upper = data.to_uppercase();
            let ours = upper.contains("UID:VOXEL-TEST-")
                || upper.contains("UID:URN:UUID:VOXEL-TEST-")
                || data.contains("FN:Voxel Test ")
                || data.contains("SUMMARY:Voxel Test");
            if ours {
                let etag = Some(etag.as_str()).filter(|e| !e.is_empty());
                if dav.delete(&href, etag).await.is_ok() {
                    left += 1;
                }
            }
        }
    }
    left
}

async fn contacts_scenario(env: &TestEnv, tag: &str) {
    let f = CardDavFacade::new(
        env.service("carddav"),
        env.user.clone(),
        env.password.clone(),
        transport(),
    );
    let uploads = Uploads::default();
    let mut ids = CreatedIds::default();
    f.probe().await;
    assert!(f.available(), "CardDAV indisponible");
    let caps = f.capabilities().unwrap();
    assert!(caps.core.contains_key("urn:ietf:params:jmap:contacts"));
    assert!(
        caps.core
            .contains_key("urn:ietf:params:jmap:contacts:parse")
    );

    let books = api(
        &*f,
        "AddressBook/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await;
    let list = books["list"].as_array().unwrap();
    assert!(!list.is_empty());
    let book = list
        .iter()
        .find(|b| b["isDefault"] == true)
        .unwrap_or(&list[0])
        .clone();
    let book_id = book["id"].as_str().unwrap().to_string();
    eprintln!("carnets : {}", list.len());
    let state0 = api(
        &*f,
        "ContactCard/get",
        json!({"ids": []}),
        &mut ids,
        &uploads,
    )
    .await["state"]
        .clone();

    let s1 = api(
        &*f,
        "ContactCard/set",
        json!({"create": {
            "a": {
                "addressBookIds": {book_id.clone(): true},
                "uid": format!("{tag}-a"),
                "name": {"full": "Voxel Test Alice", "components": [{"kind": "given", "value": "Alice"}, {"kind": "surname", "value": "Test"}]},
                "emails": {"e1": {"address": format!("{tag}-alice@example.com"), "contexts": {"work": true}}},
                "phones": {"p1": {"number": "+33 6 00 00 00 00", "features": {"mobile": true}}},
                "vCard": {"properties": [["x-voxel-test", {}, "unknown", "conserve"]]}
            },
            "b": {"addressBookIds": {book_id.clone(): true}, "uid": format!("{tag}-b"), "name": {"full": "Voxel Test Bruno"}, "emails": {"e1": {"address": format!("{tag}-bruno@example.com")}}}
        }}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(s1["notCreated"], Value::Null, "{}", s1["notCreated"]);
    let id_a = s1["created"]["a"]["id"].as_str().unwrap().to_string();
    let id_b = s1["created"]["b"]["id"].as_str().unwrap().to_string();

    let g1 = api(
        &*f,
        "ContactCard/get",
        json!({"ids": [id_a, id_b]}),
        &mut ids,
        &uploads,
    )
    .await;
    let alice = g1["list"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id_a.as_str())
        .unwrap()
        .clone();
    assert_eq!(alice["name"]["full"], "Voxel Test Alice");
    let email = alice["emails"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()["address"]
        .clone();
    assert_eq!(email, json!(format!("{tag}-alice@example.com")));
    let kept = alice["vCard"]["properties"].as_array().is_some_and(|p| {
        p.iter()
            .any(|p| p[0] == "x-voxel-test" && p[3] == "conserve")
    });
    assert!(kept, "propriété inconnue perdue");

    let q = api(
        &*f,
        "ContactCard/query",
        json!({"filter": {"text": format!("{tag}-bruno")}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(strs(&q["ids"]), vec![id_b.clone()]);

    // groupe : membres par uid
    let s2 = api(
        &*f,
        "ContactCard/set",
        json!({"create": {"g": {"addressBookIds": {book_id.clone(): true}, "uid": format!("{tag}-g"), "kind": "group", "name": {"full": "Voxel Test Groupe"}, "members": {format!("{tag}-a"): true}}}}),
        &mut ids,
        &uploads,
    )
    .await;
    let id_g = s2["created"]["g"]["id"].as_str().unwrap().to_string();
    let s3 = api(
        &*f,
        "ContactCard/set",
        json!({"update": {id_g.clone(): {format!("members/{tag}-b"): true}, id_a.clone(): {"name/full": "Voxel Test Alice Modifiée"}}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(s3["notUpdated"], Value::Null, "{}", s3["notUpdated"]);
    let g2 = api(
        &*f,
        "ContactCard/get",
        json!({"ids": [id_g, id_a]}),
        &mut ids,
        &uploads,
    )
    .await;
    let find = |id: &str| {
        g2["list"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
            .clone()
    };
    let group = find(&id_g);
    assert_eq!(group["kind"], "group");
    let mut members: Vec<String> = group["members"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    members.sort();
    assert_eq!(members, vec![format!("{tag}-a"), format!("{tag}-b")]);
    assert_eq!(find(&id_a)["name"]["full"], "Voxel Test Alice Modifiée");

    // changes depuis l'état initial
    let ch = api(
        &*f,
        "ContactCard/changes",
        json!({"sinceState": state0}),
        &mut ids,
        &uploads,
    )
    .await;
    let seen = [strs(&ch["created"]), strs(&ch["updated"])].concat();
    for id in [&id_a, &id_b, &id_g] {
        assert!(seen.contains(id), "changes sans {id}");
    }

    // conflit d'ETag (412) vu par le client DAV
    let dav = DavClient::new(
        env.service("carddav"),
        &env.user,
        &env.password,
        transport(),
    );
    let books = dav
        .discover(DavKind::Card, Duration::from_secs(15))
        .await
        .unwrap();
    let book_href = books
        .iter()
        .find(|b| book["name"] == b.name.as_str())
        .unwrap()
        .href
        .clone();
    let mine = dav
        .list_members(&book_href)
        .await
        .unwrap()
        .into_iter()
        .find(|m| m.href.contains(&format!("{tag}-b")))
        .unwrap();
    let conflict = dav
        .put(
            &mine.href,
            "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:x\r\nFN:x\r\nEND:VCARD\r\n",
            Some("\"etag-perime\""),
            "text/vcard; charset=utf-8",
        )
        .await
        .unwrap();
    assert!(matches!(conflict, PutResult::Conflict));

    // parse d'un fichier de deux vCard téléversé
    let vcf = format!(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Voxel Test Import 1\r\nEMAIL:{tag}-i1@example.com\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Voxel Test Import 2\r\nEND:VCARD\r\n"
    );
    uploads
        .0
        .lock()
        .unwrap()
        .insert("U1".into(), vcf.into_bytes());
    let p = api(
        &*f,
        "ContactCard/parse",
        json!({"blobIds": ["U1"]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(p["parsed"]["U1"].as_array().map(Vec::len), Some(2));

    // suppression, puis changes
    let g3 = api(
        &*f,
        "ContactCard/get",
        json!({"ids": []}),
        &mut ids,
        &uploads,
    )
    .await;
    let s4 = api(
        &*f,
        "ContactCard/set",
        json!({"destroy": [id_a, id_b, id_g]}),
        &mut ids,
        &uploads,
    )
    .await;
    let mut destroyed = strs(&s4["destroyed"]);
    destroyed.sort();
    let mut expected = vec![id_a.clone(), id_b.clone(), id_g.clone()];
    expected.sort();
    assert_eq!(destroyed, expected);
    let ch2 = api(
        &*f,
        "ContactCard/changes",
        json!({"sinceState": g3["state"]}),
        &mut ids,
        &uploads,
    )
    .await;
    for id in [&id_a, &id_b, &id_g] {
        assert!(
            strs(&ch2["destroyed"]).contains(id),
            "destruction de {id} absente de changes"
        );
    }
    f.close();
}

async fn calendars_scenario(env: &TestEnv, tag: &str) {
    let f = CalDavFacade::new(
        env.service("caldav"),
        env.user.clone(),
        env.password.clone(),
        transport(),
    );
    let uploads = Uploads::default();
    let mut ids = CreatedIds::default();
    f.probe().await;
    assert!(f.available(), "CalDAV indisponible");
    let caps = f.capabilities().unwrap();
    assert!(caps.core.contains_key("urn:ietf:params:jmap:calendars"));
    assert!(
        caps.core
            .contains_key("urn:ietf:params:jmap:calendars:parse")
    );

    let cals = api(
        &*f,
        "Calendar/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await;
    let cal = cals["list"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["isDefault"] == true)
        .unwrap()
        .clone();
    let cal_id = cal["id"].as_str().unwrap().to_string();
    let s0 = api(
        &*f,
        "CalendarEvent/get",
        json!({"ids": []}),
        &mut ids,
        &uploads,
    )
    .await["state"]
        .clone();

    let set1 = api(
        &*f,
        "CalendarEvent/set",
        json!({"create": {"s": {
            "calendarIds": {cal_id.clone(): true},
            "uid": format!("{tag}-serie"),
            "title": "Voxel Test série B3",
            "start": "2026-11-10T09:00:00",
            "timeZone": "Europe/Paris",
            "duration": "PT1H",
            "recurrenceRules": [{"@type": "RecurrenceRule", "frequency": "weekly", "byDay": [{"@type": "NDay", "day": "tu"}, {"@type": "NDay", "day": "th"}], "count": 6}],
            "recurrenceOverrides": {"2026-11-17T09:00:00": {"excluded": true}},
            "alerts": {"a": {"@type": "Alert", "trigger": {"@type": "OffsetTrigger", "offset": "-PT15M"}, "action": "display"}},
            "participants": {"o": {"@type": "Participant", "calendarAddress": format!("mailto:{}", env.user), "roles": {"owner": true, "attendee": true}, "participationStatus": "accepted"}},
            "iCalendar": {"name": "vevent", "properties": [["x-voxel-test", {}, "unknown", "garde-moi"]]}
        }}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(set1["notCreated"], Value::Null, "{}", set1["notCreated"]);
    let id = set1["created"]["s"]["id"].as_str().unwrap().to_string();

    // relu par CalDAV : fuseau, règle, exclusion, alarme, propriété inconnue
    let g = api(
        &*f,
        "CalendarEvent/get",
        json!({"ids": [id]}),
        &mut ids,
        &uploads,
    )
    .await;
    let ev = &g["list"][0];
    assert_eq!(ev["timeZone"], "Europe/Paris");
    assert_eq!(ev["recurrenceRules"][0]["count"], 6);
    assert_eq!(
        ev["recurrenceOverrides"],
        json!({"2026-11-17T09:00:00": {"excluded": true}})
    );
    assert_eq!(ev["alerts"].as_object().map(|a| a.len()), Some(1));
    let kept = ev["iCalendar"]["properties"].as_array().is_some_and(|p| {
        p.iter()
            .any(|p| p[0] == "x-voxel-test" && p[3] == "garde-moi")
    });
    assert!(kept, "propriété inconnue perdue");

    // plage (calendar-query + time-range du serveur) et occurrences développées
    let range = json!({"inCalendar": cal_id.clone(), "after": "2026-11-09T00:00:00Z", "before": "2026-11-20T00:00:00Z"});
    let q = api(
        &*f,
        "CalendarEvent/query",
        json!({"filter": range}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(strs(&q["ids"]).contains(&id));
    let mut filter = range.clone();
    filter["text"] = json!("série B3");
    let qe = api(
        &*f,
        "CalendarEvent/query",
        json!({"filter": filter, "expandRecurrences": true}),
        &mut ids,
        &uploads,
    )
    .await;
    let occ_ids = strs(&qe["ids"]);
    // l'id de l'événement (empreinte base64url) peut lui-même contenir « _ » : on coupe au dernier
    let suffixes: Vec<&str> = occ_ids
        .iter()
        .map(|x| &x[x.rfind('_').unwrap() + 1..])
        .collect();
    assert_eq!(
        suffixes,
        vec!["20261110T090000", "20261112T090000", "20261119T090000"]
    );

    // « cet événement » : exception sur une occurrence ; sendSchedulingMessages ignoré (pas d'iTIP)
    let u = api(
        &*f,
        "CalendarEvent/set",
        json!({"update": {occ_ids[1].clone(): {"title": "Voxel Test déplacé", "start": "2026-11-12T11:00:00"}}, "sendSchedulingMessages": true}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(u["notUpdated"], Value::Null, "{}", u["notUpdated"]);
    let g2 = api(
        &*f,
        "CalendarEvent/get",
        json!({"ids": [id, occ_ids[1]]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(
        g2["list"][0]["recurrenceOverrides"]["2026-11-12T09:00:00"]["title"],
        "Voxel Test déplacé"
    );
    assert_eq!(g2["list"][1]["start"], "2026-11-12T11:00:00");
    assert_eq!(g2["list"][1]["baseEventId"], json!(id));

    // changes, puis suppression
    let ch = api(
        &*f,
        "CalendarEvent/changes",
        json!({"sinceState": s0}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(
        [strs(&ch["created"]), strs(&ch["updated"])]
            .concat()
            .contains(&id)
    );
    let d = api(
        &*f,
        "CalendarEvent/set",
        json!({"destroy": [id]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(d["destroyed"], json!([id]));
    let ch2 = api(
        &*f,
        "CalendarEvent/changes",
        json!({"sinceState": ch["newState"]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(strs(&ch2["destroyed"]).contains(&id));
    f.close();
}

#[tokio::test]
async fn live_contacts() {
    let _serial = SERIAL.lock().await;
    let Some(env) = TestEnv::load() else {
        eprintln!("VOXEL_TEST_* non définies : test sauté");
        return;
    };
    let tag = tag();
    let outcome = std::panic::AssertUnwindSafe(contacts_scenario(&env, &tag))
        .catch_unwind()
        .await;
    cleanup(&env, DavKind::Card).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    assert_eq!(
        cleanup(&env, DavKind::Card).await,
        0,
        "fiches de test restantes"
    );
}

#[tokio::test]
async fn live_calendars() {
    let _serial = SERIAL.lock().await;
    let Some(env) = TestEnv::load() else {
        eprintln!("VOXEL_TEST_* non définies : test sauté");
        return;
    };
    let tag = tag();
    let outcome = std::panic::AssertUnwindSafe(calendars_scenario(&env, &tag))
        .catch_unwind()
        .await;
    cleanup(&env, DavKind::Cal).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    assert_eq!(
        cleanup(&env, DavKind::Cal).await,
        0,
        "événements de test restants"
    );
}
