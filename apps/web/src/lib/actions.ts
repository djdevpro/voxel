import type { InfiniteData } from '@tanstack/react-query';
import { toast } from 'sonner';
import { descendantIds, keywordPatch, movePatch, pointerEscape, type Mailbox, type PatchObject } from '@voxel/jmap';
import { queryClient } from './queryClient';
import { getMailboxData, roleId, type MailboxData, type ThreadData, type ThreadItem, type ThreadsPage } from './mail';
import { runCalls, isOffline } from './outbox';
import { jmap } from './jmap';
import { useUi, type MailboxSel, type SystemRole } from '@/store/ui';
import { goView } from '@/nav/nav';
import i18n from '@/i18n';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

// ------------------------------------------------------------------ cache

export function updateLists(fn: (items: ThreadItem[]) => ThreadItem[]) {
  queryClient.setQueriesData<InfiniteData<ThreadsPage>>({ queryKey: ['threads'] }, (old) =>
    old ? { ...old, pages: old.pages.map((p) => ({ ...p, items: fn(p.items) })) } : old,
  );
}

const invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Recharge (avec anti-rebond) tout ce qui dépend d'un compte. */
export function invalidateAccount(accountId: string, delay = 350) {
  clearTimeout(invalidateTimers.get(accountId));
  invalidateTimers.set(
    accountId,
    setTimeout(() => {
      invalidateTimers.delete(accountId);
      void queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
      void queryClient.invalidateQueries({
        queryKey: ['threads'],
        predicate: (q) => {
          const k = q.queryKey[1] as { accounts?: string[] } | undefined;
          return !k?.accounts || k.accounts.includes(accountId);
        },
      });
      void queryClient.invalidateQueries({ queryKey: ['thread', accountId] });
      // quota relu après chaque changement d'Email
      void queryClient.invalidateQueries({ queryKey: ['quota', accountId] });
    }, delay),
  );
}

/** Retire des fils de la liste avec l'animation de sortie (hauteur → 0 + fondu). */
export function removeWithExit(keys: string[]) {
  const ui = useUi.getState();
  ui.markLeaving(keys);
  const set = new Set(keys);
  setTimeout(() => {
    updateLists((items) => items.filter((i) => !set.has(i.key)));
    useUi.getState().unmarkLeaving(keys);
    const sel = new Set(useUi.getState().selected);
    let changed = false;
    keys.forEach((k) => {
      if (sel.delete(k)) changed = true;
    });
    if (changed) useUi.getState().setSelected(sel);
  }, 210);
}

function groupByAccount(items: ThreadItem[]): Map<string, ThreadItem[]> {
  const m = new Map<string, ThreadItem[]>();
  for (const i of items) {
    const l = m.get(i.accountId) ?? [];
    l.push(i);
    m.set(i.accountId, l);
  }
  return m;
}

/** `titleKey` : clé i18n du titre de l'erreur (ex. `mail:errors.move`). */
function reportError(e: unknown, titleKey: string) {
  toast.error(t(titleKey), { description: (e as Error)?.message });
}

function queuedNote(queued: boolean) {
  return queued ? ` · ${t('mail:toasts.pendingSync')}` : '';
}

// ------------------------------------------------------------------ dossier Archives

/** Nom du dossier Archives créé sur le serveur : celui de la langue courante (affiché ensuite via son rôle). */
const ARCHIVE_NAME = () => t('mail:roles.archive');

async function ensureRole(accountId: string, role: 'archive'): Promise<string> {
  const data = await getMailboxData(accountId);
  const existing = roleId(data, role);
  if (existing) return existing;
  if (isOffline()) throw new Error(t('mail:errors.archiveOffline'));
  const r = await jmap(accountId).call('Mailbox/set', {
    accountId: data.jmapAccountId,
    create: { a: { name: ARCHIVE_NAME(), role: 'archive', parentId: null, isSubscribed: true } as Partial<Mailbox> },
  });
  const id = r.created?.a?.id;
  if (!id) {
    // certains serveurs refusent le rôle : on crée un simple dossier
    const r2 = await jmap(accountId).call('Mailbox/set', { accountId: data.jmapAccountId, create: { a: { name: ARCHIVE_NAME(), parentId: null } } });
    const id2 = r2.created?.a?.id;
    if (!id2) throw new Error(r.notCreated?.a?.description ?? t('mail:errors.archiveCreate'));
    await queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
    return id2;
  }
  await queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
  return id;
}

// ------------------------------------------------------------------ déplacements

type Target = { role: SystemRole } | { mailboxId: string };

interface MoveOptions {
  label: string;
  undo?: boolean;
  /** remplace entièrement mailboxIds (corbeille, spam) au lieu de retirer le dossier courant */
  replace?: boolean;
  extraPatch?: PatchObject;
}

