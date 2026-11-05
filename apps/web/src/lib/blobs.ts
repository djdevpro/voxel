/**
 * Fichiers d'un message : un `<a href>` ou un `<img src>` ne porte pas `Authorization`,
 * donc on télécharge par `fetch` authentifié (`client.download()`) puis on passe par des URL d'objets.
 */
import { useEffect, useState } from 'react';
import type { EmailBodyPart } from '@voxel/jmap';
import { jmap } from './jmap';
import { authHeader } from './accounts';
import { downloadToFile, isDesktop } from './platform';

/** Petit cache mémoire des blobs téléchargés (plafonné en taille), partagé entre aperçus et vignettes. */
const CACHE_MAX = 40 * 1024 * 1024;
const cache = new Map<string, Blob>();
let cacheSize = 0;

function remember(key: string, b: Blob) {
  if (b.size > CACHE_MAX / 4) return;
  cache.set(key, b);
  cacheSize += b.size;
  for (const [k, v] of cache) {
    if (cacheSize <= CACHE_MAX) break;
    cache.delete(k);
    cacheSize -= v.size;
  }
}

/** Télécharge un blob du compte (fetch authentifié), avec le type MIME voulu. */
export async function fetchBlob(accountId: string, jmapAccountId: string, blobId: string, name: string, type = 'application/octet-stream'): Promise<Blob> {
  const key = `${accountId}:${blobId}:${type}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = await jmap(accountId).download(jmapAccountId, blobId, name || 'file', type);
  const b = raw.type === type ? raw : new Blob([raw], { type });
  remember(key, b);
  return b;
}

/** URL d'objet d'un blob, révoquée au démontage ; `null` tant qu'il se télécharge (ou en cas d'échec). */
export function useBlobUrl(accountId: string, jmapAccountId: string, blobId: string | null | undefined, name: string, type?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blobId || !jmapAccountId) return;
    let alive = true;
    let made: string | null = null;
    fetchBlob(accountId, jmapAccountId, blobId, name, type)
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [accountId, jmapAccountId, blobId, name, type]);
  return url;
}

/** Télécharge puis enregistre le fichier (lien `<a download>` temporaire). */
export async function saveBlob(accountId: string, jmapAccountId: string, blobId: string, name: string, type?: string) {
  if (isDesktop) {
    await jmap(accountId).getSession();
    await downloadToFile(name || 'file', jmap(accountId).downloadUrl(jmapAccountId, blobId, name || 'file', type), authHeader(accountId));
    return;
  }
  const b = await fetchBlob(accountId, jmapAccountId, blobId, name, type);
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Ouvre le fichier dans un nouvel onglet (PDF, `.eml`…). L'onglet est ouvert tout de suite (sinon le
 * bloqueur de fenêtres l'interdit après l'attente), puis dirigé vers l'URL d'objet une fois le fichier reçu.
 */
export async function openBlob(accountId: string, jmapAccountId: string, blobId: string, name: string, type?: string) {
  const win = window.open('', '_blank');
  try {
    const b = await fetchBlob(accountId, jmapAccountId, blobId, name, type);
    const url = URL.createObjectURL(b);
    if (win) win.location.href = url;
    else window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

// ------------------------------------------------------------------ images `cid:` du message

/** Plafond cumulé des images intégrées préparées automatiquement pour un message. */
export const CID_LIMIT = 15 * 1024 * 1024;

const cidOf = (a: EmailBodyPart) => (a.cid ?? '').replace(/^<|>$/g, '');

/** Images `cid:` d'un message : `{ cid → URL blob: }`, préparées avant le rendu de `EmailFrame`. */
export async function buildCidMap(
  accountId: string,
  jmapAccountId: string,
  parts: EmailBodyPart[],
  limit = CID_LIMIT,
): Promise<{ map: Record<string, string>; skipped: number; urls: string[] }> {
  const map: Record<string, string> = {};
  const urls: string[] = [];
  let total = 0;
  let skipped = 0;
  await Promise.all(
    parts
      .filter((a) => a.cid && a.blobId)
      .filter((a) => {
        total += a.size ?? 0;
        if (total > limit) {
          skipped++;
          return false;
        }
        return true;
      })
      .map(async (a) => {
        try {
          const b = await fetchBlob(accountId, jmapAccountId, a.blobId!, a.name ?? 'image', a.type);
          const u = URL.createObjectURL(b);
          urls.push(u);
          map[cidOf(a)] = u;
        } catch {
          /* image manquante : laissée vide */
        }
      }),
  );
  return { map, skipped, urls };
}

/** Variante React : `ready` passe à `true` quand les images sont prêtes ; `skipped` = images au-delà du plafond. */
export function useCidMap(accountId: string, jmapAccountId: string, parts: EmailBodyPart[] | undefined, enabled: boolean, unlimited = false) {
  const [state, setState] = useState<{ map: Record<string, string>; skipped: number; ready: boolean }>({ map: {}, skipped: 0, ready: false });
  const key = (parts ?? []).map((p) => (p.cid ? `${p.cid}:${p.blobId}` : '')).join('|');
  useEffect(() => {
    if (!enabled || !jmapAccountId || !key.replace(/\|/g, '')) {
      setState({ map: {}, skipped: 0, ready: true });
      return;
    }
    let alive = true;
    let made: string[] = [];
    setState((s) => ({ ...s, ready: false }));
    void buildCidMap(accountId, jmapAccountId, parts ?? [], unlimited ? Infinity : CID_LIMIT).then((r) => {
      made = r.urls;
      if (alive) setState({ map: r.map, skipped: r.skipped, ready: true });
      else r.urls.forEach((u) => URL.revokeObjectURL(u));
    });
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, jmapAccountId, key, enabled, unlimited]);
  return state;
}
