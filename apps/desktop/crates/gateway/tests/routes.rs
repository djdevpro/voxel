//! Routes /imap/* contre une façade factice (port de `gateway.test.ts`, `errors.test.ts` et des cas SEC-01, SEC-04
//! et SEC-08 de `security.test.ts`) : en-têtes, statuts, corps d'erreur, blobs, flux d'événements, limites, découverte.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use voxel_core::backend::{BackendFactory, DownloadResult, MailAccount, MailBackend, UploadResult};
use voxel_core::dns::DnsLookup;
use voxel_core::error::BackendError;
use voxel_core::http::{CoreBody, CoreRequest, CoreResponse};
use voxel_core::jmap::{JmapRequest, JmapResponse};
use voxel_core::kv::{KvStore, MemoryKv};
use voxel_core::net::HttpClient;
use voxel_gateway::{Gateway, KvProvider};

/// Comportement programmable de la façade factice.
#[derive(Default)]
struct Script {
    verify: Option<BackendError>,
    error: Option<BackendError>,
    download_type: String,
    uploaded_types: Vec<String>,
    downloaded_types: Vec<Option<String>>,
    events: Option<tokio::sync::mpsc::Sender<serde_json::Value>>,
    events_open: bool,
}

struct FakeBackend {
    script: Arc<Mutex<Script>>,
}

impl FakeBackend {
    fn fail(&self) -> Result<(), BackendError> {
        match self.script.lock().unwrap().error.clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

impl MailBackend for FakeBackend {
    fn session(&self) -> BoxFuture<'_, Result<serde_json::Value, BackendError>> {
        Box::pin(async move {
            self.fail()?;
            Ok(serde_json::json!({
                "capabilities": { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:websocket": {} },
                "accounts": {},
                "apiUrl": "x", "downloadUrl": "x", "uploadUrl": "x", "eventSourceUrl": "x",
                "state": "s1"
            }))
        })
    }

    fn api(&self, request: JmapRequest) -> BoxFuture<'_, Result<JmapResponse, BackendError>> {
        Box::pin(async move {
            self.fail()?;
            Ok(JmapResponse {
                method_responses: request.method_calls,
                session_state: "s1".into(),
                created_ids: None,
            })
        })
    }

    fn upload(
        &self,
        account_id: String,
        body: bytes::Bytes,
        content_type: String,
    ) -> BoxFuture<'_, Result<UploadResult, BackendError>> {
        Box::pin(async move {
            self.fail()?;
            self.script
                .lock()
                .unwrap()
                .uploaded_types
                .push(content_type.clone());
            Ok(UploadResult {
                account_id,
                blob_id: "b1".into(),
                content_type,
                size: body.len() as u64,
            })
        })
    }

    fn download(
        &self,
        _account_id: String,
        _blob_id: String,
        content_type: Option<String>,
    ) -> BoxFuture<'_, Result<DownloadResult, BackendError>> {
        Box::pin(async move {
            self.fail()?;
            let mut script = self.script.lock().unwrap();
            script.downloaded_types.push(content_type.clone());
            Ok(DownloadResult {
                body: bytes::Bytes::from_static(b"hello"),
                content_type: content_type.unwrap_or_else(|| script.download_type.clone()),
            })
        })
    }

    fn events(
        &self,
        _types: Vec<String>,
    ) -> BoxFuture<'_, Result<tokio::sync::mpsc::Receiver<serde_json::Value>, BackendError>> {
        Box::pin(async move {
            self.fail()?;
            let (tx, rx) = tokio::sync::mpsc::channel(8);
            let mut script = self.script.lock().unwrap();
            script.events = Some(tx);
            script.events_open = true;
            Ok(rx)
        })
    }

    fn verify(&self) -> BoxFuture<'_, Result<(), BackendError>> {
        Box::pin(async move {
            match self.script.lock().unwrap().verify.clone() {
                Some(e) => Err(e),
                None => Ok(()),
            }
        })
    }

    fn probe(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

/// Fabrique factice : compte les créations, chaque façade suit le même script.
#[derive(Default)]
struct FakeFactory {
    created: AtomicUsize,
    script: Arc<Mutex<Script>>,
}

impl BackendFactory for FakeFactory {
    fn create(&self, _account: MailAccount, _kv: Arc<dyn KvStore>) -> Arc<dyn MailBackend> {
        self.created.fetch_add(1, Ordering::SeqCst);
        Arc::new(FakeBackend {
            script: self.script.clone(),
        })
    }
}

/// DNS vide : la découverte ne trouve rien sans réseau DNS.
struct NoDns;

impl DnsLookup for NoDns {
    fn mx<'a>(&'a self, _domain: &'a str) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
    fn srv<'a>(&'a self, _name: &'a str) -> BoxFuture<'a, Option<(String, u16)>> {
        Box::pin(async { None })
    }
    fn txt<'a>(&'a self, _name: &'a str) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
}

fn gateway() -> (Arc<Gateway>, Arc<FakeFactory>) {
    let factory = Arc::new(FakeFactory::default());
    let kv: KvProvider = Arc::new(|_key: &str| Arc::new(MemoryKv::default()) as Arc<dyn KvStore>);
    let gw = Gateway::new(
        factory.clone(),
        kv,
        HttpClient::new().expect("client HTTP"),
        Arc::new(NoDns),
    );
    (gw, factory)
}

fn basic(user: &str, password: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
    )
}

