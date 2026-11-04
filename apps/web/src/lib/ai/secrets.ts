/**
 * Clés d'API de l'IA (et de Deepgram), chiffrées avec la clé d'appareil (`encryptSecret`) dans Dexie `kv`,
 * ligne `ai-key:<id>`. Les valeurs déchiffrées ne vivent qu'en mémoire, dans ce module ; jamais journalisées.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type SecretBox } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/accounts';

const cache = new Map<string, string>();

const rowKey = (id: string) => `ai-key:${id}`;

function isSecretBox(v: unknown): v is SecretBox {
  return !!v && typeof v === 'object' && 'iv' in v && 'data' in v;
}

/** Identifiant de secret : id d'un fournisseur IA, ou `deepgram`. Vide ou `null` → suppression. */
export async function setAiSecret(id: string, value: string | null): Promise<void> {
  const text = value?.trim() ?? '';
  if (!text) {
    await deleteAiSecret(id);
    return;
  }
  await db.kv.put({ key: rowKey(id), value: await encryptSecret(text) });
  cache.set(id, text);
}

/** Clé déchiffrée, mise en cache mémoire ; `undefined` si absente ou illisible. */
export async function getAiSecret(id: string): Promise<string | undefined> {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const row = await db.kv.get(rowKey(id));
  if (!isSecretBox(row?.value)) return undefined;
  try {
    const text = await decryptSecret(row.value);
    cache.set(id, text);
    return text;
  } catch {
    // clé d'appareil changée (données effacées) : secret perdu
    return undefined;
  }
}

/** Vide le cache mémoire des clés déchiffrées (« Tout déconnecter »). */
export function clearAiSecretCache(): void {
  cache.clear();
}

export async function deleteAiSecret(id: string): Promise<void> {
  cache.delete(id);
  await db.kv.delete(rowKey(id));
}

/** Présence d'une clé (lecture vivante, pour l'UI des réglages). `undefined` pendant le chargement. */
export function useAiSecretSet(id: string): boolean | undefined {
  return useLiveQuery(() => db.kv.get(rowKey(id)).then((r) => !!r), [id]);
}
