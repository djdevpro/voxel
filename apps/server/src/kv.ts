/**
 * Stockage clé-valeur de la façade IMAP : une seule table SQLite `imap_kv`.
 * `mailbox_key = sha256(lowercase(username) + '@' + hôte IMAP)` : ni mot de passe ni adresse en clair.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from './config.js';
import { sha256 } from './crypto.js';
import type { KvStore } from './backend/types.js';

const RETENTION_MS = 180 * 24 * 3600 * 1000;

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(join(config.dataDir, 'imap-kv.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS imap_kv (
      mailbox_key TEXT NOT NULL,
      k TEXT NOT NULL,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (mailbox_key, k)
    );
    CREATE INDEX IF NOT EXISTS imap_kv_updated ON imap_kv (mailbox_key, updated_at);
  `);
  return db;
}

export function mailboxKey(username: string, imapHost: string): string {
  return sha256(`${username.trim().toLowerCase()}@${imapHost.trim().toLowerCase()}`);
}

/** KvStore d'une boîte ; chaque lecture rafraîchit sa date pour la purge. */
export function kvStoreFor(key: string): KvStore {
  const d = open();
  const get = d.prepare('SELECT v FROM imap_kv WHERE mailbox_key = ? AND k = ?');
  const put = d.prepare(
    'INSERT INTO imap_kv (mailbox_key, k, v, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(mailbox_key, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
  );
  const del = d.prepare('DELETE FROM imap_kv WHERE mailbox_key = ? AND k = ?');
  const touch = d.prepare('UPDATE imap_kv SET updated_at = ? WHERE mailbox_key = ? AND updated_at < ?');
  touch.run(Date.now(), key, Date.now() - 24 * 3600 * 1000);
  return {
    get: (k) => (get.get(key, k) as { v: string } | undefined)?.v,
    set: (k, v) => void put.run(key, k, v, Date.now()),
    delete: (k) => void del.run(key, k),
  };
}

/** Purge des boîtes inutilisées depuis 180 jours (au démarrage). */
export function purgeOldKv(): void {
  open().prepare('DELETE FROM imap_kv WHERE updated_at < ?').run(Date.now() - RETENTION_MS);
}
