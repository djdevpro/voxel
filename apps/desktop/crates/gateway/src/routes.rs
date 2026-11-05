//! Routes /imap/* (port de `routes/imap.ts` et de `readJson`/`handleError`, `http.ts`) : le même contrat HTTP que Node
//! (statuts, en-têtes, corps `{error, message}`), servi en process sur les `CoreRequest` que la coque reçoit par l'IPC.
//! Ni `Authorization` ni `X-Voxel-*` ne sont jamais journalisés ; aucune réponse ne porte `WWW-Authenticate`.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use voxel_core::backend::{BackendFactory, Endpoint};
use voxel_core::dns::DnsLookup;
use voxel_core::error::{ApiError, BackendError, ErrorCode};
use voxel_core::http::{CoreBody, CoreRequest, CoreResponse};
use voxel_core::jmap::JmapRequest;
use voxel_core::kv::KvStore;
use voxel_core::net::HttpClient;

use crate::blobs::{blob_headers, decode_uri_component, safe_mime_type};
use crate::discovery::{Discoverer, Discovery};
use crate::pool::{BackendPool, PoolHandle};
use crate::ratelimit::{Bucket, RateLimiter};
use crate::sse::event_stream;
use crate::target::target_of;

/// Taille maximale d'une requête JMAP (`maxSizeRequest`).
const MAX_REQUEST: usize = 10 * 1024 * 1024;

/// Taille maximale du corps de `/imap/discover`.
const MAX_DISCOVER_BODY: usize = 16 * 1024;

/// Longueur maximale d'une adresse à découvrir (unités UTF-16, comme JS).
const MAX_EMAIL: usize = 320;

/// Intervalle des pings SSE par défaut, en secondes.
const DEFAULT_PING: f64 = 30.0;

/// Bornes de l'intervalle des pings SSE, en secondes.
const PING_RANGE: (f64, f64) = (5.0, 300.0);

/// Capacité retirée de la session : pas de WebSocket par l'IPC.
const WEBSOCKET_CAP: &str = "urn:ietf:params:jmap:websocket";

/// Adresse à découvrir.
static DISCOVER_EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("expression d'adresse"));

pub type KvProvider = Arc<dyn Fn(&str) -> Arc<dyn KvStore> + Send + Sync>;

pub struct Gateway {
    pool: Arc<BackendPool>,
    limits: RateLimiter,
    discoverer: Discoverer,
}

/// Paramètres de la requête, décodés.
struct Query(Vec<(String, String)>);

