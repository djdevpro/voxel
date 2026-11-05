//! Une connexion IMAP authentifiée : la session async-imap, complétée des extensions qui lui manquent
//! (LIST-STATUS, codes APPENDUID/COPYUID, MOVE de secours, GETQUOTAROOT, littéraux) écrites avec
//! `run_command`/`read_response`. Chaque méthode remplace l'appel imapflow que la façade Node faisait.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use async_imap::imap_proto::{
    self, AttributeValue, BodyStructure, MailboxDatum, MessageSection, NameAttribute, Response,
    ResponseCode, SectionPath, Status, StatusAttribute,
};
use async_imap::types::{Capability, UnsolicitedResponse};
use async_imap::{Client, Session};
use chrono::{DateTime, FixedOffset};
use tokio::io::AsyncWriteExt;

use crate::ImapError;
use crate::connect::{self, ImapStream};
use crate::names::{self, Namespace};
use crate::search::SearchKey;

/// Attributs SPECIAL-USE reconnus, dans l'ordre où le premier présent est retenu.
const SPECIAL_USES: [&str; 8] = [
    "\\All",
    "\\Archive",
    "\\Drafts",
    "\\Flagged",
    "\\Junk",
    "\\Sent",
    "\\Trash",
    "\\Important",
];
/// Étiquette des commandes envoyées avant l'authentification (le générateur d'async-imap n'est pas encore là).
const PRELOGIN_TAG: &str = "V0";
/// Nom annoncé par `ID` (`clientInfo` d'imapflow).
const CLIENT_NAME: &str = "Voxel";

#[derive(Debug, Clone)]
pub struct ImapAccount {
    pub host: String,
    pub port: u16,
    pub secure: bool,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone)]
pub struct SelectedMailbox {
    pub path: String,
    pub uid_validity: u32,
    pub exists: u32,
    pub uid_next: Option<u32>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Default)]
pub struct MailboxStatus {
    pub messages: u32,
    pub unseen: u32,
    pub uid_next: u32,
    pub uid_validity: u32,
    pub highest_modseq: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ListEntry {
    pub path: String,
    pub name: String,
    pub delimiter: Option<String>,
    pub parent_path: Option<String>,
    pub flags: Vec<String>,
    pub special_use: Option<String>,
    pub subscribed: bool,
    pub status: Option<MailboxStatus>,
}

#[derive(Debug, Clone, Default)]
pub struct FetchQuery {
    pub flags: bool,
    pub internal_date: bool,
    pub size: bool,
    pub body_structure: bool,
    pub header_fields: Option<Vec<String>>,
    pub parts: Vec<PartRequest>,
}

#[derive(Debug, Clone)]
pub struct PartRequest {
    pub part: String,
    pub max_length: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct FetchedMessage {
    pub uid: u32,
    pub flags: Option<Vec<String>>,
    pub internal_date: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub size: Option<u32>,
    pub structure: Option<crate::structure::Node>,
    pub header: Option<Vec<u8>>,
    pub parts: HashMap<String, Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct UidMapping {
    pub uid_validity: u32,
    pub pairs: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Copy)]
pub enum FlagOp {
    Add,
    Remove,
    Replace,
}

/// Morceau d'une commande : texte, ou littéral IMAP (`{n}` synchronisant, `{n+}` avec LITERAL+).
pub(crate) enum Piece {
    Text(String),
    Literal(Vec<u8>),
}

pub struct ImapSession {
    inner: Option<Session<ImapStream>>,
    caps: BTreeSet<String>,
    selected: Option<SelectedMailbox>,
    usable: bool,
    /// Réponses lues depuis l'ouverture : le pool sait ainsi si une connexion est tombée avant toute réponse.
    responses: u64,
    /// Dernière synchronisation (NOOP ou SELECT) de la boîte sélectionnée, pour `with_mailbox`.
    pub(crate) synced: Option<(String, Instant)>,
    /// Place de compte tenue tant que la connexion vit (rendue à sa destruction).
    pub(crate) slot: Option<crate::pool::AccountSlot>,
    /// Espace de noms personnel, lu à l'ouverture (préfixe ajouté aux chemins).
    ns: Namespace,
    /// Noms en UTF-8 sur le fil (IMAP4rev2 seul) ; sinon UTF-7 modifié.
    utf8_names: bool,
    /// `PERMANENTFLAGS` du dernier SELECT/EXAMINE (`None` si le serveur ne l'a pas envoyé).
    permanent: Option<Vec<String>>,
}

fn cap_name(c: &Capability) -> String {
    match c {
        Capability::Imap4rev1 => "IMAP4REV1".into(),
        Capability::Auth(a) => format!("AUTH={}", a.to_uppercase()),
        Capability::Atom(a) => a.to_uppercase(),
    }
}

fn proto_cap_name(c: &imap_proto::Capability<'_>) -> String {
    match c {
        imap_proto::Capability::Imap4rev1 => "IMAP4REV1".into(),
        imap_proto::Capability::Auth(a) => format!("AUTH={}", a.to_uppercase()),
        imap_proto::Capability::Atom(a) => a.to_uppercase(),
    }
}

fn attribute_name(a: &NameAttribute<'_>) -> String {
    match a {
        NameAttribute::NoInferiors => "\\Noinferiors".into(),
        NameAttribute::NoSelect => "\\Noselect".into(),
        NameAttribute::Marked => "\\Marked".into(),
        NameAttribute::Unmarked => "\\Unmarked".into(),
        NameAttribute::All => "\\All".into(),
        NameAttribute::Archive => "\\Archive".into(),
        NameAttribute::Drafts => "\\Drafts".into(),
        NameAttribute::Flagged => "\\Flagged".into(),
        NameAttribute::Junk => "\\Junk".into(),
        NameAttribute::Sent => "\\Sent".into(),
        NameAttribute::Trash => "\\Trash".into(),
        NameAttribute::Extension(e) => e.to_string(),
        #[allow(unreachable_patterns)]
        other => format!("{other:?}"),
    }
}

/// Chaîne IMAP citée (`\\` et `\"` échappés).
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Date d'APPEND au format IMAP `dd-Mon-yyyy HH:MM:SS +zzzz`.
fn imap_date(d: &DateTime<FixedOffset>) -> String {
    d.format("%d-%b-%Y %H:%M:%S %z").to_string()
}

fn expand(set: &[imap_proto::rfc4315::UidSetMember]) -> Vec<u32> {
    let mut out = Vec::new();
    for m in set {
        match m {
            imap_proto::rfc4315::UidSetMember::Uid(u) => out.push(*u),
            imap_proto::rfc4315::UidSetMember::UidRange(r) => out.extend(r.clone()),
        }
    }
    out
}

/// Code entre crochets d'un refus d'authentification (`ALERT`, `AUTHENTICATIONFAILED`…), d'après le texte
/// `code: Some(X), info: Some("[Y] …")` des erreurs async-imap.
fn response_code(text: &str) -> Option<String> {
    let code = text.split("code: Some(").nth(1).map(|r| {
        r.chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
    });
    if let Some(c) = code.filter(|c| !c.is_empty()) {
        return Some(c.to_uppercase());
    }
    let info = text.split('[').nth(1)?;
    let c: String = info
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if c.is_empty() || !info[c.len()..].starts_with(']') {
        None
    } else {
        Some(c.to_uppercase())
    }
}

/// Attributs d'une réponse `FETCH`, lus sans passer par les types d'async-imap.
struct Attrs<'a>(&'a [AttributeValue<'a>]);

impl Attrs<'_> {
    fn uid(&self) -> Option<u32> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::Uid(u) => Some(*u),
            _ => None,
        })
    }

    fn size(&self) -> Option<u32> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::Rfc822Size(n) => Some(*n),
            _ => None,
        })
    }

    fn flags(&self) -> Vec<String> {
        self.0
            .iter()
            .find_map(|a| match a {
                AttributeValue::Flags(f) => Some(f.iter().map(|x| x.to_string()).collect()),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn internal_date(&self) -> Option<DateTime<FixedOffset>> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::InternalDate(d) => {
                DateTime::parse_from_str(d.trim(), "%d-%b-%Y %H:%M:%S %z").ok()
            }
            _ => None,
        })
    }

    fn bodystructure(&self) -> Option<&BodyStructure<'_>> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::BodyStructure(b) => Some(b),
            _ => None,
        })
    }

    fn header(&self) -> Option<&[u8]> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::BodySection {
                section: Some(SectionPath::Full(MessageSection::Header)),
                data: Some(d),
                ..
            }
            | AttributeValue::Rfc822Header(Some(d)) => Some(d.as_ref()),
            _ => None,
        })
    }

    fn body(&self) -> Option<&[u8]> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::BodySection {
                section: None,
                data: Some(d),
                ..
            }
            | AttributeValue::Rfc822(Some(d)) => Some(d.as_ref()),
            _ => None,
        })
    }

    fn section(&self, path: &SectionPath) -> Option<&[u8]> {
        self.0.iter().find_map(|a| match a {
            AttributeValue::BodySection {
                section: Some(p),
                data: Some(d),
                ..
            } if p == path => Some(d.as_ref()),
            _ => None,
        })
    }
}