fn request(method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> CoreRequest {
    let mut map = http::HeaderMap::new();
    for (k, v) in headers {
        map.append(
            http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            http::HeaderValue::from_str(v).unwrap(),
        );
    }
    CoreRequest {
        method: http::Method::from_bytes(method.as_bytes()).unwrap(),
        path: path.to_string(),
        headers: map,
        body: bytes::Bytes::copy_from_slice(body),
    }
}

/// En-têtes d'une boîte valide.
fn mailbox(user: &str, password: &str, imap: &str) -> Vec<(String, String)> {
    vec![
        ("authorization".into(), basic(user, password)),
        ("x-voxel-imap".into(), imap.into()),
        ("x-voxel-smtp".into(), "smtp.example.com:465:ssl".into()),
    ]
}

async fn call(
    gw: &Arc<Gateway>,
    method: &str,
    path: &str,
    extra: &[(&str, &str)],
    body: &[u8],
) -> CoreResponse {
    let base = mailbox("alice@example.com", "secret", "imap.example.com:993:ssl");
    let mut headers: Vec<(&str, &str)> =
        base.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    for (k, v) in extra {
        headers.retain(|(name, _)| name != k);
        headers.push((k, v));
    }
    gw.handle(request(method, path, &headers, body)).await
}

fn header<'a>(res: &'a CoreResponse, name: &str) -> Option<&'a str> {
    res.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn body_json(res: CoreResponse) -> serde_json::Value {
    let CoreBody::Full(body) = res.body else {
        panic!("corps entier attendu")
    };
    serde_json::from_slice(&body).expect("JSON")
}