impl Query {
    fn parse(raw: &str) -> Self {
        Query(
            url::form_urlencoded::parse(raw.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect(),
        )
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn not_found() -> ApiError {
    ApiError::new(404, ErrorCode::NotFound, "unknown route")
}

fn jmap_problem(value: serde_json::Value) -> CoreResponse {
    let status = value["status"].as_u64().unwrap_or(400) as u16;
    CoreResponse::json(status, &value)
}

fn internal(message: impl std::fmt::Display) -> ApiError {
    voxel_core::log::warn(format!("gateway: {message}"));
    ApiError::new(500, ErrorCode::Internal, "internal error")
}

impl Gateway {
    pub fn new(
        factory: Arc<dyn BackendFactory>,
        kv: KvProvider,
        http: HttpClient,
        dns: Arc<dyn DnsLookup>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool: BackendPool::new(factory, kv),
            limits: RateLimiter::default(),
            discoverer: Discoverer::new(http, dns),
        })
    }

    pub async fn handle(self: &Arc<Self>, request: CoreRequest) -> CoreResponse {
        match self.route(request).await {
            Ok(response) => response,
            Err(error) => CoreResponse::api_error(&error),
        }
    }

    /// Ferme toutes les façades (`closeAllBackends`).
    pub async fn close(&self) {
        self.pool.close_all().await;
    }

    async fn route(self: &Arc<Self>, request: CoreRequest) -> Result<CoreResponse, ApiError> {
        let (path, query) = match request.path.split_once('?') {
            Some((p, q)) => (p.to_string(), Query::parse(q)),
            None => (request.path.clone(), Query(Vec::new())),
        };
        let Some(rest) = path.strip_prefix("/imap/") else {
            return Err(not_found());
        };
        let segments: Vec<String> = rest.split('/').map(decode_uri_component).collect();
        let segs: Vec<&str> = segments.iter().map(String::as_str).collect();
        let method = request.method.clone();
        match (method.as_str(), segs.as_slice()) {
            ("GET", ["session"]) => self.session(&request).await,
            ("POST", ["api"]) => self.api(&request).await,
            ("POST", ["upload", account]) if !account.is_empty() => {
                self.upload(&request, account).await
            }
            ("GET", ["download", account, blob, name])
                if !account.is_empty() && !blob.is_empty() && !name.is_empty() =>
            {
                self.download(&request, &query, account, blob, name).await
            }
            ("GET", ["download", account, blob]) if !account.is_empty() && !blob.is_empty() => {
                self.download(&request, &query, account, blob, "download")
                    .await
            }
            ("GET", ["events"]) => self.events(&request, &query).await,
            ("POST", ["discover"]) => self.discover(&request).await,
            _ => Err(not_found()),
        }
    }

    /// Façade prête pour ces identifiants. Première utilisation d'une empreinte : vérification IMAP + SMTP,
    /// sous la limite d'échecs ; refus → `invalid_credentials` (à la session) ou `upstream_auth` (ailleurs).
    async fn backend_for(
        &self,
        request: &CoreRequest,
        on_session: bool,
    ) -> Result<PoolHandle, ApiError> {
        let target = target_of(&request.headers)?;
        let handle = self.pool.get(&target)?;
        if handle.verified {
            return Ok(handle);
        }
        let login = target.username.to_lowercase();
        self.limits
            .assert_not_limited(Bucket::Login, Some(&login))?;
        match handle.backend.verify().await {
            Ok(()) => {
                handle.mark_verified();
                Ok(handle)
            }
            Err(BackendError::Auth(_)) => {
                handle.discard();
                self.limits.record_attempt(Bucket::Login, Some(&login));
                let code = if on_session {
                    ErrorCode::InvalidCredentials
                } else {
                    ErrorCode::UpstreamAuth
                };
                Err(ApiError::new(
                    401,
                    code,
                    "the mail server rejected the credentials",
                ))
            }
            Err(error) => {
                handle.discard();
                Err(error.into())
            }
        }
    }

    async fn session(&self, request: &CoreRequest) -> Result<CoreResponse, ApiError> {
        let handle = self.backend_for(request, true).await?;
        // protocoles compagnons (ManageSieve, QUOTA, CardDAV) : vérifiés une fois, résultat gardé par la façade
        handle.backend.probe().await;
        let session = handle.backend.session().await?;
        let serde_json::Value::Object(mut out) = session else {
            return Err(internal("session is not an object"));
        };
        if let Some(serde_json::Value::Object(caps)) = out.get_mut("capabilities") {
            caps.remove(WEBSOCKET_CAP);
        }
        for (key, value) in [
            ("apiUrl", "/imap/api"),
            (
                "downloadUrl",
                "/imap/download/{accountId}/{blobId}/{name}?type={type}",
            ),
            ("uploadUrl", "/imap/upload/{accountId}"),
            (
                "eventSourceUrl",
                "/imap/events?types={types}&closeafter={closeafter}&ping={ping}",
            ),
        ] {
            out.insert(key.to_string(), value.into());
        }
        Ok(CoreResponse::json(200, &serde_json::Value::Object(out))
            .header("Cache-Control", "no-store"))
    }

    async fn api(&self, request: &CoreRequest) -> Result<CoreResponse, ApiError> {
        let handle = self.backend_for(request, false).await?;
        if request.body.len() > MAX_REQUEST {
            return Ok(jmap_problem(serde_json::json!({
                "type": "urn:ietf:params:jmap:error:limit", "limit": "maxSizeRequest", "status": 413
            })));
        }
        let text = String::from_utf8_lossy(&request.body);
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            return Ok(jmap_problem(serde_json::json!({
                "type": "urn:ietf:params:jmap:error:notJSON", "status": 400
            })));
        };
        let not_request = || {
            jmap_problem(serde_json::json!({
                "type": "urn:ietf:params:jmap:error:notRequest", "status": 400
            }))
        };
        if !value["using"].is_array() || !value["methodCalls"].is_array() {
            return Ok(not_request());
        }
        let Ok(jmap) = serde_json::from_value::<JmapRequest>(value) else {
            return Ok(not_request());
        };
        let response = handle.backend.api(jmap).await?;
        let body = serde_json::to_value(&response).map_err(internal)?;
        Ok(CoreResponse::json(200, &body).header("Cache-Control", "no-store"))
    }

    async fn upload(&self, request: &CoreRequest, account: &str) -> Result<CoreResponse, ApiError> {
        let handle = self.backend_for(request, false).await?;
        let content_type = request
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream");
        let result = handle
            .backend
            .upload(
                account.to_string(),
                request.body.clone(),
                safe_mime_type(Some(content_type)),
            )
            .await?;
        let body = serde_json::to_value(&result).map_err(internal)?;
        Ok(CoreResponse::json(201, &body).header("Cache-Control", "no-store"))
    }

