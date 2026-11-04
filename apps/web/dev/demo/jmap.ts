/**
 * Moteur JMAP en mémoire du mode démo (RFC 8620, RFC 8621) : comptes, dossiers, e-mails, fils, identités,
 * blobs, états et méthodes. Seul ce que le webmail appelle est implémenté ; le reste répond `unknownMethod`.
 */
import { randomUUID } from 'node:crypto';
import type { SeedSet } from './seed.ts';

export interface Address {
  name: string | null;
  email: string;
}

export interface Blob {
  data: Buffer;
  type: string;
}

interface Attachment {
  partId: string;
  blobId: string;
  type: string;
  name: string | null;
  size: number;
  disposition: string;
  cid: string | null;
}

export interface StoredEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  receivedAt: string;
  sentAt: string | null;
  messageId: string[];
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: Address[] | null;
  from: Address[] | null;
  to: Address[] | null;
  cc: Address[] | null;
  bcc: Address[] | null;
  replyTo: Address[] | null;
  subject: string;
  text: string | null;
  html: string | null;
  attachments: Attachment[];
  /** En-têtes libres, nom en minuscules → valeur texte. */
  headers: Record<string, string>;
  unsubscribe: string | null;
}

export interface Mailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
  isSubscribed: boolean;
}

interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo: Address[] | null;
  bcc: Address[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

interface Submission {
  id: string;
  emailId: string;
  identityId: string;
  threadId: string;
  sendAt: string;
  undoStatus: 'final';
}

type StateType = 'Mailbox' | 'Email' | 'Thread' | 'Identity' | 'EmailSubmission';
type Json = Record<string, unknown>;
type Invocation = [string, Json, string];
type SetError = { type: string; description?: string; properties?: string[] };

export class MethodError extends Error {
  readonly type: string;
  constructor(type: string, description?: string) {
    super(description ?? type);
    this.type = type;
  }
}

// ------------------------------------------------------------------ utilitaires

/** Minuscules, sans accents : comparaisons de la recherche. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function bodyText(e: StoredEmail): string {
  return e.text ?? (e.html ? stripHtml(e.html) : '');
}

function previewOf(e: StoredEmail): string {
  return bodyText(e).replace(/\s+/g, ' ').trim().slice(0, 256);
}

function sizeOf(e: StoredEmail): number {
  let n = 600 + Buffer.byteLength(e.subject);
  if (e.text) n += Buffer.byteLength(e.text);
  if (e.html) n += Buffer.byteLength(e.html);
  for (const a of e.attachments) n += Math.ceil(a.size * 1.37);
  return n;
}

function utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function addrText(list: Address[] | null): string {
  return (list ?? []).map((a) => `${a.name ?? ''} ${a.email}`).join(' ');
}

/** Segment de JSON Pointer : `~1` → `/`, `~0` → `~`. */
function unescapePointer(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** JSON Pointer avec le joker `*` qui aplatit les tableaux (RFC 8620 §3.7). */
function evalPointer(value: unknown, parts: string[]): unknown {
  if (!parts.length) return value;
  const [head, ...rest] = parts as [string, ...string[]];
  if (head === '*') {
    if (!Array.isArray(value)) throw new MethodError('invalidResultReference');
    return value.flatMap((v) => {
      const r = evalPointer(v, rest);
      return Array.isArray(r) ? r : [r];
    });
  }
  if (Array.isArray(value)) {
    const i = Number(head);
    if (!Number.isInteger(i) || i < 0 || i >= value.length) throw new MethodError('invalidResultReference');
    return evalPointer(value[i], rest);
  }
  if (value && typeof value === 'object' && head in value) return evalPointer((value as Json)[head], rest);
  throw new MethodError('invalidResultReference');
}

function strArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

function addrList(v: unknown): Address[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((x): x is Json => !!x && typeof x === 'object' && typeof (x as Json).email === 'string')
    .map((x) => ({ name: typeof x.name === 'string' ? x.name : null, email: x.email as string }));
}

const DEFAULT_EMAIL_PROPS = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'messageId', 'inReplyTo', 'references',
  'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview', 'bodyValues',
  'textBody', 'htmlBody', 'attachments',
];

const MAILBOX_RIGHTS = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};

// ------------------------------------------------------------------ compte

export class DemoAccount {
  readonly id: string;
  readonly username: string;
  readonly mailboxes = new Map<string, Mailbox>();
  readonly emails = new Map<string, StoredEmail>();
  readonly blobs = new Map<string, Blob>();
  private readonly identities = new Map<string, Identity>();
  private readonly submissions = new Map<string, Submission>();
  private readonly states: Record<StateType, number> = { Mailbox: 1, Email: 1, Thread: 1, Identity: 1, EmailSubmission: 1 };
  private readonly tombs: Record<StateType, Set<string>> = {
    Mailbox: new Set(), Email: new Set(), Thread: new Set(), Identity: new Set(), EmailSubmission: new Set(),
  };
  private readonly listeners = new Set<(changed: Partial<Record<StateType, string>>) => void>();
  private seq = 0;

  constructor(username: string, seed: SeedSet) {
    this.username = username;
    this.id = `demo-${username.split('@')[0]!.replace(/[^a-z0-9._-]/gi, '')}`;
    this.identities.set('id-main', {
      id: 'id-main', name: seed.displayName, email: username, replyTo: null, bcc: null,
      textSignature: seed.signatureText, htmlSignature: seed.signatureHtml, mayDelete: false,
    });
    for (const m of seed.mailboxes) this.mailboxes.set(m.id, { ...m });
    for (const b of seed.blobs) this.blobs.set(b.id, { data: b.data, type: b.type });
    for (const e of seed.emails) this.emails.set(e.id, e);
  }