fn assert_error(res: CoreResponse, status: u16, code: &str) -> String {
    assert_eq!(res.status, status);
    assert!(header(&res, "www-authenticate").is_none());
    let body = body_json(res);
    assert_eq!(body["error"], code, "{body}");
    body["message"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn headers_are_validated_before_any_backend() {
    let (gw, factory) = gateway();
    let res = gw.handle(request("GET", "/imap/session", &[], b"")).await;
    assert_eq!(
        assert_error(res, 401, "invalid_credentials"),
        "Basic credentials required"
    );
    let res = gw
        .handle(request(
            "GET",
            "/imap/session",
            &[("authorization", "Basic !!!")],
            b"",
        ))
        .await;
    assert_error(res, 401, "invalid_credentials");
    let res = gw
        .handle(request(
            "GET",
            "/imap/session",
            &[("authorization", &basic("alice", ""))],
            b"",
        ))
        .await;
    assert_error(res, 401, "invalid_credentials");
    let res = gw
        .handle(request(
            "GET",
            "/imap/session",
            &[("authorization", &basic("alice", "pw"))],
            b"",
        ))
        .await;
    assert_eq!(
        assert_error(res, 400, "validation"),
        "X-Voxel-Imap and X-Voxel-Smtp headers required (host:port:ssl|starttls)"
    );
    for (name, value, message) in [
        (
            "x-voxel-imap",
            "imap.example.com:993:plain",
            "X-Voxel-Imap and X-Voxel-Smtp headers required (host:port:ssl|starttls)",
        ),
        (
            "x-voxel-imap",
            "imap.example.com:0:ssl",
            "X-Voxel-Imap and X-Voxel-Smtp headers required (host:port:ssl|starttls)",
        ),
        (
            "x-voxel-smtp",
            "bad host:465:ssl",
            "X-Voxel-Imap and X-Voxel-Smtp headers required (host:port:ssl|starttls)",
        ),
        (
            "x-voxel-email",
            "not-an-email",
            "X-Voxel-Email must be an email address",
        ),
        (
            "x-voxel-sieve",
            "sieve.example.com:4190",
            "X-Voxel-Sieve must be host:port:ssl|starttls",
        ),
        (
            "x-voxel-carddav",
            "http://example.com/dav",
            "X-Voxel-CardDav must be an https URL",
        ),
        (
            "x-voxel-carddav",
            "https://user:pw@example.com/dav",
            "X-Voxel-CardDav must be an https URL",
        ),
        (
            "x-voxel-caldav",
            "http://example.com/dav",
            "X-Voxel-CalDav must be an https URL",
        ),
        (
            "x-voxel-caldav",
            "https://user:pw@example.com/dav",
            "X-Voxel-CalDav must be an https URL",
        ),
    ] {
        let res = call(&gw, "GET", "/imap/session", &[(name, value)], b"").await;
        assert_eq!(
            assert_error(res, 400, "validation"),
            message,
            "{name}: {value}"
        );
    }
    assert_eq!(factory.created.load(Ordering::SeqCst), 0);
    // D6 : tout port, CardDAV https sur un port quelconque.
    let res = call(
        &gw,
        "GET",
        "/imap/session",
        &[
            ("x-voxel-imap", "imap.example.com:1143:starttls"),
            ("x-voxel-carddav", "https://dav.example.com:8443/"),
            ("x-voxel-sieve", "sieve.example.com:2000:starttls"),
        ],
        b"",
    )
    .await;
    assert_eq!(res.status, 200);
}

#[tokio::test]
async fn session_rewrites_urls_and_drops_websocket() {
    let (gw, _) = gateway();
    let res = call(&gw, "GET", "/imap/session", &[], b"").await;
    assert_eq!(res.status, 200);
    assert_eq!(header(&res, "cache-control"), Some("no-store"));
    let body = body_json(res);
    assert_eq!(body["apiUrl"], "/imap/api");
    assert_eq!(
        body["downloadUrl"],
        "/imap/download/{accountId}/{blobId}/{name}?type={type}"
    );
    assert_eq!(body["uploadUrl"], "/imap/upload/{accountId}");
    assert_eq!(
        body["eventSourceUrl"],
        "/imap/events?types={types}&closeafter={closeafter}&ping={ping}"
    );
    assert!(
        body["capabilities"]
            .get("urn:ietf:params:jmap:websocket")
            .is_none()
    );
    assert!(
        body["capabilities"]
            .get("urn:ietf:params:jmap:core")
            .is_some()
    );
    assert_eq!(body["state"], "s1");
}

#[tokio::test]
async fn api_errors_and_relay() {
    let (gw, _) = gateway();
    let res = call(&gw, "POST", "/imap/api", &[], b"{nope").await;
    assert_eq!(res.status, 400);
    assert_eq!(
        body_json(res),
        serde_json::json!({"type":"urn:ietf:params:jmap:error:notJSON","status":400})
    );
    let res = call(
        &gw,
        "POST",
        "/imap/api",
        &[],
        br#"{"using":"x","methodCalls":[]}"#,
    )
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        body_json(res),
        serde_json::json!({"type":"urn:ietf:params:jmap:error:notRequest","status":400})
    );
    let big = vec![b' '; 10 * 1024 * 1024 + 1];
    let res = call(&gw, "POST", "/imap/api", &[], &big).await;
    assert_eq!(res.status, 413);
    assert_eq!(
        body_json(res),
        serde_json::json!({"type":"urn:ietf:params:jmap:error:limit","limit":"maxSizeRequest","status":413})
    );
    let res = call(
        &gw,
        "POST",
        "/imap/api",
        &[],
        br#"{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Core/echo",{"a":1},"c0"]]}"#,
    )
    .await;
    assert_eq!(res.status, 200);
    assert_eq!(header(&res, "cache-control"), Some("no-store"));
    let body = body_json(res);
    assert_eq!(
        body["methodResponses"],
        serde_json::json!([["Core/echo", {"a":1}, "c0"]])
    );
    assert_eq!(body["sessionState"], "s1");
}

#[tokio::test]
async fn upload_and_download() {
    let (gw, factory) = gateway();
    let res = call(
        &gw,
        "POST",
        "/imap/upload/acc1",
        &[("content-type", "image/png")],
        b"data",
    )
    .await;
    assert_eq!(res.status, 201);
    assert_eq!(header(&res, "cache-control"), Some("no-store"));
    assert_eq!(
        body_json(res),
        serde_json::json!({"accountId":"acc1","blobId":"b1","type":"image/png","size":4})
    );
    let res = call(&gw, "POST", "/imap/upload/acc1", &[], b"").await;
    // Corps vide accepté, comme Node : il est passé tel quel à la façade.
    assert_eq!(res.status, 201);
    assert_eq!(body_json(res)["size"], 0);
    // SEC-04 : un type invalide n'est jamais reflété.
    let res = call(
        &gw,
        "POST",
        "/imap/upload/acc1",
        &[("content-type", "text/html<script>")],
        b"x",
    )
    .await;
    assert_eq!(res.status, 201);
    assert_eq!(
        factory
            .script
            .lock()
            .unwrap()
            .uploaded_types
            .last()
            .map(String::as_str),
        Some("application/octet-stream")
    );

    // Par défaut : pièce jointe, nom « download ».
    factory.script.lock().unwrap().download_type = "image/png".into();
    let res = call(&gw, "GET", "/imap/download/acc1/b1", &[], b"").await;
    assert_eq!(res.status, 200);
    assert_eq!(header(&res, "content-type"), Some("image/png"));
    assert_eq!(header(&res, "content-length"), Some("5"));
    assert_eq!(
        header(&res, "content-disposition"),
        Some("attachment; filename=\"download\"; filename*=UTF-8''download")
    );
    assert_eq!(
        header(&res, "content-security-policy"),
        Some("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
    );
    assert_eq!(header(&res, "x-content-type-options"), Some("nosniff"));
    // inline=1 sur un type sûr, nom accentué décodé du chemin.
    let res = call(
        &gw,
        "GET",
        "/imap/download/acc1/b1/r%C3%A9sum%C3%A9.png?inline=1",
        &[],
        b"",
    )
    .await;
    assert_eq!(
        header(&res, "content-disposition"),
        Some("inline; filename=\"r_sum_.png\"; filename*=UTF-8''r%C3%A9sum%C3%A9.png")
    );
    // inline=1 sur un type actif → pièce jointe ; type demandé assaini.
    let res = call(
        &gw,
        "GET",
        "/imap/download/acc1/b1/x.html?type=text%2Fhtml&inline=1",
        &[],
        b"",
    )
    .await;
    assert_eq!(header(&res, "content-type"), Some("text/html"));
    assert!(
        header(&res, "content-disposition")
            .unwrap()
            .starts_with("attachment;")
    );
    assert!(
        header(&res, "content-security-policy")
            .unwrap()
            .ends_with("sandbox")
    );
    let res = call(
        &gw,
        "GET",
        "/imap/download/acc1/b1/x?type=text%2Fhtml%0A%3Cx%3E",
        &[],
        b"",
    )
    .await;
    assert_eq!(
        header(&res, "content-type"),
        Some("application/octet-stream")
    );
    let res = call(
        &gw,
        "GET",
        "/imap/download/acc1/b1/x.txt?type=text%2Fplain%3B%20charset%3D%22UTF-8%22",
        &[],
        b"",
    )
    .await;
    assert_eq!(
        header(&res, "content-type"),
        Some("text/plain; charset=utf-8")
    );
}

async fn next_text(stream: &mut voxel_core::http::BodyStream) -> String {
    let chunk = tokio::time::timeout(Duration::from_secs(10), stream.next())
        .await
        .expect("délai")
        .expect("fin inattendue")
        .expect("erreur de flux");
    String::from_utf8(chunk.to_vec()).unwrap()
}

#[tokio::test]
async fn events_stream_state_and_close() {
    let (gw, factory) = gateway();
    let res = call(
        &gw,
        "GET",
        "/imap/events?types=*&closeafter=state&ping=0",
        &[],
        b"",
    )
    .await;
    assert_eq!(res.status, 200);
    assert_eq!(
        header(&res, "content-type"),
        Some("text/event-stream; charset=utf-8")
    );
    assert_eq!(
        header(&res, "cache-control"),
        Some("no-cache, no-transform")
    );
    assert_eq!(header(&res, "x-accel-buffering"), Some("no"));
    let CoreBody::Stream(mut stream) = res.body else {
        panic!("flux attendu")
    };
    assert_eq!(next_text(&mut stream).await, ": ok\n\n");
    let tx = factory.script.lock().unwrap().events.clone().unwrap();
    tx.send(serde_json::json!({"@type":"StateChange","changed":{"a":{"Email":"s2"}}}))
        .await
        .unwrap();
    assert_eq!(
        next_text(&mut stream).await,
        "event: state\ndata: {\"@type\":\"StateChange\",\"changed\":{\"a\":{\"Email\":\"s2\"}}}\n\n"
    );
    // closeafter=state : fin du flux, la façade est désabonnée.
    assert!(
        tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .unwrap()
            .is_none()
    );
    tokio::time::timeout(Duration::from_secs(10), tx.closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn events_ping() {
    let (gw, factory) = gateway();
    let res = call(&gw, "GET", "/imap/events?types=Email&ping=1", &[], b"").await;
    let CoreBody::Stream(mut stream) = res.body else {
        panic!("flux attendu")
    };
    assert_eq!(next_text(&mut stream).await, ": ok\n\n");
    // Borné à 5 s au minimum.
    assert_eq!(
        next_text(&mut stream).await,
        "event: ping\ndata: {\"interval\":5}\n\n"
    );
    // Le lecteur lâche le flux : la façade est désabonnée.
    drop(stream);
    let tx = factory.script.lock().unwrap().events.clone().unwrap();
    tokio::time::timeout(Duration::from_secs(10), tx.closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn backend_errors_map_to_status() {
    for (error, status, code) in [
        (BackendError::Auth("x".into()), 401, "upstream_auth"),
        (
            BackendError::Unavailable("x".into()),
            502,
            "upstream_unreachable",
        ),
        (BackendError::BlobNotFound("b".into()), 404, "not_found"),
        (BackendError::BlobTooLarge, 413, "validation"),
    ] {
        let (gw, factory) = gateway();
        factory.script.lock().unwrap().error = Some(error);
        let res = call(&gw, "GET", "/imap/download/acc1/b1", &[], b"").await;
        assert_error(res, status, code);
    }
}

#[tokio::test]
async fn rejected_credentials_on_verify() {
    let (gw, factory) = gateway();
    factory.script.lock().unwrap().verify = Some(BackendError::Auth("no".into()));
    let res = call(&gw, "GET", "/imap/session", &[], b"").await;
    assert_eq!(
        assert_error(res, 401, "invalid_credentials"),
        "the mail server rejected the credentials"
    );
    let res = call(&gw, "POST", "/imap/api", &[], b"{}").await;
    assert_error(res, 401, "upstream_auth");
    // Façade jetée après chaque refus.
    assert_eq!(factory.created.load(Ordering::SeqCst), 2);
    factory.script.lock().unwrap().verify = Some(BackendError::Unavailable("down".into()));
    let res = call(&gw, "GET", "/imap/session", &[], b"").await;
    assert_error(res, 502, "upstream_unreachable");
}

#[tokio::test]
async fn sec08_login_failures_are_limited() {
    let (gw, factory) = gateway();
    factory.script.lock().unwrap().verify = Some(BackendError::Auth("no".into()));
    for _ in 0..10 {
        let res = call(&gw, "GET", "/imap/session", &[], b"").await;
        assert_eq!(res.status, 401);
    }
    let res = call(&gw, "GET", "/imap/session", &[], b"").await;
    let retry: u64 = header(&res, "retry-after").unwrap().parse().unwrap();
    assert!((1..=900).contains(&retry));
    assert_eq!(
        assert_error(res, 429, "rate_limited"),
        "too many attempts, try again later"
    );
}

#[tokio::test]
async fn sec01_fingerprint_reuses_and_separates() {
    let (gw, factory) = gateway();
    let send = |user: &str, password: &str, imap: &str| {
        let headers = mailbox(user, password, imap);
        let gw = gw.clone();
        async move {
            let h: Vec<(&str, &str)> = headers
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            gw.handle(request("GET", "/imap/session", &h, b""))
                .await
                .status
        }
    };
    assert_eq!(
        send("alice@example.com", "pw", "imap.example.com:993:ssl").await,
        200
    );
    assert_eq!(
        send("alice@example.com", "pw", "IMAP.example.com:993:ssl").await,
        200
    );
    assert_eq!(factory.created.load(Ordering::SeqCst), 1);
    assert_eq!(
        send("alice@example.com", "pw2", "imap.example.com:993:ssl").await,
        200
    );
    assert_eq!(factory.created.load(Ordering::SeqCst), 2);
    assert_eq!(
        send("alice@example.com", "pw", "imap2.example.com:993:ssl").await,
        200
    );
    assert_eq!(
        send("alice@example.com", "pw", "imap.example.com:143:starttls").await,
        200
    );
    assert_eq!(factory.created.load(Ordering::SeqCst), 4);
    // Autre hôte SMTP : nouvelle façade.
    let res = call(
        &gw,
        "GET",
        "/imap/session",
        &[
            ("authorization", &basic("alice@example.com", "pw")),
            ("x-voxel-smtp", "smtp2.example.com:465:ssl"),
        ],
        b"",
    )
    .await;
    assert_eq!(res.status, 200);
    assert_eq!(factory.created.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn unknown_routes() {
    let (gw, _) = gateway();
    for (method, path) in [
        ("GET", "/imap/nope"),
        ("POST", "/imap/session"),
        ("GET", "/imap/api"),
        ("GET", "/imap/download/acc1"),
        ("GET", "/healthz"),
        ("GET", "/api/v2"),
    ] {
        let res = gw.handle(request(method, path, &[], b"")).await;
        assert_eq!(
            assert_error(res, 404, "not_found"),
            "unknown route",
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn discover_validation_and_limit() {
    let (gw, _) = gateway();
    let res = gw
        .handle(request("POST", "/imap/discover", &[], b"[1]"))
        .await;
    assert_eq!(
        assert_error(res, 400, "validation"),
        "JSON object body expected"
    );
    let res = gw
        .handle(request(
            "POST",
            "/imap/discover",
            &[],
            br#"{"email":"nope@x"}"#,
        ))
        .await;
    assert_eq!(assert_error(res, 400, "validation"), "valid email required");
    let big = format!(r#"{{"email":"{}@example.com"}}"#, "a".repeat(17 * 1024));
    let res = gw
        .handle(request("POST", "/imap/discover", &[], big.as_bytes()))
        .await;
    assert_eq!(assert_error(res, 413, "validation"), "body too large");
    // Domaine réservé (RFC 2606) : rien n'est trouvé, le résultat est gardé en cache.
    for _ in 0..30 {
        let res = gw
            .handle(request(
                "POST",
                "/imap/discover",
                &[],
                br#"{"email":"Bob@Example.invalid"}"#,
            ))
            .await;
        assert_eq!(res.status, 200);
        assert_eq!(header(&res, "cache-control"), Some("no-store"));
        assert_eq!(body_json(res), serde_json::json!({"protocol": null}));
    }
    let res = gw
        .handle(request(
            "POST",
            "/imap/discover",
            &[],
            br#"{"email":"bob@example.invalid"}"#,
        ))
        .await;
    assert!(header(&res, "retry-after").is_some());
    assert_error(res, 429, "rate_limited");
}
