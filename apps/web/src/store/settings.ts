/**
 * Préférences.
 * - Préférences **d'appareil** (thème clair/sombre/système, densité, volet, délai d'annulation…) : localStorage.
 * - Préférences **de boîte** (couleurs de dossiers, identité par défaut ; nom et couleur dans la table `accounts`) :
 *   Dexie `kv`, clé `mbset:<id>`, propres à chaque appareil (plus de serveur).
 * L'API publique du store est inchangée : `folderColors` est indexé par `${mailboxId}:${folderId}`
 * et `defaultIdentity` par id de boîte, comme en v1.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { MailboxSettings, SessionInfo } from '@/lib/api';
import { db } from '@/lib/db';
import { queryClient } from '@/lib/queryClient';
import { scheduleSyncedWrite, setSyncedApplier } from '@/lib/syncedSettings';
import { updateAccount } from '@/lib/accounts';
import { isDesktop } from '@/lib/platform';

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';
export type ReadingPane = 'right' | 'bottom' | 'none';

export interface SyncedSettings {
  theme: Theme;
  density: Density;
  readingPane: ReadingPane;
  undoSendSeconds: number;
  remoteImages: 'block' | 'allow';
  notifications: boolean;
  defaultIdentity: Record<string, string>;
  folderColors: Record<string, string>;
  trustedSenders: string[];
  /** Accusés de lecture demandés par l'expéditeur : demander, toujours envoyer, jamais. */
  readReceipts: 'ask' | 'always' | 'never';
}

interface LocalLayout {
  sidebarWidth: number;
  listWidth: number;
  listHeight: number;
}

interface SettingsState extends SyncedSettings, LocalLayout {
  loaded: boolean;
  set: (patch: Partial<SyncedSettings>) => void;
  setLayout: (patch: Partial<LocalLayout>) => void;
  /** Charge depuis Dexie les préférences de toutes les boîtes ouvertes. */
  hydrate: () => Promise<void>;
  /** Oublie les préférences locales d'une boîte (`null` = toutes). */
  forgetMailbox: (mailboxId: string | null) => void;
}

export const DEFAULT_SETTINGS: SyncedSettings = {
  theme: 'system',
  density: 'comfortable',
  readingPane: 'right',
  undoSendSeconds: 10,
  remoteImages: 'block',
  notifications: isDesktop,
  defaultIdentity: {},
  folderColors: {},
  trustedSenders: [],
  readReceipts: 'ask',
};

/** Clés propres à l'appareil (localStorage). */
const DEVICE_KEYS = ['theme', 'density', 'readingPane', 'undoSendSeconds', 'remoteImages', 'notifications', 'trustedSenders', 'readReceipts'] as const;

function sessionMailboxIds(): string[] {
  return queryClient.getQueryData<SessionInfo>(['session'])?.mailboxes.map((m) => m.id) ?? [];
}

