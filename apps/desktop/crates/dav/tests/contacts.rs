//! Client WebDAV et façade CardDAV → JMAP Contacts contre un faux serveur DAV en mémoire (avec et sans
//! `sync-collection`), branché comme `DavTransport`. Port de `apps/server/test/carddav.test.ts` ; la validation de
//! `X-Voxel-CardDav` relève de la passerelle (WP5).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use voxel_core::backend::{CallContext, Companion, UploadSource};
use voxel_core::jmap::{CreatedIds, FacadeError, Object};
use voxel_core::net::HttpRequest;
use voxel_dav::CardDavFacade;
use voxel_dav::client::{DavClient, DavError, DavHttpResponse, DavKind, DavTransport};

// ------------------------------------------------------------------ faux serveur DAV

const ORIGIN: &str = "https://dav.example.com";
const DEFAULT: &str = "/dav/card/u/default/";
const WORK: &str = "/dav/card/u/work/";

struct Item {
    etag: String,
    data: String,
}

struct Book {
    href: String,
    name: String,
    items: Vec<(String, Item)>,
    ctag: u32,
}

struct LogEntry {
    v: u32,
    href: String,
    book: String,
    deleted: bool,
}

struct State {
    books: Vec<Book>,
    log: Vec<LogEntry>,
    version: u32,
    etag_n: u32,
}

impl State {
    fn book(&mut self, href: &str) -> &mut Book {
        self.books.iter_mut().find(|b| b.href == href).unwrap()
    }

    fn bump(&mut self, book: &str, href: String, deleted: bool) {
        self.version += 1;
        let v = self.version;
        self.log.push(LogEntry {
            v,
            href,
            book: book.to_string(),
            deleted,
        });
        self.book(book).ctag += 1;
    }

    fn set_item(&mut self, book: &str, name: &str, data: &str) -> String {
        self.etag_n += 1;
        let etag = format!("\"{}\"", self.etag_n);
        let b = self.book(book);
        let item = Item {
            etag: etag.clone(),
            data: data.to_string(),
        };
        match b.items.iter_mut().find(|(n, _)| n == name) {
            Some(e) => e.1 = item,
            None => b.items.push((name.to_string(), item)),
        }
        etag
    }
}

struct FakeDav {
    sync: bool,
    auth: String,
    state: Mutex<State>,
    /// Modification « par un autre client » juste avant le prochain PUT.
    race: Mutex<Option<(String, String, String)>>,
}

