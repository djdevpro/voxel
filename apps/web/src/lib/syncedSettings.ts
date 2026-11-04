/**
 * Réglages synchronisés entre appareils.
 *
 * Préférences de boîte (`displayName`, `color`, `folderColors`, `defaultIdentityId`) rangées dans un dossier
 * caché (`SYNCED_FOLDER_NAME`) à la racine de la boîte, qui contient un seul message dont la pièce jointe
 * `settings.json` porte le document (fusion clé par clé, la valeur la plus récente gagne : `@voxel/jmap`).
 * Même méthode pour JMAP et IMAP (la façade sait créer et lire des messages), sans extension en brouillon.
 * L'apparence (thème, langue, densité) reste propre à l'appareil.
 */
import { EMPTY_SYNCED, mergeSynced, parseSynced, patchSynced, syncedValues, type Mailbox, type SyncedDoc } from '@voxel/jmap';
import { db } from './db';
import { jmap } from './jmap';
import { isOffline } from './outbox';
import { queryClient } from './queryClient';

// ------------------------------------------------------------------ constantes (un seul module)

export const SYNCED_FOLDER_NAME = '.voxel';
export const SYNCED_SUBJECT = 'Voxel — réglages';
export const SYNCED_BODY = 'Ne pas supprimer : réglages du webmail Voxel';
export const SYNCED_ATTACHMENT = 'settings.json';
/** Regroupement des écritures. */
const WRITE_DELAY_MS = 1000;

export type SyncedKey = 'displayName' | 'color' | 'folderColors' | 'defaultIdentityId' | 'templates';
export type SyncedValues = Partial<Record<SyncedKey, unknown>>;

/** Le dossier caché des réglages (racine, nom exact). */
export function isSyncedSettingsFolder(m: Pick<Mailbox, 'name' | 'parentId'>): boolean {
  return !m.parentId && m.name === SYNCED_FOLDER_NAME;
}

// ------------------------------------------------------------------ lecture distante

interface Remote {
  folderId: string | null;
  emailIds: string[];
  doc: SyncedDoc | null;
}

/** Messages de réglages d'un dossier et leur document. */
async function readFolder(accountId: string, folderId: string): Promise<Omit<Remote, 'folderId'>> {
  const c = jmap(accountId);
  const aid = await c.accountId();
  const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: folderId }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 20 });
  if (!q.ids.length) return { emailIds: [], doc: null };
  const g = await c.call('Email/get', { accountId: aid, ids: q.ids, properties: ['id', 'attachments'] });
  let doc: SyncedDoc | null = null;
  // plusieurs messages (deux appareils en même temps) : on les fusionne tous
  for (const e of g.list) {
    const att = (e.attachments ?? []).find((a) => a.name === SYNCED_ATTACHMENT && a.blobId);
    if (!att?.blobId) continue;
    const text = await (await c.download(aid, att.blobId, SYNCED_ATTACHMENT, 'application/json')).text();
    const d = parseSynced(text);
    if (d) doc = doc ? mergeSynced(doc, d) : d;
  }
  return { emailIds: q.ids, doc };
}

