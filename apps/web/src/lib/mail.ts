import {
  EMAIL_FULL_PROPERTIES,
  EMAIL_LIST_PROPERTIES,
  findByRole,
  priorityOf,
  type Priority,
  type Email,
  type EmailAddress,
  type EmailFilterCondition,
  type Filter,
  type Identity,
  type Mailbox,
  type VacationResponse,
} from '@voxel/jmap';
import { queryOptions } from '@tanstack/react-query';
import { listAccounts } from './accounts';
import { jmap } from './jmap';
import { rememberContacts } from './db';
import { queryClient } from './queryClient';
import { searchConditions } from './search';
import i18n from '@/i18n';
import { isSyncedSettingsFolder } from './syncedSettings';
import type { MailboxSel, QuickFilters, SearchChip, SystemRole, View } from '@/store/ui';

// ------------------------------------------------------------------ libellés

/** Libellé traduit d'un dossier système (rôle JMAP). Appeler pendant le rendu d'un composant qui utilise useTranslation. */
export function roleLabel(role: SystemRole): string {
  return i18n.t(`mail:roles.${role}`);
}

export const SYSTEM_ROLES: SystemRole[] = ['inbox', 'flagged', 'drafts', 'sent', 'scheduled', 'archive', 'junk', 'trash'];

const ALL_ROLES = new Set<string>(SYSTEM_ROLES);

/** Nom affiché d'un dossier : traduit pour les dossiers système, nom réel pour les dossiers perso. */
export function mailboxLabel(m: Mailbox): string {
  if (m.role && ALL_ROLES.has(m.role)) return roleLabel(m.role as SystemRole);
  return m.name;
}

// ------------------------------------------------------------------ comptes

export const accountsQuery = queryOptions({
  queryKey: ['accounts'],
  queryFn: async () => {
    const list = await listAccounts(); // v3 : comptes de l'appareil (Dexie), sans requête réseau
    return list.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  },
  staleTime: 5 * 60_000,
  networkMode: 'always',
});

// ------------------------------------------------------------------ dossiers

export interface MailboxData {
  jmapAccountId: string;
  mailboxes: Mailbox[];
  state: string;
  canSchedule: boolean;
  /**
   * Dossier caché des réglages synchronisés : retiré de `mailboxes`, donc jamais affiché,
   * compté ni proposé comme cible ; exclu des recherches et des vues unifiées par `buildFilter`.
   */
  hiddenId?: string | null;
}

export async function fetchMailboxes(accountId: string): Promise<MailboxData> {
  const c = jmap(accountId);
  const aid = await c.accountId();
  const r = await c.call('Mailbox/get', { accountId: aid, ids: null });
  const sub = c.accountCapability<{ maxDelayedSend?: number }>('urn:ietf:params:jmap:submission', aid);
  const hidden = r.list.find(isSyncedSettingsFolder);
  return {
    jmapAccountId: aid,
    mailboxes: hidden ? r.list.filter((m) => m !== hidden) : r.list,
    state: r.state,
    canSchedule: (sub?.maxDelayedSend ?? 0) > 0,
    hiddenId: hidden?.id ?? null,
  };
}

export const mailboxesQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['mailboxes', accountId],
    queryFn: () => fetchMailboxes(accountId),
    staleTime: 60_000,
  });

export async function getMailboxData(accountId: string): Promise<MailboxData> {
  const cached = queryClient.getQueryData<MailboxData>(['mailboxes', accountId]);
  if (cached) return cached;
  return queryClient.fetchQuery(mailboxesQuery(accountId));
}

export function roleId(data: MailboxData | undefined, role: SystemRole): string | undefined {
  if (!data) return undefined;
  return findByRole(data.mailboxes, role)?.id;
}

/** Dossier affiché par la vue pour ce compte (exclu des cibles de « Déplacer vers »). */
export function viewMailboxId(data: MailboxData | undefined, view: View, accountId: string): string | undefined {
  if (view.mailbox.kind === 'role') return roleId(data, view.mailbox.role);
  return view.accountId === accountId ? view.mailbox.id : undefined;
}

