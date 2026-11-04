/**
 * Chemins partagés, sans effet de bord (importable par la façade IMAP comme par config.ts).
 * Seule source de vérité du dossier de données : VOXEL_DATA_DIR, sinon <dépôt>/data.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine du dépôt : apps/server/{src,dist}/paths.* → ../../.. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Dossier de données (imap-kv.sqlite, secret.key, blobs/). Lu à l'appel : config.ts charge .env avant. */
export function resolveDataDir(): string {
  return resolve(process.env.VOXEL_DATA_DIR ?? join(repoRoot, 'data'));
}
