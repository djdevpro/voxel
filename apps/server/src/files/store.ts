/**
 * Comptes et fichiers des pièces jointes volumineuses : `files.sqlite` dans le dossier de données.
 * - `s3_account` : un compte par expéditeur vérifié, créé à sa première pièce jointe volumineuse ;
 *   identifiant = sha256(URL de session JMAP + identifiant de connexion), jamais de mot de passe.
 * - `s3_file` : un objet S3 par fichier ; `pending` jusqu'à la confirmation de l'envoi, `ready` ensuite.
 *   Tant que `expires_at` n'est pas passé, sa taille compte dans l'espace du compte (réservation comprise).
 */
import { DatabaseSync } from 'node:sqlite';

export type FileState = 'pending' | 'ready';

export interface FileRow {
  id: string;
  account_id: string;
  object_key: string;
  name: string;
  type: string;
  size: number;
  state: FileState;
  created_at: number;
  expires_at: number;
}

export interface AccountRow {
  id: string;
  email: string;
  created_at: number;
  last_used_at: number;
}

export class FilesStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS s3_account (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS s3_file (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        object_key TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS s3_file_account ON s3_file (account_id, expires_at);
      CREATE INDEX IF NOT EXISTS s3_file_expires ON s3_file (expires_at);
    `);
  }

  account(id: string): AccountRow | undefined {
    return this.db.prepare('SELECT id, email, created_at, last_used_at FROM s3_account WHERE id = ?').get(id) as AccountRow | undefined;
  }

  /** Crée le compte s'il n'existe pas ; `true` s'il vient d'être créé. */
  ensureAccount(id: string, email: string, now: number): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO s3_account (id, email, created_at, last_used_at) VALUES (?, ?, ?, ?)').run(id, email, now, now);
    if (r.changes > 0) return true;
    this.db.prepare('UPDATE s3_account SET email = ?, last_used_at = ? WHERE id = ?').run(email, now, id);
    return false;
  }

  /** Octets comptés dans l'espace du compte : fichiers prêts et envois réservés, non expirés. */
  usage(accountId: string, now: number): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM s3_file WHERE account_id = ? AND expires_at > ?').get(accountId, now) as { used: number };
    return Number(r.used);
  }

  insert(row: FileRow): void {
    this.db
      .prepare('INSERT INTO s3_file (id, account_id, object_key, name, type, size, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.account_id, row.object_key, row.name, row.type, row.size, row.state, row.created_at, row.expires_at);
  }

  file(id: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM s3_file WHERE id = ?').get(id) as FileRow | undefined;
  }

  markReady(id: string, expiresAt: number): void {
    this.db.prepare("UPDATE s3_file SET state = 'ready', expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM s3_file WHERE id = ?').run(id);
  }

  /** Fin de vie immédiate : le lien cesse, l'espace est libéré, le nettoyage supprime l'objet. */
  expire(id: string, now: number): void {
    this.db.prepare('UPDATE s3_file SET expires_at = ? WHERE id = ?').run(now, id);
  }

  /** Fichiers expirés (liens échus, envois abandonnés), à supprimer de S3 puis d'ici. */
  expired(now: number, limit = 1000): FileRow[] {
    return this.db.prepare('SELECT * FROM s3_file WHERE expires_at <= ? ORDER BY expires_at LIMIT ?').all(now, limit) as unknown as FileRow[];
  }

  close(): void {
    this.db.close();
  }
}