/// Refuse une chaîne qui contient CR, LF ou NUL : elle ajouterait une commande IMAP (C15).
pub(crate) fn check_text(s: &str) -> Result<(), ImapError> {
    if s.contains(['\r', '\n', '\0']) {
        return Err(ImapError::Command(
            "invalid IMAP string (CR, LF or NUL)".into(),
        ));
    }
    Ok(())
}

/// Ensemble d'UID : `^[0-9]+(:[0-9]+|:\*)?(,[0-9]+(:[0-9]+|:\*)?)*$` (C15).
pub(crate) fn check_uid_set(set: &str) -> Result<(), ImapError> {
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    let item_ok = |item: &str| match item.split_once(':') {
        Some((a, b)) => digits(a) && (b == "*" || digits(b)),
        None => digits(item),
    };
    if set.split(',').all(item_ok) {
        Ok(())
    } else {
        Err(ImapError::Command("invalid UID set".into()))
    }
}

fn checked_uid_set(set: &str) -> Result<&str, ImapError> {
    check_uid_set(set).map(|()| set)
}

/// Nom d'en-tête : `^[\x21-\x39\x3b-\x7e]+$` (C15).
pub(crate) fn check_header_name(name: &str) -> Result<(), ImapError> {
    if !name.is_empty()
        && name
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b':')
    {
        Ok(())
    } else {
        Err(ImapError::Command("invalid header name".into()))
    }
}

/// Lecture d'une réponse pendant une commande.
#[derive(Debug, PartialEq)]
enum Step {
    Continue,
    Done,
    Refused(String),
    Other,
}

fn refused_text(o: &imap_proto::Outcome<'_>) -> String {
    o.information
        .as_deref()
        .unwrap_or("command refused")
        .to_string()
}

/// Réponse après l'envoi complet : la ligne balisée `OK` termine, `NO`/`BAD` refuse (C15), le reste est
/// une réponse non balisée de la commande.
fn final_step(r: &Response<'_>, expected: Option<&imap_proto::RequestId>) -> Step {
    match r {
        Response::Done {
            tag,
            status,
            outcome,
        } if expected == Some(tag) => match status {
            Status::Ok => Step::Done,
            _ => Step::Refused(refused_text(outcome)),
        },
        _ => Step::Other,
    }
}

/// Plafond de la réponse `NAMESPACE` lue à la main.
const NAMESPACE_MAX: usize = 64 * 1024;
/// Étiquette de `NAMESPACE`, distincte de celles d'async-imap (`A1`, `A2`…).
const NAMESPACE_TAG: &[u8] = b"V1 ";

