/**
 * Dossiers : imbriquer et déplacer, abonnements, ordre, vider la corbeille et les indésirables.
 * Les modifications de propriétés passent par `runCalls` (file `outbox`, type `mailbox`, rejouée hors ligne).
 */
import { CAP, type CoreCapability, type Mailbox } from '@voxel/jmap';
import i18n from '@/i18n';
import { invalidateAccount } from './actions';
import { jmap } from './jmap';
import { getMailboxData, mailboxLabel, SYSTEM_ROLES, type MailboxData } from './mail';
import { runCalls } from './outbox';
import { queryClient } from './queryClient';

type Patch = Partial<Pick<Mailbox, 'parentId' | 'isSubscribed' | 'sortOrder'>>;

/** Dossier de rôle (Réception, Envoyés…) : ni déplaçable ni imbriquable. */
export function isRoleMailbox(m: Pick<Mailbox, 'role'>): boolean {
  return !!m.role && (SYSTEM_ROLES as string[]).includes(m.role);
}

/** Descendants d'un dossier (pour refuser de le déplacer dans lui-même). */
export function descendantsOf(list: Mailbox[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const m of list) if (m.parentId === pid && !out.has(m.id)) {
      out.add(m.id);
      walk(m.id);
    }
  };
  walk(id);
  return out;
}

/** Cibles possibles pour « Déplacer dans… » : ni lui-même, ni ses descendants, ni son parent actuel. */
export function moveTargets(data: MailboxData, id: string): Mailbox[] {
  const self = data.mailboxes.find((m) => m.id === id);
  const banned = descendantsOf(data.mailboxes, id);
  banned.add(id);
  return data.mailboxes.filter((m) => !banned.has(m.id) && m.id !== self?.parentId && m.myRights?.mayCreateChild !== false);
}

/** Modifie des propriétés de dossiers (affichage immédiat, puis serveur ou file hors ligne). */
export async function patchMailboxes(accountId: string, patches: Record<string, Patch>, label: string): Promise<void> {
  const data = await getMailboxData(accountId);
  const prev = queryClient.getQueryData<MailboxData>(['mailboxes', accountId]);
  queryClient.setQueryData<MailboxData>(['mailboxes', accountId], (old) =>
    old ? { ...old, mailboxes: old.mailboxes.map((m) => (patches[m.id] ? { ...m, ...patches[m.id] } : m)) } : old,
  );
  try {
    const r = await runCalls(accountId, [['Mailbox/set', { accountId: data.jmapAccountId, update: patches }]], { kind: 'mailbox', label });
    if (!r.queued) invalidateAccount(accountId, 300);
  } catch (e) {
    if (prev) queryClient.setQueryData(['mailboxes', accountId], prev);
    throw e;
  }
}

export async function moveMailboxTo(accountId: string, id: string, parentId: string | null): Promise<void> {
  const data = await getMailboxData(accountId);
  const m = data.mailboxes.find((x) => x.id === id);
  if (!m || isRoleMailbox(m)) throw new Error(i18n.t('settings:folders.roleLocked'));
  if (parentId && (parentId === id || descendantsOf(data.mailboxes, id).has(parentId))) throw new Error(i18n.t('settings:folders.cycle'));
  await patchMailboxes(accountId, { [id]: { parentId } }, i18n.t('settings:folders.movedLabel', { name: m.name }));
}

export function setSubscribed(accountId: string, id: string, isSubscribed: boolean): Promise<void> {
  return patchMailboxes(accountId, { [id]: { isSubscribed } }, i18n.t('settings:folders.subscribeLabel'));
}

/** Nouvel ordre des frères (`sortOrder` 10, 20, 30…). */
export function reorderSiblings(accountId: string, orderedIds: string[]): Promise<void> {
  const patches: Record<string, Patch> = {};
  orderedIds.forEach((id, i) => (patches[id] = { sortOrder: (i + 1) * 10 }));
  return patchMailboxes(accountId, patches, i18n.t('settings:folders.reorderLabel'));
}

/** Tri des dossiers : rôles d'abord, puis `sortOrder`, puis nom (ordre alphabétique si le serveur ignore l'ordre). */
export function compareMailboxes(a: Mailbox, b: Mailbox): number {
  const ra = isRoleMailbox(a) ? 0 : 1;
  const rb = isRoleMailbox(b) ? 0 : 1;
  if (ra !== rb) return ra - rb;
  // dossiers de rôle : même ordre que la barre latérale (Réception, Suivis, Brouillons…)
  if (ra === 0) return (SYSTEM_ROLES as string[]).indexOf(a.role!) - (SYSTEM_ROLES as string[]).indexOf(b.role!);
  if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  return mailboxLabel(a).localeCompare(mailboxLabel(b));
}

/**
 * Vide un dossier (corbeille, indésirables) : `Email/query` + `Email/set destroy` par lots de `maxObjectsInSet`,
 * avec progression ; `signal` interrompt entre deux lots.
 */
export async function emptyMailbox(
  accountId: string,
  mailboxId: string,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<number> {
  const data = await getMailboxData(accountId);
  const c = jmap(accountId);
  const aid = data.jmapAccountId;
  const session = await c.getSession();
  const core = session.capabilities[CAP.core] as CoreCapability | undefined;
  const batch = Math.max(1, Math.min(core?.maxObjectsInSet ?? 500, core?.maxObjectsInGet ?? 500, 500));
  let done = 0;
  let total = data.mailboxes.find((m) => m.id === mailboxId)?.totalEmails ?? 0;
  try {
    for (let guard = 0; guard < 10_000; guard++) {
      if (opts.signal?.aborted) break;
      const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: mailboxId }, limit: batch, calculateTotal: true });
      if (guard === 0 && typeof q.total === 'number') total = q.total;
      if (!q.ids.length) break;
      const r = await c.call('Email/set', { accountId: aid, destroy: q.ids });
      const n = r.destroyed?.length ?? 0;
      done += n;
      opts.onProgress?.(done, Math.max(total, done));
      if (n === 0) throw new Error(Object.values(r.notDestroyed ?? {})[0]?.description ?? 'destroy');
    }
  } finally {
    invalidateAccount(accountId, 0);
  }
  return done;
}
