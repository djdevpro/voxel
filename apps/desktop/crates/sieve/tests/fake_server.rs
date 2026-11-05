//! Client ManageSieve et façade JMAP for Sieve contre un faux serveur TCP local (STARTTLS simulé sans
//! chiffrement, réponses découpées en morceaux arbitraires). Port de `apps/server/test/sieve.test.ts`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use voxel_core::backend::{CallContext, Companion, UploadSource};
use voxel_core::jmap::{CreatedIds, Object};
use voxel_sieve::SieveFacade;
use voxel_sieve::client::{
    ManageSieveClient, ResponseReader, SieveConnector, SieveError, SieveStream, Token,
};

// ---------------------------------------------------------------- faux serveur

#[derive(Default)]
struct FakeState {
    /// Scripts dans l'ordre de création.
    scripts: Vec<(String, String)>,
    active: Option<String>,
    log: Vec<String>,
}

impl FakeState {
    fn get(&self, name: &str) -> Option<String> {
        self.scripts
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, c)| c.clone())
    }
    fn set(&mut self, name: &str, content: &str) {
        match self.scripts.iter_mut().find(|(n, _)| n == name) {
            Some(entry) => entry.1 = content.to_string(),
            None => self.scripts.push((name.to_string(), content.to_string())),
        }
    }
    fn remove(&mut self, name: &str) {
        self.scripts.retain(|(n, _)| n != name);
    }
}

type Shared = Arc<Mutex<FakeState>>;

struct Opts {
    user: &'static str,
    pass: &'static str,
    chunk: Option<usize>,
}

const CAPS: [&str; 5] = [
    "\"IMPLEMENTATION\" \"Fake Sieve\"",
    "\"SASL\" \"PLAIN\"",
    "\"SIEVE\" \"fileinto vacation imap4flags copy mailboxid\"",
    "\"MAXREDIRECTS\" \"4\"",
    "\"VERSION\" \"1.0\"",
];

