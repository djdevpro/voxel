//! Client ManageSieve (RFC 5804), minimal : TLS implicite ou STARTTLS, `AUTHENTICATE "PLAIN"`, `CAPABILITY`,
//! `LISTSCRIPTS`, `GETSCRIPT`, `PUTSCRIPT`, `CHECKSCRIPT`, `SETACTIVE`, `DELETESCRIPT`, `RENAMESCRIPT`,
//! `HAVESPACE`, `LOGOUT`. Port de `apps/server/src/sieve/client.ts`.
//!
//! Le transport est injecté (`SieveConnector`) : la production passe par `transport.rs`, les tests par un faux
//! serveur local. Les commandes sont sérialisées par `&mut self` ; délais et tailles bornés. Rien de sensible
//! n'est journalisé.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Délai par commande.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// Taille maximale d'une réponse (octets).
const DEFAULT_MAX_RESPONSE: usize = 2 * 1024 * 1024;

/// Taille d'une lecture sur le flux.
const READ_CHUNK: usize = 16 * 1024;

pub trait SieveStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> SieveStream for T {}

pub type Upgrade = Box<
    dyn FnOnce(Box<dyn SieveStream>) -> BoxFuture<'static, std::io::Result<Box<dyn SieveStream>>>
        + Send,
>;

/// Ouvre le transport (TLS implicite déjà négocié, ou connexion en clair avant STARTTLS) ; `upgrade` négocie TLS
/// après `STARTTLS` (absent : TLS implicite).
#[allow(clippy::type_complexity)]
pub struct SieveConnector {
    pub connect:
        Box<dyn Fn() -> BoxFuture<'static, std::io::Result<Box<dyn SieveStream>>> + Send + Sync>,
    pub upgrade: Option<
        Arc<
            dyn Fn(
                    Box<dyn SieveStream>,
                ) -> BoxFuture<'static, std::io::Result<Box<dyn SieveStream>>>
                + Send
                + Sync,
        >,
    >,
}

#[derive(Debug, Clone, Default)]
pub struct SieveCapabilities {
    pub implementation: Option<String>,
    pub sasl: Vec<String>,
    /// Extensions Sieve annoncées (`SIEVE`), en minuscules.
    pub sieve: Vec<String>,
    pub starttls: bool,
    pub max_redirects: Option<u32>,
    /// Taille maximale d'un script, si le serveur l'annonce (extension non standard `MAXSCRIPTSIZE`).
    pub max_script_size: Option<u64>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SieveScriptInfo {
    pub name: String,
    pub active: bool,
}

/// `Response` : réponse `NO` / `BYE` du serveur, `code` = code de réponse entre parenthèses (`QUOTA/MAXSIZE`…) ;
/// `Auth` : identifiants refusés ; `Protocol` : flux illisible, coupé ou trop lent.
#[derive(Debug, Clone, PartialEq)]
pub enum SieveError {
    Response {
        kind: String,
        code: Option<String>,
        message: String,
    },
    Auth(String),
    Protocol(String),
}

impl SieveError {
    fn response(kind: &str, code: Option<String>, message: &str) -> Self {
        // comme `super(message || `${kind} (${code})`)` en TS
        let message = if message.is_empty() {
            match &code {
                Some(c) => format!("{kind} ({c})"),
                None => kind.to_string(),
            }
        } else {
            message.to_string()
        };
        SieveError::Response {
            kind: kind.to_string(),
            code,
            message,
        }
    }
}

impl fmt::Display for SieveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SieveError::Response { message, .. } => f.write_str(message),
            SieveError::Auth(m) | SieveError::Protocol(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SieveError {}

/// Jeton d'une ligne de réponse : atome, chaîne (entre guillemets ou littéral) ou code entre parenthèses.
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Atom(String),
    Str(String),
    Code(String),
}

impl Token {
    fn value(&self) -> &str {
        match self {
            Token::Atom(v) | Token::Str(v) | Token::Code(v) => v,
        }
    }
}

/// Réponse complète : lignes de données puis statut `OK`, `NO` ou `BYE`.
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: String,
    pub code: Option<String>,
    pub message: String,
    pub lines: Vec<Vec<Token>>,
}

