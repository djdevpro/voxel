//! Découverte automatique de la configuration d'une adresse (port ligne à ligne de `discovery.ts`).
//! Ordre : JMAP (.well-known du domaine, des MX et de mail.<domaine>, SRV) → IMAP (autoconfig, ISPDB, SRV,
//! supposition MX), puis ManageSieve, CardDAV et CalDAV pour une boîte IMAP. Résultat gardé en mémoire par domaine.
//! Politique D6 : les sondes passent par `HttpClient` (https, http vers la boucle locale) ; SRV ManageSieve sur tout port.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use voxel_core::backend::Endpoint;
use voxel_core::dns::DnsLookup;
use voxel_core::net::{
    FetchOptions, HttpClient, HttpRequest, HttpResponse, connect_tcp, parse_dav_url,
};
use voxel_core::util::now_ms;

use crate::blobs::encode_uri_component;
use crate::target::js_integer;

/// Durée de vie d'une découverte réussie.
const CACHE_TTL_MS: i64 = 24 * 3600 * 1000;

/// Un échec est retenu moins longtemps : la configuration DNS peut être corrigée.
const NEGATIVE_TTL_MS: i64 = 3600 * 1000;

/// Délai d'une sonde HTTP.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Délai de la sonde TCP du port ManageSieve.
const TCP_TIMEOUT: Duration = Duration::from_secs(3);

/// Sondes JMAP et autoconfig permises par découverte.
const MAX_PROBES: usize = 10;

/// Taille maximale d'une session JMAP sondée.
const MAX_JSON: usize = 1024 * 1024;

/// Taille maximale d'un fichier autoconfig.
const MAX_XML: usize = 512 * 1024;

/// Au-delà, le cache est vidé.
const MAX_CACHED_DOMAINS: usize = 5000;

/// Capacité obligatoire d'une session JMAP.
const CAP_CORE: &str = "urn:ietf:params:jmap:core";

/// Chemin d'un service JMAP derrière un 401.
static JMAP_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)jmap").expect("expression jmap"));

/// Type de contenu JSON.
static JSON_TYPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)json").expect("expression json"));

/// Fichier autoconfig de Thunderbird.
static CLIENT_CONFIG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?i)<clientConfig").expect("expression clientConfig"));

/// Enregistrement TXT `path=` d'un SRV DAV (RFC 6764 §4).
static TXT_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^path=(/.*)$").expect("expression path"));

#[derive(Debug, Clone, PartialEq)]
pub enum Discovery {
    Jmap {
        session_url: String,
    },
    Imap {
        imap: Endpoint,
        smtp: Endpoint,
        /// Modèle de nom d'utilisateur annoncé par l'autoconfig : `email` ou `localpart`.
        username: Option<String>,
        sieve: Option<Endpoint>,
        carddav: Option<String>,
        caldav: Option<String>,
    },
}

fn email_domain(email: &str) -> String {
    email
        .trim()
        .to_lowercase()
        .split('@')
        .nth(1)
        .unwrap_or("")
        .to_string()
}

struct ProbeBudget(usize);

impl ProbeBudget {
    fn take(&mut self) -> bool {
        if self.0 >= MAX_PROBES {
            return false;
        }
        self.0 += 1;
        true
    }
}

/// `TLS implicite d'abord`, puis le premier serveur du bloc ; `socketType` en clair ignoré.
pub(crate) fn xml_server(xml: &str, tag: &str, kind: &str) -> Option<(Endpoint, Option<String>)> {
    let re = Regex::new(&format!(
        r#"(?i)<{tag}\s+type=["']{kind}["'][^>]*>([\s\S]*?)</{tag}>"#
    ))
    .ok()?;
    let pick = |block: &str, name: &str| -> Option<String> {
        Regex::new(&format!(r"(?i)<{name}>\s*([^<]*?)\s*</{name}>"))
            .ok()?
            .captures(block)
            .map(|m| m[1].to_string())
    };
    let mut out: Vec<(Endpoint, Option<String>)> = Vec::new();
    for m in re.captures_iter(xml) {
        let block = m.get(1).map_or("", |b| b.as_str());
        let host = pick(block, "hostname").filter(|h| !h.is_empty());
        let port = pick(block, "port").and_then(|p| js_integer(&p));
        let socket = pick(block, "socketType").unwrap_or_default().to_uppercase();
        let (Some(host), Some(port)) = (host, port) else {
            continue;
        };
        if !(1..=65535).contains(&port) {
            continue;
        }
        // jamais en clair
        if socket != "SSL" && socket != "STARTTLS" {
            continue;
        }
        let username = pick(block, "username").filter(|u| !u.is_empty());
        out.push((
            Endpoint {
                host: host.to_lowercase(),
                port: port as u16,
                secure: socket == "SSL",
            },
            username,
        ));
    }
    out.sort_by_key(|(e, _)| !e.secure);
    out.into_iter().next()
}

