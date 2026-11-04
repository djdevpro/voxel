/**
 * Dossiers IMAP ↔ objets Mailbox JMAP : ids stables (KvStore), rôles SPECIAL-USE, compteurs,
 * états, Mailbox/get|query|set|changes.
 */
import type { ListResponse } from 'imapflow';
import type { KvStore } from '../backend/types.js';
import type { ImapPool } from './pool.js';
import { hashOf, isObject, MethodError, randomBase36, SetError, setErrorOf } from './util.js';

export interface Folder {
  id: string;
  path: string;
  name: string;
  delimiter: string;
  parentId: string | null;
  role: string | null;
  subscribed: boolean;
  messages: number;
  unseen: number;
  uidNext: number;
  uidValidity: bigint;
  highestModseq: bigint | null;
}

const ROLE_BY_USE: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\Flagged': 'flagged',
  '\\All': 'all',
  '\\Important': 'important',
};

const ROLE_BY_NAME: Array<[RegExp, string]> = [
  [/^(sent|sent items|sent mail|sent messages|envoy[ée]s|[ée]l[ée]ments envoy[ée]s|messages envoy[ée]s|enviados|gesendet|inviati)$/i, 'sent'],
  [/^(drafts?|brouillons?|borradores|entw[üu]rfe|bozze)$/i, 'drafts'],
  [/^(trash|deleted|deleted items|deleted messages|corbeille|[ée]l[ée]ments supprim[ée]s|papelera|papierkorb|cestino|bin)$/i, 'trash'],
  [/^(junk|junk mail|junk e-mail|spam|courrier ind[ée]sirable|ind[ée]sirables|correo no deseado)$/i, 'junk'],
  [/^(archives?|archivo|archiv|archivio)$/i, 'archive'],
];

const ROLE_ORDER: Record<string, number> = { inbox: 1, drafts: 2, sent: 3, archive: 4, junk: 5, trash: 6, flagged: 7, all: 8, important: 9 };

const MB_PROPS = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed'];

export class Folders {
  private cache: { at: number; list: Folder[] } | undefined;
  private pending: Promise<Folder[]> | undefined;
  private generation = 0;
  /** Appelé à chaque relevé LIST/STATUS (journal des changements). */
  onList: ((list: Folder[]) => void) | null = null;

  constructor(
    private readonly pool: ImapPool,
    private readonly kv: KvStore,
    private readonly ttlMs = 4_000,
  ) {}

  // ---------------------------------------------------------------- ids stables

  idForPath(path: string): string {
    const k = `mb:p:${path}`;
    const existing = this.kv.get(k);
    if (existing) return existing;
    let id = '';
    do id = `m${randomBase36(5)}`;
    while (this.kv.get(`mb:i:${id}`));
    this.kv.set(k, id);
    this.kv.set(`mb:i:${id}`, path);
    return id;
  }

  private movePath(oldPath: string, newPath: string, delimiter: string) {
    // le dossier et ses descendants gardent leur id
    const id = this.kv.get(`mb:p:${oldPath}`);
    if (id) {
      this.kv.delete(`mb:p:${oldPath}`);
      this.kv.set(`mb:p:${newPath}`, id);
      this.kv.set(`mb:i:${id}`, newPath);
    }
    for (const f of this.cache?.list ?? []) {
      if (f.path.startsWith(oldPath + delimiter)) {
        const np = newPath + f.path.slice(oldPath.length);
        this.kv.delete(`mb:p:${f.path}`);
        this.kv.set(`mb:p:${np}`, f.id);
        this.kv.set(`mb:i:${f.id}`, np);
      }
    }
  }

  private forget(path: string) {
    const id = this.kv.get(`mb:p:${path}`);
    this.kv.delete(`mb:p:${path}`);
    if (id) this.kv.delete(`mb:i:${id}`);
  }

  // ---------------------------------------------------------------- liste

  invalidate() {
    this.cache = undefined;
    this.generation++;
  }

