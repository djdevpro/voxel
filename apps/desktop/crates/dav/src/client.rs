//! Client WebDAV / CardDAV / CalDAV léger (RFC 4918, RFC 6352, RFC 4791, RFC 6578) des façades Contacts et Agenda :
//! PROPFIND, REPORT `sync-collection` (sinon `getctag` + `getetag`), `addressbook-multiget` / `calendar-multiget`,
//! `calendar-query` avec `time-range`, PUT et DELETE avec `If-Match`. Port de `apps/server/src/carddav/dav.ts`.
//!
//! Les requêtes passent par un `DavTransport` injecté (`HttpDavTransport` en production, faux serveur en mémoire
//! dans les tests) ; chaque URL résolue passe par la politique réseau du cœur (`check_url`, D6). Délais et tailles
//! bornés. Ni les identifiants ni les en-têtes ne sont journalisés.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::future::BoxFuture;
use voxel_core::net::{FetchOptions, HttpClient, HttpRequest, NetError, check_url};

use crate::xml::{normalize_color, parse_multistatus, xml_escape};

/// Délai d'une requête.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(15);

/// Taille maximale d'une réponse.
const MAX_BODY: usize = 20 * 1024 * 1024;

/// Nombre de ressources par `multiget`.
const MULTIGET_CHUNK: usize = 100;

/// Redirections suivies par `HttpDavTransport`.
const MAX_REDIRECTS: usize = 5;

/// Espaces de noms CardDAV.
const NS: &str = "xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:carddav\" xmlns:cs=\"http://calendarserver.org/ns/\"";

/// Espaces de noms CalDAV.
const NS_CAL: &str = "xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:cs=\"http://calendarserver.org/ns/\" xmlns:ic=\"http://apple.com/ns/ical/\"";

pub struct DavHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: bytes::Bytes,
}

pub trait DavTransport: Send + Sync {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<DavHttpResponse, DavError>>;
}

/// Transport de production : `HttpClient::fetch` (redirections suivies), corps lu dans la limite de 20 Mio.
pub struct HttpDavTransport {
    pub client: HttpClient,
}

impl DavTransport for HttpDavTransport {
    fn send<'a>(
        &'a self,
        request: HttpRequest,
        timeout: Duration,
    ) -> BoxFuture<'a, Result<DavHttpResponse, DavError>> {
        Box::pin(async move {
            let options = FetchOptions {
                timeout: Some(timeout),
                max_redirects: MAX_REDIRECTS,
            };
            let res = self
                .client
                .fetch(request, options)
                .await
                .map_err(net_error)?;
            let status = res.status;
            let headers = res.headers.clone();
            let body = res.bytes_limited(MAX_BODY).await.map_err(net_error)?;
            Ok(DavHttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

fn net_error(e: NetError) -> DavError {
    match e {
        NetError::Blocked(m) => DavError::Blocked(m),
        NetError::TooLarge => DavError::Status(413, "DAV response too large".into()),
        e => DavError::Network(e.to_string()),
    }
}

/// `Status` : réponse inattendue ; `Auth` : identifiants refusés (401) ; `Blocked` : URL hors politique réseau.
#[derive(Debug, Clone, PartialEq)]
pub enum DavError {
    Status(u16, String),
    Auth,
    Blocked(String),
    Network(String),
}

impl fmt::Display for DavError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DavError::Status(_, m) | DavError::Blocked(m) | DavError::Network(m) => f.write_str(m),
            DavError::Auth => f.write_str("DAV authentication failed"),
        }
    }
}

impl std::error::Error for DavError {}

#[derive(Debug, Clone)]
pub struct DavBook {
    pub href: String,
    pub name: String,
    pub description: Option<String>,
    pub ctag: Option<String>,
    pub sync_token: Option<String>,
    pub supports_sync: bool,
    pub may_write: bool,
    /// CalDAV : couleur (`calendar-color` d'Apple, `#rrggbb`).
    pub color: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DavMember {
    pub href: String,
    pub etag: String,
}

/// Protocole des collections : CardDAV (carnets) ou CalDAV (agendas).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DavKind {
    Card,
    Cal,
}