fn percent_decode(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(Ok(v)) = text.get(i + 1..i + 3).map(|h| u8::from_str_radix(h, 16))
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

fn ms(inner: &str, token: Option<&str>) -> String {
    format!(
        "<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\" xmlns:B=\"urn:ietf:params:xml:ns:carddav\" xmlns:C=\"http://calendarserver.org/ns/\">{inner}{}</D:multistatus>",
        token
            .map(|t| format!("<D:sync-token>{t}</D:sync-token>"))
            .unwrap_or_default()
    )
}

fn ok(href: &str, props: &str) -> String {
    format!(
        "<D:response><D:href>{href}</D:href><D:propstat><D:prop>{props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
    )
}

fn gone(href: &str) -> String {
    format!(
        "<D:response><D:href>{href}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>"
    )
}

fn reply(status: u16, body: String, headers: Vec<(&str, String)>) -> DavHttpResponse {
    DavHttpResponse {
        status,
        headers: headers
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        body: bytes::Bytes::from(body),
    }
}

impl FakeDav {
    fn new(sync: bool, user: &str, pass: &str) -> Arc<Self> {
        let book = |href: &str, name: &str| Book {
            href: href.into(),
            name: name.into(),
            items: Vec::new(),
            ctag: 1,
        };
        Arc::new(Self {
            sync,
            auth: format!("Basic {}", STANDARD.encode(format!("{user}:{pass}"))),
            state: Mutex::new(State {
                books: vec![book(DEFAULT, "Contacts"), book(WORK, "Travail")],
                log: Vec::new(),
                version: 1,
                etag_n: 100,
            }),
            race: Mutex::new(None),
        })
    }

    fn touch(&self, book: &str, name: &str, data: &str) {
        let mut st = self.state.lock().unwrap();
        st.set_item(book, name, data);
        st.bump(book, format!("{book}{name}"), false);
    }

    fn item(&self, book: &str, name: &str) -> Option<String> {
        let mut st = self.state.lock().unwrap();
        st.book(book)
            .items
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, i)| i.data.clone())
    }

    fn count(&self, book: &str) -> usize {
        self.state.lock().unwrap().book(book).items.len()
    }

    fn reports(&self) -> String {
        format!(
            "<D:supported-report-set>{}<D:supported-report><D:report><B:addressbook-multiget/></D:report></D:supported-report></D:supported-report-set>",
            if self.sync {
                "<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>"
            } else {
                ""
            }
        )
    }

    fn handle(
        &self,
        method: &str,
        url: &url::Url,
        headers: &[(String, String)],
        body: &str,
    ) -> DavHttpResponse {
        let header = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        if header("authorization").as_deref() != Some(self.auth.as_str()) {
            return reply(
                401,
                String::new(),
                vec![("WWW-Authenticate", "Basic".into())],
            );
        }
        let path = percent_decode(url.path());
        if method == "PUT"
            && let Some((book, name, data)) = self.race.lock().unwrap().take()
        {
            self.touch(&book, &name, &data);
        }
        let mut st = self.state.lock().unwrap();
        if method == "PROPFIND" && path == "/.well-known/carddav" {
            return reply(301, String::new(), vec![("Location", "/dav/card/".into())]);
        }
        if method == "PROPFIND" && path == "/dav/card/" {
            let props = "<D:current-user-principal><D:href>/dav/principals/u/</D:href></D:current-user-principal>";
            return reply(207, ms(&ok("/dav/card/", props), None), vec![]);
        }
        if method == "PROPFIND" && path == "/dav/principals/u/" {
            let props =
                "<B:addressbook-home-set><D:href>/dav/card/u/</D:href></B:addressbook-home-set>";
            return reply(207, ms(&ok("/dav/principals/u/", props), None), vec![]);
        }
        if method == "PROPFIND" && path == "/dav/card/u/" {
            let mut inner = ok(
                "/dav/card/u/",
                "<D:resourcetype><D:collection/></D:resourcetype>",
            );
            for b in &st.books {
                inner += &ok(
                    &b.href,
                    &format!(
                        "<D:resourcetype><D:collection/><B:addressbook/></D:resourcetype><D:displayname>{}</D:displayname><C:getctag>\"{}\"</C:getctag>{}{}<D:current-user-privilege-set><D:privilege><D:all/></D:privilege></D:current-user-privilege-set>",
                        b.name,
                        b.ctag,
                        if self.sync {
                            format!("<D:sync-token>tok-{}</D:sync-token>", st.version)
                        } else {
                            String::new()
                        },
                        self.reports()
                    ),
                );
            }
            return reply(207, ms(&inner, None), vec![]);
        }
        let Some(book_href) = st
            .books
            .iter()
            .map(|b| b.href.clone())
            .find(|h| path.starts_with(h.as_str()))
        else {
            return reply(404, String::new(), vec![]);
        };
        if method == "PROPFIND" && path == book_href {
            let mut inner = ok(
                &book_href,
                "<D:resourcetype><D:collection/><B:addressbook/></D:resourcetype>",
            );
            for (name, it) in &st.book(&book_href).items {
                inner += &ok(
                    &format!("{book_href}{}", encode(name)),
                    &format!("<D:getetag>{}</D:getetag><D:resourcetype/>", xml(&it.etag)),
                );
            }
            return reply(207, ms(&inner, None), vec![]);
        }
        if method == "REPORT" && body.contains("sync-collection") {
            if !self.sync {
                return reply(403, String::new(), vec![]);
            }
            let tok = body
                .split("<d:sync-token>")
                .nth(1)
                .and_then(|r| r.split('<').next())
                .unwrap_or("")
                .to_string();
            let since: u32 = tok.trim_start_matches("tok-").parse().unwrap_or(0);
            let valid = tok.starts_with("tok-") && tok[4..].bytes().all(|b| b.is_ascii_digit());
            if !tok.is_empty() && !valid {
                return reply(403, "<error><valid-sync-token/></error>".into(), vec![]);
            }
            let mut inner = String::new();
            let mut seen: Vec<String> = Vec::new();
            let log: Vec<(u32, String, String, bool)> = st
                .log
                .iter()
                .rev()
                .map(|e| (e.v, e.href.clone(), e.book.clone(), e.deleted))
                .collect();
            for (v, href, book, deleted) in log {
                if v <= since || book != book_href || seen.contains(&href) {
                    continue;
                }
                seen.push(href.clone());
                let name = href[book_href.len()..].to_string();
                let item = st
                    .book(&book_href)
                    .items
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, i)| i.etag.clone());
                let target = format!("{book_href}{}", encode(&name));
                inner += &match item {
                    Some(etag) if !deleted => {
                        ok(&target, &format!("<D:getetag>{}</D:getetag>", xml(&etag)))
                    }
                    _ => gone(&target),
                };
            }
            if tok.is_empty() {
                for (name, it) in &st.book(&book_href).items {
                    if !seen.contains(&format!("{book_href}{name}")) {
                        inner += &ok(
                            &format!("{book_href}{}", encode(name)),
                            &format!("<D:getetag>{}</D:getetag>", xml(&it.etag)),
                        );
                    }
                }
            }
            let token = format!("tok-{}", st.version);
            return reply(207, ms(&inner, Some(&token)), vec![]);
        }
        if method == "REPORT" && body.contains("addressbook-multiget") {
            let mut inner = String::new();
            for part in body.split("<d:href>").skip(1) {
                let href = part.split("</d:href>").next().unwrap_or("");
                let name = percent_decode(href)[book_href.len()..].to_string();
                inner += &match st.book(&book_href).items.iter().find(|(n, _)| *n == name) {
                    Some((_, it)) => ok(
                        href,
                        &format!(
                            "<D:getetag>{}</D:getetag><B:address-data><![CDATA[{}]]></B:address-data>",
                            xml(&it.etag),
                            it.data
                        ),
                    ),
                    None => gone(href),
                };
            }
            return reply(207, ms(&inner, None), vec![]);
        }
        let name = path[book_href.len()..].to_string();
        let cur = st
            .book(&book_href)
            .items
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, i)| i.etag.clone());
        match method {
            "PUT" => {
                if header("if-none-match").as_deref() == Some("*") && cur.is_some() {
                    return reply(412, String::new(), vec![]);
                }
                if let Some(im) = header("if-match")
                    && cur.as_deref() != Some(im.as_str())
                {
                    return reply(412, String::new(), vec![]);
                }
                let etag = st.set_item(&book_href, &name, body);
                st.bump(&book_href, format!("{book_href}{name}"), false);
                reply(
                    if cur.is_some() { 204 } else { 201 },
                    String::new(),
                    vec![("ETag", etag)],
                )
            }
            "DELETE" => {
                let Some(cur) = cur else {
                    return reply(404, String::new(), vec![]);
                };
                if let Some(im) = header("if-match")
                    && cur != im
                {
                    return reply(412, String::new(), vec![]);
                }
                st.book(&book_href).items.retain(|(n, _)| *n != name);
                st.bump(&book_href, format!("{book_href}{name}"), true);
                reply(204, String::new(), vec![])
            }
            _ => reply(405, String::new(), vec![]),
        }
    }
}