  async list(force = false): Promise<Folder[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.list;
    if (this.pending) return this.pending;
    const gen = this.generation;
    this.pending = (async () => {
      try {
        const raw = await this.pool.use(async (c) => {
          const condstore = c.capabilities.has('CONDSTORE') || c.capabilities.has('IMAP4rev2') || c.enabled.has('CONDSTORE');
          // STATUS du dossier sélectionné sur cette connexion = sa vue (Dovecot), en retard sur les écritures
          // des autres connexions : NOOP d'abord pour que le relevé soit exact.
          if (c.mailbox) await c.noop();
          return c.list({ statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true, highestModseq: condstore } });
        });
        const list = this.build(raw);
        if (gen === this.generation) this.cache = { at: Date.now(), list };
        try {
          this.onList?.(list);
        } catch {
          /* le journal ne doit jamais faire échouer une lecture */
        }
        return list;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  private build(raw: ListResponse[]): Folder[] {
    const selectable = raw.filter((r) => !hasFlag(r.flags, '\Noselect') && !hasFlag(r.flags, '\NonExistent'));
    const byPath = new Map(selectable.map((r) => [r.path, r]));
    const usedRoles = new Set<string>();
    // rôles : d'abord SPECIAL-USE annoncé par le serveur, puis noms usuels
    const roles = new Map<string, string>();
    const sorted = [...selectable].sort((a, b) => sourceRank(a) - sourceRank(b));
    for (const r of sorted) {
      let role: string | undefined;
      if (r.path.toUpperCase() === 'INBOX') role = 'inbox';
      else if (r.specialUse && ROLE_BY_USE[r.specialUse]) role = ROLE_BY_USE[r.specialUse];
      else if (!r.parentPath) {
        role = ROLE_BY_NAME.find(([re]) => re.test(r.name))?.[1];
      }
      if (role && !usedRoles.has(role)) {
        usedRoles.add(role);
        roles.set(r.path, role);
      }
    }
    const out: Folder[] = [];
    for (const r of selectable) {
      // parent sélectionnable le plus proche (un parent non sélectionnable est sauté)
      let parentId: string | null = null;
      const segs = r.parent ?? [];
      for (let n = segs.length; n > 0; n--) {
        const pp = segs.slice(0, n).join(r.delimiter);
        if (byPath.has(pp)) {
          parentId = this.idForPath(pp);
          break;
        }
      }
      const st = r.status;
      out.push({
        id: this.idForPath(r.path),
        path: r.path,
        name: r.path.toUpperCase() === 'INBOX' ? 'Inbox' : r.name,
        delimiter: r.delimiter || '/',
        parentId,
        role: roles.get(r.path) ?? null,
        subscribed: r.subscribed !== false,
        messages: st?.messages ?? 0,
        unseen: st?.unseen ?? 0,
        uidNext: st?.uidNext ?? 0,
        uidValidity: st?.uidValidity ?? 0n,
        highestModseq: st?.highestModseq ?? null,
      });
    }
    return out;
  }

  async byId(id: string): Promise<Folder | undefined> {
    return (await this.list()).find((f) => f.id === id);
  }

  async byRole(role: string): Promise<Folder | undefined> {
    return (await this.list()).find((f) => f.role === role);
  }

  /** Empreinte d'un dossier (change dès qu'un message arrive, part ou change de drapeaux). */
  static stamp(f: Folder): string {
    return `${f.uidValidity}|${f.uidNext}|${f.messages}|${f.unseen}|${f.highestModseq ?? ''}`;
  }

  /** État Email d'un relevé de dossiers (même calcul pour emailState et le journal des changements). */
  static emailStateOf(list: Folder[]): string {
    return `e${hashOf(list.map((f) => `${f.path}|${Folders.stamp(f)}`).join('\n'), 12)}`;
  }

  async emailState(): Promise<string> {
    return Folders.emailStateOf(await this.list());
  }

  async mailboxState(): Promise<string> {
    const list = await this.list();
    return `b${hashOf(list.map((f) => `${f.id}|${f.path}|${f.role}|${f.subscribed}|${f.messages}|${f.unseen}`).join('\n'), 12)}`;
  }

  toJmap(f: Folder, props: string[] | null): Record<string, unknown> {
    const full: Record<string, unknown> = {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      role: f.role,
      sortOrder: f.role ? (ROLE_ORDER[f.role] ?? 10) : 10,
      totalEmails: f.messages,
      unreadEmails: f.unseen,
      totalThreads: f.messages,
      unreadThreads: f.unseen,
      myRights: {
        mayReadItems: true,
        mayAddItems: true,
        mayRemoveItems: true,
        maySetSeen: true,
        maySetKeywords: true,
        mayCreateChild: true,
        mayRename: f.role !== 'inbox',
        mayDelete: f.role !== 'inbox',
        maySubmit: true,
      },
      isSubscribed: f.subscribed,
    };
    if (!props) return full;
    const out: Record<string, unknown> = { id: f.id };
    for (const p of props) if (p in full) out[p] = full[p];
    return out;
  }

  // ---------------------------------------------------------------- méthodes JMAP

  async get(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.list();
    const props = Array.isArray(args.properties) ? (args.properties as string[]) : null;
    if (props) for (const p of props) if (!MB_PROPS.includes(p)) throw new MethodError('invalidArguments', `unknown property ${p}`);
    const ids = args.ids;
    let found: Folder[];
    const notFound: string[] = [];
    if (ids === null || ids === undefined) found = list;
    else if (Array.isArray(ids)) {
      found = [];
      for (const id of ids as string[]) {
        const f = list.find((x) => x.id === id);
        if (f) found.push(f);
        else notFound.push(id);
      }
    } else throw new MethodError('invalidArguments', 'ids must be an array or null');
    return { state: await this.mailboxState(), list: found.map((f) => this.toJmap(f, props)), notFound };
  }

  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.list();
    const filter = isObject(args.filter) ? args.filter : {};
    let res = list.filter((f) => {
      if ('parentId' in filter && f.parentId !== filter.parentId) return false;
      if ('role' in filter && f.role !== filter.role) return false;
      if ('hasAnyRole' in filter && !!f.role !== filter.hasAnyRole) return false;
      if ('isSubscribed' in filter && f.subscribed !== filter.isSubscribed) return false;
      if (typeof filter.name === 'string' && !f.name.toLowerCase().includes(filter.name.toLowerCase())) return false;
      return true;
    });
    res = res.sort((a, b) => (a.role ? (ROLE_ORDER[a.role] ?? 10) : 10) - (b.role ? (ROLE_ORDER[b.role] ?? 10) : 10) || a.path.localeCompare(b.path));
    const position = typeof args.position === 'number' ? Math.max(0, args.position) : 0;
    const limit = typeof args.limit === 'number' ? args.limit : res.length;
    return {
      queryState: await this.mailboxState(),
      canCalculateChanges: false,
      position,
      ids: res.slice(position, position + limit).map((f) => f.id),
      total: res.length,
    };
  }

  async changes(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.mailboxState();
    if (args.sinceState === state) return { oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [], updatedProperties: null };
    throw new MethodError('cannotCalculateChanges', 'IMAP facade cannot compute mailbox changes');
  }

  async set(args: Record<string, unknown>, resolveId: (id: string) => string, onCreated: (cid: string, id: string) => void): Promise<Record<string, unknown>> {
    const oldState = await this.mailboxState();
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};

    // création (les parents créés dans la même requête sont référencés par #id)
    const toCreate = isObject(args.create) ? Object.entries(args.create) : [];
    for (const [cid, obj] of toCreate) {
      try {
        if (!isObject(obj)) throw new SetError('invalidProperties', 'object expected');
        const name = typeof obj.name === 'string' ? obj.name.trim() : '';
        if (!name) throw new SetError('invalidProperties', 'name required', ['name']);
        const list = await this.list();
        const parentId = typeof obj.parentId === 'string' ? resolveId(obj.parentId) : null;
        const parent = parentId ? list.find((f) => f.id === parentId) : undefined;
        if (parentId && !parent) throw new SetError('invalidProperties', 'parent not found', ['parentId']);
        const delimiter = parent?.delimiter ?? list[0]?.delimiter ?? '/';
        if (name.includes(delimiter)) throw new SetError('invalidProperties', `name cannot contain "${delimiter}"`, ['name']);
        const path = parent ? `${parent.path}${delimiter}${name}` : name;
        if (list.some((f) => f.path.toLowerCase() === path.toLowerCase())) throw new SetError('alreadyExists', 'a mailbox with this name exists', ['name']);
        await this.pool.use(async (c) => {
          await c.mailboxCreate(path);
          if (obj.isSubscribed !== false) await c.mailboxSubscribe(path).catch(() => false);
        });
        this.invalidate();
        const id = this.idForPath(path);
        onCreated(cid, id);
        created[cid] = { id, role: null, sortOrder: 10, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: obj.isSubscribed !== false };
      } catch (e) {
        notCreated[cid] = setErrorOf(e);
      }
    }

    const toUpdate = isObject(args.update) ? Object.entries(args.update) : [];
    for (const [rawId, patch] of toUpdate) {
      const id = resolveId(rawId);
      try {
        if (!isObject(patch)) throw new SetError('invalidPatch');
        const list = await this.list(true);
        const f = list.find((x) => x.id === id);
        if (!f) throw new SetError('notFound');
        let newName = f.name;
        let newParent = f.parentId;
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'name') {
            if (typeof v !== 'string' || !v.trim()) throw new SetError('invalidProperties', 'invalid name', ['name']);
            newName = v.trim();
          } else if (k === 'parentId') {
            newParent = typeof v === 'string' ? resolveId(v) : null;
          } else if (k === 'isSubscribed') {
            await this.pool.use((c) => (v ? c.mailboxSubscribe(f.path) : c.mailboxUnsubscribe(f.path)));
          } else if (k === 'sortOrder' || k === 'role') {
            /* non persistant en IMAP : ignoré */
          } else throw new SetError('invalidProperties', `cannot update ${k}`, [k]);
        }
        if (newName !== f.name || newParent !== f.parentId) {
          if (f.role === 'inbox') throw new SetError('forbidden', 'cannot rename the inbox');
          const parent = newParent ? list.find((x) => x.id === newParent) : undefined;
          if (newParent && !parent) throw new SetError('invalidProperties', 'parent not found', ['parentId']);
          if (parent && (parent.id === f.id || parent.path.startsWith(f.path + f.delimiter))) throw new SetError('invalidProperties', 'cannot move a mailbox into itself', ['parentId']);
          if (newName.includes(f.delimiter)) throw new SetError('invalidProperties', `name cannot contain "${f.delimiter}"`, ['name']);
          const newPath = parent ? `${parent.path}${f.delimiter}${newName}` : newName;
          if (list.some((x) => x.id !== f.id && x.path.toLowerCase() === newPath.toLowerCase())) throw new SetError('alreadyExists', 'a mailbox with this name exists', ['name']);
          await this.pool.use(async (c) => {
            await c.mailboxRename(f.path, newPath);
            await c.mailboxSubscribe(newPath).catch(() => false);
          });
          this.movePath(f.path, newPath, f.delimiter);
        }
        this.invalidate();
        updated[id] = null;
      } catch (e) {
        notUpdated[rawId] = setErrorOf(e);
      }
    }

