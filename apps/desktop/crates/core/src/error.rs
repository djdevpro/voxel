//! Erreurs de l'API locale et des backends : codes stables traduits par l'interface (port de `apps/server/src/http.ts`).
//! Les messages renvoyés sont courts et fixes : jamais de détail amont ni de pile au client.

use std::fmt;

/// Codes d'erreur stables, traduits par le front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidCredentials,
    DiscoveryFailed,
    DomainNotAllowed,
    RateLimited,
    UpstreamUnreachable,
    UpstreamAuth,
    NotFound,
    Forbidden,
    Validation,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidCredentials => "invalid_credentials",
            ErrorCode::DiscoveryFailed => "discovery_failed",
            ErrorCode::DomainNotAllowed => "domain_not_allowed",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::UpstreamUnreachable => "upstream_unreachable",
            ErrorCode::UpstreamAuth => "upstream_auth",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::Validation => "validation",
            ErrorCode::Internal => "internal",
        }
    }
}

/// Erreur à renvoyer telle quelle au client.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: ErrorCode,
    pub message: String,
    pub headers: Vec<(String, String)>,
}

impl ApiError {
    pub fn new(status: u16, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            headers: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    pub fn body(&self) -> serde_json::Value {
        serde_json::json!({ "error": self.code.as_str(), "message": self.message })
    }
}

/// Échec d'un backend de messagerie.
#[derive(Debug, Clone)]
pub enum BackendError {
    Auth(String),
    Unavailable(String),
    BlobNotFound(String),
    BlobTooLarge,
    Api(ApiError),
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendError::Auth(m) | BackendError::Unavailable(m) => f.write_str(m),
            BackendError::BlobNotFound(id) => write!(f, "blob {id} not found"),
            BackendError::BlobTooLarge => f.write_str("blob too large"),
            BackendError::Api(e) => f.write_str(&e.message),
        }
    }
}

impl From<BackendError> for ApiError {
    fn from(e: BackendError) -> Self {
        match e {
            BackendError::Api(e) => e,
            BackendError::BlobNotFound(_) => {
                ApiError::new(404, ErrorCode::NotFound, "blob not found")
            }
            BackendError::BlobTooLarge => {
                ApiError::new(413, ErrorCode::Validation, "blob too large")
            }
            // 401 : l'interface affiche « Reconnectez-vous ».
            BackendError::Auth(m) => {
                crate::log::warn(format!("upstream auth: {m}"));
                ApiError::new(
                    401,
                    ErrorCode::UpstreamAuth,
                    "the mail server rejected the credentials",
                )
            }
            BackendError::Unavailable(m) => {
                crate::log::warn(format!("upstream unreachable: {m}"));
                ApiError::new(
                    502,
                    ErrorCode::UpstreamUnreachable,
                    "the mail server is unreachable",
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_errors_map_to_stable_codes() {
        let cases = [
            (
                BackendError::BlobNotFound("mabc-1-2".into()),
                404,
                "not_found",
                "blob not found",
            ),
            (
                BackendError::BlobTooLarge,
                413,
                "validation",
                "blob too large",
            ),
            (
                BackendError::Auth(
                    "IMAP LOGIN failed: [AUTHENTICATIONFAILED] secret detail".into(),
                ),
                401,
                "upstream_auth",
                "the mail server rejected the credentials",
            ),
            (
                BackendError::Unavailable("connect ECONNREFUSED 10.0.0.1:993".into()),
                502,
                "upstream_unreachable",
                "the mail server is unreachable",
            ),
            (
                BackendError::Api(
                    ApiError::new(429, ErrorCode::RateLimited, "slow down")
                        .with_header("Retry-After", "5"),
                ),
                429,
                "rate_limited",
                "slow down",
            ),
        ];
        for (error, status, code, message) in cases {
            let api = ApiError::from(error);
            assert_eq!(
                (api.status, api.code.as_str(), api.message.as_str()),
                (status, code, message)
            );
            let text = api.body().to_string();
            assert_eq!(
                api.body(),
                serde_json::json!({ "error": code, "message": message })
            );
            assert!(!text.contains("secret detail") && !text.contains("ECONNREFUSED"));
        }
    }

    #[test]
    fn display() {
        assert_eq!(
            BackendError::BlobNotFound("b1".into()).to_string(),
            "blob b1 not found"
        );
        assert_eq!(BackendError::BlobTooLarge.to_string(), "blob too large");
        assert_eq!(BackendError::Auth("no".into()).to_string(), "no");
    }
}