  newId(prefix: string): string {
    return `${prefix}${(++this.seq).toString(36)}${randomUUID().slice(0, 6)}`;
  }

  state(type: StateType): string {
    return String(this.states[type]);
  }

  /** Abonnement aux changements d'état (flux d'événements). */
  onChange(fn: (changed: Partial<Record<StateType, string>>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private bump(...types: StateType[]) {
    const changed: Partial<Record<StateType, string>> = {};
    for (const t of new Set(types)) {
      this.states[t]++;
      changed[t] = this.state(t);
    }
    for (const fn of this.listeners) fn(changed);
  }

  allStates(): Record<string, string> {
    return { Mailbox: this.state('Mailbox'), Email: this.state('Email'), Thread: this.state('Thread'), Identity: this.state('Identity'), EmailSubmission: this.state('EmailSubmission') };
  }

  // ---------------------------------------------------------------- requête

  handle(methodCalls: Invocation[], inCreated: Record<string, string> = {}): { methodResponses: Invocation[]; createdIds: Record<string, string> } {
    const createdIds: Record<string, string> = { ...inCreated };
    const out: Invocation[] = [];
    for (const [name, rawArgs, callId] of methodCalls) {
      try {
        const args = this.resolveRefs(rawArgs, out);
        if (args.accountId !== undefined && args.accountId !== this.id) throw new MethodError('accountNotFound');
        const extra: Invocation[] = [];
        const res = this.dispatch(name, args, createdIds, extra, callId);
        out.push([name, res, callId], ...extra);
      } catch (e) {
        if (e instanceof MethodError) out.push(['error', { type: e.type, ...(e.message !== e.type ? { description: e.message } : {}) }, callId]);
        else out.push(['error', { type: 'serverFail', description: e instanceof Error ? e.message : String(e) }, callId]);
      }
    }
    return { methodResponses: out, createdIds };
  }

  /** Arguments `#clé` : référence arrière vers le résultat d'un appel précédent. */
  private resolveRefs(args: Json, done: Invocation[]): Json {
    const out: Json = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (!k.startsWith('#')) {
        out[k] = v;
        continue;
      }
      const ref = v as { resultOf?: string; name?: string; path?: string };
      const src = done.find(([n, , id]) => id === ref.resultOf && n === ref.name);
      if (!src || typeof ref.path !== 'string') throw new MethodError('invalidResultReference');
      out[k.slice(1)] = evalPointer(src[1], ref.path.split('/').slice(1).map(unescapePointer));
    }
    return out;
  }

  private dispatch(name: string, a: Json, created: Record<string, string>, extra: Invocation[], callId: string): Json {
    switch (name) {
      case 'Mailbox/get': return this.mailboxGet(a);
      case 'Mailbox/changes': return this.changes('Mailbox', a, { updatedProperties: null });
      case 'Mailbox/query': return this.mailboxQuery(a);
      case 'Mailbox/queryChanges': throw new MethodError('cannotCalculateChanges');
      case 'Mailbox/set': return this.mailboxSet(a, created);
      case 'Email/query': return this.emailQuery(a);
      case 'Email/queryChanges': throw new MethodError('cannotCalculateChanges');
      case 'Email/get': return this.emailGet(a);
      case 'Email/changes': return this.changes('Email', a);
      case 'Email/set': return this.emailSet(a, created);
      case 'Thread/get': return this.threadGet(a);
      case 'Thread/changes': return this.changes('Thread', a);
      case 'Identity/get': return this.identityGet(a);
      case 'Identity/changes': return this.changes('Identity', a);
      case 'Identity/set': return this.identitySet(a);
      case 'EmailSubmission/get': return this.submissionGet(a);
      case 'EmailSubmission/changes': return this.changes('EmailSubmission', a);
      case 'EmailSubmission/set': return this.submissionSet(a, created, extra, callId);
      case 'SearchSnippet/get': {
        const ids = strArray(a.emailIds) ?? [];
        return { accountId: this.id, list: ids.map((id) => ({ emailId: id, subject: null, preview: null })), notFound: [] };
      }
      default: throw new MethodError('unknownMethod');
    }
  }

  // ---------------------------------------------------------------- changements

  private idsOf(type: StateType): string[] {
    switch (type) {
      case 'Mailbox': return [...this.mailboxes.keys()];
      case 'Email': return [...this.emails.keys()];
      case 'Thread': return [...new Set([...this.emails.values()].map((e) => e.threadId))];
      case 'Identity': return [...this.identities.keys()];
      case 'EmailSubmission': return [...this.submissions.keys()];
    }
  }

  /** Simplification : tout ce qui existe est « modifié » depuis un état ancien, les tombes sont « détruites ». */
  private changes(type: StateType, a: Json, more: Json = {}): Json {
    const since = String(a.sinceState ?? '');
    const now = this.state(type);
    if (!/^\d+$/.test(since) || Number(since) > Number(now)) throw new MethodError('cannotCalculateChanges');
    const same = since === now;
    const existing = new Set(this.idsOf(type));
    return {
      accountId: this.id, oldState: since, newState: now, hasMoreChanges: false, created: [],
      updated: same ? [] : [...existing],
      destroyed: same ? [] : [...this.tombs[type]].filter((id) => !existing.has(id)),
      ...more,
    };
  }

  // ---------------------------------------------------------------- dossiers

  private mailboxJson(m: Mailbox): Json {
    const inBox = [...this.emails.values()].filter((e) => e.mailboxIds[m.id]);
    const threads = new Set(inBox.map((e) => e.threadId));
    const unreadThreads = new Set(inBox.filter((e) => !e.keywords.$seen).map((e) => e.threadId));
    return {
      id: m.id, name: m.name, parentId: m.parentId, role: m.role, sortOrder: m.sortOrder,
      totalEmails: inBox.length, unreadEmails: inBox.filter((e) => !e.keywords.$seen).length,
      totalThreads: threads.size, unreadThreads: unreadThreads.size,
      myRights: { ...MAILBOX_RIGHTS }, isSubscribed: m.isSubscribed,
    };
  }

  private mailboxGet(a: Json): Json {
    const ids = strArray(a.ids);
    const props = strArray(a.properties);
    const list: Json[] = [];
    const notFound: string[] = [];
    for (const id of ids ?? [...this.mailboxes.keys()]) {
      const m = this.mailboxes.get(id);
      if (!m) {
        notFound.push(id);
        continue;
      }
      const full = this.mailboxJson(m);
      list.push(props ? Object.fromEntries(['id', ...props].filter((p) => p in full).map((p) => [p, full[p]])) : full);
    }
    return { accountId: this.id, state: this.state('Mailbox'), list, notFound };
  }

  private mailboxQuery(a: Json): Json {
    const f = (a.filter ?? {}) as Json;
    const list = [...this.mailboxes.values()]
      .filter((m) => (f.role === undefined || m.role === f.role) && (f.parentId === undefined || m.parentId === f.parentId))
      .sort((x, y) => x.sortOrder - y.sortOrder || x.name.localeCompare(y.name));
    return { accountId: this.id, queryState: this.state('Mailbox'), canCalculateChanges: false, position: 0, ids: list.map((m) => m.id), total: list.length };
  }

  private resolveId(id: unknown, created: Record<string, string>): string | null {
    if (typeof id !== 'string') return null;
    return id.startsWith('#') ? (created[id.slice(1)] ?? null) : id;
  }

  private mailboxSet(a: Json, created: Record<string, string>): Json {
    const oldState = this.state('Mailbox');
    const res: Json = { accountId: this.id, oldState };
    const ok: Json = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Json = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    let changed = false;
    let emailsChanged = false;

    for (const [k, raw] of Object.entries((a.create ?? {}) as Record<string, Json>)) {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const parentId = raw.parentId == null ? null : this.resolveId(raw.parentId, created);
      if (!name) {
        notCreated[k] = { type: 'invalidProperties', properties: ['name'] };
        continue;
      }
      if (raw.parentId != null && (!parentId || !this.mailboxes.has(parentId))) {
        notCreated[k] = { type: 'invalidProperties', properties: ['parentId'] };
        continue;
      }
      if ([...this.mailboxes.values()].some((m) => m.parentId === parentId && m.name === name)) {
        notCreated[k] = { type: 'alreadyExists', description: 'A mailbox with this name already exists' };
        continue;
      }
      const id = this.newId('mb-');
      const m: Mailbox = {
        id, name, parentId, role: typeof raw.role === 'string' ? raw.role : null,
        sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : 10,
        isSubscribed: raw.isSubscribed !== false,
      };
      this.mailboxes.set(id, m);
      created[k] = id;
      const j = this.mailboxJson(m);
      ok[k] = { id, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: j.myRights, isSubscribed: m.isSubscribed, sortOrder: m.sortOrder, role: m.role };
      changed = true;
    }

    for (const [rawId, patch] of Object.entries((a.update ?? {}) as Record<string, Json>)) {
      const id = this.resolveId(rawId, created) ?? rawId;
      const m = this.mailboxes.get(id);
      if (!m) {
        notUpdated[rawId] = { type: 'notFound' };
        continue;
      }
      const next = { ...m };
      const bad: string[] = [];
      for (const [p, v] of Object.entries(patch)) {
        if (p === 'name' && typeof v === 'string' && v.trim()) next.name = v.trim();
        else if (p === 'parentId') {
          const pid = v == null ? null : this.resolveId(v, created);
          if (v != null && (!pid || !this.mailboxes.has(pid) || pid === id || this.isDescendant(pid, id))) bad.push(p);
          else next.parentId = pid;
        } else if (p === 'sortOrder' && typeof v === 'number') next.sortOrder = v;
        else if (p === 'isSubscribed' && typeof v === 'boolean') next.isSubscribed = v;
        else if (p === 'role' && (v === null || typeof v === 'string')) next.role = v;
        else bad.push(p);
      }
      if (bad.length) {
        notUpdated[rawId] = { type: 'invalidProperties', properties: bad };
        continue;
      }
      this.mailboxes.set(id, next);
      updated[rawId] = null;
      changed = true;
    }

    // dans l'ordre reçu : le client détruit les sous-dossiers d'abord
    for (const id of strArray(a.destroy) ?? []) {
      const m = this.mailboxes.get(id);
      if (!m) {
        notDestroyed[id] = { type: 'notFound' };
        continue;
      }
      if ([...this.mailboxes.values()].some((x) => x.parentId === id)) {
        notDestroyed[id] = { type: 'mailboxHasChild' };
        continue;
      }
      const inside = [...this.emails.values()].filter((e) => e.mailboxIds[id]);
      if (inside.length && a.onDestroyRemoveEmails !== true) {
        notDestroyed[id] = { type: 'mailboxHasEmail' };
        continue;
      }
      for (const e of inside) {
        delete e.mailboxIds[id];
        if (!Object.keys(e.mailboxIds).length) this.removeEmail(e.id);
        emailsChanged = true;
      }
      this.mailboxes.delete(id);
      this.tombs.Mailbox.add(id);
      destroyed.push(id);
      changed = true;
    }

    if (emailsChanged) this.bump('Mailbox', 'Email', 'Thread');
    else if (changed) this.bump('Mailbox');
    return {
      ...res, newState: this.state('Mailbox'),
      created: Object.keys(ok).length ? ok : null, updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null, notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }

  private isDescendant(id: string, ancestor: string): boolean {
    let cur = this.mailboxes.get(id);
    while (cur?.parentId) {
      if (cur.parentId === ancestor) return true;
      cur = this.mailboxes.get(cur.parentId);
    }
    return false;
  }

  // ---------------------------------------------------------------- recherche

  private matches(e: StoredEmail, f: Json): boolean {
    if (typeof f.operator === 'string') {
      const conds = (Array.isArray(f.conditions) ? f.conditions : []) as Json[];
      if (f.operator === 'AND') return conds.every((c) => this.matches(e, c));
      if (f.operator === 'OR') return conds.some((c) => this.matches(e, c));
      if (f.operator === 'NOT') return !conds.some((c) => this.matches(e, c));
      throw new MethodError('unsupportedFilter', `Unknown operator ${f.operator}`);
    }
    const has = (field: string, needle: unknown) => typeof needle !== 'string' || fold(field).includes(fold(needle));
    for (const [k, v] of Object.entries(f)) {
      switch (k) {
        case 'inMailbox': if (typeof v === 'string' && !e.mailboxIds[v]) return false; break;
        case 'inMailboxOtherThan': if (Array.isArray(v) && !Object.keys(e.mailboxIds).some((id) => !v.includes(id))) return false; break;
        case 'before': if (typeof v === 'string' && !(e.receivedAt < v)) return false; break;
        case 'after': if (typeof v === 'string' && !(e.receivedAt > v)) return false; break;
        case 'minSize': if (typeof v === 'number' && sizeOf(e) < v) return false; break;
        case 'maxSize': if (typeof v === 'number' && sizeOf(e) >= v) return false; break;
        case 'hasKeyword': if (typeof v === 'string' && !e.keywords[v]) return false; break;
        case 'notKeyword': if (typeof v === 'string' && e.keywords[v]) return false; break;
        case 'allInThreadHaveKeyword':
        case 'someInThreadHaveKeyword':
        case 'noneInThreadHaveKeyword': {
          const thread = [...this.emails.values()].filter((x) => x.threadId === e.threadId);
          const n = thread.filter((x) => typeof v === 'string' && x.keywords[v]).length;
          if (k === 'allInThreadHaveKeyword' && n !== thread.length) return false;
          if (k === 'someInThreadHaveKeyword' && n === 0) return false;
          if (k === 'noneInThreadHaveKeyword' && n > 0) return false;
          break;
        }
        case 'hasAttachment': if (typeof v === 'boolean' && (e.attachments.length > 0) !== v) return false; break;
        case 'text':
          if (!has([e.subject, addrText(e.from), addrText(e.to), addrText(e.cc), bodyText(e)].join('\n'), v)) return false;
          break;
        case 'from': if (!has(addrText(e.from), v)) return false; break;
        case 'to': if (!has(addrText(e.to), v)) return false; break;
        case 'cc': if (!has(addrText(e.cc), v)) return false; break;
        case 'bcc': if (!has(addrText(e.bcc), v)) return false; break;
        case 'subject': if (!has(e.subject, v)) return false; break;
        case 'body': if (!has(bodyText(e), v)) return false; break;
        default: throw new MethodError('unsupportedFilter', `Unsupported filter condition ${k}`);
      }
    }
    return true;
  }

  private sortKey(e: StoredEmail, prop: string): string | number {
    switch (prop) {
      case 'receivedAt': return e.receivedAt;
      case 'sentAt': return e.sentAt ?? e.receivedAt;
      case 'size': return sizeOf(e);
      case 'subject': return fold(e.subject);
      case 'from': return fold(e.from?.[0]?.name ?? e.from?.[0]?.email ?? '');
      case 'to': return fold(e.to?.[0]?.name ?? e.to?.[0]?.email ?? '');
      default: throw new MethodError('unsupportedSort', `Unsupported sort ${prop}`);
    }
  }

  private emailQuery(a: Json): Json {
    let list = [...this.emails.values()].filter((e) => !a.filter || this.matches(e, a.filter as Json));
    const sort = (Array.isArray(a.sort) && a.sort.length ? a.sort : [{ property: 'receivedAt', isAscending: false }]) as Array<{ property: string; isAscending?: boolean }>;
    list.sort((x, y) => {
      for (const s of sort) {
        const kx = this.sortKey(x, s.property);
        const ky = this.sortKey(y, s.property);
        if (kx !== ky) return (kx < ky ? -1 : 1) * (s.isAscending === false ? -1 : 1);
      }
      return x.id < y.id ? -1 : 1;
    });
    if (a.collapseThreads === true) {
      const seen = new Set<string>();
      list = list.filter((e) => (seen.has(e.threadId) ? false : (seen.add(e.threadId), true)));
    }
    const total = list.length;
    let position = typeof a.position === 'number' ? a.position : 0;
    if (typeof a.anchor === 'string') {
      const i = list.findIndex((e) => e.id === a.anchor);
      if (i < 0) throw new MethodError('anchorNotFound');
      position = Math.max(0, i + (typeof a.anchorOffset === 'number' ? a.anchorOffset : 0));
    } else if (position < 0) position = Math.max(0, total + position);
    const limit = typeof a.limit === 'number' && a.limit >= 0 ? a.limit : 50;
    const ids = list.slice(position, position + limit).map((e) => e.id);
    return {
      accountId: this.id, queryState: this.state('Email'), canCalculateChanges: false, position, ids,
      ...(a.calculateTotal === true ? { total } : {}), limit,
    };
  }

  // ---------------------------------------------------------------- lecture

  private part(e: StoredEmail, kind: 'text' | 'html'): Json {
    const value = kind === 'text' ? e.text : e.html;
    return {
      partId: kind === 'text' ? '1' : '2', blobId: `${e.blobId}.${kind === 'text' ? 1 : 2}`,
      size: Buffer.byteLength(value ?? ''), headers: [], name: null,
      type: kind === 'text' ? 'text/plain' : 'text/html', charset: 'utf-8', disposition: null, cid: null, language: null, location: null,
    };
  }

  private attachmentJson(a: Attachment): Json {
    return { partId: a.partId, blobId: a.blobId, size: a.size, headers: [], name: a.name, type: a.type, charset: null, disposition: a.disposition, cid: a.cid, language: null, location: null };
  }

  private bodyStructure(e: StoredEmail): Json {
    const body: Json[] = [];
    if (e.text !== null) body.push(this.part(e, 'text'));
    if (e.html !== null) body.push(this.part(e, 'html'));
    const alt: Json = body.length === 1 ? body[0]! : { partId: null, blobId: null, size: 0, headers: [], name: null, type: 'multipart/alternative', subParts: body };
    if (!e.attachments.length) return alt;
    return { partId: null, blobId: null, size: 0, headers: [], name: null, type: 'multipart/mixed', subParts: [alt, ...e.attachments.map((x) => this.attachmentJson(x))] };
  }

  /** Propriété `header:<Nom>[:as<Forme>][:all]`. */
  private headerProp(e: StoredEmail, prop: string): unknown {
    const [, rawName = '', form = 'asRaw'] = prop.split(':');
    const name = rawName.toLowerCase();
    if (name === 'list-unsubscribe') {
      if (!e.unsubscribe) return null;
      return form === 'asURLs' ? [e.unsubscribe] : `<${e.unsubscribe}>`;
    }
    const v = e.headers[name];
    if (v === undefined) return null;
    return form === 'asText' || form === 'asRaw' ? v : null;
  }

  private emailJson(e: StoredEmail, props: string[], a: Json): Json {
    const out: Json = { id: e.id };
    const maxBytes = typeof a.maxBodyValueBytes === 'number' && a.maxBodyValueBytes > 0 ? a.maxBodyValueBytes : 0;
    const textPart = e.text !== null ? 'text' : 'html';
    const htmlPart = e.html !== null ? 'html' : 'text';
    for (const p of props) {
      if (p.startsWith('header:')) {
        out[p] = this.headerProp(e, p);
        continue;
      }
      switch (p) {
        case 'id': break;
        case 'blobId': out.blobId = e.blobId; break;
        case 'threadId': out.threadId = e.threadId; break;
        case 'mailboxIds': out.mailboxIds = { ...e.mailboxIds }; break;
        case 'keywords': out.keywords = { ...e.keywords }; break;
        case 'size': out.size = sizeOf(e); break;
        case 'receivedAt': out.receivedAt = e.receivedAt; break;
        case 'sentAt': out.sentAt = e.sentAt; break;
        case 'messageId': out.messageId = e.messageId; break;
        case 'inReplyTo': out.inReplyTo = e.inReplyTo; break;
        case 'references': out.references = e.references; break;
        case 'sender': out.sender = e.sender; break;
        case 'from': out.from = e.from; break;
        case 'to': out.to = e.to; break;
        case 'cc': out.cc = e.cc; break;
        case 'bcc': out.bcc = e.bcc; break;
        case 'replyTo': out.replyTo = e.replyTo; break;
        case 'subject': out.subject = e.subject; break;
        case 'hasAttachment': out.hasAttachment = e.attachments.length > 0; break;
        case 'preview': out.preview = previewOf(e); break;
        case 'textBody': out.textBody = [this.part(e, textPart)]; break;
        case 'htmlBody': out.htmlBody = [this.part(e, htmlPart)]; break;
        case 'attachments': out.attachments = e.attachments.map((x) => this.attachmentJson(x)); break;
        case 'bodyStructure': out.bodyStructure = this.bodyStructure(e); break;
        case 'bodyValues': {
          const wanted = new Set<'text' | 'html'>();
          if (a.fetchAllBodyValues === true) {
            if (e.text !== null) wanted.add('text');
            if (e.html !== null) wanted.add('html');
          }
          if (a.fetchTextBodyValues === true) wanted.add(textPart);
          if (a.fetchHTMLBodyValues === true) wanted.add(htmlPart);
          const values: Json = {};
          for (const kind of wanted) {
            const full = (kind === 'text' ? e.text : e.html) ?? '';
            const cut = maxBytes && Buffer.byteLength(full) > maxBytes ? Buffer.from(full).subarray(0, maxBytes).toString('utf8').replace(/�+$/, '') : full;
            values[kind === 'text' ? '1' : '2'] = { value: cut, isEncodingProblem: false, isTruncated: cut.length !== full.length };
          }
          out.bodyValues = values;
          break;
        }
        default: break;
      }
    }
    return out;
  }

  private emailGet(a: Json): Json {
    const props = strArray(a.properties) ?? DEFAULT_EMAIL_PROPS;
    const ids = strArray(a.ids);
    const list: Json[] = [];
    const notFound: string[] = [];
    for (const id of ids ?? [...this.emails.keys()].slice(0, 1000)) {
      const e = this.emails.get(id);
      if (e) list.push(this.emailJson(e, props, a));
      else notFound.push(id);
    }
    return { accountId: this.id, state: this.state('Email'), list, notFound };
  }

  private threadGet(a: Json): Json {
    const ids = strArray(a.ids);
    const groups = new Map<string, StoredEmail[]>();
    for (const e of this.emails.values()) {
      const g = groups.get(e.threadId) ?? [];
      g.push(e);
      groups.set(e.threadId, g);
    }
    const list: Json[] = [];
    const notFound: string[] = [];
    for (const id of ids ?? [...groups.keys()]) {
      const g = groups.get(id);
      if (!g) {
        notFound.push(id);
        continue;
      }
      list.push({ id, emailIds: g.sort((x, y) => x.receivedAt.localeCompare(y.receivedAt)).map((e) => e.id) });
    }
    return { accountId: this.id, state: this.state('Thread'), list, notFound };
  }

  // ---------------------------------------------------------------- écriture

  /** Création d'un e-mail (formes `bodyStructure` ou `textBody`/`htmlBody`/`attachments` + `bodyValues`). */
  private createEmail(raw: Json, created: Record<string, string>): StoredEmail | SetError {
    const mailboxIds: Record<string, true> = {};
    for (const [k, v] of Object.entries((raw.mailboxIds ?? {}) as Json)) {
      const id = this.resolveId(k, created);
      if (v !== true || !id || !this.mailboxes.has(id)) return { type: 'invalidProperties', properties: ['mailboxIds'] };
      mailboxIds[id] = true;
    }
    if (!Object.keys(mailboxIds).length) return { type: 'invalidProperties', properties: ['mailboxIds'], description: 'An email must belong to at least one mailbox' };
    const keywords: Record<string, true> = {};
    for (const [k, v] of Object.entries((raw.keywords ?? {}) as Json)) if (v === true) keywords[k] = true;

    const values = (raw.bodyValues ?? {}) as Record<string, { value?: string }>;
    let text: string | null = null;
    let html: string | null = null;
    const atts: Array<Json> = [];
    const leaf = (p: Json) => {
      const type = typeof p.type === 'string' ? p.type.toLowerCase() : '';
      if (typeof p.partId === 'string' && type.startsWith('text/')) {
        const v = values[p.partId]?.value ?? '';
        if (type === 'text/html') html = html === null ? v : html + v;
        else text = text === null ? v : text + v;
      } else if (typeof p.blobId === 'string') atts.push(p);
    };
    if (raw.bodyStructure && typeof raw.bodyStructure === 'object') {
      const walk = (p: Json) => {
        if (Array.isArray(p.subParts)) for (const s of p.subParts as Json[]) walk(s);
        else leaf(p);
      };
      walk(raw.bodyStructure as Json);
    } else {
      for (const p of (Array.isArray(raw.textBody) ? raw.textBody : []) as Json[]) leaf({ ...p, type: p.type ?? 'text/plain' });
      for (const p of (Array.isArray(raw.htmlBody) ? raw.htmlBody : []) as Json[]) leaf({ ...p, type: p.type ?? 'text/html' });
      for (const p of (Array.isArray(raw.attachments) ? raw.attachments : []) as Json[]) leaf(p);
    }
    const attachments: Attachment[] = [];
    for (const [i, p] of atts.entries()) {
      const blobId = p.blobId as string;
      const blob = this.blobs.get(blobId);
      if (!blob) return { type: 'blobNotFound', description: `Unknown blob ${blobId}` };
      attachments.push({
        partId: String(3 + i), blobId, type: typeof p.type === 'string' ? p.type : blob.type,
        name: typeof p.name === 'string' ? p.name : null, size: blob.data.length,
        disposition: typeof p.disposition === 'string' ? p.disposition : 'attachment', cid: typeof p.cid === 'string' ? p.cid : null,
      });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('header:')) continue;
      const name = k.split(':')[1]?.toLowerCase();
      if (name && typeof v === 'string') headers[name] = v;
    }
    const inReplyTo = strArray(raw.inReplyTo);
    const references = strArray(raw.references);
    const parents = new Set([...(inReplyTo ?? []), ...(references ?? [])]);
    const parent = parents.size ? [...this.emails.values()].find((e) => e.messageId.some((m) => parents.has(m))) : undefined;
    const id = this.newId('e-');
    const email: StoredEmail = {
      id, blobId: `b-${id}`, threadId: parent?.threadId ?? this.newId('t-'), mailboxIds, keywords,
      receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : utc(new Date()),
      sentAt: typeof raw.sentAt === 'string' ? raw.sentAt : utc(new Date()),
      messageId: strArray(raw.messageId) ?? [`${randomUUID()}@demo`],
      inReplyTo, references,
      sender: addrList(raw.sender), from: addrList(raw.from), to: addrList(raw.to), cc: addrList(raw.cc), bcc: addrList(raw.bcc), replyTo: addrList(raw.replyTo),
      subject: typeof raw.subject === 'string' ? raw.subject : '',
      text, html, attachments, headers, unsubscribe: null,
    };
    return email;
  }

  /** Patch RFC 8620 (`keywords/x`, `mailboxIds/x`) ou remplacement complet. */
  private patchEmail(e: StoredEmail, patch: Json, created: Record<string, string>): SetError | null {
    const keywords = { ...e.keywords };
    const mailboxIds = { ...e.mailboxIds };
    const bad: string[] = [];
    for (const [p, v] of Object.entries(patch)) {
      const [head, ...rest] = p.split('/');
      const sub = rest.length ? unescapePointer(rest.join('/')) : null;
      if (head === 'keywords' && sub === null) {
        if (!v || typeof v !== 'object') bad.push(p);
        else {
          for (const k of Object.keys(keywords)) delete keywords[k];
          for (const [k, x] of Object.entries(v as Json)) if (x === true) keywords[k] = true;
        }
      } else if (head === 'keywords' && sub) {
        if (v === true) keywords[sub] = true;
        else if (v === null || v === false) delete keywords[sub];
        else bad.push(p);
      } else if (head === 'mailboxIds' && sub === null) {
        if (!v || typeof v !== 'object') bad.push(p);
        else {
          for (const k of Object.keys(mailboxIds)) delete mailboxIds[k];
          for (const [k, x] of Object.entries(v as Json)) {
            const id = this.resolveId(k, created);
            if (x === true && id && this.mailboxes.has(id)) mailboxIds[id] = true;
            else bad.push(p);
          }
        }
      } else if (head === 'mailboxIds' && sub) {
        const id = this.resolveId(sub, created);
        if (!id) bad.push(p);
        else if (v === true) {
          if (this.mailboxes.has(id)) mailboxIds[id] = true;
          else bad.push(p);
        } else if (v === null || v === false) delete mailboxIds[id];
        else bad.push(p);
      } else bad.push(p);
    }
    if (bad.length) return { type: 'invalidProperties', properties: bad };
    if (!Object.keys(mailboxIds).length) return { type: 'invalidProperties', properties: ['mailboxIds'], description: 'An email must belong to at least one mailbox' };
    e.keywords = keywords;
    e.mailboxIds = mailboxIds;
    return null;
  }

  private removeEmail(id: string) {
    const e = this.emails.get(id);
    if (!e) return;
    this.emails.delete(id);
    this.tombs.Email.add(id);
    if (![...this.emails.values()].some((x) => x.threadId === e.threadId)) this.tombs.Thread.add(e.threadId);
  }

  private emailSet(a: Json, created: Record<string, string>): Json {
    const oldState = this.state('Email');
    const ok: Json = {};
    const notCreated: Record<string, SetError> = {};
    const updated: Json = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    for (const [k, raw] of Object.entries((a.create ?? {}) as Record<string, Json>)) {
      const r = this.createEmail(raw, created);
      if (!('id' in r)) {
        notCreated[k] = r;
        continue;
      }
      this.emails.set(r.id, r);
      created[k] = r.id;
      ok[k] = { id: r.id, blobId: r.blobId, threadId: r.threadId, size: sizeOf(r) };
    }
    for (const [rawId, patch] of Object.entries((a.update ?? {}) as Record<string, Json>)) {
      const e = this.emails.get(this.resolveId(rawId, created) ?? rawId);
      if (!e) {
        notUpdated[rawId] = { type: 'notFound' };
        continue;
      }
      const err = this.patchEmail(e, patch ?? {}, created);
      if (err) notUpdated[rawId] = err;
      else updated[rawId] = null;
    }
    for (const rawId of strArray(a.destroy) ?? []) {
      const id = this.resolveId(rawId, created) ?? rawId;
      if (!this.emails.has(id)) {
        notDestroyed[rawId] = { type: 'notFound' };
        continue;
      }
      this.removeEmail(id);
      destroyed.push(rawId);
    }
    const anyCreatedOrDestroyed = Object.keys(ok).length > 0 || destroyed.length > 0;
    if (anyCreatedOrDestroyed) this.bump('Email', 'Mailbox', 'Thread');
    else if (Object.keys(updated).length) this.bump('Email', 'Mailbox');
    return {
      accountId: this.id, oldState, newState: this.state('Email'),
      created: Object.keys(ok).length ? ok : null, updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null, notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }

  // ---------------------------------------------------------------- identités et envoi

  private identityGet(a: Json): Json {
    const ids = strArray(a.ids);
    const list: Json[] = [];
    const notFound: string[] = [];
    for (const id of ids ?? [...this.identities.keys()]) {
      const i = this.identities.get(id);
      if (i) list.push({ ...i });
      else notFound.push(id);
    }
    return { accountId: this.id, state: this.state('Identity'), list, notFound };
  }

  private identitySet(a: Json): Json {
    const oldState = this.state('Identity');
    const ok: Json = {};
    const updated: Json = {};
    const notUpdated: Record<string, SetError> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, SetError> = {};
    const fields = (target: Identity, patch: Json) => {
      if (typeof patch.name === 'string') target.name = patch.name;
      if (typeof patch.textSignature === 'string') target.textSignature = patch.textSignature;
      if (typeof patch.htmlSignature === 'string') target.htmlSignature = patch.htmlSignature;
      if ('replyTo' in patch) target.replyTo = addrList(patch.replyTo);
      if ('bcc' in patch) target.bcc = addrList(patch.bcc);
    };
    for (const [k, raw] of Object.entries((a.create ?? {}) as Record<string, Json>)) {
      const id = this.newId('id-');
      const i: Identity = { id, name: '', email: typeof raw.email === 'string' ? raw.email : this.username, replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true };
      fields(i, raw);
      this.identities.set(id, i);
      ok[k] = { id, mayDelete: true };
    }
    for (const [id, patch] of Object.entries((a.update ?? {}) as Record<string, Json>)) {
      const i = this.identities.get(id);
      if (!i) notUpdated[id] = { type: 'notFound' };
      else {
        fields(i, patch);
        updated[id] = null;
      }
    }
    for (const id of strArray(a.destroy) ?? []) {
      const i = this.identities.get(id);
      if (!i) notDestroyed[id] = { type: 'notFound' };
      else if (!i.mayDelete) notDestroyed[id] = { type: 'forbidden' };
      else {
        this.identities.delete(id);
        this.tombs.Identity.add(id);
        destroyed.push(id);
      }
    }
    if (Object.keys(ok).length || Object.keys(updated).length || destroyed.length) this.bump('Identity');
    return {
      accountId: this.id, oldState, newState: this.state('Identity'),
      created: Object.keys(ok).length ? ok : null, updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null, notCreated: null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null, notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }

  private submissionGet(a: Json): Json {
    const ids = strArray(a.ids);
    const list: Json[] = [];
    const notFound: string[] = [];
    for (const id of ids ?? [...this.submissions.keys()]) {
      const s = this.submissions.get(id);
      if (s) list.push({ ...s });
      else notFound.push(id);
    }
    return { accountId: this.id, state: this.state('EmailSubmission'), list, notFound };
  }

  /** L'envoi « réussit » toujours ; `onSuccessUpdateEmail` est appliqué par un `Email/set` implicite. */
  private submissionSet(a: Json, created: Record<string, string>, extra: Invocation[], callId: string): Json {
    const oldState = this.state('EmailSubmission');
    const ok: Json = {};
    const notCreated: Record<string, SetError> = {};
    const subEmail = new Map<string, string>(); // `#clé` ou id de soumission → id d'e-mail
    for (const [k, raw] of Object.entries((a.create ?? {}) as Record<string, Json>)) {
      const emailId = this.resolveId(raw.emailId, created);
      const e = emailId ? this.emails.get(emailId) : undefined;
      if (!e) {
        notCreated[k] = { type: 'invalidProperties', properties: ['emailId'] };
        continue;
      }
      const id = this.newId('s-');
      const sendAt = utc(new Date());
      this.submissions.set(id, { id, emailId: e.id, identityId: typeof raw.identityId === 'string' ? raw.identityId : 'id-main', threadId: e.threadId, sendAt, undoStatus: 'final' });
      created[k] = id;
      subEmail.set(`#${k}`, e.id);
      subEmail.set(id, e.id);
      ok[k] = { id, sendAt, undoStatus: 'final' };
    }
    const update: Record<string, Json> = {};
    for (const [key, patch] of Object.entries((a.onSuccessUpdateEmail ?? {}) as Record<string, Json>)) {
      const emailId = subEmail.get(key);
      if (emailId) update[emailId] = patch;
    }
    const destroy = (strArray(a.onSuccessDestroyEmail) ?? []).map((k) => subEmail.get(k)).filter((x): x is string => !!x);
    // sans consigne du client : on range quand même le message dans Envoyés
    const drafts = [...this.mailboxes.values()].find((m) => m.role === 'drafts')?.id;
    const sent = [...this.mailboxes.values()].find((m) => m.role === 'sent')?.id;
    for (const emailId of new Set(subEmail.values())) {
      if (update[emailId] || destroy.includes(emailId)) continue;
      const p: Json = { 'keywords/$draft': null, 'keywords/$seen': true };
      if (drafts && sent) {
        p[`mailboxIds/${drafts}`] = null;
        p[`mailboxIds/${sent}`] = true;
      }
      update[emailId] = p;
    }
    if (Object.keys(ok).length) this.bump('EmailSubmission');
    if (Object.keys(update).length || destroy.length) {
      extra.push(['Email/set', this.emailSet({ accountId: this.id, update, destroy }, created), callId]);
    }
    return {
      accountId: this.id, oldState, newState: this.state('EmailSubmission'),
      created: Object.keys(ok).length ? ok : null, notCreated: Object.keys(notCreated).length ? notCreated : null,
      updated: null, destroyed: null, notUpdated: null, notDestroyed: null,
    };
  }

  // ---------------------------------------------------------------- blobs

  addBlob(data: Buffer, type: string): string {
    const id = this.newId('blob-');
    this.blobs.set(id, { data, type });
    return id;
  }

  /** Blob téléversé, pièce jointe, partie de corps (`<blobId>.1|2`) ou message complet (RFC 5322 simplifié). */
  getBlob(blobId: string): Blob | undefined {
    const b = this.blobs.get(blobId);
    if (b) return b;
    const m = /^(b-.+?)(?:\.([12]))?$/.exec(blobId);
    if (!m) return undefined;
    const e = [...this.emails.values()].find((x) => x.blobId === m[1]);
    if (!e) return undefined;
    if (m[2] === '1') return { data: Buffer.from(e.text ?? ''), type: 'text/plain; charset=utf-8' };
    if (m[2] === '2') return { data: Buffer.from(e.html ?? ''), type: 'text/html; charset=utf-8' };
    return { data: Buffer.from(this.rfc822(e)), type: 'message/rfc822' };
  }

  private rfc822(e: StoredEmail): string {
    const fmt = (l: Address[] | null) => (l ?? []).map((x) => (x.name ? `"${x.name}" <${x.email}>` : x.email)).join(', ');
    const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
    const lines = [
      `From: ${fmt(e.from)}`, `To: ${fmt(e.to)}`, ...(e.cc?.length ? [`Cc: ${fmt(e.cc)}`] : []),
      `Subject: ${enc(e.subject)}`, `Date: ${new Date(e.sentAt ?? e.receivedAt).toUTCString()}`,
      `Message-ID: <${e.messageId[0] ?? e.id}>`, 'MIME-Version: 1.0',
    ];
    const body = e.html ?? e.text ?? '';
    lines.push(`Content-Type: ${e.html !== null ? 'text/html' : 'text/plain'}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '');
    lines.push(...(Buffer.from(body).toString('base64').match(/.{1,76}/g) ?? []));
    return lines.join('\r\n') + '\r\n';
  }
}