// ------------------------------------------------------------------ liste des fils

export interface ThreadEmailMeta {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: EmailAddress[] | null;
  receivedAt: string;
}

export interface ThreadItem {
  key: string;
  accountId: string;
  threadId: string;
  emailId: string;
  subject: string;
  preview: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  senders: EmailAddress[];
  count: number;
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  draft: boolean;
  /** priorité annoncée par l'expéditeur */
  priority?: Priority;
  receivedAt: string;
  /** emails visibles du fil (hors corbeille/spam, sauf dans ces dossiers) */
  emails: ThreadEmailMeta[];
  /** emails du fil présents dans le dossier courant (pour « déplacer depuis ») */
  contextEmailIds: string[];
  contextMailboxId: string | null;
}

export interface ListSpec {
  mailbox: MailboxSel;
  chips: SearchChip[];
  text: string;
  quick: QuickFilters;
  sortAsc: boolean;
}

export interface AccountPage {
  items: ThreadItem[];
  total: number;
  next: number | null;
}

/** Filtre JMAP + dossier de contexte pour une vue. `null` = dossier absent (liste vide). */
export function buildFilter(
  data: MailboxData,
  spec: ListSpec,
): { filter: Filter<EmailFilterCondition>; contextMailboxId: string | null; inTrash: boolean } | null {
  const trash = roleId(data, 'trash');
  const junk = roleId(data, 'junk');
  // le dossier caché des réglages n'apparaît jamais dans une recherche ni une vue transversale
  const notTrashJunk = [trash, junk, data.hiddenId].filter(Boolean) as string[];
  const searching = spec.chips.length > 0 || spec.text.trim().length > 0;
  const { conditions, inRole } = searchConditions(spec.chips, spec.text, spec.quick, { roleId: (r) => roleId(data, r) });

  let base: EmailFilterCondition | null = null;
  let contextMailboxId: string | null = null;
  let inTrash = false;

  if (searching && !inRole) {
    base = notTrashJunk.length ? { inMailboxOtherThan: notTrashJunk } : {};
  } else {
    const sel: MailboxSel = inRole ? { kind: 'role', role: inRole } : spec.mailbox;
    if (sel.kind === 'role' && sel.role === 'flagged') {
      base = { hasKeyword: '$flagged', ...(notTrashJunk.length ? { inMailboxOtherThan: notTrashJunk } : {}) };
    } else {
      const id = sel.kind === 'id' ? sel.id : roleId(data, sel.role);
      if (!id) return null;
      if (sel.kind === 'id' && !data.mailboxes.some((m) => m.id === id)) return null;
      base = { inMailbox: id };
      contextMailboxId = id;
      inTrash = id === trash || id === junk;
    }
  }
  const all = [base, ...conditions].filter((c): c is EmailFilterCondition => !!c && Object.keys(c).length > 0);
  const filter: Filter<EmailFilterCondition> = all.length === 1 ? all[0]! : { operator: 'AND', conditions: all };
  return { filter, contextMailboxId, inTrash };
}

const META_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt'];