async function readRemote(accountId: string): Promise<Remote> {
  const c = jmap(accountId);
  const aid = await c.accountId();
  const mb = await c.call('Mailbox/get', { accountId: aid, ids: null, properties: ['id', 'name', 'parentId'] });
  const folder = mb.list.find(isSyncedSettingsFolder);
  if (folder) return { folderId: folder.id, ...(await readFolder(accountId, folder.id)) };
  // réglages rangés dans un autre dossier caché (nom d'une version précédente) : dossier repris et renommé
  for (const m of mb.list) {
    if (m.parentId || !m.name.startsWith('.')) continue;
    const found = await readFolder(accountId, m.id);
    if (!found.doc) continue;
    await c.call('Mailbox/set', { accountId: aid, update: { [m.id]: { name: SYNCED_FOLDER_NAME } } }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
    return { folderId: m.id, ...found };
  }
  return { folderId: null, emailIds: [], doc: null };
}

// ------------------------------------------------------------------ écriture

const pending = new Map<string, SyncedValues & { at?: string }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Dernier message écrit ou lu par cet appareil : évite de relire nos propres écritures. */
const lastSeen = new Map<string, string>();

async function writeRemote(accountId: string, doc: SyncedDoc, remote: Remote): Promise<void> {
  const c = jmap(accountId);
  const aid = await c.accountId();
  let folderId = remote.folderId;
  if (!folderId) {
    const r = await c.call('Mailbox/set', { accountId: aid, create: { h: { name: SYNCED_FOLDER_NAME, parentId: null, isSubscribed: false } } });
    folderId = (r.created?.h?.id as string | undefined) ?? null;
    if (!folderId) throw new Error(r.notCreated?.h?.description ?? r.notCreated?.h?.type ?? 'mailbox');
  }
  const blob = await c.upload(aid, new Blob([JSON.stringify(doc)], { type: 'application/json' }));
  const session = await c.getSession();
  const r = await c.call('Email/set', {
    accountId: aid,
    create: {
      s: {
        mailboxIds: { [folderId]: true },
        keywords: { $seen: true },
        from: [{ name: null, email: session.username }],
        subject: SYNCED_SUBJECT,
        bodyValues: { t: { value: SYNCED_BODY } },
        textBody: [{ partId: 't', type: 'text/plain' }],
        attachments: [{ blobId: blob.blobId, type: 'application/json', name: SYNCED_ATTACHMENT, disposition: 'attachment' }],
      },
    },
    // nouveau message puis suppression de l'ancien, dans le même Email/set
    destroy: remote.emailIds,
  });
  const id = r.created?.s?.id as string | undefined;
  if (!id) throw new Error(r.notCreated?.s?.description ?? r.notCreated?.s?.type ?? 'email');
  lastSeen.set(accountId, id);
  await db.kv.put({ key: `synced:${accountId}`, value: doc });
  void queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
}

async function flush(accountId: string): Promise<void> {
  const values = pending.get(accountId);
  if (!values) return;
  if (isOffline()) {
    window.addEventListener('online', () => scheduleSyncedWrite(accountId, {}), { once: true });
    return;
  }
  pending.delete(accountId);
  const { at, ...rest } = values;
  try {
    const remote = await readRemote(accountId);
    const doc = patchSynced(remote.doc ?? EMPTY_SYNCED, rest, at ?? new Date().toISOString());
    await writeRemote(accountId, doc, remote);
  } catch (e) {
    // échec : on garde les valeurs pour la prochaine tentative (au retour du réseau)
    pending.set(accountId, { ...values, ...(pending.get(accountId) ?? {}) });
    console.warn('syncedSettings: write failed', e);
    window.addEventListener('online', () => scheduleSyncedWrite(accountId, {}), { once: true });
  }
}

/** Enregistre des préférences de boîte à synchroniser (écritures regroupées sur 1 s). */
export function scheduleSyncedWrite(accountId: string, values: SyncedValues): void {
  const prev = pending.get(accountId) ?? {};
  pending.set(accountId, { ...prev, ...values, at: new Date().toISOString() });
  clearTimeout(timers.get(accountId));
  timers.set(
    accountId,
    setTimeout(() => {
      timers.delete(accountId);
      void flush(accountId);
    }, WRITE_DELAY_MS),
  );
}

// ------------------------------------------------------------------ lecture et application

/** Valeurs locales actuelles d'une boîte (migration v3 : table `accounts` + `kv` `mbset:<id>`). */
async function localValues(accountId: string): Promise<SyncedValues> {
  const row = await db.accounts.get(accountId);
  const mb = ((await db.kv.get(`mbset:${accountId}`))?.value ?? {}) as { folderColors?: Record<string, string>; defaultIdentityId?: string | null };
  const out: SyncedValues = {};
  if (row?.displayName) out.displayName = row.displayName;
  if (row?.color) out.color = row.color;
  if (mb.folderColors && Object.keys(mb.folderColors).length) out.folderColors = mb.folderColors;
  if (mb.defaultIdentityId) out.defaultIdentityId = mb.defaultIdentityId;
  return out;
}

type Applier = (accountId: string, values: SyncedValues) => Promise<void>;
let applier: Applier | null = null;
/** Branché par le store des préférences (évite une dépendance circulaire). */
export function setSyncedApplier(fn: Applier): void {
  applier = fn;
}

const pulling = new Set<string>();

/**
 * Relit les réglages de la boîte et les applique localement. Sans dossier caché : migration, les
 * préférences locales de la v3 sont envoyées. Les erreurs sont avalées (nouvel essai au prochain changement).
 */
export async function pullSyncedSettings(accountId: string): Promise<void> {
  if (pulling.has(accountId) || isOffline()) return;
  pulling.add(accountId);
  try {
    const remote = await readRemote(accountId);
    if (!remote.doc) {
      if (!remote.folderId || !remote.emailIds.length) {
        const local = await localValues(accountId);
        if (Object.keys(local).length) scheduleSyncedWrite(accountId, local);
      }
      return;
    }
    const newest = remote.emailIds[0];
    if (newest && lastSeen.get(accountId) === newest && remote.emailIds.length === 1) return;
    if (newest) lastSeen.set(accountId, newest);
    await db.kv.put({ key: `synced:${accountId}`, value: remote.doc });
    if (applier) await applier(accountId, syncedValues(remote.doc));
    // plusieurs messages : on les réunit en un seul
    if (remote.emailIds.length > 1) await writeRemote(accountId, remote.doc, remote);
  } catch (e) {
    console.warn('syncedSettings: read failed', e);
  } finally {
    pulling.delete(accountId);
  }
}
