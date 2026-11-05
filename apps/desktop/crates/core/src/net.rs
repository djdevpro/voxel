//! Réseau sortant du cœur : politique D6 (https partout, http seulement vers la boucle locale), client HTTP
//! à redirections contrôlées (port de `safeFetch`, `apps/server/src/netguard.ts`) et connexions TCP/TLS.
//! Pas de liste d'IP privées ni de restriction de ports : l'appli tourne sur le poste de l'utilisateur (D6).

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;

/// Longueur maximale d'une URL de service DAV, comme `parseDavUrl`.
const MAX_DAV_URL_LEN: usize = 2048;

/// Délai d'établissement d'une connexion HTTP.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq)]
pub enum NetError {
    Blocked(String),
    Timeout,
    Network(String),
    TooManyRedirects,
    TooLarge,
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NetError::Blocked(m) | NetError::Network(m) => f.write_str(m),
            NetError::Timeout => f.write_str("timeout"),
            NetError::TooManyRedirects => f.write_str("too many redirects"),
            NetError::TooLarge => f.write_str("response too large"),
        }
    }
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host);
    if bare == "localhost" || bare.ends_with(".localhost") {
        return true;
    }
    bare.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

pub fn check_url(url: &url::Url) -> Result<(), NetError> {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "https" => Ok(()),
        "http" if is_loopback_host(host) => Ok(()),
        scheme => Err(NetError::Blocked(format!("{scheme}://{host} not allowed"))),
    }
}

pub fn parse_dav_url(raw: &str) -> Option<url::Url> {
    if raw.is_empty() || raw.encode_utf16().count() > MAX_DAV_URL_LEN {
        return None;
    }
    let url = url::Url::parse(raw.trim()).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    check_url(&url).ok()?;
    Some(url)
}

pub struct HttpRequest {
    pub method: http::Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: bytes::Bytes,
}

#[derive(Debug, Clone, Copy)]
pub struct FetchOptions {
    pub timeout: Option<Duration>,
    pub max_redirects: usize,
}