export async function fetchThreadPage(accountId: string, spec: ListSpec, position: number, limit: number): Promise<AccountPage> {
  const data = await getMailboxData(accountId);
  const built = buildFilter(data, spec);
  if (!built) return { items: [], total: 0, next: null };
  const { filter, contextMailboxId, inTrash } = built;
  const trash = roleId(data, 'trash');
  const junk = roleId(data, 'junk');
  const aid = data.jmapAccountId;
  const c = jmap(accountId);
  const b = c.batch();
  const q = b.call('Email/query', {
    accountId: aid,
    filter,
    sort: [{ property: 'receivedAt', isAscending: spec.sortAsc }],
    collapseThreads: true,
    position,
    limit,
    calculateTotal: true,
  });
  const g = b.call('Email/get', { accountId: aid, '#ids': q.ref('/ids'), properties: [...EMAIL_LIST_PROPERTIES] });
  const t = b.call('Thread/get', { accountId: aid, '#ids': g.ref('/list/*/threadId') });
  const m = b.call('Email/get', { accountId: aid, '#ids': t.ref('/list/*/emailIds'), properties: META_PROPS });
  await b.send();
  const query = q.result;
  const heads = g.result.list;
  const threads = new Map(t.result.list.map((x) => [x.id, x.emailIds]));
  const metas = new Map(m.result.list.map((x) => [x.id, x as unknown as ThreadEmailMeta]));

  const items: ThreadItem[] = [];
  const seen: EmailAddress[] = [];
  for (const id of query.ids) {
    const h = heads.find((x) => x.id === id);
    if (!h) continue;
    const ids = threads.get(h.threadId) ?? [h.id];
    const all = ids.map((eid) => metas.get(eid)).filter((x): x is ThreadEmailMeta => !!x);
    const visible = all.filter((e) => {
      const inBin = (trash && e.mailboxIds[trash]) || (junk && e.mailboxIds[junk]);
      return inTrash ? !!inBin : !inBin;
    });
    const list = visible.length ? visible : all.filter((e) => e.id === h.id);
    const senders: EmailAddress[] = [];
    for (const e of list) {
      const f = e.from?.[0];
      if (f && !senders.some((s) => s.email.toLowerCase() === f.email.toLowerCase())) senders.push(f);
    }
    const ctx = contextMailboxId ? list.filter((e) => e.mailboxIds[contextMailboxId]).map((e) => e.id) : list.map((e) => e.id);
    items.push({
      key: `${accountId}:${h.threadId}`,
      accountId,
      threadId: h.threadId,
      emailId: h.id,
      subject: h.subject ?? '',
      preview: h.preview ?? '',
      from: h.from?.[0] ?? null,
      to: [...(h.to ?? []), ...(h.cc ?? [])],
      senders,
      count: list.length,
      unread: list.some((e) => !e.keywords.$seen),
      flagged: list.some((e) => e.keywords.$flagged),
      hasAttachment: h.hasAttachment,
      draft: !!h.keywords.$draft,
      priority: priorityOf(h as unknown as Record<string, unknown>),
      receivedAt: h.receivedAt,
      emails: list,
      contextEmailIds: ctx.length ? ctx : [h.id],
      contextMailboxId,
    });
    if (h.from) seen.push(...h.from);
  }
  void rememberContacts(seen.map((a) => ({ email: a.email, name: a.name })), 0);
  const total = query.total ?? position + query.ids.length;
  const nextPos = position + query.ids.length;
  return { items, total, next: query.ids.length > 0 && nextPos < total ? nextPos : null };
}

export interface ThreadsPage {
  items: ThreadItem[];
  next: Record<string, number | null>;
  totals: Record<string, number>;
  errors: Record<string, string>;
}

export async function fetchUnifiedPage(accountIds: string[], spec: ListSpec, positions: Record<string, number | null>): Promise<ThreadsPage> {
  const limit = accountIds.length > 1 ? 30 : 50;
  const active = accountIds.filter((a) => positions[a] !== null && positions[a] !== undefined);
  const results = await Promise.allSettled(active.map((a) => fetchThreadPage(a, spec, positions[a] ?? 0, limit)));
  const next: Record<string, number | null> = {};
  const totals: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const items: ThreadItem[] = [];
  for (const a of accountIds) next[a] = null;
  results.forEach((r, i) => {
    const a = active[i]!;
    if (r.status === 'fulfilled') {
      items.push(...r.value.items);
      next[a] = r.value.next;
      totals[a] = r.value.total;
    } else {
      errors[a] = (r.reason as Error)?.message ?? i18n.t('common:errors.generic');
      next[a] = null;
    }
  });
  if (active.length && Object.keys(errors).length === active.length) {
    throw results.find((r) => r.status === 'rejected')?.reason ?? new Error(i18n.t('mail:list.loadError'));
  }
  return { items, next, totals, errors };
}