/// `NAMESPACE` lu à la main : imap-proto 0.17 ne sait pas analyser sa réponse, et une réponse illisible
/// reste dans le tampon d'async-imap, qui échoue alors à chaque lecture. L'échange a lieu juste après le
/// `CAPABILITY` qui suit l'authentification, avant `ID` et `ENABLE` : aucune commande d'async-imap n'est
/// en vol. Le tampon de lecture d'async-imap est privé et ne peut pas être inspecté ; on suppose donc que
/// le serveur n'envoie rien entre la réponse balisée de `CAPABILITY` et la commande suivante (C7).
/// Flux dans un état inconnu (délai, plus de 64 Kio, fermeture avant la ligne balisée) → `Unavailable` ;
/// `NO`, `BAD` ou réponse illisible → `Namespace::default()`.
async fn raw_namespace(
    session: &mut Session<ImapStream>,
    timeout: Duration,
) -> Result<Namespace, ImapError> {
    use tokio::io::AsyncReadExt;
    let stream = session.get_mut();
    let io = async {
        stream.write_all(b"V1 NAMESPACE\r\n").await.ok()?;
        stream.flush().await.ok()?;
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 1];
        loop {
            if stream.read(&mut chunk).await.ok()? == 0 || buf.len() >= NAMESPACE_MAX {
                return None;
            }
            buf.push(chunk[0]);
            if buf.ends_with(b"\r\n") {
                let start = buf[..buf.len() - 2]
                    .iter()
                    .rposition(|b| *b == b'\n')
                    .map_or(0, |i| i + 1);
                if buf[start..].starts_with(NAMESPACE_TAG) {
                    return Some(buf);
                }
            }
        }
    };
    match tokio::time::timeout(timeout, io).await {
        Ok(Some(buf)) => Ok(names::parse_namespace(&buf).unwrap_or_default()),
        _ => Err(ImapError::Unavailable(
            "IMAP server unreachable (namespace)".into(),
        )),
    }
}

fn auth_error(e: async_imap::error::Error) -> ImapError {
    use async_imap::error::Error;
    match e {
        Error::No(t) | Error::Bad(t) => {
            if t.to_lowercase()
                .contains("too many simultaneous connections")
            {
                ImapError::Unavailable(
                    "IMAP server refused: too many simultaneous connections for this account"
                        .into(),
                )
            } else {
                let code = response_code(&t)
                    .map(|c| format!(" [{c}]"))
                    .unwrap_or_default();
                ImapError::Auth(format!("IMAP authentication failed{code}"))
            }
        }
        other => ImapError::from(other),
    }
}

/// `AUTHENTICATE PLAIN` (serveurs qui annoncent `LOGINDISABLED`).
struct Plain<'a> {
    user: &'a str,
    pass: &'a str,
}

impl async_imap::Authenticator for Plain<'_> {
    type Response = Vec<u8>;
    fn process(&mut self, _challenge: &[u8]) -> Vec<u8> {
        format!("\0{}\0{}", self.user, self.pass).into_bytes()
    }
}

fn lost() -> ImapError {
    ImapError::Unavailable("IMAP connection lost".into())
}

