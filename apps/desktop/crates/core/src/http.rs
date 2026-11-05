//! Requêtes et réponses HTTP internes, sans serveur : la passerelle /imap/* les produit, la coque les relaie
//! sur le canal IPC. Le corps est entier ou en flux (SSE, téléchargements).

use std::pin::Pin;

use futures_util::{Stream, StreamExt};

use crate::error::ApiError;

pub type BodyStream = Pin<Box<dyn Stream<Item = Result<bytes::Bytes, String>> + Send>>;

pub enum CoreBody {
    Full(bytes::Bytes),
    Stream(BodyStream),
}

pub struct CoreRequest {
    pub method: http::Method,
    pub path: String,
    pub headers: http::HeaderMap,
    pub body: bytes::Bytes,
}

pub struct CoreResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: CoreBody,
}

impl CoreResponse {
    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            body: CoreBody::Full(bytes::Bytes::from(value.to_string())),
        }
    }

    pub fn api_error(error: &ApiError) -> Self {
        let mut res = Self::json(error.status, &error.body());
        res.headers.extend(error.headers.iter().cloned());
        res
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }
}

pub fn receiver_stream(rx: tokio::sync::mpsc::Receiver<bytes::Bytes>) -> BodyStream {
    futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (Ok(chunk), rx))
    })
    .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn api_error_response() {
        let res = CoreResponse::api_error(
            &ApiError::new(429, ErrorCode::RateLimited, "slow").with_header("Retry-After", "3"),
        );
        assert_eq!(res.status, 429);
        assert_eq!(
            res.headers,
            vec![
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Retry-After".to_string(), "3".to_string())
            ]
        );
        let CoreBody::Full(body) = res.body else {
            panic!("corps entier attendu")
        };
        assert_eq!(&body[..], br#"{"error":"rate_limited","message":"slow"}"#);
    }

    #[tokio::test]
    async fn stream_from_receiver() {
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.send(bytes::Bytes::from_static(b"a")).await.unwrap();
        tx.send(bytes::Bytes::from_static(b"b")).await.unwrap();
        drop(tx);
        let chunks: Vec<_> = receiver_stream(rx).collect().await;
        assert_eq!(
            chunks,
            vec![
                Ok(bytes::Bytes::from_static(b"a")),
                Ok(bytes::Bytes::from_static(b"b"))
            ]
        );
    }
}