async function resolveTarget(accountId: string, data: MailboxData, t: Target): Promise<string | undefined> {
  if ('mailboxId' in t) return t.mailboxId;
  if (t.role === 'archive') return ensureRole(accountId, 'archive');
  return roleId(data, t.role);
}

export async function moveThreads(items: ThreadItem[], target: Target, opts: MoveOptions) {
  if (!items.length) return;
  removeWithExit(items.map((i) => i.key));
  const undoCalls: Array<{ accountId: string; update: Record<string, PatchObject>; jmapAccountId: string }> = [];
  let anyQueued = false;
  try {
    for (const [accountId, list] of groupByAccount(items)) {
      const data = await getMailboxData(accountId);
      const to = await resolveTarget(accountId, data, target);
      if (!to) throw new Error(t('mail:errors.destinationNotFound'));
      const inbox = roleId(data, 'inbox');
      const update: Record<string, PatchObject> = {};
      const undo: Record<string, PatchObject> = {};
      for (const it of list) {
        const ids = opts.replace ? it.emails.map((e) => e.id) : it.contextEmailIds;
        for (const id of ids) {
          const meta = it.emails.find((e) => e.id === id);
          const from = it.contextMailboxId ?? (meta && inbox && meta.mailboxIds[inbox] ? inbox : null);
          update[id] = { ...(opts.replace ? { mailboxIds: { [to]: true } } : movePatch(from, to)), ...(opts.extraPatch ?? {}) };
          if (meta) undo[id] = { mailboxIds: meta.mailboxIds };
        }
      }
      const r = await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, update }]], { kind: 'move', label: opts.label });
      anyQueued ||= r.queued;
      undoCalls.push({ accountId, update: undo, jmapAccountId: data.jmapAccountId });
      invalidateAccount(accountId, 600);
    }
    const msg = `${opts.label}${queuedNote(anyQueued)}`;
    // lien « Voir » vers le dossier de destination (une seule boîte concernée)
    const accs = [...groupByAccount(items).keys()];
    const dest: MailboxSel = 'mailboxId' in target ? { kind: 'id', id: target.mailboxId } : { kind: 'role', role: target.role };
    const view =
      accs.length === 1 && !(dest.kind === 'role' && dest.role === 'inbox')
        ? { label: t('mail:toasts.view'), onClick: () => goView({ accountId: accs[0]!, mailbox: dest }) }
        : undefined;
    if (opts.undo !== false) {
      toast(msg, {
        duration: 8000,
        cancel: view,
        action: {
          label: t('common:actions.undo'),
          onClick: async () => {
            try {
              for (const u of undoCalls) {
                await runCalls(u.accountId, [['Email/set', { accountId: u.jmapAccountId, update: u.update }]], { kind: 'move', label: t('mail:outbox.undo') });
                invalidateAccount(u.accountId, 0);
              }
            } catch (e) {
              reportError(e, 'mail:errors.undo');
            }
          },
        },
      });
    } else toast(msg, { cancel: view });
  } catch (e) {
    reportError(e, 'mail:errors.move');
    for (const a of groupByAccount(items).keys()) invalidateAccount(a, 0);
  }
}

export function archiveThreads(items: ThreadItem[]) {
  return moveThreads(items, { role: 'archive' }, { label: t('mail:toasts.archived', { count: items.length }) });
}

export function trashThreads(items: ThreadItem[]) {
  return moveThreads(items, { role: 'trash' }, {
    label: t('mail:toasts.trashed', { count: items.length }),
    replace: true,
  });
}

export function spamThreads(items: ThreadItem[], notSpam = false) {
  if (notSpam)
    return moveThreads(items, { role: 'inbox' }, { label: t('mail:toasts.movedToInbox'), replace: true, extraPatch: { 'keywords/$junk': null, 'keywords/$notjunk': true } });
  return moveThreads(items, { role: 'junk' }, {
    label: t('mail:toasts.spammed', { count: items.length }),
    replace: true,
    extraPatch: { 'keywords/$junk': true, 'keywords/$notjunk': null },
  });
}

export function moveToMailbox(items: ThreadItem[], mailboxId: string, name: string) {
  return moveThreads(items, { mailboxId }, { label: t('mail:toasts.movedTo', { name }) });
}

/** Suppression définitive (depuis la corbeille ou le spam). */
export async function destroyThreads(items: ThreadItem[]) {
  if (!items.length) return;
  removeWithExit(items.map((i) => i.key));
  try {
    for (const [accountId, list] of groupByAccount(items)) {
      const data = await getMailboxData(accountId);
      const ids = list.flatMap((i) => i.emails.map((e) => e.id));
      await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, destroy: ids }]], { kind: 'delete', label: t('mail:outbox.destroy') });
      invalidateAccount(accountId, 600);
    }
    toast(t('mail:toasts.destroyed', { count: items.length }));
  } catch (e) {
    reportError(e, 'mail:errors.delete');
  }
}