struct KindInfo {
    ns: &'static str,
    home: &'static str,
    kind: &'static str,
    description: &'static str,
    multiget: &'static str,
    data: &'static str,
    extra: &'static str,
}

impl DavKind {
    fn info(self) -> KindInfo {
        match self {
            DavKind::Card => KindInfo {
                ns: NS,
                home: "addressbook-home-set",
                kind: "addressbook",
                description: "addressbook-description",
                multiget: "addressbook-multiget",
                data: "address-data",
                extra: "",
            },
            DavKind::Cal => KindInfo {
                ns: NS_CAL,
                home: "calendar-home-set",
                kind: "calendar",
                description: "calendar-description",
                multiget: "calendar-multiget",
                data: "calendar-data",
                extra: "<ic:calendar-color/><c:supported-calendar-component-set/>",
            },
        }
    }
}

pub enum SyncResult {
    Changes {
        changed: Vec<DavMember>,
        removed: Vec<String>,
        token: Option<String>,
    },
    InvalidToken,
}

pub enum PutResult {
    Written { etag: Option<String> },
    Conflict,
}

pub enum DeleteResult {
    Ok,
    Conflict,
    Gone,
}

struct RawResponse {
    status: u16,
    text: String,
    headers: Vec<(String, String)>,
}

/// Décodage `%XX` d'un chemin (`decodeURIComponent`, séquences invalides gardées telles quelles).
pub(crate) fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = text.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Encodage d'un nom de fichier (`encodeURIComponent`).
pub(crate) fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn same_collection(a: &url::Url, b: &url::Url) -> bool {
    let n = |u: &url::Url| percent_decode(u.path()).trim_end_matches('/').to_string();
    a.origin() == b.origin() && n(a) == n(b)
}

/// `YYYYMMDDTHHMMSSZ` d'un instant UTC.
fn compact_utc(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y%m%dT%H%M%SZ").to_string())
        .unwrap_or_default()
}

pub struct DavClient {
    service_url: url::Url,
    auth: String,
    transport: Arc<dyn DavTransport>,
}

impl DavClient {
    pub fn new(
        service_url: url::Url,
        username: &str,
        password: &str,
        transport: Arc<dyn DavTransport>,
    ) -> Self {
        Self {
            service_url,
            auth: format!(
                "Basic {}",
                STANDARD.encode(format!("{username}:{password}"))
            ),
            transport,
        }
    }

    /// URL absolue d'un href, résolu par rapport à `base`, refusée hors de la politique réseau.
    pub(crate) fn resolve(
        &self,
        href: &str,
        base: Option<&url::Url>,
    ) -> Result<url::Url, DavError> {
        let base = base.unwrap_or(&self.service_url);
        let url = base
            .join(href)
            .map_err(|_| DavError::Network(format!("invalid href {href}")))?;
        check_url(&url).map_err(net_error)?;
        Ok(url)
    }

    async fn request(
        &self,
        method: &str,
        url: &url::Url,
        body: Option<String>,
        extra: &[(&str, String)],
        timeout: Duration,
    ) -> Result<RawResponse, DavError> {
        let mut headers: Vec<(String, String)> = vec![("Authorization".into(), self.auth.clone())];
        if body.as_ref().is_some_and(|b| !b.is_empty()) {
            headers.push((
                "Content-Type".into(),
                "application/xml; charset=utf-8".into(),
            ));
        }
        for (name, value) in extra {
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
            headers.push((name.to_string(), value.clone()));
        }
        let request = HttpRequest {
            method: http::Method::from_bytes(method.as_bytes())
                .map_err(|_| DavError::Network(format!("bad method {method}")))?,
            url: url.as_str().to_string(),
            headers,
            body: bytes::Bytes::from(body.unwrap_or_default()),
        };
        let res = self.transport.send(request, timeout).await?;
        if res.status == 401 {
            return Err(DavError::Auth);
        }
        Ok(RawResponse {
            status: res.status,
            text: String::from_utf8_lossy(&res.body).into_owned(),
            headers: res.headers,
        })
    }