impl DavTransport for FakeDav {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        _timeout: Duration,
    ) -> BoxFuture<'a, Result<DavHttpResponse, DavError>> {
        Box::pin(async move {
            // comme HttpClient::fetch : redirections suivies
            let mut url = url::Url::parse(&request.url).unwrap();
            let body = String::from_utf8_lossy(&request.body).into_owned();
            for _ in 0..5 {
                let res = self.handle(request.method.as_str(), &url, &request.headers, &body);
                let location = res
                    .headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("location"))
                    .map(|(_, v)| v.clone());
                match location {
                    Some(loc) if (300..400).contains(&res.status) => url = url.join(&loc).unwrap(),
                    _ => return Ok(res),
                }
            }
            Err(DavError::Network("too many redirects".into()))
        })
    }
}

fn vcard(uid: &str, full: &str, email: &str) -> String {
    format!(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:{full}\r\nEMAIL;TYPE=INTERNET:{email}\r\nX-CUSTOM:garde-moi\r\nEND:VCARD\r\n"
    )
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

fn facade(fake: &Arc<FakeDav>) -> Arc<CardDavFacade> {
    CardDavFacade::new(
        url::Url::parse(&format!("{ORIGIN}/.well-known/carddav")).unwrap(),
        "u".into(),
        "p".into(),
        fake.clone(),
    )
}

async fn try_call(
    f: &CardDavFacade,
    method: &str,
    args: Value,
    created: &mut CreatedIds,
    uploads: &Uploads,
) -> Result<Object, FacadeError> {
    let args = args.as_object().cloned().unwrap_or_default();
    f.call(method, args, CallContext { created, uploads }).await
}

async fn call(
    f: &CardDavFacade,
    method: &str,
    args: Value,
    created: &mut CreatedIds,
    uploads: &Uploads,
) -> Value {
    Value::Object(
        try_call(f, method, args, created, uploads)
            .await
            .unwrap_or_else(|e| panic!("{method}: {e:?}")),
    )
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

// ------------------------------------------------------------------ tests

#[tokio::test]
async fn client_discovery_and_rejected_credentials() {
    let fake = FakeDav::new(true, "u", "p");
    let service = url::Url::parse(&format!("{ORIGIN}/dav/card/")).unwrap();
    let books = DavClient::new(service.clone(), "u", "p", fake.clone())
        .discover(DavKind::Card, Duration::from_secs(15))
        .await
        .unwrap();
    let rows: Vec<(String, bool, bool)> = books
        .iter()
        .map(|b| (b.name.clone(), b.supports_sync, b.may_write))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("Contacts".to_string(), true, true),
            ("Travail".to_string(), true, true)
        ]
    );
    let err = DavClient::new(service, "u", "mauvais", fake.clone())
        .discover(DavKind::Card, Duration::from_secs(15))
        .await
        .unwrap_err();
    assert_eq!(err, DavError::Auth);
    assert!(err.to_string().contains("authentication"));

    let bad = facade(&FakeDav::new(true, "u", "autre"));
    bad.probe().await;
    assert!(!bad.available());
    assert!(bad.capabilities().is_none());
}