impl Default for FetchOptions {
    fn default() -> Self {
        Self {
            timeout: None,
            max_redirects: 5,
        }
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub final_url: String,
    inner: reqwest::Response,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub async fn text_limited(self, max: usize) -> Result<String, NetError> {
        let bytes = self.bytes_limited(max).await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn bytes_limited(mut self, max: usize) -> Result<bytes::Bytes, NetError> {
        let mut out = bytes::BytesMut::new();
        while let Some(chunk) = self.inner.chunk().await.map_err(net_error)? {
            if out.len() + chunk.len() > max {
                return Err(NetError::TooLarge);
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out.freeze())
    }

    pub fn into_stream(self) -> crate::http::BodyStream {
        self.inner
            .bytes_stream()
            .map(|r| r.map_err(|e| net_error(e).to_string()))
            .boxed()
    }

    pub async fn discard(self) {
        drop(self.inner);
    }
}

#[derive(Clone)]
pub struct HttpClient {
    client: reqwest::Client,
    /// Client sans proxy pour la boucle locale : hyper-util n'exempte ni `localhost`, ni 127.0.0.0/8, ni ::1 (C15).
    direct: reqwest::Client,
}

impl HttpClient {
    pub fn new() -> Result<Self, String> {
        let builder = || {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(HTTP_CONNECT_TIMEOUT)
                .user_agent(concat!("Voxel/", env!("CARGO_PKG_VERSION")))
        };
        let client = builder().build().map_err(|e| e.to_string())?;
        let direct = builder().no_proxy().build().map_err(|e| e.to_string())?;
        Ok(Self { client, direct })
    }

    /// Client d'un saut : jamais de proxy vers la boucle locale, où la requête partirait en clair.
    fn client_for(&self, url: &url::Url) -> &reqwest::Client {
        if is_loopback_host(url.host_str().unwrap_or("")) {
            &self.direct
        } else {
            &self.client
        }
    }

    /// Port de `safeFetch` : chaque saut repasse par la politique ; `authorization` ne suit pas un changement d'origine.
    pub async fn fetch(
        &self,
        request: HttpRequest,
        options: FetchOptions,
    ) -> Result<HttpResponse, NetError> {
        let mut current =
            url::Url::parse(&request.url).map_err(|_| NetError::Network("invalid URL".into()))?;
        let origin = current.origin();
        let mut headers = request.headers;
        let mut method = request.method;
        let mut body = request.body;
        for hop in 0.. {
            check_url(&current)?;
            let mut builder = self
                .client_for(&current)
                .request(method.clone(), current.clone())
                .body(body.clone());
            for (k, v) in &headers {
                builder = builder.header(k.as_str(), v.as_str());
            }
            if let Some(timeout) = options.timeout {
                builder = builder.timeout(timeout);
            }
            let res = builder.send().await.map_err(net_error)?;
            let status = res.status().as_u16();
            let location = res
                .headers()
                .get(http::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if let (300..=399, Some(location)) = (status, location) {
                if hop >= options.max_redirects {
                    return Err(NetError::TooManyRedirects);
                }
                drop(res);
                current = current
                    .join(&location)
                    .map_err(|_| NetError::Network("bad redirect location".into()))?;
                if current.origin() != origin {
                    headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
                }
                if status == 303
                    || ((status == 301 || status == 302) && method == http::Method::POST)
                {
                    method = http::Method::GET;
                    body = bytes::Bytes::new();
                }
                continue;
            }
            let headers = res
                .headers()
                .iter()
                .map(|(k, v)| {
                    (
                        k.as_str().to_string(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();
            return Ok(HttpResponse {
                status,
                status_text: res.status().canonical_reason().unwrap_or("").to_string(),
                headers,
                final_url: current.to_string(),
                inner: res,
            });
        }
        unreachable!()
    }
}

fn net_error(e: reqwest::Error) -> NetError {
    if e.is_timeout() {
        NetError::Timeout
    } else {
        NetError::Network(e.without_url().to_string())
    }
}

/// Port de `pinHostCandidates` + `tryCandidates`, sans filtrage : IPv4 d'abord, puis IPv6.
pub async fn connect_tcp(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<tokio::net::TcpStream, NetError> {
    let no_address = || NetError::Network(format!("no address for {host}"));
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| no_address())?
        .collect();
    let (v4, v6): (Vec<SocketAddr>, Vec<SocketAddr>) =
        addrs.into_iter().partition(SocketAddr::is_ipv4);
    let mut last = no_address();
    for addr in v4.into_iter().chain(v6) {
        match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => last = NetError::Network(e.to_string()),
            Err(_) => last = NetError::Timeout,
        }
    }
    Err(last)
}

pub async fn tls_connect(
    stream: tokio::net::TcpStream,
    domain: &str,
    timeout: Duration,
) -> Result<tokio_native_tls::TlsStream<tokio::net::TcpStream>, NetError> {
    let connector =
        native_tls::TlsConnector::new().map_err(|e| NetError::Network(format!("tls: {e}")))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    match tokio::time::timeout(timeout, connector.connect(domain, stream)).await {
        Ok(Ok(tls)) => Ok(tls),
        Ok(Err(e)) => Err(NetError::Network(format!("tls: {e}"))),
        Err(_) => Err(NetError::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn loopback_hosts() {
        for h in [
            "localhost",
            "a.localhost",
            "127.0.0.2",
            "::1",
            "[::1]",
            "LOCALHOST",
        ] {
            assert!(is_loopback_host(h), "{h}");
        }
        for h in ["example.com", "10.0.0.1", "localhost.example.com"] {
            assert!(!is_loopback_host(h), "{h}");
        }
    }

    #[test]
    fn policy() {
        let url = |s: &str| url::Url::parse(s).unwrap();
        assert_eq!(
            check_url(&url("http://example.com/")),
            Err(NetError::Blocked("http://example.com not allowed".into()))
        );
        assert!(check_url(&url("http://127.0.0.1:8080/")).is_ok());
        assert!(check_url(&url("http://[::1]/")).is_ok());
        assert!(check_url(&url("https://10.0.0.1:8443/")).is_ok());
        assert!(check_url(&url("ftp://localhost/")).is_err());
    }

    #[test]
    fn dav_urls() {
        assert!(parse_dav_url("https://dav.example.com/").is_some());
        assert!(parse_dav_url("https://dav.example.com:8443/x/").is_some());
        assert!(parse_dav_url("http://dav.example.com/").is_none());
        assert!(parse_dav_url("http://localhost:5232/").is_some());
        assert!(parse_dav_url("https://u:p@dav.example.com/").is_none());
        assert!(parse_dav_url(&format!("https://dav.example.com/{}", "a".repeat(2048))).is_none());
        assert!(parse_dav_url("https://dav.example.com/#x").is_none());
        assert!(parse_dav_url("").is_none());
        assert!(parse_dav_url("not a url").is_none());
    }

    #[test]
    fn loopback_bypasses_proxy() {
        let client = HttpClient::new().unwrap();
        let url = |s: &str| url::Url::parse(s).unwrap();
        for u in [
            "http://127.0.0.1:8080/",
            "http://localhost/",
            "http://[::1]/",
            "https://a.localhost/",
        ] {
            assert!(
                std::ptr::eq(client.client_for(&url(u)), &client.direct),
                "{u}"
            );
        }
        for u in ["https://example.com/", "https://10.0.0.1/"] {
            assert!(
                std::ptr::eq(client.client_for(&url(u)), &client.client),
                "{u}"
            );
        }
    }

    /// Répond une fois avec `response` et renvoie les en-têtes reçus, en minuscules.
    async fn serve_once(listener: tokio::net::TcpListener, response: String) -> String {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = socket.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.ok();
        String::from_utf8_lossy(&buf).to_lowercase()
    }

    #[tokio::test]
    async fn redirect_drops_authorization_on_origin_change() {
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = tokio::net::TcpListener::bind("127.0.0.2:0").await.unwrap();
        let first_port = first.local_addr().unwrap().port();
        let second_port = second.local_addr().unwrap().port();
        let a = tokio::spawn(serve_once(
            first,
            format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.2:{second_port}/b\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ),
        ));
        let b = tokio::spawn(serve_once(
            second,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string(),
        ));
        let client = HttpClient::new().unwrap();
        let res = client
            .fetch(
                HttpRequest {
                    method: http::Method::GET,
                    url: format!("http://127.0.0.1:{first_port}/a"),
                    headers: vec![("Authorization".into(), "Bearer t".into())],
                    body: bytes::Bytes::new(),
                },
                FetchOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.final_url, format!("http://127.0.0.2:{second_port}/b"));
        assert_eq!(res.text_limited(16).await.unwrap(), "ok");
        assert!(a.await.unwrap().contains("authorization: bearer t"));
        assert!(!b.await.unwrap().contains("authorization"));
    }
}