    async fn multistatus(
        &self,
        method: &str,
        url: &url::Url,
        body: String,
        depth: &str,
        timeout: Duration,
    ) -> Result<Vec<crate::xml::DavResponseEntry>, DavError> {
        let r = self
            .request(method, url, Some(body), &[("Depth", depth.into())], timeout)
            .await?;
        if r.status != 207 {
            return Err(DavError::Status(r.status, format!("{method} {}", r.status)));
        }
        Ok(parse_multistatus(&r.text)?.0)
    }

    /// Collections du compte : principal (`current-user-principal`) → maison (`*-home-set`) → collections du
    /// protocole. Si l'URL du service est elle-même la maison, ses collections sont listées directement.
    pub async fn discover(
        &self,
        kind: DavKind,
        timeout: Duration,
    ) -> Result<Vec<DavBook>, DavError> {
        let k = kind.info();
        let step1 = self
            .multistatus(
                "PROPFIND",
                &self.service_url,
                format!(
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind {}><d:prop><d:current-user-principal/><c:{}/><d:resourcetype/></d:prop></d:propfind>",
                    k.ns, k.home
                ),
                "0",
                timeout,
            )
            .await?;
        let first = step1.first();
        let base = match first.filter(|f| !f.href.is_empty()) {
            Some(f) => self.resolve(&f.href, None)?,
            None => self.service_url.clone(),
        };
        let mut home = first.and_then(|f| f.props.href(k.home));
        if home.is_none()
            && let Some(principal) = first.and_then(|f| f.props.href("current-user-principal"))
        {
            let step2 = self
                .multistatus(
                    "PROPFIND",
                    &self.resolve(&principal, Some(&base))?,
                    format!(
                        "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind {}><d:prop><c:{}/></d:prop></d:propfind>",
                        k.ns, k.home
                    ),
                    "0",
                    timeout,
                )
                .await?;
            home = step2.first().and_then(|r| r.props.href(k.home));
        }
        let home_url = match home {
            Some(h) => self.resolve(&h, Some(&base))?,
            None => base,
        };
        let listing = self
            .multistatus(
                "PROPFIND",
                &home_url,
                format!(
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind {}><d:prop><d:resourcetype/><d:displayname/><c:{}/><cs:getctag/><d:sync-token/><d:supported-report-set/><d:current-user-privilege-set/>{}</d:prop></d:propfind>",
                    k.ns, k.description, k.extra
                ),
                "1",
                timeout,
            )
            .await?;
        let non_empty = |v: Option<String>| v.filter(|s| !s.is_empty());
        let mut books = Vec::new();
        for r in &listing {
            if !r.props.has_child("resourcetype", k.kind) {
                continue;
            }
            let url = self.resolve(&r.href, Some(&home_url))?;
            let href = if url.path().ends_with('/') {
                url.as_str().to_string()
            } else {
                format!("{}/", url.as_str())
            };
            let last = url
                .path()
                .split('/')
                .rfind(|s| !s.is_empty())
                .map(percent_decode)
                .unwrap_or_default();
            books.push(DavBook {
                href,
                name: non_empty(r.props.text("displayname")).unwrap_or(last),
                description: non_empty(r.props.text(k.description)),
                ctag: non_empty(r.props.text("getctag")),
                sync_token: non_empty(r.props.text("sync-token")),
                supports_sync: r
                    .props
                    .contains_any("supported-report-set", &["sync-collection"]),
                // sans privilèges annoncés : on suppose l'écriture possible (le serveur tranchera)
                may_write: !r.props.has_children("current-user-privilege-set")
                    || r.props.contains_any(
                        "current-user-privilege-set",
                        &["all", "write", "write-content", "bind"],
                    ),
                color: match kind {
                    DavKind::Cal => r
                        .props
                        .text("calendar-color")
                        .and_then(|c| normalize_color(&c)),
                    DavKind::Card => None,
                },
            });
        }
        Ok(books)
    }

