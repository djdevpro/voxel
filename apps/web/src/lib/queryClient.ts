import { QueryClient } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { db } from './db';
import { ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24 * 7,
      networkMode: 'offlineFirst',
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
        return count < 2;
      },
    },
    mutations: { networkMode: 'always' },
  },
});

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: PersistedClient | undefined;

/** Écrit tout de suite l'instantané en attente : sinon une modification suivie d'un rechargement est perdue. */
function flushPersist() {
  if (!pending) return;
  clearTimeout(timer);
  timer = undefined;
  const c = pending;
  pending = undefined;
  void db.kv.put({ key: 'rq-cache', value: c }).catch(() => undefined);
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPersist();
  });
}

/** Persistance du cache react-query dans IndexedDB (lecture immédiate, lisible hors ligne). */
export const dexiePersister: Persister = {
  persistClient: async (client) => {
    pending = client;
    if (timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      const c = pending;
      pending = undefined;
      if (c) {
        try {
          await db.kv.put({ key: 'rq-cache', value: c });
        } catch {
          /* quota ou navigation privée */
        }
      }
    }, 1000);
  },
  restoreClient: async () => {
    try {
      return (await db.kv.get('rq-cache'))?.value as PersistedClient | undefined;
    } catch {
      return undefined;
    }
  },
  removeClient: async () => {
    try {
      await db.kv.delete('rq-cache');
    } catch {
      /* ignore */
    }
  },
};

/** Une clé de requête concerne-t-elle cette boîte (n'importe où dans la clé, y compris `threads` unifiés) ? */
function keyMentions(queryKey: readonly unknown[], mailboxId: string): boolean {
  try {
    return JSON.stringify(queryKey).includes(JSON.stringify(mailboxId));
  } catch {
    return false;
  }
}

/** Retire du cache (mémoire + IndexedDB) toutes les requêtes d'une boîte. */
export async function removeMailboxQueries(mailboxId: string) {
  queryClient.removeQueries({ predicate: (q) => keyMentions(q.queryKey, mailboxId) });
  try {
    const stored = (await db.kv.get('rq-cache'))?.value as PersistedClient | undefined;
    if (stored?.clientState?.queries) {
      stored.clientState.queries = stored.clientState.queries.filter((q) => !keyMentions(q.queryKey, mailboxId));
      await db.kv.put({ key: 'rq-cache', value: stored });
    }
  } catch {
    /* ignoré */
  }
}

/** Ne garde en cache que les requêtes des boîtes encore ouvertes (après restauration au démarrage). */
export function pruneQueriesTo(mailboxIds: string[]) {
  const scoped = new Set(['mailboxes', 'thread', 'identities', 'vacation']);
  queryClient.removeQueries({
    predicate: (q) => {
      const [head, second] = q.queryKey as [unknown, unknown];
      if (typeof head !== 'string') return false;
      if (scoped.has(head)) return typeof second === 'string' && !mailboxIds.includes(second);
      if (head === 'threads') {
        const accounts = (second as { accounts?: string[] } | undefined)?.accounts ?? [];
        return accounts.some((a) => !mailboxIds.includes(a));
      }
      return false;
    },
  });
}

/** « Tout déconnecter » : vide le cache mémoire et persisté. */
export async function clearAllQueries() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  pending = undefined;
  queryClient.clear();
  await dexiePersister.removeClient();
}
