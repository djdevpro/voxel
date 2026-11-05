//! Blobs téléversés (pièces jointes en cours de rédaction, port de `blobs.ts`) : fichiers temporaires sous
//! `<dossier des blobs>/<empreinte de la boîte>/`, gardés 24 h, avec un quota par boîte pour que des
//! téléversements répétés ne remplissent pas le disque. Chaque fichier est écrit à part puis renommé :
//! une lecture ne voit jamais un blob à moitié écrit.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use futures_util::future::BoxFuture;
use voxel_core::backend::UploadSource;
use voxel_core::util::{hash_of, now_ms, random_hex};

/// Durée de vie d'un blob.
const TTL: Duration = Duration::from_secs(24 * 3600);
/// Blobs au plus par boîte sur 24 h.
const MAX_BLOBS: usize = 300;
/// Octets au plus par boîte sur 24 h.
const MAX_TOTAL_BYTES: u64 = 500_000_000;
/// Intervalle minimal entre deux nettoyages.
const CLEANUP_EVERY: Duration = Duration::from_secs(3600);

/// Blob téléversé au-delà de la taille maximale ou du quota (le routeur le traduit en 413).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobTooLarge;

impl std::fmt::Display for BlobTooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blob too large")
    }
}

impl std::error::Error for BlobTooLarge {}

pub struct BlobStore {
    dir: PathBuf,
    max_size: u64,
    last_cleanup: Mutex<Option<Instant>>,
}

/// Suffixe des fichiers temporaires (compteur du processus : deux écritures ne se croisent pas).
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Écrit `data` dans un fichier temporaire du même dossier puis le renomme en `path`.
async fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.{n}.tmp", std::process::id()));
    if let Err(e) = tokio::fs::write(&tmp, data).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

fn older_than_ttl(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|age| age > TTL)
}

impl BlobStore {
    pub fn new(dir: PathBuf, email: &str, max_size: u64) -> Self {
        BlobStore {
            dir: dir.join(hash_of(&email.to_lowercase(), 16)),
            max_size,
            last_cleanup: Mutex::new(None),
        }
    }

    pub fn is_upload_id(id: &str) -> bool {
        id.len() == 25
            && id.starts_with('U')
            && id[1..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    /// Enregistre un blob : `(blobId, taille, type)`.
    pub async fn put(
        &self,
        body: Bytes,
        content_type: &str,
    ) -> Result<(String, u64, String), BlobTooLarge> {
        if let Err(e) = tokio::fs::create_dir_all(&self.dir).await {
            voxel_core::log::warn(format!("blob store unavailable: {}", e.kind()));
            return Err(BlobTooLarge);
        }
        self.cleanup().await;
        let (count, bytes) = self.usage().await;
        if count >= MAX_BLOBS || bytes >= MAX_TOTAL_BYTES {
            return Err(BlobTooLarge);
        }
        let blob_id = format!("U{}", random_hex(12));
        let size = body.len() as u64;
        let max = self.max_size.min(MAX_TOTAL_BYTES - bytes);
        if size > max {
            return Err(BlobTooLarge);
        }
        let file = self.dir.join(&blob_id);
        if let Err(e) = write_atomic(&file, &body).await {
            voxel_core::log::warn(format!("blob write failed: {}", e.kind()));
            return Err(BlobTooLarge);
        }
        let t = if content_type.is_empty() {
            "application/octet-stream".to_string()
        } else {
            content_type.to_string()
        };
        let meta = serde_json::json!({ "type": t, "size": size, "at": now_ms() }).to_string();
        let meta_file = self.dir.join(format!("{blob_id}.json"));
        if let Err(e) = write_atomic(&meta_file, meta.as_bytes()).await {
            voxel_core::log::warn(format!("blob write failed: {}", e.kind()));
            let _ = tokio::fs::remove_file(&file).await;
            return Err(BlobTooLarge);
        }
        Ok((blob_id, size, t))
    }

    /// Contenu et type d'un blob téléversé ; None s'il n'existe pas (ou plus).
    pub async fn get(&self, id: &str) -> Option<(Bytes, String)> {
        if !Self::is_upload_id(id) {
            return None;
        }
        let file = self.dir.join(id);
        let data = tokio::fs::read(&file).await.ok()?;
        let meta = tokio::fs::read_to_string(self.dir.join(format!("{id}.json")))
            .await
            .unwrap_or_else(|_| "{}".into());
        let parsed: serde_json::Value = serde_json::from_str(&meta).ok()?;
        let t = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("application/octet-stream")
            .to_string();
        Some((Bytes::from(data), t))
    }

    /// Nombre de blobs et octets occupés (hors fichiers .json de métadonnées).
    async fn usage(&self) -> (usize, u64) {
        let mut count = 0;
        let mut bytes = 0;
        let Ok(mut dir) = tokio::fs::read_dir(&self.dir).await else {
            return (0, 0);
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !Self::is_upload_id(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if older_than_ttl(&meta) {
                continue;
            }
            count += 1;
            bytes += meta.len();
        }
        (count, bytes)
    }

    /// Supprime les blobs de plus de 24 h (au plus une fois par heure).
    async fn cleanup(&self) {
        {
            let mut last = self.last_cleanup.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|at| at.elapsed() < CLEANUP_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        let Ok(mut dir) = tokio::fs::read_dir(&self.dir).await else {
            return;
        };
        while let Ok(Some(entry)) = dir.next_entry().await {
            if let Ok(meta) = entry.metadata().await
                && older_than_ttl(&meta)
            {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

impl UploadSource for BlobStore {
    fn load<'a>(&'a self, blob_id: &'a str) -> BoxFuture<'a, Option<Bytes>> {
        Box::pin(async move { self.get(blob_id).await.map(|(data, _)| data) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn depot_relecture_et_limites() {
        let base = std::env::temp_dir().join(format!("voxel-mail-blobs-{}", random_hex(6)));
        let store = BlobStore::new(base.clone(), "Alice@Example.com", 10);
        let (id, size, t) = store.put(Bytes::from_static(b"hello"), "").await.unwrap();
        assert!(BlobStore::is_upload_id(&id));
        assert_eq!((size, t.as_str()), (5, "application/octet-stream"));
        assert_eq!(
            store.get(&id).await,
            Some((
                Bytes::from_static(b"hello"),
                "application/octet-stream".into()
            ))
        );
        assert_eq!(
            store
                .put(Bytes::from_static(b"01234567890"), "text/plain")
                .await,
            Err(BlobTooLarge)
        );
        assert_eq!(store.get("U000000000000000000000000").await, None);
        assert_eq!(store.get("../x").await, None);
        let _ = std::fs::remove_dir_all(base);
    }
}
