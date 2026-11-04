import { JmapClient } from '@voxel/jmap';
import { reportUpstreamAuth } from './api';
import { accountRow, authHeader, peekSession, saveSession } from './accounts';
import { queryClient } from './queryClient';

const clients = new Map<string, JmapClient>();

/** `fetch` d'un compte : signale un 401 (bandeau « Reconnectez-vous ») sans modifier la réponse. */
export function accountFetch(accountId: string) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const res = await globalThis.fetch(input, init);
    if (res.status === 401) reportUpstreamAuth(accountId);
    return res;
  };
}

/** Client JMAP d'un compte, qui parle directement au serveur de messagerie. */
export function jmap(accountId: string): JmapClient {
  let c = clients.get(accountId);
  if (!c) {
    const row = accountRow(accountId);
    c = new JmapClient({
      sessionUrl: row?.sessionUrl ?? '',
      headers: () => authHeader(accountId),
      credentials: 'omit',
      fetch: accountFetch(accountId),
      // session en cache (Dexie) : l'appli s'ouvre hors ligne
      initialSession: peekSession(accountId),
      onSession: (s) => {
        saveSession(accountId, s);
        // capacités éventuellement changées : la liste des boîtes est relue depuis Dexie
        void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      },
    });
    clients.set(accountId, c);
  }
  return c;
}

export function dropClient(accountId: string) {
  clients.delete(accountId);
}

/** Identifiant de compte JMAP (mail) pour un compte de l'appli. */
export async function jmapAccountId(accountId: string): Promise<string> {
  return jmap(accountId).accountId();
}