/// Modèle de nom d'utilisateur de l'autoconfig : `localpart` si l'identifiant est la partie locale, sinon `email`.
fn username_template(username: Option<&str>) -> &'static str {
    if username.is_some_and(|u| u.contains("%EMAILLOCALPART%")) {
        "localpart"
    } else {
        "email"
    }
}

pub struct Discoverer {
    http: HttpClient,
    dns: Arc<dyn DnsLookup>,
    cache: Mutex<HashMap<String, (i64, Option<Discovery>)>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Discoverer {
    pub fn new(http: HttpClient, dns: Arc<dyn DnsLookup>) -> Self {
        Self {
            http,
            dns,
            cache: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    async fn fetch(
        &self,
        method: http::Method,
        url: String,
        headers: Vec<(String, String)>,
    ) -> Option<HttpResponse> {
        let request = HttpRequest {
            method,
            url,
            headers,
            body: bytes::Bytes::new(),
        };
        let options = FetchOptions {
            timeout: Some(PROBE_TIMEOUT),
            max_redirects: 5,
        };
        self.http.fetch(request, options).await.ok()
    }

    /// Sonde un point d'entrée JMAP : JSON avec capabilities[core], ou 401 + WWW-Authenticate sur un chemin /jmap.
    async fn probe_jmap(&self, url: String, budget: &mut ProbeBudget) -> Option<Discovery> {
        if !budget.take() {
            return None;
        }
        let res = self
            .fetch(
                http::Method::GET,
                url,
                vec![("Accept".to_string(), "application/json".to_string())],
            )
            .await?;
        let final_url = res.final_url.clone();
        let ctype = res.header("content-type").unwrap_or("").to_string();
        if (200..300).contains(&res.status) && JSON_TYPE_RE.is_match(&ctype) {
            let text = res.text_limited(MAX_JSON).await.ok()?;
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            let core = json.get("capabilities").and_then(|c| c.get(CAP_CORE));
            if json.get("capabilities").is_some_and(|c| c.is_object()) && core.is_some_and(truthy) {
                return Some(Discovery::Jmap {
                    session_url: final_url,
                });
            }
            return None;
        }
        let status = res.status;
        let authenticate = res
            .header("www-authenticate")
            .is_some_and(|v| !v.is_empty());
        res.discard().await;
        let path = url::Url::parse(&final_url).ok()?.path().to_string();
        if status == 401 && authenticate && JMAP_PATH_RE.is_match(&path) {
            return Some(Discovery::Jmap {
                session_url: final_url,
            });
        }
        None
    }

    async fn probe_autoconfig(&self, url: String, budget: &mut ProbeBudget) -> Option<Discovery> {
        if !budget.take() {
            return None;
        }
        let res = self
            .fetch(
                http::Method::GET,
                url,
                vec![(
                    "Accept".to_string(),
                    "application/xml, text/xml".to_string(),
                )],
            )
            .await?;
        if !(200..300).contains(&res.status) {
            res.discard().await;
            return None;
        }
        let xml = res.text_limited(MAX_XML).await.ok()?;
        if !CLIENT_CONFIG_RE.is_match(&xml) {
            return None;
        }
        let (imap, username) = xml_server(&xml, "incomingServer", "imap")?;
        let (smtp, _) = xml_server(&xml, "outgoingServer", "smtp")?;
        let username = username_template(username.as_deref());
        Some(Discovery::Imap {
            imap,
            smtp,
            username: Some(username.to_string()),
            sieve: None,
            carddav: None,
            caldav: None,
        })
    }

    async fn discover_uncached(&self, email: &str, domain: &str) -> Option<Discovery> {
        let mx = self.dns.mx(domain).await;
        let mut budget = ProbeBudget(0);

        // JMAP
        let mut jmap_hosts: Vec<String> = Vec::new();
        let mut add_host = |h: &str| {
            if !h.is_empty() && !jmap_hosts.iter().any(|x| x == h) {
                jmap_hosts.push(h.to_string());
            }
        };
        add_host(domain);
        for h in mx.iter().take(2) {
            add_host(h);
        }
        add_host(&format!("mail.{domain}"));
        for host in &jmap_hosts {
            if let Some(found) = self
                .probe_jmap(format!("https://{host}/.well-known/jmap"), &mut budget)
                .await
            {
                return Some(found);
            }
        }
        if let Some((name, port)) = self.dns.srv(&format!("_jmap._tcp.{domain}")).await {
            let port = if port == 443 {
                String::new()
            } else {
                format!(":{port}")
            };
            if let Some(found) = self
                .probe_jmap(
                    format!("https://{name}{port}/.well-known/jmap"),
                    &mut budget,
                )
                .await
            {
                return Some(found);
            }
        }

        // IMAP : autoconfig, ISPDB
        let enc = encode_uri_component(email);
        for url in [
            format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={enc}"),
            format!(
                "https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={enc}"
            ),
            format!(
                "https://autoconfig.thunderbird.net/v1.1/{}",
                encode_uri_component(domain)
            ),
        ] {
            if let Some(found) = self.probe_autoconfig(url, &mut budget).await {
                return Some(found);
            }
        }

        // IMAP : SRV (RFC 6186 / 8314)
        let imaps = self.dns.srv(&format!("_imaps._tcp.{domain}")).await;
        let submissions = self.dns.srv(&format!("_submissions._tcp.{domain}")).await;
        let submission = if submissions.is_some() {
            None
        } else {
            self.dns.srv(&format!("_submission._tcp.{domain}")).await
        };
        if let Some((imap_host, imap_port)) = imaps
            && (submissions.is_some() || submission.is_some())
        {
            let smtp = match (submissions, submission) {
                (Some((host, port)), _) => Endpoint {
                    host,
                    port,
                    secure: true,
                },
                (None, Some((host, port))) => Endpoint {
                    host,
                    port,
                    secure: false,
                },
                (None, None) => unreachable!("vérifié juste avant"),
            };
            return Some(Discovery::Imap {
                imap: Endpoint {
                    host: imap_host,
                    port: imap_port,
                    secure: true,
                },
                smtp,
                username: None,
                sieve: None,
                carddav: None,
                caldav: None,
            });
        }

        // Supposition à partir du MX principal.
        let first = mx.into_iter().next()?;
        Some(Discovery::Imap {
            imap: Endpoint {
                host: first.clone(),
                port: 993,
                secure: true,
            },
            smtp: Endpoint {
                host: first,
                port: 465,
                secure: true,
            },
            username: None,
            sieve: None,
            carddav: None,
            caldav: None,
        })
    }

    /// ManageSieve : SRV `_sieve._tcp` (STARTTLS, RFC 5804 §1.8), puis le port 4190 de l'hôte IMAP.
    async fn discover_sieve(&self, domain: &str, imap_host: &str) -> Option<Endpoint> {
        if let Some((host, port)) = self.dns.srv(&format!("_sieve._tcp.{domain}")).await {
            return Some(Endpoint {
                host,
                port,
                secure: false,
            });
        }
        if connect_tcp(imap_host, 4190, TCP_TIMEOUT).await.is_ok() {
            return Some(Endpoint {
                host: imap_host.to_string(),
                port: 4190,
                secure: false,
            });
        }
        None
    }

    /// Lit l'enregistrement TXT `path=` d'un SRV DAV (RFC 6764 §4).
    async fn txt_path(&self, name: &str) -> Option<String> {
        self.dns
            .txt(name)
            .await
            .iter()
            .find_map(|rec| TXT_PATH_RE.captures(rec).map(|m| m[1].to_string()))
    }

    /// Le point d'entrée répond-il comme un service DAV (sans identifiants) ? 207, ou 401 avec `WWW-Authenticate`
    /// (ou en-tête `DAV`). Renvoie l'URL finale, sans requête ni fragment, si `parse_dav_url` l'accepte (D6).
    async fn probe_dav(&self, url: String) -> Option<String> {
        let method = http::Method::from_bytes(b"PROPFIND").ok()?;
        let res = self
            .fetch(method, url, vec![("Depth".to_string(), "0".to_string())])
            .await?;
        let has = |name: &str| res.header(name).is_some_and(|v| !v.is_empty());
        let ok =
            res.status == 207 || (res.status == 401 && (has("www-authenticate") || has("dav")));
        let final_url = res.final_url.clone();
        res.discard().await;
        if !ok {
            return None;
        }
        let mut url = parse_dav_url(&final_url)?;
        url.set_query(None);
        url.set_fragment(None);
        Some(url.to_string())
    }

    async fn discover_dav(&self, kind: &str, domain: &str, imap_host: &str) -> Option<String> {
        let name = format!("_{kind}s._tcp.{domain}");
        if let Some((host, port)) = self.dns.srv(&name).await
            && port == 443
        {
            let path = self
                .txt_path(&name)
                .await
                .unwrap_or_else(|| format!("/.well-known/{kind}"));
            if let Some(found) = self.probe_dav(format!("https://{host}{path}")).await {
                return Some(found);
            }
        }
        let mut hosts = vec![domain];
        if imap_host != domain {
            hosts.push(imap_host);
        }
        for host in hosts {
            if let Some(found) = self
                .probe_dav(format!("https://{host}/.well-known/{kind}"))
                .await
            {
                return Some(found);
            }
        }
        None
    }

    fn read_cache(&self, domain: &str) -> Option<Option<Discovery>> {
        let mut cache = self.cache.lock().expect("cache de découverte");
        let (at, result) = cache.get(domain)?.clone();
        let ttl = if result.is_some() {
            CACHE_TTL_MS
        } else {
            NEGATIVE_TTL_MS
        };
        if now_ms() - at > ttl {
            cache.remove(domain);
            return None;
        }
        Some(result)
    }

    /// Découvre la configuration d'une adresse (n'échoue jamais : `None` si rien trouvé).
    pub async fn discover(&self, email: &str) -> Option<Discovery> {
        let domain = email_domain(email);
        if domain.is_empty() {
            return None;
        }
        if let Some(cached) = self.read_cache(&domain) {
            return cached;
        }
        let lock = self
            .inflight
            .lock()
            .expect("découvertes en vol")
            .entry(domain.clone())
            .or_default()
            .clone();
        let _guard = lock.lock().await;
        if let Some(cached) = self.read_cache(&domain) {
            return cached;
        }
        let mut result = self.discover_uncached(email, &domain).await;
        if let Some(Discovery::Imap {
            imap,
            sieve,
            carddav,
            caldav,
            ..
        }) = &mut result
        {
            let (s, cd, cl) = tokio::join!(
                self.discover_sieve(&domain, &imap.host),
                self.discover_dav("carddav", &domain, &imap.host),
                self.discover_dav("caldav", &domain, &imap.host),
            );
            *sieve = s;
            *carddav = cd;
            *caldav = cl;
        }
        {
            let mut cache = self.cache.lock().expect("cache de découverte");
            if cache.len() > MAX_CACHED_DOMAINS {
                cache.clear();
            }
            cache.insert(domain.clone(), (now_ms(), result.clone()));
        }
        self.inflight
            .lock()
            .expect("découvertes en vol")
            .remove(&domain);
        result
    }
}

/// Vérité au sens de JavaScript.
fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<clientConfig version="1.1"><emailProvider id="example.com">
      <incomingServer type="imap"><hostname>plain.example.com</hostname><port>143</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer>
      <incomingServer type="imap"><hostname>Imap.Example.com</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></incomingServer>
      <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
    </emailProvider></clientConfig>"#;

    #[test]
    fn xml_server_prefers_ssl_and_skips_plain() {
        let (imap, username) = xml_server(XML, "incomingServer", "imap").unwrap();
        assert_eq!(
            imap,
            Endpoint {
                host: "imap.example.com".into(),
                port: 993,
                secure: true
            }
        );
        assert_eq!(username.as_deref(), Some("%EMAILLOCALPART%"));
        assert_eq!(username_template(username.as_deref()), "localpart");
        assert_eq!(username_template(Some("%EMAILADDRESS%")), "email");
        assert_eq!(username_template(None), "email");
        let (smtp, _) = xml_server(XML, "outgoingServer", "smtp").unwrap();
        assert_eq!(
            smtp,
            Endpoint {
                host: "smtp.example.com".into(),
                port: 587,
                secure: false
            }
        );
        let plain_only = r#"<incomingServer type="imap"><hostname>a</hostname><port>143</port><socketType>plain</socketType></incomingServer>"#;
        assert!(xml_server(plain_only, "incomingServer", "imap").is_none());
    }

    #[test]
    fn email_domain_takes_the_second_part() {
        assert_eq!(email_domain(" Bob@Example.COM "), "example.com");
        assert_eq!(email_domain("nobody"), "");
    }
}