    const toDestroy = Array.isArray(args.destroy) ? (args.destroy as string[]) : [];
    for (const rawId of toDestroy) {
      const id = resolveId(rawId);
      try {
        const list = await this.list(true);
        const f = list.find((x) => x.id === id);
        if (!f) throw new SetError('notFound');
        if (f.role === 'inbox') throw new SetError('forbidden', 'cannot delete the inbox');
        const childAlive = list.some((x) => x.parentId === f.id && !toDestroy.map(resolveId).includes(x.id));
        if (childAlive) throw new SetError('mailboxHasChild');
        if (f.messages > 0 && !args.onDestroyRemoveEmails) throw new SetError('mailboxHasEmail');
        await this.pool.use(async (c) => {
          await c.mailboxUnsubscribe(f.path).catch(() => false);
          await c.mailboxDelete(f.path);
        });
        this.forget(f.path);
        this.invalidate();
        destroyed.push(id);
      } catch (e) {
        notDestroyed[rawId] = setErrorOf(e);
      }
    }

    // les destructions demandées dans l'ordre parent → enfant échouent : on réessaie dans l'ordre inverse
    const retry = Object.keys(notDestroyed).filter((k) => (notDestroyed[k] as { type?: string }).type === 'mailboxHasChild');
    if (retry.length && destroyed.length) {
      for (const rawId of retry) {
        const id = resolveId(rawId);
        try {
          const list = await this.list(true);
          const f = list.find((x) => x.id === id);
          if (!f) throw new SetError('notFound');
          if (list.some((x) => x.parentId === f.id)) throw new SetError('mailboxHasChild');
          if (f.messages > 0 && !args.onDestroyRemoveEmails) throw new SetError('mailboxHasEmail');
          await this.pool.use((c) => c.mailboxDelete(f.path));
          this.forget(f.path);
          this.invalidate();
          destroyed.push(id);
          delete notDestroyed[rawId];
        } catch (e) {
          notDestroyed[rawId] = setErrorOf(e);
        }
      }
    }

    return {
      oldState,
      newState: await this.mailboxState(),
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }
}

function hasFlag(flags: Set<string> | undefined, flag: string): boolean {
  if (!flags) return false;
  const low = flag.toLowerCase();
  for (const f of flags) if (f.toLowerCase() === low) return true;
  return false;
}

function sourceRank(r: ListResponse): number {
  if (r.specialUseSource === 'user') return 0;
  if (r.specialUseSource === 'extension') return 1;
  if (r.specialUse) return 2;
  return 3;
}