fn q(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn lit(s: &str) -> String {
    format!("{{{}}}\r\n{s}", s.len())
}

async fn send(sock: &mut TcpStream, chunk: Option<usize>, s: &str) {
    let data = s.as_bytes();
    // découpage en petits morceaux arbitraires pour éprouver le lecteur
    let n = chunk.unwrap_or(data.len()).max(1);
    for part in data.chunks(n) {
        if sock.write_all(part).await.is_err() {
            return;
        }
        let _ = sock.flush().await;
    }
}

fn caps(tls: bool) -> String {
    let mut lines: Vec<String> = CAPS.iter().map(|s| s.to_string()).collect();
    if !tls {
        lines.push("\"STARTTLS\"".into());
    }
    format!("{}\r\nOK\r\n", lines.join("\r\n"))
}

/// Réponse à une commande, et vrai s'il faut fermer la connexion après l'envoi.
fn handle(
    state: &Shared,
    opts: &Opts,
    tls: &mut bool,
    cmd: &str,
    args: &[String],
) -> (String, bool) {
    let mut st = state.lock().unwrap();
    st.log.push(cmd.to_string());
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    match cmd {
        "STARTTLS" => {
            *tls = true;
            (format!("OK \"begin TLS\"\r\n{}", caps(true)), false)
        }
        "AUTHENTICATE" => {
            let decoded = STANDARD.decode(arg(1)).unwrap_or_default();
            let text = String::from_utf8_lossy(&decoded).into_owned();
            let parts: Vec<&str> = text.split('\0').collect();
            let ok = parts.get(1) == Some(&opts.user) && parts.get(2) == Some(&opts.pass);
            (
                if ok {
                    "OK \"logged in\"\r\n"
                } else {
                    "NO \"auth failed\"\r\n"
                }
                .into(),
                false,
            )
        }
        "CAPABILITY" => (caps(*tls), false),
        "LISTSCRIPTS" => {
            let mut out = String::new();
            for (n, _) in &st.scripts {
                let active = if st.active.as_deref() == Some(n) {
                    " ACTIVE"
                } else {
                    ""
                };
                out.push_str(&format!("{}{active}\r\n", q(n)));
            }
            out.push_str("OK\r\n");
            (out, false)
        }
        "GETSCRIPT" => match st.get(&arg(0)) {
            None => ("NO (NONEXISTENT) \"no such script\"\r\n".into(), false),
            Some(s) => (format!("{}\r\nOK\r\n", lit(&s)), false),
        },
        "PUTSCRIPT" | "CHECKSCRIPT" => {
            let content = if cmd == "PUTSCRIPT" { arg(1) } else { arg(0) };
            if content.contains("syntax error") {
                let msg = "line 1: syntax error\nunexpected token";
                return (format!("NO {}\r\n", lit(msg)), false);
            }
            if cmd == "PUTSCRIPT" {
                st.set(&arg(0), &content);
            }
            ("OK\r\n".into(), false)
        }
        "SETACTIVE" => {
            let name = arg(0);
            if !name.is_empty() && st.get(&name).is_none() {
                return ("NO (NONEXISTENT) \"no such script\"\r\n".into(), false);
            }
            st.active = if name.is_empty() { None } else { Some(name) };
            ("OK\r\n".into(), false)
        }
        "DELETESCRIPT" => {
            if st.active.as_deref() == Some(arg(0).as_str()) {
                return ("NO (ACTIVE) \"script is active\"\r\n".into(), false);
            }
            st.remove(&arg(0));
            ("OK\r\n".into(), false)
        }
        "RENAMESCRIPT" => {
            let Some(s) = st.get(&arg(0)) else {
                return ("NO (NONEXISTENT)\r\n".into(), false);
            };
            st.remove(&arg(0));
            st.set(&arg(1), &s);
            if st.active.as_deref() == Some(arg(0).as_str()) {
                st.active = Some(arg(1));
            }
            ("OK\r\n".into(), false)
        }
        "HAVESPACE" => (
            if arg(1).parse::<u64>().unwrap_or(0) > 1000 {
                "NO (QUOTA/MAXSIZE) \"too big\"\r\n"
            } else {
                "OK\r\n"
            }
            .into(),
            false,
        ),
        "LOGOUT" => ("OK \"bye\"\r\n".into(), true),
        _ => ("NO \"unknown command\"\r\n".into(), false),
    }
}

/// Analyse : mot de commande, puis chaînes entre guillemets, nombres ou littéraux `{n+}` ; `None` si incomplet.
fn parse_command(buf: &[u8]) -> Option<(String, Vec<String>, usize)> {
    let word_len = buf.iter().take_while(|b| b.is_ascii_uppercase()).count();
    if word_len == 0 {
        return None;
    }
    let word = String::from_utf8_lossy(&buf[..word_len]).into_owned();
    let mut i = word_len;
    let mut args = Vec::new();
    loop {
        if i + 1 < buf.len() + 1 && buf[i..].starts_with(b"\r\n") {
            return Some((word, args, i + 2));
        }
        if i >= buf.len() {
            return None;
        }
        match buf[i] {
            b' ' => i += 1,
            b'"' => {
                let mut v = Vec::new();
                i += 1;
                while i < buf.len() && buf[i] != b'"' {
                    if buf[i] == b'\\' {
                        i += 1;
                    }
                    if i < buf.len() {
                        v.push(buf[i]);
                    }
                    i += 1;
                }
                if i >= buf.len() {
                    return None;
                }
                i += 1;
                args.push(String::from_utf8_lossy(&v).into_owned());
            }
            b'{' => {
                let close = buf[i..].iter().position(|&b| b == b'}')? + i;
                let inner = String::from_utf8_lossy(&buf[i + 1..close]).into_owned();
                let n: usize = inner.trim_end_matches('+').parse().ok()?;
                if !buf[close + 1..].starts_with(b"\r\n") {
                    return None;
                }
                let start = close + 3;
                if buf.len() < start + n {
                    return None;
                }
                args.push(String::from_utf8_lossy(&buf[start..start + n]).into_owned());
                i = start + n;
            }
            _ => {
                let len = buf[i..]
                    .iter()
                    .take_while(|b| !b.is_ascii_whitespace())
                    .count();
                args.push(String::from_utf8_lossy(&buf[i..i + len]).into_owned());
                i += len;
            }
        }
    }
}

async fn serve(mut sock: TcpStream, state: Shared, opts: Arc<Opts>) {
    let mut tls = false;
    send(&mut sock, opts.chunk, &caps(tls)).await;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 4096];
    loop {
        while let Some((cmd, args, used)) = parse_command(&buf) {
            buf.drain(..used);
            let (reply, close) = handle(&state, &opts, &mut tls, &cmd, &args);
            send(&mut sock, opts.chunk, &reply).await;
            if close {
                let _ = sock.shutdown().await;
                return;
            }
        }
        match sock.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

async fn start(state: Shared, opts: Opts) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let opts = Arc::new(opts);
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            tokio::spawn(serve(sock, state.clone(), opts.clone()));
        }
    });
    port
}