/// Lecteur de réponses : tampon d'octets, lignes CRLF, littéraux `{n}` / `{n+}` intégrés aux lignes.
/// Public pour les tests.
pub struct ResponseReader {
    buf: Vec<u8>,
    max: usize,
    total: usize,
    ended: bool,
}

impl ResponseReader {
    pub fn new(max: usize) -> Self {
        Self {
            buf: Vec::new(),
            max,
            total: 0,
            ended: false,
        }
    }

    /// Octets reçus mais pas encore lus (passage d'un transport à l'autre après STARTTLS).
    pub fn take_rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        self.total += chunk.len();
    }

    /// Vrai une fois le flux fermé ou en erreur.
    pub(crate) fn ended(&self) -> bool {
        self.ended
    }

    async fn need<S: AsyncRead + Unpin + ?Sized>(
        &mut self,
        stream: &mut S,
    ) -> Result<(), SieveError> {
        if self.ended {
            return Err(SieveError::Protocol("connection closed".into()));
        }
        if self.total > self.max {
            return Err(SieveError::Protocol("response too large".into()));
        }
        let mut chunk = vec![0u8; READ_CHUNK];
        match stream.read(&mut chunk).await {
            Ok(0) => {
                self.ended = true;
                Err(SieveError::Protocol("connection closed".into()))
            }
            Ok(n) => {
                self.push(&chunk[..n]);
                Ok(())
            }
            Err(e) => {
                self.ended = true;
                Err(SieveError::Protocol(e.to_string()))
            }
        }
    }

    /// Lit une ligne logique (littéraux inclus) et la découpe en jetons.
    pub async fn read_line<S: AsyncRead + Unpin + ?Sized>(
        &mut self,
        stream: &mut S,
    ) -> Result<Vec<Token>, SieveError> {
        let mut tokens = Vec::new();
        loop {
            let i = loop {
                if let Some(i) = find_crlf(&self.buf) {
                    break i;
                }
                self.need(stream).await?;
            };
            let line = String::from_utf8_lossy(&self.buf[..i]).into_owned();
            self.buf.drain(..i + 2);
            let Some(lit) = tokenize(&line, &mut tokens)? else {
                return Ok(tokens);
            };
            while self.buf.len() < lit {
                self.need(stream).await?;
            }
            tokens.push(Token::Str(
                String::from_utf8_lossy(&self.buf[..lit]).into_owned(),
            ));
            self.buf.drain(..lit);
        }
    }

    /// Lit jusqu'à la ligne de statut (`OK`, `NO`, `BYE`).
    pub async fn read_response<S: AsyncRead + Unpin + ?Sized>(
        &mut self,
        stream: &mut S,
    ) -> Result<Response, SieveError> {
        let mut lines = Vec::new();
        loop {
            let tokens = self.read_line(stream).await?;
            if let Some(Token::Atom(first)) = tokens.first() {
                let status = first.to_ascii_uppercase();
                if matches!(status.as_str(), "OK" | "NO" | "BYE") {
                    let code = tokens.iter().find_map(|t| match t {
                        Token::Code(c) => Some(c.clone()),
                        _ => None,
                    });
                    let message = tokens
                        .iter()
                        .skip(1)
                        .find_map(|t| match t {
                            Token::Str(s) => Some(s.clone()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    self.total = self.buf.len();
                    return Ok(Response {
                        status,
                        code,
                        message,
                        lines,
                    });
                }
            }
            lines.push(tokens);
        }
    }
}

fn find_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\r\n")
}

/// Découpe une ligne ; renvoie la taille d'un littéral final `{n}` / `{n+}` à lire ensuite.
fn tokenize(line: &str, out: &mut Vec<Token>) -> Result<Option<usize>, SieveError> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ' ' {
            i += 1;
        } else if c == '"' {
            let mut v = String::new();
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                v.push(chars[i]);
                i += 1;
            }
            i += 1;
            out.push(Token::Str(v));
        } else if c == '(' {
            let end = chars[i..]
                .iter()
                .position(|&x| x == ')')
                .map_or(chars.len(), |j| i + j);
            out.push(Token::Code(chars[i + 1..end].iter().collect()));
            i = end + 1;
        } else if c == '{' {
            let rest: String = chars[i..].iter().collect();
            return parse_literal(&rest)
                .map(Some)
                .ok_or_else(|| SieveError::Protocol("bad literal".into()));
        } else {
            let mut j = i;
            while j < chars.len() && chars[j] != ' ' {
                j += 1;
            }
            out.push(Token::Atom(chars[i..j].iter().collect()));
            i = j;
        }
    }
    Ok(None)
}

