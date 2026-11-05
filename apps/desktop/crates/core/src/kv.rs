//! Stockage clé-valeur de la façade IMAP : une seule table SQLite `imap_kv` (port de `apps/server/src/kv.ts`).
//! `mailbox_key = sha256(lowercase(username) + '@' + hôte IMAP)` : ni mot de passe ni adresse en clair.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

use crate::util::{now_ms, sha256_hex};

/// Une boîte lue moins d'une fois par jour voit sa date rafraîchie à l'ouverture, pas à chaque écriture.
const TOUCH_INTERVAL_MS: i64 = 24 * 3600 * 1000;

/// Schéma identique à `kv.ts`.
const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS imap_kv (
      mailbox_key TEXT NOT NULL,
      k TEXT NOT NULL,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (mailbox_key, k)
    );
    CREATE INDEX IF NOT EXISTS imap_kv_updated ON imap_kv (mailbox_key, updated_at);
";

pub trait KvStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str);
    fn delete(&self, key: &str);
}

/// Base `imap_kv` partagée par toutes les boîtes.
pub struct KvDatabase {
    conn: Mutex<Connection>,
}

impl KvDatabase {
    pub fn open(path: &Path) -> Result<Arc<Self>, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            conn: Mutex::new(conn),
        }))
    }

    /// KvStore d'une boîte ; son ouverture rafraîchit sa date pour la purge.
    pub fn store(self: &Arc<Self>, mailbox_key: &str) -> Arc<dyn KvStore> {
        let now = now_ms();
        let touched = self.with(|c| {
            c.execute(
                "UPDATE imap_kv SET updated_at = ? WHERE mailbox_key = ? AND updated_at < ?",
                params![now, mailbox_key, now - TOUCH_INTERVAL_MS],
            )
        });
        if let Err(e) = touched {
            crate::log::warn(format!("kv: {e}"));
        }
        Arc::new(MailboxKv {
            db: Arc::clone(self),
            mailbox_key: mailbox_key.to_string(),
        })
    }

    pub fn purge_older_than(&self, max_age: Duration) {
        let limit = now_ms() - max_age.as_millis() as i64;
        if let Err(e) =
            self.with(|c| c.execute("DELETE FROM imap_kv WHERE updated_at < ?", params![limit]))
        {
            crate::log::warn(format!("kv: {e}"));
        }
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&conn)
    }
}

struct MailboxKv {
    db: Arc<KvDatabase>,
    mailbox_key: String,
}

impl KvStore for MailboxKv {
    fn get(&self, key: &str) -> Option<String> {
        self.db
            .with(|c| {
                c.query_row(
                    "SELECT v FROM imap_kv WHERE mailbox_key = ? AND k = ?",
                    params![self.mailbox_key, key],
                    |r| r.get(0),
                )
                .optional()
            })
            .ok()
            .flatten()
    }

    fn set(&self, key: &str, value: &str) {
        let written = self.db.with(|c| {
            c.execute(
                "INSERT INTO imap_kv (mailbox_key, k, v, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(mailbox_key, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
                params![self.mailbox_key, key, value, now_ms()],
            )
        });
        if let Err(e) = written {
            crate::log::warn(format!("kv: {e}"));
        }
    }

    fn delete(&self, key: &str) {
        let deleted = self.db.with(|c| {
            c.execute(
                "DELETE FROM imap_kv WHERE mailbox_key = ? AND k = ?",
                params![self.mailbox_key, key],
            )
        });
        if let Err(e) = deleted {
            crate::log::warn(format!("kv: {e}"));
        }
    }
}

pub fn mailbox_key(username: &str, imap_host: &str) -> String {
    sha256_hex(
        format!(
            "{}@{}",
            username.trim().to_lowercase(),
            imap_host.trim().to_lowercase()
        )
        .as_bytes(),
    )
}

/// KvStore en mémoire, pour les tests et les sessions sans disque.
#[derive(Default)]
pub struct MemoryKv {
    map: Mutex<HashMap<String, String>>,
}

impl KvStore for MemoryKv {
    fn get(&self, key: &str) -> Option<String> {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .cloned()
    }

    fn set(&self, key: &str, value: &str) {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_string(), value.to_string());
    }

    fn delete(&self, key: &str) {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::random_hex;

    fn temp_db() -> (std::path::PathBuf, Arc<KvDatabase>) {
        let dir = std::env::temp_dir().join(format!("voxel-kv-{}", random_hex(6)));
        let db = KvDatabase::open(&dir.join("imap-kv.sqlite")).unwrap();
        (dir, db)
    }

    #[test]
    fn read_write_delete_and_isolation() {
        let (dir, db) = temp_db();
        let a = db.store(&mailbox_key("Alice", "imap.example.com"));
        let b = db.store(&mailbox_key("bob", "imap.example.com"));
        assert_eq!(a.get("k"), None);
        a.set("k", "1");
        a.set("k", "2");
        b.set("k", "b");
        assert_eq!(a.get("k").as_deref(), Some("2"));
        assert_eq!(b.get("k").as_deref(), Some("b"));
        a.delete("k");
        assert_eq!(a.get("k"), None);
        assert_eq!(b.get("k").as_deref(), Some("b"));
        drop((a, b, db));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn purge() {
        let (dir, db) = temp_db();
        let a = db.store("box");
        a.set("k", "v");
        db.purge_older_than(Duration::from_secs(3600));
        assert_eq!(a.get("k").as_deref(), Some("v"));
        std::thread::sleep(Duration::from_millis(5));
        db.purge_older_than(Duration::ZERO);
        assert_eq!(a.get("k"), None);
        drop((a, db));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn key_is_normalized() {
        assert_eq!(
            mailbox_key(" Alice ", "IMAP.example.com"),
            mailbox_key("alice", "imap.example.com")
        );
        assert_eq!(mailbox_key("a", "h"), sha256_hex(b"a@h"));
    }

    #[test]
    fn memory() {
        let kv = MemoryKv::default();
        kv.set("a", "1");
        assert_eq!(kv.get("a").as_deref(), Some("1"));
        kv.delete("a");
        assert_eq!(kv.get("a"), None);
    }
}