// ------------------------------------------------------------------ fil complet

export interface ThreadData {
  emails: Email[];
}

export async function fetchThread(accountId: string, threadId: string): Promise<ThreadData> {
  const data = await getMailboxData(accountId);
  const aid = data.jmapAccountId;
  const c = jmap(accountId);
  const b = c.batch();
  const t = b.call('Thread/get', { accountId: aid, ids: [threadId] });
  const g = b.call('Email/get', {
    accountId: aid,
    '#ids': t.ref('/list/*/emailIds'),
    properties: [...EMAIL_FULL_PROPERTIES],
    fetchHTMLBodyValues: true,
    fetchTextBodyValues: true,
    maxBodyValueBytes: 1_500_000,
  });
  await b.send();
  const emails = g.result.list.slice().sort((x, y) => x.receivedAt.localeCompare(y.receivedAt));
  const addrs: EmailAddress[] = [];
  for (const e of emails) addrs.push(...(e.from ?? []), ...(e.to ?? []), ...(e.cc ?? []));
  void rememberContacts(addrs.map((a) => ({ email: a.email, name: a.name })), 0);
  return { emails };
}

export const threadQuery = (accountId: string, threadId: string) =>
  queryOptions({
    queryKey: ['thread', accountId, threadId],
    queryFn: () => fetchThread(accountId, threadId),
    staleTime: 60_000,
  });

// ------------------------------------------------------------------ identités

export async function fetchIdentities(accountId: string): Promise<Identity[]> {
  const data = await getMailboxData(accountId);
  const r = await jmap(accountId).call('Identity/get', { accountId: data.jmapAccountId, ids: null });
  return r.list.slice().sort((a, b) => a.email.localeCompare(b.email) || a.name.localeCompare(b.name));
}

export const identitiesQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['identities', accountId],
    queryFn: () => fetchIdentities(accountId),
    staleTime: 5 * 60_000,
  });

export function pickIdentity(identities: Identity[] | undefined, defaults: Record<string, string>, accountId: string, accountEmail?: string): Identity | undefined {
  if (!identities?.length) return undefined;
  const def = defaults[accountId];
  return identities.find((i) => i.id === def) ?? identities.find((i) => i.email.toLowerCase() === accountEmail?.toLowerCase()) ?? identities[0];
}

// ------------------------------------------------------------------ répondeur

export async function fetchVacation(accountId: string): Promise<VacationResponse | null> {
  const data = await getMailboxData(accountId);
  const r = await jmap(accountId).call('VacationResponse/get', { accountId: data.jmapAccountId, ids: ['singleton'] });
  return r.list[0] ?? null;
}

export async function saveVacation(accountId: string, patch: Partial<VacationResponse>) {
  const data = await getMailboxData(accountId);
  const r = await jmap(accountId).call('VacationResponse/set', { accountId: data.jmapAccountId, update: { singleton: patch } });
  const err = r.notUpdated?.singleton;
  if (err) throw new Error(err.description ?? err.type);
}

// ------------------------------------------------------------------ utilitaires corps

export function bodyHtml(e: Email): string | null {
  const parts = e.htmlBody ?? [];
  if (!parts.length || parts.every((p) => p.type !== 'text/html')) return null;
  let out = '';
  for (const p of parts) {
    if (!p.partId) continue;
    const v = e.bodyValues?.[p.partId]?.value;
    if (v == null) continue;
    if (p.type === 'text/html') out += v;
    else if (p.type === 'text/plain') out += `<pre style="white-space:pre-wrap;font:inherit">${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  }
  return out || null;
}

export function bodyText(e: Email): string {
  const parts = e.textBody ?? [];
  let out = '';
  for (const p of parts) {
    if (!p.partId) continue;
    const v = e.bodyValues?.[p.partId]?.value;
    if (v != null && p.type === 'text/plain') out += v;
  }
  return out;
}

export function unsubscribeUrls(e: Email): string[] {
  const v = e['header:List-Unsubscribe:asURLs'];
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
}
