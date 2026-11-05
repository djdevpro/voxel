//! Limitation de débit en mémoire sur 15 min glissantes (port de `ratelimit.ts`) : 10 échecs de connexion par adresse,
//! 30 découvertes en tout. Un seul utilisateur sur le poste et aucune adresse IP : pas de clé par IP.

use std::collections::HashMap;
use std::sync::Mutex;

use voxel_core::error::{ApiError, ErrorCode};
use voxel_core::util::now_ms;

/// Fenêtre glissante des limites.
const WINDOW_MS: i64 = 15 * 60 * 1000;

/// Échecs de connexion permis par adresse dans la fenêtre.
const LOGIN_LIMIT: usize = 10;

/// Découvertes permises dans la fenêtre.
const DISCOVER_LIMIT: usize = 30;

#[derive(Debug, Clone, Copy)]
pub enum Bucket {
    Login,
    Discover,
}

#[derive(Default)]
pub struct RateLimiter {
    hits: Mutex<HashMap<String, Vec<i64>>>,
}

impl RateLimiter {
    fn key(bucket: Bucket, email: Option<&str>) -> (String, usize) {
        match bucket {
            Bucket::Login => (
                format!("login:email:{}", email.unwrap_or("").to_lowercase()),
                LOGIN_LIMIT,
            ),
            Bucket::Discover => ("discover:shared".to_string(), DISCOVER_LIMIT),
        }
    }

    /// Essais encore dans la fenêtre ; nettoie aussi les fenêtres expirées.
    fn recent(hits: &mut HashMap<String, Vec<i64>>, key: &str, now: i64) -> Vec<i64> {
        let since = now - WINDOW_MS;
        hits.retain(|_, list| {
            list.retain(|&t| t > since);
            !list.is_empty()
        });
        hits.get(key).cloned().unwrap_or_default()
    }

    /// `rate_limited` (429 + Retry-After) si la clé a atteint sa limite.
    pub fn assert_not_limited(&self, bucket: Bucket, email: Option<&str>) -> Result<(), ApiError> {
        let (key, limit) = Self::key(bucket, email);
        let now = now_ms();
        let mut hits = self.hits.lock().expect("limites");
        let list = Self::recent(&mut hits, &key, now);
        if list.len() >= limit {
            let retry = ((list[0] + WINDOW_MS - now) as f64 / 1000.0)
                .ceil()
                .max(1.0) as i64;
            return Err(ApiError::new(
                429,
                ErrorCode::RateLimited,
                "too many attempts, try again later",
            )
            .with_header("Retry-After", retry.to_string()));
        }
        Ok(())
    }

    pub fn record_attempt(&self, bucket: Bucket, email: Option<&str>) {
        let (key, _) = Self::key(bucket, email);
        let now = now_ms();
        let mut hits = self.hits.lock().expect("limites");
        Self::recent(&mut hits, &key, now);
        hits.entry(key).or_default().push(now);
    }
}