    /// Membres d'une collection (href + ETag), par PROPFIND Depth 1.
    pub async fn list_members(&self, book_href: &str) -> Result<Vec<DavMember>, DavError> {
        let book = self.resolve(book_href, None)?;
        let listing = self
            .multistatus(
                "PROPFIND",
                &book,
                format!(
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind {NS}><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>"
                ),
                "1",
                TIMEOUT,
            )
            .await?;
        let mut out = Vec::new();
        for r in &listing {
            let url = self.resolve(&r.href, Some(&book))?;
            if same_collection(&url, &book) || r.props.has_child("resourcetype", "collection") {
                continue;
            }
            if let Some(etag) = r.props.text("getetag").filter(|e| !e.is_empty()) {
                out.push(DavMember {
                    href: url.as_str().to_string(),
                    etag,
                });
            }
        }
        Ok(out)
    }

    /// REPORT `sync-collection` (RFC 6578) : changements depuis `token` (vide = tout) ; `InvalidToken` si le
    /// serveur refuse le jeton (403/409, 400 `valid-sync-token`).
    pub async fn sync_collection(
        &self,
        book_href: &str,
        token: &str,
    ) -> Result<SyncResult, DavError> {
        let book = self.resolve(book_href, None)?;
        let body = format!(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:sync-collection {NS}><d:sync-token>{}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>",
            xml_escape(token)
        );
        let r = self
            .request(
                "REPORT",
                &book,
                Some(body),
                &[("Depth", "0".into())],
                TIMEOUT,
            )
            .await?;
        if r.status == 403
            || r.status == 409
            || (r.status == 400 && r.text.contains("valid-sync-token"))
        {
            return Ok(SyncResult::InvalidToken);
        }
        if r.status != 207 {
            return Err(DavError::Status(
                r.status,
                format!("REPORT sync-collection {}", r.status),
            ));
        }
        let (responses, token) = parse_multistatus(&r.text)?;
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        for res in &responses {
            if res.href.is_empty() {
                continue;
            }
            let url = self.resolve(&res.href, Some(&book))?;
            if same_collection(&url, &book) {
                continue;
            }
            if res.status == Some(404) {
                removed.push(url.as_str().to_string());
            } else if let Some(etag) = res.props.text("getetag").filter(|e| !e.is_empty()) {
                changed.push(DavMember {
                    href: url.as_str().to_string(),
                    etag,
                });
            }
        }
        Ok(SyncResult::Changes {
            changed,
            removed,
            token,
        })
    }

    /// `addressbook-multiget` / `calendar-multiget` : (href, ETag, texte) des membres demandés (absents : ignorés),
    /// par lots de 100.
    pub async fn multiget(
        &self,
        book_href: &str,
        hrefs: &[String],
        kind: DavKind,
    ) -> Result<Vec<(String, String, String)>, DavError> {
        let k = kind.info();
        let book = self.resolve(book_href, None)?;
        let mut out = Vec::new();
        for chunk in hrefs.chunks(MULTIGET_CHUNK) {
            let mut part = String::new();
            for h in chunk {
                let path = book
                    .join(h)
                    .map(|u| u.path().to_string())
                    .map_err(|_| DavError::Network(format!("invalid href {h}")))?;
                part.push_str(&format!("<d:href>{}</d:href>", xml_escape(&path)));
            }
            let listing = self
                .multistatus(
                    "REPORT",
                    &book,
                    format!(
                        "<?xml version=\"1.0\" encoding=\"utf-8\"?><c:{m} {}><d:prop><d:getetag/><c:{}/></d:prop>{part}</c:{m}>",
                        k.ns,
                        k.data,
                        m = k.multiget
                    ),
                    "1",
                    TIMEOUT,
                )
                .await?;
            for r in &listing {
                if r.status.is_some_and(|s| s != 200) {
                    continue;
                }
                let data = r.props.text(k.data).unwrap_or_default();
                let etag = r.props.text("getetag").unwrap_or_default();
                if !data.is_empty() {
                    out.push((
                        self.resolve(&r.href, Some(&book))?.as_str().to_string(),
                        etag,
                        data,
                    ));
                }
            }
        }
        Ok(out)
    }