/// `^\{(\d{1,9})\+?\}$`.
fn parse_literal(text: &str) -> Option<usize> {
    let inner = text.strip_prefix('{')?.strip_suffix('}')?;
    let digits = inner.strip_suffix('+').unwrap_or(inner);
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

fn parse_capabilities(lines: &[Vec<Token>]) -> SieveCapabilities {
    let mut caps = SieveCapabilities::default();
    for l in lines {
        let name = l.first().map(|t| t.value().to_ascii_uppercase());
        let value = l.get(1).map(|t| t.value().to_string()).unwrap_or_default();
        match name.as_deref() {
            Some("IMPLEMENTATION") => caps.implementation = Some(value),
            Some("SASL") => {
                caps.sasl = value.split_whitespace().map(|x| x.to_uppercase()).collect()
            }
            Some("SIEVE") => {
                caps.sieve = value.split_whitespace().map(|x| x.to_lowercase()).collect()
            }
            Some("STARTTLS") => caps.starttls = true,
            Some("MAXREDIRECTS") if is_digits(&value) => caps.max_redirects = value.parse().ok(),
            Some("MAXSCRIPTSIZE") if is_digits(&value) => caps.max_script_size = value.parse().ok(),
            Some("VERSION") => caps.version = Some(value),
            _ => {}
        }
    }
    caps
}

/// Chaîne ManageSieve entre guillemets (ou littéral si elle contient CR, LF, NUL ou dépasse 1 000 octets).
fn sieve_string(s: &str) -> String {
    if s.contains(['\r', '\n', '\0']) || s.len() > 1000 {
        return literal(s);
    }
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Littéral non synchronisant (`{n+}`), toujours utilisé pour le contenu d'un script.
fn literal(s: &str) -> String {
    format!("{{{}+}}\r\n{s}", s.len())
}

pub struct ManageSieveClient {
    connector: SieveConnector,
    username: String,
    password: String,
    timeout: Duration,
    max_response: usize,
    stream: Option<Box<dyn SieveStream>>,
    reader: Option<ResponseReader>,
    capabilities: Option<SieveCapabilities>,
}

impl ManageSieveClient {
    pub fn new(connector: SieveConnector, username: String, password: String) -> Self {
        Self {
            connector,
            username,
            password,
            timeout: DEFAULT_TIMEOUT,
            max_response: DEFAULT_MAX_RESPONSE,
            stream: None,
            reader: None,
            capabilities: None,
        }
    }

    pub fn connected(&self) -> bool {
        self.stream.is_some() && self.reader.as_ref().is_some_and(|r| !r.ended())
    }

    fn attach(&mut self, stream: Box<dyn SieveStream>) {
        self.stream = Some(stream);
        self.reader = Some(ResponseReader::new(self.max_response));
    }

    /// Lit une réponse dans le délai ; délai dépassé → connexion fermée.
    async fn read(&mut self, what: &str) -> Result<Response, SieveError> {
        let (Some(stream), Some(reader)) = (self.stream.as_mut(), self.reader.as_mut()) else {
            return Err(SieveError::Protocol("not connected".into()));
        };
        match tokio::time::timeout(self.timeout, reader.read_response(stream)).await {
            Ok(r) => r,
            Err(_) => {
                self.destroy();
                Err(SieveError::Protocol(format!("{what}: timeout")))
            }
        }
    }

    async fn command(&mut self, line: &str, what: &str) -> Result<Response, SieveError> {
        let Some(stream) = self.stream.as_mut() else {
            return Err(SieveError::Protocol("not connected".into()));
        };
        if self.reader.is_none() {
            return Err(SieveError::Protocol("not connected".into()));
        }
        let written = async {
            stream.write_all(format!("{line}\r\n").as_bytes()).await?;
            stream.flush().await
        };
        if let Err(e) = written.await {
            self.destroy();
            return Err(SieveError::Protocol(e.to_string()));
        }
        let r = self.read(what).await?;
        if r.status == "BYE" {
            self.destroy();
            return Err(SieveError::response("BYE", r.code, &r.message));
        }
        Ok(r)
    }

    /// Connexion, STARTTLS si demandé, puis authentification PLAIN.
    pub async fn connect(&mut self) -> Result<SieveCapabilities, SieveError> {
        if self.connected()
            && let Some(caps) = &self.capabilities
        {
            return Ok(caps.clone());
        }
        let stream = match tokio::time::timeout(self.timeout, (self.connector.connect)()).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => return Err(SieveError::Protocol(e.to_string())),
            Err(_) => {
                self.destroy();
                return Err(SieveError::Protocol("connect: timeout".into()));
            }
        };
        self.attach(stream);
        let mut greet = self.read("greeting").await?;
        if greet.status != "OK" {
            let kind = if greet.status == "BYE" { "BYE" } else { "NO" };
            return Err(SieveError::response(kind, greet.code, &greet.message));
        }
        let mut caps = parse_capabilities(&greet.lines);
        if let Some(upgrade) = self.connector.upgrade.clone() {
            if !caps.starttls {
                return Err(SieveError::Protocol("STARTTLS not offered".into()));
            }
            let r = self.command("STARTTLS", "starttls").await?;
            if r.status != "OK" {
                return Err(SieveError::response("NO", r.code, &r.message));
            }
            let rest = self
                .reader
                .as_mut()
                .map(|r| r.take_rest())
                .unwrap_or_default();
            let raw = self
                .stream
                .take()
                .ok_or_else(|| SieveError::Protocol("not connected".into()))?;
            self.reader = None;
            let secured = match tokio::time::timeout(self.timeout, upgrade(raw)).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(SieveError::Protocol(e.to_string())),
                Err(_) => {
                    self.destroy();
                    return Err(SieveError::Protocol("tls: timeout".into()));
                }
            };
            self.attach(secured);
            if !rest.is_empty()
                && let Some(reader) = self.reader.as_mut()
            {
                reader.push(&rest);
            }
            // RFC 5804 §2.2 : le serveur renvoie ses capacités après la négociation TLS
            greet = self.read("capability").await?;
            caps = parse_capabilities(&greet.lines);
        }
        if !caps.sasl.is_empty() && !caps.sasl.iter().any(|m| m == "PLAIN") {
            return Err(SieveError::Protocol("SASL PLAIN not offered".into()));
        }
        let token = STANDARD.encode(format!("\0{}\0{}", self.username, self.password));
        let auth = self
            .command(
                &format!("AUTHENTICATE \"PLAIN\" \"{token}\""),
                "authenticate",
            )
            .await?;
        if auth.status != "OK" {
            self.destroy();
            return Err(SieveError::Auth("ManageSieve authentication failed".into()));
        }
        // certains serveurs renvoient les capacités après l'authentification (RFC 5804 §2.1)
        if !auth.lines.is_empty() {
            let more = parse_capabilities(&auth.lines);
            caps = SieveCapabilities {
                implementation: more.implementation.or(caps.implementation),
                sasl: more.sasl,
                sieve: more.sieve,
                starttls: more.starttls,
                max_redirects: more.max_redirects.or(caps.max_redirects),
                max_script_size: more.max_script_size.or(caps.max_script_size),
                version: more.version.or(caps.version),
            };
        }
        self.capabilities = Some(caps.clone());
        Ok(caps)
    }

    pub async fn capability(&mut self) -> Result<SieveCapabilities, SieveError> {
        let r = self.command("CAPABILITY", "capability").await?;
        check(&r)?;
        let caps = parse_capabilities(&r.lines);
        self.capabilities = Some(caps.clone());
        Ok(caps)
    }

    pub async fn list_scripts(&mut self) -> Result<Vec<SieveScriptInfo>, SieveError> {
        let r = self.command("LISTSCRIPTS", "listscripts").await?;
        check(&r)?;
        Ok(r.lines
            .iter()
            .filter_map(|l| match l.first() {
                Some(Token::Str(name)) => Some(SieveScriptInfo {
                    name: name.clone(),
                    active: l
                        .iter()
                        .skip(1)
                        .any(|x| matches!(x, Token::Atom(a) if a.eq_ignore_ascii_case("ACTIVE"))),
                }),
                _ => None,
            })
            .collect())
    }

    pub async fn get_script(&mut self, name: &str) -> Result<String, SieveError> {
        let r = self
            .command(&format!("GETSCRIPT {}", sieve_string(name)), "getscript")
            .await?;
        check(&r)?;
        Ok(r.lines
            .first()
            .and_then(|l| {
                l.iter().find_map(|t| match t {
                    Token::Str(s) => Some(s.clone()),
                    _ => None,
                })
            })
            .unwrap_or_default())
    }

    pub async fn put_script(&mut self, name: &str, content: &str) -> Result<(), SieveError> {
        let line = format!("PUTSCRIPT {} {}", sieve_string(name), literal(content));
        check(&self.command(&line, "putscript").await?)
    }

    /// `None` si le script est valide, sinon le message d'erreur du serveur.
    pub async fn check_script(&mut self, content: &str) -> Result<Option<String>, SieveError> {
        let r = self
            .command(&format!("CHECKSCRIPT {}", literal(content)), "checkscript")
            .await?;
        if r.status == "OK" {
            return Ok(None);
        }
        Ok(Some(if !r.message.is_empty() {
            r.message
        } else {
            r.code
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| "invalid script".into())
        }))
    }

    /// `""` désactive tous les scripts.
    pub async fn set_active(&mut self, name: &str) -> Result<(), SieveError> {
        let line = format!("SETACTIVE {}", sieve_string(name));
        check(&self.command(&line, "setactive").await?)
    }

    pub async fn delete_script(&mut self, name: &str) -> Result<(), SieveError> {
        let line = format!("DELETESCRIPT {}", sieve_string(name));
        check(&self.command(&line, "deletescript").await?)
    }

    pub async fn rename_script(&mut self, from: &str, to: &str) -> Result<(), SieveError> {
        let line = format!("RENAMESCRIPT {} {}", sieve_string(from), sieve_string(to));
        check(&self.command(&line, "renamescript").await?)
    }

    pub async fn have_space(&mut self, name: &str, size: u64) -> Result<bool, SieveError> {
        let line = format!("HAVESPACE {} {size}", sieve_string(name));
        Ok(self.command(&line, "havespace").await?.status == "OK")
    }

    pub async fn logout(&mut self) {
        if !self.connected() {
            return;
        }
        let _ = self.command("LOGOUT", "logout").await;
        self.destroy();
    }

    pub fn destroy(&mut self) {
        self.stream = None;
        self.reader = None;
        self.capabilities = None;
    }
}

fn check(r: &Response) -> Result<(), SieveError> {
    if r.status != "OK" {
        return Err(SieveError::response("NO", r.code.clone(), &r.message));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_and_literals() {
        assert_eq!(sieve_string("a \"b\" \\c"), "\"a \\\"b\\\" \\\\c\"");
        assert_eq!(sieve_string("a\nb"), "{3+}\r\na\nb");
        assert_eq!(literal("é"), "{2+}\r\né");
        assert_eq!(parse_literal("{12}"), Some(12));
        assert_eq!(parse_literal("{12+}"), Some(12));
        assert_eq!(parse_literal("{1234567890}"), None);
        assert_eq!(parse_literal("{x}"), None);
    }
}