// ------------------------------------------------------------------ mots-clés

export async function setSeen(items: ThreadItem[], seen: boolean, silent = false) {
  const targets = items.filter((i) => i.unread === seen || i.emails.some((e) => !!e.keywords.$seen !== seen));
  if (!targets.length) return;
  const keys = new Set(targets.map((i) => i.key));
  updateLists((list) =>
    list.map((i) =>
      keys.has(i.key)
        ? { ...i, unread: !seen, emails: i.emails.map((e) => ({ ...e, keywords: { ...e.keywords, $seen: seen } })) }
        : i,
    ),
  );
  bumpUnreadCounts(targets, seen ? -1 : 1);
  try {
    let queued = false;
    for (const [accountId, list] of groupByAccount(targets)) {
      const data = await getMailboxData(accountId);
      const update: Record<string, PatchObject> = {};
      for (const it of list) for (const e of it.emails) if (!!e.keywords.$seen !== seen) update[e.id] = keywordPatch('$seen', seen);
      if (!Object.keys(update).length) continue;
      const r = await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, update }]], {
        kind: 'keywords',
        label: seen ? t('mail:actions.markRead') : t('mail:actions.markUnread'),
      });
      queued ||= r.queued;
      invalidateAccount(accountId, 1500);
    }
    if (!silent) toast(`${seen ? t('mail:toasts.markedRead') : t('mail:toasts.markedUnread')}${queuedNote(queued)}`);
  } catch (e) {
    reportError(e, 'mail:errors.update');
  }
}

/** Ajuste les compteurs non lus localement (les vrais compteurs suivent via push). */
function bumpUnreadCounts(items: ThreadItem[], delta: number) {
  for (const [accountId, list] of groupByAccount(items)) {
    queryClient.setQueryData<MailboxData>(['mailboxes', accountId], (old) => {
      if (!old) return old;
      const counts = new Map<string, number>();
      for (const it of list) {
        const affected = it.emails.filter((e) => (delta < 0 ? !e.keywords.$seen : !!e.keywords.$seen));
        const mbs = new Set<string>();
        for (const e of affected) Object.keys(e.mailboxIds).forEach((m) => mbs.add(m));
        mbs.forEach((m) => counts.set(m, (counts.get(m) ?? 0) + 1));
      }
      return {
        ...old,
        mailboxes: old.mailboxes.map((m) =>
          counts.has(m.id)
            ? { ...m, unreadThreads: Math.max(0, m.unreadThreads + delta * counts.get(m.id)!), unreadEmails: Math.max(0, m.unreadEmails + delta * counts.get(m.id)!) }
            : m,
        ),
      };
    });
  }
}

export async function setFlagged(items: ThreadItem[], flagged: boolean) {
  if (!items.length) return;
  const keys = new Set(items.map((i) => i.key));
  updateLists((list) => list.map((i) => (keys.has(i.key) ? { ...i, flagged } : i)));
  // conversation ouverte : même mise à jour optimiste (sinon le lecteur attend la synchro, hors ligne compris)
  for (const it of items) {
    queryClient.setQueryData<ThreadData>(['thread', it.accountId, it.threadId], (old) =>
      old
        ? {
            ...old,
            emails: old.emails.map((e) => {
              if (flagged ? e.id !== it.emailId : !e.keywords.$flagged) return e;
              const keywords = { ...e.keywords };
              if (flagged) keywords.$flagged = true;
              else delete keywords.$flagged;
              return { ...e, keywords };
            }),
          }
        : old,
    );
  }
  try {
    let queued = false;
    for (const [accountId, list] of groupByAccount(items)) {
      const data = await getMailboxData(accountId);
      const update: Record<string, PatchObject> = {};
      for (const it of list) {
        if (flagged) update[it.emailId] = keywordPatch('$flagged', true);
        else for (const e of it.emails) if (e.keywords.$flagged || e.id === it.emailId) update[e.id] = keywordPatch('$flagged', false);
      }
      const r = await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, update }]], {
        kind: 'keywords',
        label: flagged ? t('mail:actions.flag') : t('mail:actions.unflag'),
      });
      queued ||= r.queued;
      invalidateAccount(accountId, 1500);
    }
    if (queued) toast(t('mail:toasts.changePending'));
  } catch (e) {
    reportError(e, 'mail:errors.update');
  }
}