    /// `calendar-query` (RFC 4791 §7.8) : VEVENT qui touchent la plage [start, end[ (ms UTC), avec leur ETag. Le
    /// serveur développe lui-même les récurrences pour le filtre `time-range`.
    pub async fn calendar_query(
        &self,
        cal_href: &str,
        start: Option<i64>,
        end: Option<i64>,
    ) -> Result<Vec<DavMember>, DavError> {
        let cal = self.resolve(cal_href, None)?;
        let range = if start.is_some() || end.is_some() {
            format!(
                "<c:time-range{}{}/>",
                start
                    .map(|s| format!(" start=\"{}\"", compact_utc(s)))
                    .unwrap_or_default(),
                end.map(|e| format!(" end=\"{}\"", compact_utc(e)))
                    .unwrap_or_default()
            )
        } else {
            String::new()
        };
        let listing = self
            .multistatus(
                "REPORT",
                &cal,
                format!(
                    "<?xml version=\"1.0\" encoding=\"utf-8\"?><c:calendar-query {NS_CAL}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\">{range}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"
                ),
                "1",
                TIMEOUT,
            )
            .await?;
        let mut out = Vec::new();
        for r in &listing {
            if r.href.is_empty() {
                continue;
            }
            let url = self.resolve(&r.href, Some(&cal))?;
            if same_collection(&url, &cal) {
                continue;
            }
            if let Some(etag) = r.props.text("getetag").filter(|e| !e.is_empty()) {
                out.push(DavMember {
                    href: url.as_str().to_string(),
                    etag,
                });
            }
        }
        Ok(out)
    }

    /// Écrit une ressource : `etag` → `If-Match` (mise à jour), `None` → `If-None-Match: *` (création). `Conflict` sur
    /// 412.
    pub async fn put(
        &self,
        href: &str,
        data: &str,
        etag: Option<&str>,
        content_type: &str,
    ) -> Result<PutResult, DavError> {
        let url = self.resolve(href, None)?;
        let condition = match etag {
            Some(e) => ("If-Match", e.to_string()),
            None => ("If-None-Match", "*".to_string()),
        };
        let r = self
            .request(
                "PUT",
                &url,
                Some(data.to_string()),
                &[("Content-Type", content_type.to_string()), condition],
                TIMEOUT,
            )
            .await?;
        if r.status == 412 {
            return Ok(PutResult::Conflict);
        }
        if !(200..300).contains(&r.status) {
            return Err(DavError::Status(r.status, format!("PUT {}", r.status)));
        }
        let etag = r
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("etag"))
            .map(|(_, v)| v.clone());
        Ok(PutResult::Written { etag })
    }

    /// Supprime une ressource (`If-Match` si l'ETag est connu) ; `Conflict` sur 412, `Gone` sur 404.
    pub async fn delete(&self, href: &str, etag: Option<&str>) -> Result<DeleteResult, DavError> {
        let url = self.resolve(href, None)?;
        let extra: Vec<(&str, String)> = etag
            .map(|e| ("If-Match", e.to_string()))
            .into_iter()
            .collect();
        let r = self.request("DELETE", &url, None, &extra, TIMEOUT).await?;
        match r.status {
            412 => Ok(DeleteResult::Conflict),
            404 => Ok(DeleteResult::Gone),
            s if (200..300).contains(&s) => Ok(DeleteResult::Ok),
            s => Err(DavError::Status(s, format!("DELETE {s}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_helpers() {
        assert_eq!(percent_decode("a%20b%C3%A9%zz"), "a bé%zz");
        assert_eq!(encode_component("a b@c.vcf"), "a%20b%40c.vcf");
        assert_eq!(compact_utc(0), "19700101T000000Z");
    }
}