    async fn download(
        &self,
        request: &CoreRequest,
        query: &Query,
        account: &str,
        blob: &str,
        name: &str,
    ) -> Result<CoreResponse, ApiError> {
        let handle = self.backend_for(request, false).await?;
        let requested = query.get("type").filter(|t| !t.is_empty());
        let content_type = requested.map(|t| safe_mime_type(Some(t)));
        let result = handle
            .backend
            .download(account.to_string(), blob.to_string(), content_type)
            .await?;
        let mut headers =
            blob_headers(&result.content_type, name, query.get("inline") == Some("1"));
        headers.push(("Content-Length".to_string(), result.body.len().to_string()));
        Ok(CoreResponse {
            status: 200,
            headers,
            body: CoreBody::Full(result.body),
        })
    }

    /// Flux d'événements JMAP (RFC 8620 §7.3) ; pings émis par la passerelle.
    async fn events(&self, request: &CoreRequest, query: &Query) -> Result<CoreResponse, ApiError> {
        let handle = self.backend_for(request, false).await?;
        let types_param = query.get("types").unwrap_or("*");
        let types: Vec<String> = if types_param == "*" || types_param.is_empty() {
            Vec::new()
        } else {
            types_param
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        };
        let close_after_state = query.get("closeafter") == Some("state");
        let ping_raw = match query.get("ping") {
            None => Some(DEFAULT_PING),
            Some(p) if p.trim().is_empty() => Some(0.0),
            Some(p) => p.trim().parse::<f64>().ok(),
        };
        let ping = match ping_raw {
            Some(p) if p.is_finite() && p > 0.0 => {
                (p + 0.5).floor().clamp(PING_RANGE.0, PING_RANGE.1) as u64
            }
            _ => 0,
        };
        let events = handle.backend.events(types).await?;
        Ok(CoreResponse {
            status: 200,
            headers: vec![
                (
                    "Content-Type".to_string(),
                    "text/event-stream; charset=utf-8".to_string(),
                ),
                (
                    "Cache-Control".to_string(),
                    "no-cache, no-transform".to_string(),
                ),
                ("X-Accel-Buffering".to_string(), "no".to_string()),
            ],
            body: CoreBody::Stream(event_stream(events, ping, close_after_state)),
        })
    }

    /// Découverte : JMAP → l'interface s'y connecte directement ; IMAP → serveurs à utiliser.
    async fn discover(&self, request: &CoreRequest) -> Result<CoreResponse, ApiError> {
        if request.body.len() > MAX_DISCOVER_BODY {
            return Err(ApiError::new(413, ErrorCode::Validation, "body too large"));
        }
        let expected = || ApiError::new(400, ErrorCode::Validation, "JSON object body expected");
        let body: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&request.body))
            .map_err(|_| expected())?;
        let serde_json::Value::Object(body) = body else {
            return Err(expected());
        };
        let email = body
            .get("email")
            .and_then(|e| e.as_str())
            .map(|e| e.trim().to_lowercase())
            .unwrap_or_default();
        if !DISCOVER_EMAIL_RE.is_match(&email) || email.encode_utf16().count() > MAX_EMAIL {
            return Err(ApiError::new(
                400,
                ErrorCode::Validation,
                "valid email required",
            ));
        }
        self.limits.assert_not_limited(Bucket::Discover, None)?;
        self.limits.record_attempt(Bucket::Discover, None);
        let found = self.discoverer.discover(&email).await;
        let ep = |e: &Endpoint| serde_json::json!({ "host": e.host, "port": e.port, "security": if e.secure { "ssl" } else { "starttls" } });
        let out = match found {
            None => serde_json::json!({ "protocol": null }),
            Some(Discovery::Jmap { session_url }) => {
                serde_json::json!({ "protocol": "jmap", "sessionUrl": session_url })
            }
            Some(Discovery::Imap {
                imap,
                smtp,
                username,
                sieve,
                carddav,
                caldav,
            }) => {
                let mut out = serde_json::Map::new();
                out.insert("protocol".into(), "imap".into());
                out.insert("imap".into(), ep(&imap));
                out.insert("smtp".into(), ep(&smtp));
                if let Some(sieve) = &sieve {
                    out.insert("sieve".into(), ep(sieve));
                }
                if let Some(carddav) = carddav {
                    out.insert("carddav".into(), carddav.into());
                }
                if let Some(caldav) = caldav {
                    out.insert("caldav".into(), caldav.into());
                }
                if let Some(username) = username {
                    out.insert("username".into(), username.into());
                }
                serde_json::Value::Object(out)
            }
        };
        Ok(CoreResponse::json(200, &out).header("Cache-Control", "no-store"))
    }
}