/// Lit une réponse avant l'authentification, sous délai.
async fn read_prelogin<R>(
    client: &mut Client<
        impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
    >,
    timeout: Duration,
    f: impl FnOnce(&Response<'_>) -> R,
) -> Result<R, ImapError> {
    match tokio::time::timeout(timeout, client.read_response()).await {
        Ok(Ok(Some(r))) => Ok(f(r.parsed())),
        Ok(Ok(None)) | Ok(Err(_)) => Err(lost()),
        Err(_) => Err(ImapError::Unavailable(
            "IMAP server unreachable (TimedOut)".into(),
        )),
    }
}

impl ImapSession {
    /// TCP, TLS implicite ou STARTTLS, CAPABILITY, LOGIN (ou AUTHENTICATE PLAIN), CAPABILITY, ID, ENABLE CONDSTORE.
    pub async fn open(
        account: &ImapAccount,
        connect_timeout: Duration,
        greeting_timeout: Duration,
    ) -> Result<ImapSession, ImapError> {
        let tcp = connect::tcp(&account.host, account.port, connect_timeout).await?;
        let tls = if account.secure {
            connect::tls(tcp, &account.host, connect_timeout).await?
        } else {
            let mut plain = Client::new(tcp);
            greeting(&mut plain, greeting_timeout).await?;
            tokio::time::timeout(
                greeting_timeout,
                plain.run_command_and_check_ok("STARTTLS", None),
            )
            .await
            .map_err(|_| ImapError::Unavailable("IMAP server unreachable (TimedOut)".into()))?
            .map_err(|_| ImapError::Unavailable("IMAP server unreachable (tls)".into()))?;
            connect::tls(plain.into_inner(), &account.host, connect_timeout).await?
        };
        let mut client = Client::new(tls);
        if account.secure {
            greeting(&mut client, greeting_timeout).await?;
        }
        // CAPABILITY avant l'authentification : LOGINDISABLED impose AUTHENTICATE PLAIN.
        client
            .get_mut()
            .write_all(format!("{PRELOGIN_TAG} CAPABILITY\r\n").as_bytes())
            .await
            .map_err(|_| lost())?;
        client.get_mut().flush().await.map_err(|_| lost())?;
        let mut pre_caps = BTreeSet::new();
        loop {
            let done = read_prelogin(&mut client, greeting_timeout, |r| match r {
                Response::Capabilities(list) => {
                    pre_caps.extend(list.iter().map(proto_cap_name));
                    false
                }
                Response::Done { tag, .. } => tag.0 == PRELOGIN_TAG,
                _ => false,
            })
            .await?;
            if done {
                break;
            }
        }
        let login = async {
            if pre_caps.contains("LOGINDISABLED") {
                client
                    .authenticate(
                        "PLAIN",
                        Plain {
                            user: &account.username,
                            pass: &account.password,
                        },
                    )
                    .await
            } else {
                client.login(&account.username, &account.password).await
            }
        };
        let mut session = match tokio::time::timeout(greeting_timeout, login).await {
            Ok(Ok(s)) => s,
            Ok(Err((e, _))) => return Err(auth_error(e)),
            Err(_) => {
                return Err(ImapError::Unavailable(
                    "IMAP server unreachable (TimedOut)".into(),
                ));
            }
        };
        let caps: BTreeSet<String> = session
            .capabilities()
            .await
            .map_err(ImapError::from)?
            .iter()
            .map(cap_name)
            .collect();
        let namespace = if caps.contains("NAMESPACE") {
            Some(raw_namespace(&mut session, connect_timeout).await?)
        } else {
            None
        };
        if caps.contains("ID") {
            let _ = session
                .run_command_and_check_ok(format!("ID (\"name\" {})", quoted(CLIENT_NAME)))
                .await;
        }
        if caps.contains("ENABLE") && caps.contains("CONDSTORE") {
            let _ = session.run_command_and_check_ok("ENABLE CONDSTORE").await;
        }
        let utf8_names = caps.contains("IMAP4REV2") && !caps.contains("IMAP4REV1");
        let mut s = ImapSession {
            inner: Some(session),
            caps,
            selected: None,
            usable: true,
            responses: 1,
            synced: None,
            slot: None,
            ns: Namespace::default(),
            utf8_names,
            permanent: None,
        };
        s.drain_unsolicited();
        s.ns = match namespace {
            Some(ns) => ns,
            None => s.load_namespace().await?,
        };
        Ok(s)
    }

    pub fn capabilities(&self) -> &BTreeSet<String> {
        &self.caps
    }

    pub fn has(&self, cap: &str) -> bool {
        self.caps.contains(&cap.to_uppercase())
    }

    pub fn is_usable(&self) -> bool {
        self.usable && self.inner.is_some()
    }

    pub fn namespace(&self) -> &names::Namespace {
        &self.ns
    }

    pub fn selected(&self) -> Option<&SelectedMailbox> {
        self.selected.as_ref()
    }

    pub(crate) fn responses(&self) -> u64 {
        self.responses
    }

    /// Session async-imap prêtée à l'IDLE (rendue par `put_session`).
    pub(crate) fn take_session(&mut self) -> Option<Session<ImapStream>> {
        self.inner.take()
    }

    pub(crate) fn put_session(&mut self, s: Session<ImapStream>) {
        self.inner = Some(s);
    }

    pub(crate) fn mark_unusable(&mut self) {
        self.usable = false;
    }

    fn session(&mut self) -> Result<&mut Session<ImapStream>, ImapError> {
        if !self.usable {
            return Err(lost());
        }
        self.inner.as_mut().ok_or_else(lost)
    }

    /// Réponses non sollicitées rangées par async-imap : seul le dernier EXISTS compte ici.
    fn drain_unsolicited(&mut self) {
        let Some(s) = self.inner.as_mut() else { return };
        while let Ok(u) = s.unsolicited_responses.try_recv() {
            if let UnsolicitedResponse::Exists(n) = u
                && let Some(sel) = self.selected.as_mut()
            {
                sel.exists = n;
            }
        }
    }

    /// Espace de noms personnel sans la capacité `NAMESPACE` : `LIST "" ""`.
    async fn load_namespace(&mut self) -> Result<Namespace, ImapError> {
        let with_delimiter = |prefix: String, delimiter: Option<String>| {
            let mut prefix = prefix;
            if let Some(d) = delimiter.as_deref().filter(|d| !d.is_empty())
                && !prefix.is_empty()
                && !prefix.ends_with(d)
            {
                prefix.push_str(d);
            }
            Namespace { prefix, delimiter }
        };
        let mut root: Option<(String, Option<String>)> = None;
        let r = self
            .exec_text("LIST \"\" \"\"".into(), |r| {
                if let Response::MailboxData(MailboxDatum::List(l)) = r {
                    root = Some((
                        l.name.to_string(),
                        l.delimiter.as_ref().map(|d| d.to_string()),
                    ));
                }
            })
            .await;
        match (r, root) {
            (Ok(()), Some((name, delimiter))) => {
                let name = match delimiter.as_deref().filter(|d| !d.is_empty()) {
                    Some(d) => name.strip_prefix(d).unwrap_or(&name).to_string(),
                    None => name,
                };
                Ok(with_delimiter(name, delimiter))
            }
            (Err(ImapError::Unavailable(t)), _) => Err(ImapError::Unavailable(t)),
            _ => Ok(Namespace::default()),
        }
    }

    /// Nom de dossier sur le fil : préfixe, UTF-7 modifié, chaîne IMAP citée.
    /// Le contrôle CR/LF/NUL porte sur la forme envoyée (C16) : en UTF-7 modifié, un nom décodé qui
    /// contient ces caractères (`&AAo-` donne LF) reste utilisable.
    fn mailbox(&self, path: &str) -> Result<Piece, ImapError> {
        let wire = names::wire_path(&self.ns, self.utf8_names, path);
        check_text(&wire)?;
        Ok(Piece::Text(quoted(&wire)))
    }

    async fn send_line(
        &mut self,
        tag: &mut Option<imap_proto::RequestId>,
        line: &[u8],
    ) -> Result<(), ImapError> {
        let s = self.session()?;
        let r = match tag {
            None => match std::str::from_utf8(line) {
                Ok(text) => s
                    .run_command(text)
                    .await
                    .map(|id| *tag = Some(id))
                    .map_err(ImapError::from),
                Err(_) => return Err(ImapError::Protocol("command is not UTF-8".into())),
            },
            Some(_) => {
                let stream = s.get_mut();
                let mut buf = line.to_vec();
                buf.extend_from_slice(b"\r\n");
                match stream.write_all(&buf).await {
                    Ok(()) => stream.flush().await.map_err(|_| lost()),
                    Err(_) => Err(lost()),
                }
            }
        };
        if r.is_err() {
            self.usable = false;
        }
        r
    }

    /// Lit une réponse ; met à jour EXISTS, BYE et le compteur de réponses.
    async fn next_with<R>(&mut self, f: impl FnOnce(&Response<'_>) -> R) -> Result<R, ImapError> {
        let s = self.session()?;
        let r = match s.read_response().await {
            Ok(Some(r)) => r,
            Ok(None) | Err(_) => {
                self.usable = false;
                return Err(lost());
            }
        };
        self.responses += 1;
        let parsed = r.parsed();
        match parsed {
            Response::MailboxData(MailboxDatum::Exists(n)) => {
                if let Some(sel) = self.selected.as_mut() {
                    sel.exists = *n;
                }
            }
            Response::Data {
                status: Status::Bye,
                ..
            } => self.usable = false,
            _ => {}
        }
        Ok(f(parsed))
    }

    /// Envoie une commande (littéraux compris) ; `on` voit chacune de ses réponses, la réponse balisée en dernier.
    async fn exec(
        &mut self,
        pieces: Vec<Piece>,
        mut on: impl FnMut(&Response<'_>) + Send,
    ) -> Result<(), ImapError> {
        let plus = self.caps.contains("LITERAL+");
        let mut tag: Option<imap_proto::RequestId> = None;
        let mut pending: Vec<u8> = Vec::new();
        for piece in pieces {
            match piece {
                Piece::Text(t) => pending.extend_from_slice(t.as_bytes()),
                Piece::Literal(bytes) => {
                    pending.extend_from_slice(
                        format!("{{{}{}}}", bytes.len(), if plus { "+" } else { "" }).as_bytes(),
                    );
                    self.send_line(&mut tag, &pending).await?;
                    pending.clear();
                    if !plus {
                        loop {
                            let expected = tag.clone();
                            let step = self
                                .next_with(|r| match r {
                                    Response::Continue(_) => Step::Continue,
                                    Response::Done {
                                        tag: t, outcome, ..
                                    } if expected.as_ref() == Some(t) => {
                                        Step::Refused(refused_text(outcome))
                                    }
                                    other => {
                                        on(other);
                                        Step::Other
                                    }
                                })
                                .await?;
                            match step {
                                Step::Continue => break,
                                Step::Refused(text) => return Err(ImapError::Command(text)),
                                _ => {}
                            }
                        }
                    }
                    pending.extend_from_slice(&bytes);
                }
            }
        }
        self.send_line(&mut tag, &pending).await?;
        loop {
            let expected = tag.clone();
            let step = self
                .next_with(|r| {
                    let step = final_step(r, expected.as_ref());
                    if !matches!(step, Step::Refused(_)) {
                        on(r);
                    }
                    step
                })
                .await?;
            match step {
                Step::Done => return Ok(()),
                Step::Refused(text) => return Err(ImapError::Command(text)),
                _ => {}
            }
        }
    }

    async fn exec_text(
        &mut self,
        command: String,
        on: impl FnMut(&Response<'_>) + Send,
    ) -> Result<(), ImapError> {
        self.exec(vec![Piece::Text(command)], on).await
    }

    pub async fn list(&mut self, with_highest_modseq: bool) -> Result<Vec<ListEntry>, ImapError> {
        let status_items = format!(
            "MESSAGES UNSEEN UIDNEXT UIDVALIDITY{}",
            if with_highest_modseq {
                " HIGHESTMODSEQ"
            } else {
                ""
            }
        );
        let mut raw: Vec<(String, Option<String>, Vec<String>)> = Vec::new();
        let mut statuses: HashMap<String, MailboxStatus> = HashMap::new();
        let collect_status = |status: &[StatusAttribute]| {
            let mut st = MailboxStatus::default();
            for a in status {
                match a {
                    StatusAttribute::Messages(n) => st.messages = *n,
                    StatusAttribute::Unseen(n) => st.unseen = *n,
                    StatusAttribute::UidNext(n) => st.uid_next = *n,
                    StatusAttribute::UidValidity(n) => st.uid_validity = *n,
                    StatusAttribute::HighestModSeq(n) => st.highest_modseq = Some(*n),
                    _ => {}
                }
            }
            st
        };
        let list_status = self.caps.contains("LIST-STATUS");
        let mut subscribed: BTreeSet<String> = BTreeSet::new();
        let command = if list_status {
            format!("LIST \"\" \"*\" RETURN (SUBSCRIBED SPECIAL-USE STATUS ({status_items}))")
        } else {
            "LIST \"\" \"*\"".to_string()
        };
        self.exec_text(command, |r| match r {
            Response::MailboxData(MailboxDatum::List(l)) => {
                raw.push((
                    l.name.to_string(),
                    l.delimiter.as_ref().map(|d| d.to_string()),
                    l.name_attributes.iter().map(attribute_name).collect(),
                ));
            }
            Response::MailboxData(MailboxDatum::Status { mailbox, status }) => {
                statuses.insert(mailbox.to_string(), collect_status(status));
            }
            _ => {}
        })
        .await?;
        if !list_status {
            self.exec_text("LSUB \"\" \"*\"".to_string(), |r| {
                if let Response::MailboxData(MailboxDatum::List(l)) = r {
                    subscribed.insert(l.name.to_string());
                }
            })
            .await?;
            for (path, delimiter, flags) in &raw {
                if flags.iter().any(|f| {
                    f.eq_ignore_ascii_case("\\Noselect") || f.eq_ignore_ascii_case("\\NonExistent")
                }) {
                    continue;
                }
                let listed =
                    names::listed_path(&self.ns, self.utf8_names, path, delimiter.as_deref());
                // nom refusé : ce dossier reste sans statut, la liste ne tombe pas (C16)
                let Ok(name) = self.mailbox(&listed) else {
                    continue;
                };
                let pieces = vec![
                    Piece::Text("STATUS ".into()),
                    name,
                    Piece::Text(format!(" ({status_items})")),
                ];
                let mut found = None;
                match self
                    .exec(pieces, |r| {
                        if let Response::MailboxData(MailboxDatum::Status { status, .. }) = r {
                            found = Some(collect_status(status));
                        }
                    })
                    .await
                {
                    Ok(()) => {
                        if let Some(st) = found {
                            statuses.insert(path.clone(), st);
                        }
                    }
                    Err(ImapError::Command(_)) => {}
                    Err(e) => return Err(e),
                }
            }
        }
        // statuts et abonnements restent indexés par le nom brut du serveur
        Ok(raw
            .into_iter()
            .map(|(raw_name, delimiter, flags)| {
                let path =
                    names::listed_path(&self.ns, self.utf8_names, &raw_name, delimiter.as_deref());
                let (name, parent_path) = match delimiter
                    .as_deref()
                    .filter(|d| !d.is_empty())
                    .and_then(|d| path.rfind(d).map(|i| (i, d.len())))
                {
                    Some((i, len)) => (path[i + len..].to_string(), Some(path[..i].to_string())),
                    None => (path.clone(), None),
                };
                let special_use = flags
                    .iter()
                    .find(|f| SPECIAL_USES.iter().any(|s| s.eq_ignore_ascii_case(f)))
                    .cloned();
                let is_subscribed = if list_status {
                    flags.iter().any(|f| f.eq_ignore_ascii_case("\\Subscribed"))
                } else {
                    subscribed.contains(&raw_name)
                };
                ListEntry {
                    status: statuses.remove(&raw_name),
                    name,
                    parent_path,
                    delimiter,
                    special_use,
                    subscribed: is_subscribed,
                    flags,
                    path,
                }
            })
            .collect())
    }

    pub async fn select(
        &mut self,
        path: &str,
        read_only: bool,
    ) -> Result<SelectedMailbox, ImapError> {
        self.selected = None;
        self.synced = None;
        let pieces = vec![
            Piece::Text(if read_only {
                "EXAMINE ".into()
            } else {
                "SELECT ".into()
            }),
            self.mailbox(path)?,
        ];
        self.permanent = None;
        let mut permanent = None;
        let mut sel = SelectedMailbox {
            path: names::normalize_path(&self.ns, path, false),
            uid_validity: 0,
            exists: 0,
            uid_next: None,
            read_only,
        };
        self.exec(pieces, |r| match r {
            Response::MailboxData(MailboxDatum::Exists(n)) => sel.exists = *n,
            Response::Data { outcome, .. } | Response::Done { outcome, .. } => {
                match &outcome.code {
                    Some(ResponseCode::UidValidity(v)) => sel.uid_validity = *v,
                    Some(ResponseCode::UidNext(n)) => sel.uid_next = Some(*n),
                    Some(ResponseCode::ReadOnly) => sel.read_only = true,
                    Some(ResponseCode::PermanentFlags(flags)) => {
                        permanent = Some(flags.iter().map(|f| f.to_string()).collect())
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .await?;
        self.permanent = permanent;
        self.selected = Some(sel.clone());
        Ok(sel)
    }

    pub async fn noop(&mut self) -> Result<(), ImapError> {
        self.exec_text("NOOP".into(), |_| {}).await
    }

    pub async fn uid_search(&mut self, key: &SearchKey) -> Result<Vec<u32>, ImapError> {
        let (criteria, utf8) = key.to_imap(self.caps.contains("LITERAL+"))?;
        let mut pieces = vec![Piece::Text(
            if utf8 {
                "UID SEARCH CHARSET UTF-8 "
            } else {
                "UID SEARCH "
            }
            .to_string(),
        )];
        pieces.extend(criteria);
        let mut uids = BTreeSet::new();
        self.exec(pieces, |r| {
            if let Response::MailboxData(MailboxDatum::Search(list)) = r {
                uids.extend(list.iter().copied());
            }
        })
        .await?;
        Ok(uids.into_iter().collect())
    }

    /// `UID FETCH` par l'exécution contrôlée (C15) : `NO`/`BAD` → `Command`, fin de flux → `Unavailable`,
    /// jamais une liste partielle rendue comme un succès. `f` lit les attributs de chaque réponse.
    async fn fetch_with<T: Send>(
        &mut self,
        uid_set: &str,
        query: &str,
        mut f: impl FnMut(&Attrs<'_>) -> Option<T> + Send,
    ) -> Result<Vec<T>, ImapError> {
        check_uid_set(uid_set)?;
        let mut out = Vec::new();
        self.exec_text(format!("UID FETCH {uid_set} {query}"), |r| {
            if let Response::Fetch(_, attrs) = r
                && let Some(v) = f(&Attrs(attrs))
            {
                out.push(v);
            }
        })
        .await?;
        Ok(out)
    }

    pub async fn uid_fetch(
        &mut self,
        uid_set: &str,
        query: &FetchQuery,
    ) -> Result<Vec<FetchedMessage>, ImapError> {
        let mut items = vec!["UID".to_string()];
        if query.flags {
            items.push("FLAGS".into());
        }
        if query.internal_date {
            items.push("INTERNALDATE".into());
        }
        if query.size {
            items.push("RFC822.SIZE".into());
        }
        if query.body_structure {
            items.push("BODYSTRUCTURE".into());
        }
        if let Some(fields) = &query.header_fields {
            for name in fields {
                check_header_name(name)?;
            }
            items.push(format!("BODY.PEEK[HEADER.FIELDS ({})]", fields.join(" ")));
        }
        let mut sections: Vec<(String, Vec<u32>)> = Vec::new();
        for p in &query.parts {
            let Ok(numbers) = p
                .part
                .split('.')
                .map(|n| n.parse::<u32>())
                .collect::<Result<Vec<_>, _>>()
            else {
                continue;
            };
            items.push(match p.max_length {
                Some(max) => format!("BODY.PEEK[{}]<0.{max}>", p.part),
                None => format!("BODY.PEEK[{}]", p.part),
            });
            sections.push((p.part.clone(), numbers));
        }
        let q = format!("({})", items.join(" "));
        self.fetch_with(uid_set, &q, |fetch| {
            let uid = fetch.uid()?;
            let mut m = FetchedMessage {
                uid,
                size: fetch.size(),
                internal_date: fetch.internal_date(),
                ..FetchedMessage::default()
            };
            if query.flags {
                m.flags = Some(fetch.flags());
            }
            m.structure = fetch.bodystructure().map(crate::structure::node_from_imap);
            m.header = fetch.header().map(<[u8]>::to_vec);
            for (key, numbers) in &sections {
                if let Some(data) = fetch.section(&SectionPath::Part(numbers.clone(), None)) {
                    m.parts.insert(key.clone(), data.to_vec());
                }
            }
            Some(m)
        })
        .await
    }

    pub async fn changed_since(&mut self, modseq: u64) -> Result<Vec<u32>, ImapError> {
        let mut uids = self
            .fetch_with(
                "1:*",
                &format!("(UID FLAGS) (CHANGEDSINCE {modseq})"),
                |f| f.uid(),
            )
            .await?;
        uids.sort_unstable();
        uids.dedup();
        Ok(uids)
    }

    pub async fn store_flags(
        &mut self,
        uid_set: &str,
        op: FlagOp,
        flags: &[String],
    ) -> Result<(), ImapError> {
        check_uid_set(uid_set)?;
        let item = match op {
            FlagOp::Add => "+FLAGS.SILENT",
            FlagOp::Remove => "-FLAGS.SILENT",
            FlagOp::Replace => "FLAGS.SILENT",
        };
        let Some(flags) = names::store_flags(op, flags, self.permanent.as_deref()) else {
            return Ok(());
        };
        self.exec_text(
            format!("UID STORE {uid_set} {item} ({})", flags.join(" ")),
            |_| {},
        )
        .await
    }

    /// Code `COPYUID` d'une réponse (non balisée `* OK [COPYUID …]` ou balisée, selon le serveur).
    fn copy_uid(r: &Response<'_>, mapping: &mut Option<UidMapping>) {
        if let Response::Data { outcome, .. } | Response::Done { outcome, .. } = r
            && let Some(ResponseCode::CopyUid(v, src, dst)) = &outcome.code
        {
            *mapping = Some(UidMapping {
                uid_validity: *v,
                pairs: expand(src).into_iter().zip(expand(dst)).collect(),
            });
        }
    }

    pub async fn uid_copy(
        &mut self,
        uid_set: &str,
        dest: &str,
    ) -> Result<Option<UidMapping>, ImapError> {
        let pieces = vec![
            Piece::Text(format!("UID COPY {} ", checked_uid_set(uid_set)?)),
            self.mailbox(dest)?,
        ];
        let mut mapping = None;
        self.exec(pieces, |r| Self::copy_uid(r, &mut mapping))
            .await?;
        Ok(mapping)
    }

    /// `\Deleted` puis `UID EXPUNGE` (UIDPLUS) ou `EXPUNGE`.
    async fn delete_and_expunge(&mut self, uid_set: &str) -> Result<(), ImapError> {
        self.store_flags(uid_set, FlagOp::Add, &[r"\Deleted".to_string()])
            .await?;
        let command = if self.caps.contains("UIDPLUS") {
            format!("UID EXPUNGE {uid_set}")
        } else {
            "EXPUNGE".to_string()
        };
        self.exec_text(command, |_| {}).await
    }

    pub async fn uid_move(
        &mut self,
        uid_set: &str,
        dest: &str,
    ) -> Result<Option<UidMapping>, ImapError> {
        if self.caps.contains("MOVE") {
            let pieces = vec![
                Piece::Text(format!("UID MOVE {} ", checked_uid_set(uid_set)?)),
                self.mailbox(dest)?,
            ];
            let mut mapping = None;
            self.exec(pieces, |r| Self::copy_uid(r, &mut mapping))
                .await?;
            return Ok(mapping);
        }
        let mapping = self.uid_copy(uid_set, dest).await?;
        self.delete_and_expunge(uid_set).await?;
        Ok(mapping)
    }

    pub async fn uid_delete(&mut self, uid_set: &str) -> Result<(), ImapError> {
        self.delete_and_expunge(uid_set).await
    }

    pub async fn append(
        &mut self,
        path: &str,
        flags: &[String],
        internal_date: DateTime<FixedOffset>,
        message: &[u8],
    ) -> Result<Option<(u32, u32)>, ImapError> {
        let pieces = vec![
            Piece::Text("APPEND ".into()),
            self.mailbox(path)?,
            Piece::Text(format!(
                " ({}) \"{}\" ",
                flags
                    .iter()
                    .filter_map(|f| names::format_flag(f))
                    .collect::<Vec<_>>()
                    .join(" "),
                imap_date(&internal_date)
            )),
            Piece::Literal(message.to_vec()),
        ];
        let mut appended = None;
        self.exec(pieces, |r| {
            if let Response::Done { outcome, .. } | Response::Data { outcome, .. } = r
                && let Some(ResponseCode::AppendUid(v, set)) = &outcome.code
            {
                appended = expand(set).first().map(|uid| (*v, *uid));
            }
        })
        .await?;
        Ok(appended)
    }

    async fn mailbox_command(&mut self, verb: &str, path: &str) -> Result<(), ImapError> {
        let pieces = vec![Piece::Text(format!("{verb} ")), self.mailbox(path)?];
        self.exec(pieces, |_| {}).await
    }

    /// `CREATE` puis `SUBSCRIBE` (erreur ignorée) ; `[ALREADYEXISTS]` n'est pas une erreur.
    pub async fn create(&mut self, path: &str) -> Result<(), ImapError> {
        match self.mailbox_command("CREATE", path).await {
            Ok(()) => {
                let _ = self.mailbox_command("SUBSCRIBE", path).await;
                Ok(())
            }
            Err(ImapError::Command(t)) if t.to_uppercase().contains("[ALREADYEXISTS]") => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Ferme la boîte si `path` est sélectionné : `UNSELECT` si la capacité est là, sinon `CLOSE`.
    async fn close_if_selected(&mut self, path: &str) -> Result<(), ImapError> {
        let target = names::normalize_path(&self.ns, path, false);
        if self.selected.as_ref().is_none_or(|m| m.path != target) {
            return Ok(());
        }
        let command = if self.caps.contains("UNSELECT") {
            "UNSELECT"
        } else {
            "CLOSE"
        };
        self.exec_text(command.into(), |_| {}).await?;
        self.selected = None;
        self.synced = None;
        self.permanent = None;
        Ok(())
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> Result<(), ImapError> {
        self.close_if_selected(from).await?;
        let pieces = vec![
            Piece::Text("RENAME ".into()),
            self.mailbox(from)?,
            Piece::Text(" ".into()),
            self.mailbox(to)?,
        ];
        self.exec(pieces, |_| {}).await
    }

    pub async fn delete(&mut self, path: &str) -> Result<(), ImapError> {
        self.close_if_selected(path).await?;
        self.mailbox_command("DELETE", path).await
    }

    pub async fn subscribe(&mut self, path: &str) -> Result<(), ImapError> {
        self.mailbox_command("SUBSCRIBE", path).await
    }

    pub async fn unsubscribe(&mut self, path: &str) -> Result<(), ImapError> {
        self.mailbox_command("UNSUBSCRIBE", path).await
    }

    /// Ressource `STORAGE` de la racine de quota du dossier, en octets : `(usage, limite)`.
    pub async fn quota_root_storage(
        &mut self,
        mailbox: &str,
    ) -> Result<Option<(u64, u64)>, ImapError> {
        let pieces = vec![Piece::Text("GETQUOTAROOT ".into()), self.mailbox(mailbox)?];
        let mut storage = None;
        self.exec(pieces, |r| {
            if let Response::Quota(q) = r
                && let Some(res) = q
                    .resources
                    .iter()
                    .find(|res| matches!(res.name, imap_proto::rfc2087::QuotaResourceName::Storage))
            {
                storage = (res.limit > 0).then_some((res.usage * 1024, res.limit * 1024));
            }
        })
        .await?;
        Ok(storage)
    }

    pub async fn fetch_raw(&mut self, uid: u32) -> Result<Option<Vec<u8>>, ImapError> {
        let mut found = self
            .fetch_with(&uid.to_string(), "(UID BODY.PEEK[])", |f| {
                (f.uid() == Some(uid))
                    .then(|| f.body().map(<[u8]>::to_vec))
                    .flatten()
            })
            .await?;
        Ok(found.pop())
    }

    pub async fn fetch_part(&mut self, uid: u32, part: &str) -> Result<Option<Vec<u8>>, ImapError> {
        let Ok(numbers) = part
            .split('.')
            .map(|n| n.parse::<u32>())
            .collect::<Result<Vec<_>, _>>()
        else {
            return Ok(None);
        };
        let path = SectionPath::Part(numbers, None);
        let mut found = self
            .fetch_with(&uid.to_string(), &format!("(UID BODY.PEEK[{part}])"), |f| {
                (f.uid() == Some(uid))
                    .then(|| f.section(&path).map(<[u8]>::to_vec))
                    .flatten()
            })
            .await?;
        Ok(found.pop())
    }

    pub async fn logout(mut self) {
        if let Some(mut s) = self.inner.take() {
            let _ = tokio::time::timeout(Duration::from_secs(5), s.logout()).await;
        }
    }
}

/// Accueil du serveur ; un `BYE` d'entrée vaut refus de connexion.
async fn greeting<S>(client: &mut Client<S>, timeout: Duration) -> Result<(), ImapError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    let bye = read_prelogin(client, timeout, |r| {
        matches!(
            r,
            Response::Data {
                status: Status::Bye,
                ..
            }
        )
    })
    .await?;
    if bye { Err(lost()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_refuse_par_le_serveur() {
        let tag = imap_proto::RequestId("A7".into());
        let step = |raw: &[u8]| final_step(&Response::parse(raw).unwrap().1, Some(&tag));
        assert_eq!(
            step(b"A7 BAD No mailbox selected\r\n"),
            Step::Refused("No mailbox selected".into())
        );
        assert_eq!(
            step(b"A7 NO [SERVERBUG] fetch failed\r\n"),
            Step::Refused("[SERVERBUG] fetch failed".into())
        );
        assert_eq!(step(b"A7 OK Fetch completed\r\n"), Step::Done);
        assert_eq!(step(b"A6 BAD autre commande\r\n"), Step::Other);
        assert_eq!(step(b"* 1 FETCH (UID 5 FLAGS (\\Seen))\r\n"), Step::Other);
    }

    #[test]
    fn controles_de_securite() {
        assert!(check_text("Projets 2026").is_ok());
        for bad in ["a\r\nA1 DELETE INBOX", "a\nb", "a\0b"] {
            assert!(matches!(check_text(bad), Err(ImapError::Command(_))));
        }
        for ok in ["1", "1:5", "1:*", "3,7:9,12:*"] {
            assert!(check_uid_set(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "*",
            "1:",
            ":5",
            "1,,2",
            "1 2",
            "1:5)\r\nA1 EXPUNGE",
            "a",
        ] {
            assert!(check_uid_set(bad).is_err(), "{bad}");
        }
        // C16 : contrôle sur la forme envoyée ; en UTF-7 modifié, LF devient `&AAo-`
        let ns = Namespace::default();
        assert_eq!(names::wire_path(&ns, false, "a\nb"), "a&AAo-b");
        assert!(check_text(&names::wire_path(&ns, false, "a\nb")).is_ok());
        assert!(check_text(&names::wire_path(&ns, true, "a\nb")).is_err());
        assert!(check_header_name("Message-ID").is_ok());
        for bad in ["", "X Y", "X:Y", "X\r\nY", "é"] {
            assert!(check_header_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn code_de_refus() {
        assert_eq!(
            response_code("code: Some(Alert), info: Some(\"x\")").as_deref(),
            Some("ALERT")
        );
        assert_eq!(
            response_code("code: None, info: Some(\"[AUTHENTICATIONFAILED] Invalid\")").as_deref(),
            Some("AUTHENTICATIONFAILED")
        );
        assert_eq!(response_code("code: None, info: Some(\"Invalid\")"), None);
        let e = auth_error(async_imap::error::Error::No(
            "code: Some(Alert), info: Some(\"Too many simultaneous connections\")".into(),
        ));
        assert_eq!(
            e,
            ImapError::Unavailable(
                "IMAP server refused: too many simultaneous connections for this account".into()
            )
        );
        let e = auth_error(async_imap::error::Error::No(
            "code: None, info: Some(\"[AUTHENTICATIONFAILED] Invalid credentials\")".into(),
        ));
        assert_eq!(
            e,
            ImapError::Auth("IMAP authentication failed [AUTHENTICATIONFAILED]".into())
        );
        let e = auth_error(async_imap::error::Error::No(
            "code: None, info: Some(\"nope\")".into(),
        ));
        assert_eq!(e, ImapError::Auth("IMAP authentication failed".into()));
    }

    #[test]
    fn dates_et_chaines() {
        let d = DateTime::parse_from_rfc3339("2026-03-05T07:08:09+01:00").unwrap();
        assert_eq!(imap_date(&d), "05-Mar-2026 07:08:09 +0100");
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