async fn full_scenario(sync: bool) {
    let fake = FakeDav::new(sync, "u", "p");
    fake.state.lock().unwrap().book(DEFAULT).items.push((
        "alice.vcf".into(),
        Item {
            etag: "\"1\"".into(),
            data: vcard("alice-uid", "Alice Martin", "alice@example.com"),
        },
    ));
    let uploads = Uploads::default();
    let mut ids = CreatedIds::default();
    let f = facade(&fake);
    f.probe().await;
    assert!(f.available());
    assert!(
        f.capabilities()
            .unwrap()
            .core
            .contains_key("urn:ietf:params:jmap:contacts")
    );

    let ab = call(
        &f,
        "AddressBook/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await;
    let def = ab["list"][0].clone();
    let work = ab["list"][1].clone();
    assert_eq!(def["name"], "Contacts");
    assert_eq!(def["isDefault"], true);
    let (def_id, work_id) = (
        def["id"].as_str().unwrap().to_string(),
        work["id"].as_str().unwrap().to_string(),
    );

    let g = call(
        &f,
        "ContactCard/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await;
    let state0 = g["state"].as_str().unwrap().to_string();
    let alice = g["list"][0].clone();
    let alice_id = alice["id"].as_str().unwrap().to_string();
    assert_eq!(alice["name"]["full"], "Alice Martin");
    assert_eq!(alice["addressBookIds"], json!({def_id.clone(): true}));

    // création (uid fixé par la façade s'il manque)
    let s1 = call(
        &f,
        "ContactCard/set",
        json!({"create": {"n": {"addressBookIds": {def_id.clone(): true}, "name": {"full": "Bruno Petit"}, "emails": {"e": {"address": "bruno@example.com"}}}}}),
        &mut ids,
        &uploads,
    )
    .await;
    let bruno = &s1["created"]["n"];
    let bruno_id = bruno["id"].as_str().unwrap().to_string();
    assert!(bruno["uid"].as_str().unwrap().starts_with("urn:uuid:"));
    assert_eq!(ids.resolve("#n"), bruno_id);

    // recherche « text » en mémoire, tri par nom
    let q = call(
        &f,
        "ContactCard/query",
        json!({"filter": {"text": "BRUNO"}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(strs(&q["ids"]), vec![bruno_id.clone()]);
    let all = call(
        &f,
        "ContactCard/query",
        json!({"filter": {"inAddressBook": def_id.clone()}, "calculateTotal": true}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(all["total"], 2);
    assert_eq!(strs(&all["ids"]), vec![alice_id.clone(), bruno_id.clone()]);

    // mise à jour par patch : la propriété inconnue X-CUSTOM est conservée
    let s2 = call(
        &f,
        "ContactCard/set",
        json!({"update": {alice_id.clone(): {"name/full": "Alice Durand", "phones/p1": {"number": "+33 6"}}}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(s2["updated"], json!({alice_id.clone(): null}));
    let stored = fake.item(DEFAULT, "alice.vcf").unwrap();
    assert!(stored.contains("FN:Alice Durand"), "{stored}");
    assert!(
        stored.to_uppercase().contains("X-CUSTOM:GARDE-MOI"),
        "{stored}"
    );
    assert!(stored.contains("VERSION:3.0"), "{stored}");

    // conflit d'ETag : modifiée ailleurs après notre lecture → stateMismatch
    let f2 = facade(&fake);
    f2.probe().await;
    *fake.race.lock().unwrap() = Some((
        DEFAULT.into(),
        "alice.vcf".into(),
        vcard("alice-uid", "Alice (ailleurs)", "alice@example.com"),
    ));
    let s3 = call(
        &f2,
        "ContactCard/set",
        json!({"update": {alice_id.clone(): {"name/full": "Perdu"}}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(s3["notUpdated"][&alice_id]["type"], "stateMismatch");

    // changes depuis l'état initial : Bruno créé (ou modifié avec sync-collection), Alice modifiée
    let ch = call(
        &f,
        "ContactCard/changes",
        json!({"sinceState": state0}),
        &mut ids,
        &uploads,
    )
    .await;
    let mut touched = [strs(&ch["created"]), strs(&ch["updated"])].concat();
    touched.sort();
    let mut expected = vec![alice_id.clone(), bruno_id.clone()];
    expected.sort();
    assert_eq!(touched, expected);
    assert_eq!(ch["destroyed"], json!([]));
    if !sync {
        assert_eq!(strs(&ch["created"]), vec![bruno_id.clone()]);
    }

    // déplacement vers « Travail » : nouvel id, ancien détruit pour changes
    let s4 = call(
        &f,
        "ContactCard/set",
        json!({"update": {bruno_id.clone(): {"addressBookIds": {work_id.clone(): true}}}}),
        &mut ids,
        &uploads,
    )
    .await;
    let moved_id = s4["updated"][&bruno_id]["id"].as_str().unwrap().to_string();
    assert_ne!(moved_id, bruno_id);
    assert_eq!(fake.count(WORK), 1);
    let ch2 = call(
        &f,
        "ContactCard/changes",
        json!({"sinceState": ch["newState"]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(strs(&ch2["destroyed"]).contains(&bruno_id));
    assert!(
        [strs(&ch2["created"]), strs(&ch2["updated"])]
            .concat()
            .contains(&moved_id)
    );

    // suppression ; état périmé → stateMismatch (ifInState)
    let stale = try_call(
        &f,
        "ContactCard/set",
        json!({"ifInState": state0, "destroy": [moved_id.clone()]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(matches!(stale, Err(FacadeError::Method(e)) if e.kind == "stateMismatch"));
    let s5 = call(
        &f,
        "ContactCard/set",
        json!({"destroy": [moved_id.clone(), "cinconnu"]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(s5["destroyed"], json!([moved_id]));
    assert_eq!(s5["notDestroyed"]["cinconnu"]["type"], "notFound");

    // parse : un fichier de deux vCard → tableau ; une seule → fiche ; texte → notParsable
    {
        let mut up = uploads.0.lock().unwrap();
        up.insert(
            "B1".into(),
            format!(
                "{}{}",
                vcard("x1", "Un", "un@x.fr"),
                vcard("x2", "Deux", "deux@x.fr")
            )
            .into_bytes(),
        );
        up.insert("B2".into(), vcard("x3", "Trois", "trois@x.fr").into_bytes());
        up.insert("B3".into(), b"bonjour".to_vec());
    }
    let p = call(
        &f,
        "ContactCard/parse",
        json!({"blobIds": ["B1", "B2", "B3", "B4"]}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(p["parsed"]["B1"].as_array().unwrap().len(), 2);
    assert_eq!(p["parsed"]["B2"]["name"]["full"], "Trois");
    assert_eq!(p["notParsable"], json!(["B3"]));
    assert_eq!(p["notFound"], json!(["B4"]));
}

#[tokio::test]
async fn facade_with_sync_collection() {
    full_scenario(true).await;
}

#[tokio::test]
async fn facade_with_ctag_and_etags() {
    full_scenario(false).await;
}

#[tokio::test]
async fn facade_one_book_per_card_bad_state_and_book_changes() {
    let fake = FakeDav::new(true, "u", "p");
    let f = facade(&fake);
    f.probe().await;
    let uploads = Uploads::default();
    let mut ids = CreatedIds::default();
    let ab = call(
        &f,
        "AddressBook/get",
        json!({"ids": null}),
        &mut ids,
        &uploads,
    )
    .await;
    let (a, b) = (ab["list"][0]["id"].clone(), ab["list"][1]["id"].clone());
    let mut books = serde_json::Map::new();
    books.insert(a.as_str().unwrap().into(), json!(true));
    books.insert(b.as_str().unwrap().into(), json!(true));
    let s = call(
        &f,
        "ContactCard/set",
        json!({"create": {"x": {"addressBookIds": books, "name": {"full": "X"}}}}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(s["notCreated"]["x"]["type"], "invalidProperties");
    let bad = try_call(
        &f,
        "ContactCard/changes",
        json!({"sinceState": "nimporte"}),
        &mut ids,
        &uploads,
    )
    .await;
    assert!(matches!(bad, Err(FacadeError::Method(e)) if e.kind == "cannotCalculateChanges"));
    let ab_state =
        call(&f, "AddressBook/get", json!({}), &mut ids, &uploads).await["state"].clone();
    let abc = call(
        &f,
        "AddressBook/changes",
        json!({"sinceState": ab_state}),
        &mut ids,
        &uploads,
    )
    .await;
    assert_eq!(
        (
            abc["created"].clone(),
            abc["updated"].clone(),
            abc["destroyed"].clone()
        ),
        (json!([]), json!([]), json!([]))
    );
}

/// Patch JMAP : chemins, échappements, suppression, garde-fous (module privé, compilé depuis ses sources).
#[path = "../src/patch.rs"]
#[allow(dead_code)]
mod patch;

#[test]
fn jmap_patch_paths_escapes_removal_guards() {
    let o = json!({"name": {"full": "A"}, "members": {"urn:uuid:1": true}});
    let r = patch::apply_patch(
        &o,
        json!({"name/full": "B", "members/urn:uuid:2": true, "members/urn:uuid:1": null, "emails/e~1x": {"address": "a@b"}})
            .as_object()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        r,
        json!({"name": {"full": "B"}, "members": {"urn:uuid:2": true}, "emails": {"e/x": {"address": "a@b"}}})
    );
    assert_eq!(o["members"], json!({"urn:uuid:1": true}));
    let err = patch::apply_patch(&o, json!({"__proto__/x": 1}).as_object().unwrap()).unwrap_err();
    assert_eq!(err.kind, "invalidPatch");
    assert!(err.description.unwrap().contains("bad path"));
}