fn connector(port: u16) -> SieveConnector {
    SieveConnector {
        connect: Box::new(move || {
            Box::pin(async move {
                let s = TcpStream::connect(("127.0.0.1", port)).await?;
                Ok(Box::new(s) as Box<dyn SieveStream>)
            })
        }),
        // STARTTLS simulé : le faux serveur continue en clair
        upgrade: Some(Arc::new(|s: Box<dyn SieveStream>| {
            Box::pin(async move { Ok(s) }) as BoxFuture<'static, _>
        })),
    }
}

struct Uploads(BTreeMap<String, Vec<u8>>);

impl UploadSource for Uploads {
    fn load<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<bytes::Bytes>> {
        Box::pin(async move { self.0.get(blob_id).cloned().map(bytes::Bytes::from) })
    }
}

async fn call(
    f: &SieveFacade,
    method: &str,
    args: Value,
    created: &mut CreatedIds,
    uploads: &Uploads,
) -> Object {
    let args = args.as_object().cloned().unwrap_or_default();
    f.call(method, args, CallContext { created, uploads })
        .await
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn reader_literals_codes_and_splitting() {
    let mut r = ResponseReader::new(1 << 20);
    let raw = b"\"a b\" ACTIVE\r\n{5}\r\nx\r\nyz\r\nNO (QUOTA/MAXSIZE) \"trop gros\"\r\n";
    for part in raw.chunks(3) {
        r.push(part);
    }
    let res = r.read_response(&mut tokio::io::empty()).await.unwrap();
    assert_eq!(res.status, "NO");
    assert_eq!(res.code.as_deref(), Some("QUOTA/MAXSIZE"));
    assert_eq!(res.message, "trop gros");
    assert_eq!(
        res.lines[0],
        vec![Token::Str("a b".into()), Token::Atom("ACTIVE".into())]
    );
    assert_eq!(res.lines[1], vec![Token::Str("x\r\nyz".into())]);

    // même flux livré en morceaux par la socket
    let (mut tx, mut rx) = tokio::io::duplex(8);
    tokio::spawn(async move {
        for part in raw.chunks(3) {
            tx.write_all(part).await.unwrap();
        }
    });
    let mut r = ResponseReader::new(1 << 20);
    let res = r.read_response(&mut rx).await.unwrap();
    assert_eq!(res.lines[1], vec![Token::Str("x\r\nyz".into())]);

    let mut r = ResponseReader::new(1 << 20);
    r.push(b"{abc}\r\n");
    assert_eq!(
        r.read_response(&mut tokio::io::empty()).await,
        Err(SieveError::Protocol("bad literal".into()))
    );
    let mut r = ResponseReader::new(4);
    r.push(b"\"0123456789");
    assert_eq!(
        r.read_response(&mut tokio::io::empty()).await,
        Err(SieveError::Protocol("response too large".into()))
    );
}

#[tokio::test]
async fn client_starttls_plain_and_all_commands() {
    let state: Shared = Arc::new(Mutex::new(FakeState {
        scripts: vec![("old".into(), "keep;".into())],
        active: Some("old".into()),
        log: vec![],
    }));
    let port = start(
        state.clone(),
        Opts {
            user: "u@x.fr",
            pass: "p€ss",
            chunk: Some(7),
        },
    )
    .await;
    let mut c = ManageSieveClient::new(connector(port), "u@x.fr".into(), "p€ss".into());
    let caps = c.connect().await.unwrap();
    assert_eq!(
        caps.sieve,
        vec!["fileinto", "vacation", "imap4flags", "copy", "mailboxid"]
    );
    assert_eq!(caps.max_redirects, Some(4));
    assert!(!caps.starttls, "capacités relues après STARTTLS");
    assert_eq!(
        state.lock().unwrap().log[..2],
        ["STARTTLS".to_string(), "AUTHENTICATE".to_string()]
    );
    let list = c.list_scripts().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].name.as_str(), list[0].active), ("old", true));
    assert_eq!(c.get_script("old").await.unwrap(), "keep;");
    let body = "require \"fileinto\";\r\n# « accents » et \"guillemets\"\r\nfileinto \"Spam\";\r\n";
    c.put_script("new one", body).await.unwrap();
    assert_eq!(c.get_script("new one").await.unwrap(), body);
    assert_eq!(c.check_script(body).await.unwrap(), None);
    assert_eq!(
        c.check_script("syntax error").await.unwrap().as_deref(),
        Some("line 1: syntax error\nunexpected token")
    );
    c.set_active("new one").await.unwrap();
    assert_eq!(state.lock().unwrap().active.as_deref(), Some("new one"));
    let err = c.delete_script("new one").await.unwrap_err();
    assert!(err.to_string().contains("active"), "{err}");
    c.rename_script("old", "older").await.unwrap();
    c.delete_script("older").await.unwrap();
    assert!(c.have_space("x", 10).await.unwrap());
    assert!(!c.have_space("x", 10_000).await.unwrap());
    assert_eq!(
        c.capability().await.unwrap().implementation.as_deref(),
        Some("Fake Sieve")
    );
    c.logout().await;
    assert!(!c.connected());
    assert!(state.lock().unwrap().log.contains(&"LOGOUT".to_string()));
}