/** Marque des emails précis comme lus (ouverture d'un fil). */
export async function markEmailsSeen(accountId: string, emailIds: string[]) {
  if (!emailIds.length) return;
  const data = await getMailboxData(accountId);
  const update: Record<string, PatchObject> = {};
  for (const id of emailIds) update[id] = keywordPatch('$seen', true);
  updateLists((list) =>
    list.map((i) =>
      i.accountId === accountId && i.emails.some((e) => emailIds.includes(e.id))
        ? {
            ...i,
            emails: i.emails.map((e) => (emailIds.includes(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e)),
            unread: i.emails.some((e) => !emailIds.includes(e.id) && !e.keywords.$seen),
          }
        : i,
    ),
  );
  try {
    await runCalls(accountId, [['Email/set', { accountId: data.jmapAccountId, update }]], { kind: 'keywords', label: t('mail:outbox.read') });
    invalidateAccount(accountId, 1200);
  } catch {
    /* silencieux */
  }
}

// ------------------------------------------------------------------ dossiers

export async function createMailbox(accountId: string, name: string, parentId: string | null) {
  const data = await getMailboxData(accountId);
  const r = await jmap(accountId).call('Mailbox/set', {
    accountId: data.jmapAccountId,
    create: { n: { name, parentId, isSubscribed: true } },
  });
  const err = r.notCreated?.n;
  if (err) throw new Error(err.description ?? err.type);
  await queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
  return r.created?.n?.id;
}

export async function renameMailbox(accountId: string, id: string, name: string) {
  const data = await getMailboxData(accountId);
  queryClient.setQueryData<MailboxData>(['mailboxes', accountId], (old) =>
    old ? { ...old, mailboxes: old.mailboxes.map((m) => (m.id === id ? { ...m, name } : m)) } : old,
  );
  const r = await jmap(accountId).call('Mailbox/set', { accountId: data.jmapAccountId, update: { [id]: { name } } });
  const err = r.notUpdated?.[id];
  if (err) {
    void queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
    throw new Error(err.description ?? err.type);
  }
}

export async function moveMailbox(accountId: string, id: string, parentId: string | null) {
  const data = await getMailboxData(accountId);
  const r = await jmap(accountId).call('Mailbox/set', { accountId: data.jmapAccountId, update: { [id]: { parentId } } });
  const err = r.notUpdated?.[id];
  if (err) throw new Error(err.description ?? err.type);
  await queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
}

/** Supprime un dossier et ses sous-dossiers ; les messages partent dans la corbeille. */
export async function deleteMailbox(accountId: string, id: string) {
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const trash = roleId(data, 'trash');
  const all = [id, ...descendantIds(data.mailboxes, id)];
  const c = jmap(accountId);
  if (trash) {
    // déplace les messages vers la corbeille
    for (const mb of all) {
      for (let pos = 0; pos < 10_000; ) {
        const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: mb }, position: 0, limit: 500 });
        if (!q.ids.length) break;
        const update: Record<string, PatchObject> = {};
        for (const eid of q.ids) update[eid] = { [`mailboxIds/${pointerEscape(mb)}`]: null, [`mailboxIds/${pointerEscape(trash)}`]: true };
        await c.call('Email/set', { accountId: aid, update });
        pos += q.ids.length;
        if (q.ids.length < 500) break;
      }
    }
  }
  // du plus profond au plus haut
  const depth = (mid: string): number => {
    let d = 0;
    let cur = data.mailboxes.find((m) => m.id === mid);
    while (cur?.parentId) {
      d++;
      cur = data.mailboxes.find((m) => m.id === cur!.parentId);
    }
    return d;
  };
  const ordered = all.slice().sort((a, b) => depth(b) - depth(a));
  const r = await c.call('Mailbox/set', { accountId: aid, destroy: ordered, onDestroyRemoveEmails: true });
  const err = r.notDestroyed && Object.values(r.notDestroyed)[0];
  await queryClient.invalidateQueries({ queryKey: ['mailboxes', accountId] });
  if (err) throw new Error(err.description ?? err.type);
}

export async function markMailboxRead(accountId: string, mailboxId: string) {
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const c = jmap(accountId);
  const q = await c.call('Email/query', { accountId: aid, filter: { inMailbox: mailboxId, notKeyword: '$seen' }, limit: 1000 });
  if (!q.ids.length) return 0;
  const update: Record<string, PatchObject> = {};
  for (const id of q.ids) update[id] = keywordPatch('$seen', true);
  await runCalls(accountId, [['Email/set', { accountId: aid, update }]], { kind: 'keywords', label: t('mail:actions.markAllRead') });
  updateLists((list) =>
    list.map((i) => (i.accountId === accountId && i.contextMailboxId === mailboxId ? { ...i, unread: false } : i)),
  );
  invalidateAccount(accountId, 0);
  return q.ids.length;
}
