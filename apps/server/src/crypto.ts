/** Empreintes : aucune donnée chiffrée côté serveur, seulement des hachages. */
import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