#[tokio::test]
async fn client_rejected_credentials() {
    let state: Shared = Arc::default();
    let port = start(
        state,
        Opts {
            user: "u",
            pass: "right",
            chunk: None,
        },
    )
    .await;
    let mut c = ManageSieveClient::new(connector(port), "u".into(), "wrong".into());
    assert_eq!(
        c.connect().await.unwrap_err(),
        SieveError::Auth("ManageSieve authentication failed".into())
    );
    assert!(!c.connected());
}

#[tokio::test]
async fn facade_get_set_validate_update_destroy_download() {
    let state: Shared = Arc::default();
    let port = start(
        state.clone(),
        Opts {
            user: "u",
            pass: "p",
            chunk: None,
        },
    )
    .await;
    let uploads = Uploads(BTreeMap::from([
        (
            "U000000000000000000000001".to_string(),
            b"require \"fileinto\";\nfileinto \"Junk\";\n".to_vec(),
        ),
        (
            "U000000000000000000000002".to_string(),
            b"syntax error".to_vec(),
        ),
        ("U000000000000000000000003".to_string(), b"keep;\n".to_vec()),
    ]));
    let f = SieveFacade::with_connector(connector(port), "u".into(), "p".into());
    f.probe().await;
    assert!(f.available());
    let cap = f.capabilities().unwrap();
    let account = &cap.account["urn:ietf:params:jmap:sieve"];
    assert_eq!(
        account["sieveExtensions"],
        json!(["copy", "fileinto", "imap4flags", "mailboxid", "vacation"])
    );
    assert_eq!(account["maxNumberRedirects"], json!(4));
    assert_eq!(cap.core["urn:ietf:params:jmap:sieve"], json!({}));

    let mut created = CreatedIds::default();
    let empty = call(
        &f,
        "SieveScript/get",
        json!({"ids": null}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(empty["list"], json!([]));

    let ok = call(
        &f,
        "SieveScript/validate",
        json!({"blobId": "U000000000000000000000001"}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(Value::Object(ok), json!({"error": null}));
    let bad = call(
        &f,
        "SieveScript/validate",
        json!({"blobId": "U000000000000000000000002"}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(bad["error"]["type"], "invalidScript");

    let r = call(
        &f,
        "SieveScript/set",
        json!({
            "create": {"voxel": {"name": "voxel", "blobId": "U000000000000000000000001"}},
            "onSuccessActivateScript": "#voxel"
        }),
        &mut created,
        &uploads,
    )
    .await;
    let id = r["created"]["voxel"]["id"].as_str().unwrap().to_string();
    assert_eq!(created.resolve("#voxel"), id);
    assert_eq!(r["created"]["voxel"]["isActive"], json!(true));
    assert_ne!(r["oldState"], r["newState"]);
    assert_eq!(state.lock().unwrap().active.as_deref(), Some("voxel"));

    let got = call(
        &f,
        "SieveScript/get",
        json!({"ids": [id, "nope"]}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(got["list"][0]["name"], "voxel");
    assert_eq!(got["list"][0]["isActive"], json!(true));
    assert_eq!(got["notFound"], json!(["nope"]));
    let blob_id = got["list"][0]["blobId"].as_str().unwrap().to_string();
    assert!(SieveFacade::is_script_blob(&blob_id));
    let (content, kind) = f.blob(&blob_id).await.unwrap();
    assert_eq!(&content[..], b"require \"fileinto\";\nfileinto \"Junk\";\n");
    assert_eq!(kind, "application/sieve");

    // nom réservé, doublon, script invalide
    let r2 = call(
        &f,
        "SieveScript/set",
        json!({"create": {
            "a": {"name": "vacation", "blobId": "U000000000000000000000003"},
            "b": {"name": "voxel", "blobId": "U000000000000000000000003"},
            "c": {"name": "x", "blobId": "U000000000000000000000002"}
        }}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(r2["notCreated"]["a"]["type"], "forbidden");
    assert_eq!(r2["notCreated"]["b"]["type"], "alreadyExists");
    assert_eq!(r2["notCreated"]["c"]["type"], "invalidScript");

    // mise à jour du contenu, puis destruction refusée tant qu'actif
    let u = call(
        &f,
        "SieveScript/set",
        json!({"update": {id.clone(): {"blobId": "U000000000000000000000003"}}}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(
        state.lock().unwrap().get("voxel").as_deref(),
        Some("keep;\n")
    );
    assert!(u["updated"][&id]["blobId"].is_string());
    let d1 = call(
        &f,
        "SieveScript/set",
        json!({"destroy": [id]}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(d1["notDestroyed"][&id]["type"], "scriptIsActive");
    let off = call(
        &f,
        "SieveScript/set",
        json!({"onSuccessDeactivateScript": true}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(off["updated"][&id]["isActive"], json!(false));
    assert_eq!(state.lock().unwrap().active, None);
    let d2 = call(
        &f,
        "SieveScript/set",
        json!({"destroy": [id]}),
        &mut created,
        &uploads,
    )
    .await;
    assert_eq!(d2["destroyed"], json!([id]));
    assert!(state.lock().unwrap().scripts.is_empty());

    let qr = call(&f, "SieveScript/query", json!({}), &mut created, &uploads).await;
    assert_eq!(qr["total"], json!(0));
    f.close();
}

#[tokio::test]
async fn facade_unreachable_server_is_unavailable() {
    let connector = SieveConnector {
        connect: Box::new(|| {
            Box::pin(async { Err(std::io::Error::from(std::io::ErrorKind::ConnectionRefused)) })
        }),
        upgrade: None,
    };
    let f = SieveFacade::with_connector(connector, "u".into(), "p".into());
    f.probe().await;
    assert!(!f.available());
    assert!(f.capabilities().is_none());
}
