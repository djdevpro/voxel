/**
 * Réglages synchronisés entre appareils : document `settings.json` rangé dans un message
 * du dossier caché de la boîte. Fusion clé par clé, la valeur la plus récente (`updatedAt`) gagne.
 * Module pur ; les constantes de nommage vivent dans `apps/web/src/lib/syncedSettings.ts`.
 */

export interface SyncedEntry {
  value: unknown;
  /** Horodatage ISO 8601 de la dernière écriture de cette clé. */
  updatedAt: string;
}

export interface SyncedDoc {
  version: 1;
  entries: Record<string, SyncedEntry>;
}

export const EMPTY_SYNCED: SyncedDoc = { version: 1, entries: {} };

/** Fusion : pour chaque clé, l'entrée la plus récente ; à égalité, `b` gagne. */
export function mergeSynced(a: SyncedDoc, b: SyncedDoc): SyncedDoc {
  const entries: Record<string, SyncedEntry> = { ...a.entries };
  for (const [k, e] of Object.entries(b.entries)) {
    const cur = entries[k];
    if (!cur || e.updatedAt >= cur.updatedAt) entries[k] = e;
  }
  return { version: 1, entries: Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]!])) };
}

/** Applique des valeurs nouvelles (horodatées `now`) sans toucher aux autres clés. */
export function patchSynced(doc: SyncedDoc, values: Record<string, unknown>, now: string): SyncedDoc {
  const patch: SyncedDoc = { version: 1, entries: {} };
  for (const [k, v] of Object.entries(values)) patch.entries[k] = { value: v, updatedAt: now };
  return mergeSynced(doc, patch);
}

/** Lecture tolérante d'un `settings.json` : entrées invalides ignorées, `null` si ce n'est pas un document. */
export function parseSynced(text: string): SyncedDoc | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || (v as SyncedDoc).version !== 1) return null;
    const raw = (v as { entries?: unknown }).entries;
    if (!raw || typeof raw !== 'object') return null;
    const entries: Record<string, SyncedEntry> = {};
    for (const [k, e] of Object.entries(raw as Record<string, unknown>)) {
      if (e && typeof e === 'object' && typeof (e as SyncedEntry).updatedAt === 'string' && 'value' in e) {
        entries[k] = { value: (e as SyncedEntry).value, updatedAt: (e as SyncedEntry).updatedAt };
      }
    }
    return { version: 1, entries };
  } catch {
    return null;
  }
}

/** Valeurs seules (sans horodatage). */
export function syncedValues(doc: SyncedDoc): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc.entries).map(([k, e]) => [k, e.value]));
}
