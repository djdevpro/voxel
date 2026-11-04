/**
 * Boîtes ouvertes sur l'appareil : lues dans Dexie sans requête réseau, comptes mémorisés
 * (adresses seulement, pour « Choisir un compte »), déconnexion d'une boîte ou de tout avec purge du cache local.
 */
import { disableAllPush, disablePush } from '@/lib/push';
import { useEffect, useSyncExternalStore } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import type { MailboxInfo, SessionInfo } from '@/lib/api';
import { clearAllQueries, queryClient, removeMailboxQueries } from '@/lib/queryClient';
import { purgeAllData, purgeMailboxData } from '@/lib/db';
import { dropClient, jmap } from '@/lib/jmap';
import { forgetAllPasswords, listAccounts, removeAccount } from '@/lib/accounts';
import { useSettings } from '@/store/settings';
import { clearAiSecretCache } from '@/lib/ai/secrets';
import { cancelSummaryJob } from '@/lib/ai/summaries';
import { useAiSettings } from '@/lib/ai/store';
import { resetAiChat } from '@/store/aiChat';

export const SESSION_KEY = ['session'] as const;
/** Clé de la liste des boîtes lue par le reste du front (`accountsQuery` de lib/mail). */
const ACCOUNTS_KEY = ['accounts'] as const;

/** Sessions JMAP rafraîchies une fois par démarrage (en ligne). */
const refreshed = new Set<string>();

function refreshSessionsOnce(list: MailboxInfo[]) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  for (const m of list) {
    if (refreshed.has(m.id)) continue;
    refreshed.add(m.id);
    void jmap(m.id)
      .getSession(true)
      .catch(() => refreshed.delete(m.id));
  }
}

export const sessionQuery = queryOptions({
  queryKey: SESSION_KEY,
  queryFn: async (): Promise<SessionInfo> => {
    const mailboxes = await listAccounts();
    queryClient.setQueryData<MailboxInfo[]>(ACCOUNTS_KEY, mailboxes);
    refreshSessionsOnce(mailboxes);
    return { mailboxes };
  },
  staleTime: Infinity,
  networkMode: 'always',
  retry: 1,
});

/** Boîtes ouvertes. `boot` (App) force la relecture de Dexie au montage. */
export function useSession(opts?: { boot?: boolean }) {
  return useQuery({ ...sessionQuery, refetchOnMount: opts?.boot ? 'always' : true });
}

export async function refreshSession(): Promise<SessionInfo> {
  const s = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
  await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
  return s;
}

// ------------------------------------------------------------------ comptes mémorisés (appareil)

export interface KnownAccount {
  email: string;
  displayName?: string;
  color?: string;
  lastUsed: number;
}

const KNOWN_KEY = 'voxel.knownAccounts';

function readKnown(): KnownAccount[] {
  try {
    const raw = localStorage.getItem(KNOWN_KEY);
    const list = raw ? (JSON.parse(raw) as KnownAccount[]) : [];
    return Array.isArray(list) ? list.filter((a) => a && typeof a.email === 'string') : [];
  } catch {
    return [];
  }
}

function writeKnown(list: KnownAccount[]) {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible */
  }
}

interface KnownState {
  list: KnownAccount[];
  remember: (m: Pick<MailboxInfo, 'email'> & Partial<MailboxInfo>) => void;
  forget: (email: string) => void;
}

/** Adresses déjà utilisées sur cet appareil — jamais de mot de passe. */
export const useKnownAccounts = create<KnownState>()((set, get) => ({
  list: readKnown(),
  remember: (m) => {
    const email = m.email.trim().toLowerCase();
    const prev = get().list.find((a) => a.email === email);
    const entry: KnownAccount = {
      email,
      displayName: m.displayName || prev?.displayName,
      color: m.color || prev?.color,
      lastUsed: Date.now(),
    };
    const list = [entry, ...get().list.filter((a) => a.email !== email)].slice(0, 12);
    writeKnown(list);
    set({ list });
  },
  forget: (email) => {
    const list = get().list.filter((a) => a.email !== email.toLowerCase());
    writeKnown(list);
    set({ list });
  },
}));

// ------------------------------------------------------------------ connexion / déconnexion

/** Après une connexion réussie : mémorise l'adresse, recharge la liste des boîtes. */
export async function afterLogin(mailbox: MailboxInfo) {
  useKnownAccounts.getState().remember(mailbox);
  useReconnect.getState().clear(mailbox.id);
  dropClient(mailbox.id);
  await refreshSession();
  void useSettings.getState().hydrate();
}

/** Efface tout ce que l'appareil garde d'une boîte. */
export async function purgeMailbox(id: string) {
  // abonnement push détruit sur le serveur tant que les identifiants sont encore là
  await disablePush(id).catch(() => undefined);
  dropClient(id);
  await removeAccount(id);
  await Promise.all([removeMailboxQueries(id), purgeMailboxData(id)]);
  // IA : style de la boîte et exclusion des résumés
  const ai = useAiSettings.getState();
  const { [id]: _style, ...mailboxStyles } = ai.mailboxStyles;
  ai.set({ mailboxStyles, summary: { ...ai.summary, excludedAccounts: ai.summary.excludedAccounts.filter((x) => x !== id) } });
  useSettings.getState().forgetMailbox(id);
  useReconnect.getState().clear(id);
}

/** Se déconnecter d'une boîte : supprime le compte, son secret et son cache ; la dernière purge tout. */
export async function logoutMailbox(id: string) {
  await purgeMailbox(id);
  const s = await refreshSession().catch(() => ({ mailboxes: [] }) as SessionInfo);
  if (!s.mailboxes.length) await purgeEverything();
}

async function purgeEverything() {
  await disableAllPush().catch(() => undefined);
  forgetAllPasswords();
  // IA : clés en mémoire, résumé en cours, discussion
  clearAiSecretCache();
  cancelSummaryJob();
  resetAiChat();
  await Promise.all([clearAllQueries(), purgeAllData()]);
  useSettings.getState().forgetMailbox(null);
  useReconnect.setState({ ids: [] });
  queryClient.setQueryData<SessionInfo>(SESSION_KEY, { mailboxes: [] });
  queryClient.setQueryData<MailboxInfo[]>(ACCOUNTS_KEY, []);
}

/** « Tout déconnecter » : vide toutes les tables Dexie et le cache react-query persistant (pas l'app shell). */
export async function logoutAll() {
  await purgeEverything();
}

// ------------------------------------------------------------------ « Reconnectez-vous » (401 du serveur mail)

interface ReconnectState {
  ids: string[];
  add: (id: string) => void;
  clear: (id: string) => void;
}

export const useReconnect = create<ReconnectState>()((set, get) => ({
  ids: [],
  add: (id) => !get().ids.includes(id) && set({ ids: [...get().ids, id] }),
  clear: (id) => set({ ids: get().ids.filter((x) => x !== id) }),
}));

/** Écoute l'événement global émis par lib/jmap (identifiants refusés par le serveur mail). */
export function useSessionEvents() {
  useEffect(() => {
    const onUpstream = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) useReconnect.getState().add(id);
    };
    window.addEventListener('voxel:upstream-auth', onUpstream);
    return () => window.removeEventListener('voxel:upstream-auth', onUpstream);
  }, []);
}

// ------------------------------------------------------------------ direction d'écriture

function subscribeDir(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
  return () => obs.disconnect();
}

/** `true` si la page est en RTL (arabe) : sert à inverser les glissements. */
export function useIsRtl(): boolean {
  return useSyncExternalStore(
    subscribeDir,
    () => document.documentElement.dir === 'rtl',
    () => false,
  );
}