/** Couleurs de dossiers d'une boîte, clés `folderId`. */
function folderColorsOf(all: Record<string, string>, mailboxId: string): Record<string, string> {
  const prefix = `${mailboxId}:`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

function sameMap(a: Record<string, string>, b: Record<string, string>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Écrit (fusionné) les préférences d'une boîte dans Dexie. */
export async function putMailboxSettings(mailboxId: string, patch: MailboxSettings): Promise<void> {
  const key = `mbset:${mailboxId}`;
  const prev = ((await db.kv.get(key))?.value ?? {}) as MailboxSettings;
  await db.kv.put({ key, value: { ...prev, ...patch } });
}

async function getMailboxSettings(mailboxId: string): Promise<MailboxSettings | null> {
  try {
    return ((await db.kv.get(`mbset:${mailboxId}`))?.value ?? null) as MailboxSettings | null;
  } catch {
    return null;
  }
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      sidebarWidth: 248,
      listWidth: 420,
      listHeight: 360,
      loaded: false,
      set: (patch) => {
        const before = get();
        set(patch);
        // préférences de boîte modifiées → PUT par boîte concernée
        const ids = new Set<string>();
        if (patch.folderColors) {
          for (const k of new Set([...Object.keys(before.folderColors), ...Object.keys(patch.folderColors)])) {
            if (before.folderColors[k] !== patch.folderColors[k]) ids.add(k.split(':')[0]!);
          }
        }
        if (patch.defaultIdentity) {
          for (const k of new Set([...Object.keys(before.defaultIdentity), ...Object.keys(patch.defaultIdentity)])) {
            if (before.defaultIdentity[k] !== patch.defaultIdentity[k]) ids.add(k);
          }
        }
        const after = get();
        for (const id of ids) {
          const body: MailboxSettings = {};
          if (patch.folderColors) {
            const prev = folderColorsOf(before.folderColors, id);
            const next = folderColorsOf(after.folderColors, id);
            if (!sameMap(prev, next)) body.folderColors = next;
          }
          if (patch.defaultIdentity && before.defaultIdentity[id] !== after.defaultIdentity[id]) {
            body.defaultIdentityId = after.defaultIdentity[id] ?? null;
          }
          if (Object.keys(body).length) {
            putMailboxSettings(id, body).catch(() => {
              /* base indisponible : la copie localStorage reste */
            });
            // réglages synchronisés entre appareils
            scheduleSyncedWrite(id, body);
          }
        }
      },
      setLayout: (patch) => set(patch),
      hydrate: async () => {
        const ids = sessionMailboxIds();
        const results = await Promise.all(ids.map(async (id) => [id, await getMailboxSettings(id)] as const));
        const folderColors: Record<string, string> = {};
        const defaultIdentity: Record<string, string> = {};
        const prev = get();
        for (const [id, s] of results) {
          if (!s) {
            // rien en base (première ouverture après la v2) : on garde la copie localStorage
            Object.assign(folderColors, Object.fromEntries(Object.entries(prev.folderColors).filter(([k]) => k.startsWith(`${id}:`))));
            if (prev.defaultIdentity[id]) defaultIdentity[id] = prev.defaultIdentity[id]!;
            continue;
          }
          const src = s;
          if (src.folderColors && typeof src.folderColors === 'object') {
            for (const [f, c] of Object.entries(src.folderColors)) if (typeof c === 'string') folderColors[`${id}:${f}`] = c;
          }
          if (typeof src.defaultIdentityId === 'string' && src.defaultIdentityId) defaultIdentity[id] = src.defaultIdentityId;
        }
        set({ folderColors, defaultIdentity, loaded: true });
      },
      forgetMailbox: (mailboxId) => {
        if (mailboxId === null) return set({ folderColors: {}, defaultIdentity: {} });
        const s = get();
        const folderColors = Object.fromEntries(Object.entries(s.folderColors).filter(([k]) => !k.startsWith(`${mailboxId}:`)));
        const defaultIdentity = { ...s.defaultIdentity };
        delete defaultIdentity[mailboxId];
        set({ folderColors, defaultIdentity });
      },
    }),
    {
      name: 'voxel-settings',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // préférences d'appareil + copie des préférences de boîte (relue depuis Dexie à chaque démarrage)
      partialize: (s) => {
        const out: Record<string, unknown> = {
          sidebarWidth: s.sidebarWidth,
          listWidth: s.listWidth,
          listHeight: s.listHeight,
          folderColors: s.folderColors,
          defaultIdentity: s.defaultIdentity,
        };
        for (const k of DEVICE_KEYS) out[k] = s[k];
        return out as Partial<SettingsState>;
      },
      migrate: (persisted) => persisted as SettingsState,
    },
  ),
);

// Réglages reçus d'un autre appareil : appliqués localement, sans les renvoyer.
setSyncedApplier(async (accountId, values) => {
  const patch: MailboxSettings = {};
  if (values.folderColors && typeof values.folderColors === 'object') patch.folderColors = values.folderColors as Record<string, string>;
  if (values.defaultIdentityId === null || typeof values.defaultIdentityId === 'string') patch.defaultIdentityId = values.defaultIdentityId;
  if (Object.keys(patch).length) await putMailboxSettings(accountId, patch);
  const acc: { displayName?: string; color?: string } = {};
  if (typeof values.displayName === 'string') acc.displayName = values.displayName;
  if (typeof values.color === 'string' && /^#[0-9a-f]{6}$/i.test(values.color)) acc.color = values.color;
  const row = await db.accounts.get(accountId);
  if (row && ((acc.displayName !== undefined && acc.displayName !== row.displayName) || (acc.color !== undefined && acc.color !== row.color))) {
    await updateAccount(accountId, acc);
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['session'] });
  }
  // réponses types : relues depuis la copie locale du document
  if ('templates' in values) void queryClient.invalidateQueries({ queryKey: ['templates', accountId] });
  await useSettings.getState().hydrate();
});
