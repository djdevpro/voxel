/**
 * Façade CardDAV → JMAP for Contacts (RFC 9610) pour les boîtes IMAP de la passerelle.
 *
 * - `AddressBook/get|changes`, `ContactCard/get|changes|query|set|parse` (`AddressBook/set` non pris en charge :
 *   la capacité annonce `mayCreateAddressBook: false`).
 * - Sans état : identifiants dérivés du chemin (`b…` pour un carnet, `c…` pour une fiche, empreinte du href) ;
 *   l'état (`state`) encode, en base64url opaque, ce qu'il faut pour `…/changes` : par carnet, le jeton
 *   `sync-collection` (RFC 6578) ou, à défaut, l'empreinte de l'ETag de chaque fiche.
 * - Déplacer une fiche d'un carnet à l'autre = écriture dans le nouveau carnet puis suppression de l'ancienne :
 *   son href, donc son identifiant, change (vu par `…/changes` comme une suppression et une création).
 * - Conflit d'ETag (412) → `notUpdated` / `notDestroyed` de type `stateMismatch`.
 * - Cache mémoire des fiches lues (href → ETag + fiche), propre à la façade (donc à ces identifiants).
 */
import { newCardUid, cardSearchText, cardSortKey, foldText, cardEmails, type ContactCardCreate, type ContactCardFilterCondition } from '@voxel/jmap/jscontact';
import { cardToVcard, parseVcf, vcardToCard } from '@voxel/jmap/vcard';
import { hashOf, isObject, MethodError, SetError } from '../imap/util.js';
import { DavClient, type DavBook, type DavFetch, type DavMember } from './dav.js';

export const CAP_CONTACTS = 'urn:ietf:params:jmap:contacts';
export const CAP_CONTACTS_PARSE = 'urn:ietf:params:jmap:contacts:parse';
const PROBE_MS = 5_000;
const BOOKS_TTL = 30_000;
const SNAPSHOT_TTL = 3_000;
const MAX_CACHE = 5_000;
const MAX_STATE_ENTRIES = 20_000;
const MAX_VCF = 5 * 1024 * 1024;

export interface CardDavFacadeOptions {
  serviceUrl: URL;
  username: string;
  password: string;
  /** Contenu d'un blob téléversé (BlobStore de la façade IMAP). */
  loadUpload: (blobId: string) => Promise<Buffer | null>;
  /** Tests : remplace `safeFetch`. */
  fetch?: DavFetch;
}

interface BookEntry {
  id: string;
  book: DavBook;
  members: DavMember[];
}

/** État encodé : par carnet, jeton de synchronisation (`t`) ou ETags abrégés par fiche (`e`). */
interface EncodedState {
  v: 1;
  b: Record<string, { t?: string; e?: Record<string, string> }>;
}

const bookIdOf = (href: string) => `b${hashOf(`book:${href}`, 12)}`;
const cardIdOf = (href: string) => `c${hashOf(`card:${href}`, 16)}`;
const etagKey = (etag: string) => hashOf(etag, 8);

function encodeState(s: EncodedState): string {
  return `d${Buffer.from(JSON.stringify(s)).toString('base64url')}`;
}

function decodeState(raw: unknown): EncodedState | null {
  if (typeof raw !== 'string' || !raw.startsWith('d')) return null;
  try {
    const s = JSON.parse(Buffer.from(raw.slice(1), 'base64url').toString('utf8')) as EncodedState;
    return s && s.v === 1 && isObject(s.b) ? s : null;
  } catch {
    return null;
  }
}

/** Applique un PatchObject JMAP (RFC 8620 §5.3 : chemins JSON Pointer sans « / » initial, null = suppression). */
export function applyPatch<T extends Record<string, unknown>>(obj: T, patch: Record<string, unknown>): T {
  const out = structuredClone(obj) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!parts.length || parts.some((p) => p === '' || p === '__proto__' || p === 'constructor' || p === 'prototype')) {
      throw new SetError('invalidPatch', `bad path ${path}`);
    }
    let cur: Record<string, unknown> = out;
    for (const p of parts.slice(0, -1)) {
      const next = cur[p];
      if (next === undefined || next === null) cur[p] = {};
      else if (!isObject(next)) throw new SetError('invalidPatch', `bad path ${path}`);
      cur = cur[p] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1]!;
    if (value === null) delete cur[last];
    else cur[last] = structuredClone(value);
  }
  return out as T;
}

/** Nom de fichier sûr pour une fiche (`<uid>.vcf`, caractères limités). */
function fileNameFor(uid: string): string {
  const base = uid
    .replace(/^urn:uuid:/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 120);
  return `${base || hashOf(uid, 16)}.vcf`;
}

/** Évalue un filtre `ContactCard/query` (conditions et opérateurs AND / OR / NOT) sur une fiche. */
function matches(card: ContactCardCreate & { addressBookIds?: Record<string, boolean> }, f: unknown): boolean {
  if (!isObject(f)) return true;
  if (typeof f.operator === 'string' && Array.isArray(f.conditions)) {
    const subs = f.conditions as unknown[];
    if (f.operator === 'AND') return subs.every((x) => matches(card, x));
    if (f.operator === 'OR') return subs.some((x) => matches(card, x));
    if (f.operator === 'NOT') return !subs.some((x) => matches(card, x));
    return false;
  }
  const c = f as ContactCardFilterCondition;
  if (c.inAddressBook && !card.addressBookIds?.[c.inAddressBook]) return false;
  if (c.kind && (card.kind ?? 'individual') !== c.kind) return false;
  if (c.uid && card.uid !== c.uid) return false;
  if (c.hasMember && !card.members?.[c.hasMember]) return false;
  if (c.text && !cardSearchText(card).includes(foldText(c.text))) return false;
  if (c.name && !foldText([card.name?.full ?? '', ...(card.name?.components ?? []).map((x) => x.value)].join(' ')).includes(foldText(c.name))) return false;
  if (c.email && !cardEmails(card).some((e) => e.toLowerCase().includes(c.email!.toLowerCase()))) return false;
  if (c.phone && !Object.values(card.phones ?? {}).some((p) => p.number.replace(/\s/g, '').includes(c.phone!.replace(/\s/g, '')))) return false;
  return true;
}

export class CardDavFacade {
  private readonly dav: DavClient;
  private books: { at: number; list: DavBook[] } | null = null;
  private snap: { at: number; list: BookEntry[] } | null = null;
  private readonly cards = new Map<string, { etag: string; card: ContactCardCreate }>();
  /** Résultat de la vérification faite au premier `/imap/session` (null : pas encore vérifié). */
  available: boolean | null = null;

  constructor(private readonly opts: CardDavFacadeOptions) {
    this.dav = new DavClient(opts.serviceUrl, opts.username, opts.password, opts.fetch);
  }

  /** Vérification (découverte des carnets, authentifiée), 5 s au plus ; échec silencieux = capacité absente. */
  async probe(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const list = await this.dav.discoverBooks({ timeoutMs: PROBE_MS, signal: AbortSignal.timeout(PROBE_MS) });
      this.books = { at: Date.now(), list };
      this.available = list.length > 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** Capacités JMAP à annoncer (session), si la vérification a réussi. */
  sessionCapability(): { core: Record<string, Record<string, unknown>>; account: Record<string, Record<string, unknown>> } | null {
    if (!this.available) return null;
    return {
      core: { [CAP_CONTACTS]: {}, [CAP_CONTACTS_PARSE]: {} },
      account: { [CAP_CONTACTS]: { maxAddressBooksPerCard: 1, mayCreateAddressBook: false }, [CAP_CONTACTS_PARSE]: {} },
    };
  }

  // ---------------------------------------------------------------- lecture DAV

  private async listBooks(fresh = false): Promise<DavBook[]> {
    if (!fresh && this.books && Date.now() - this.books.at < BOOKS_TTL) return this.books.list;
    const list = await this.dav.discoverBooks();
    this.books = { at: Date.now(), list };
    return list;
  }

  /** Carnets et membres (href + ETag), gardés 3 s (plusieurs appels d'une même requête JMAP). */
  private async snapshot(fresh = false): Promise<BookEntry[]> {
    if (!fresh && this.snap && Date.now() - this.snap.at < SNAPSHOT_TTL) return this.snap.list;
    const books = await this.listBooks(fresh);
    const list = await Promise.all(books.map(async (book) => ({ id: bookIdOf(book.href), book, members: await this.dav.listMembers(book.href) })));
    this.snap = { at: Date.now(), list };
    return list;
  }

  private invalidate(): void {
    this.snap = null;
    if (this.books) this.books.at = 0;
  }

  private remember(href: string, etag: string, card: ContactCardCreate): void {
    if (this.cards.size >= MAX_CACHE) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(href, { etag, card });
  }

  /** Fiches des membres demandés : cache si l'ETag n'a pas changé, sinon `addressbook-multiget`. */
  private async loadCards(entry: BookEntry, members: DavMember[]): Promise<Map<string, ContactCardCreate>> {
    const out = new Map<string, ContactCardCreate>();
    const missing: string[] = [];
    for (const m of members) {
      const hit = this.cards.get(m.href);
      if (hit && hit.etag === m.etag) out.set(m.href, hit.card);
      else missing.push(m.href);
    }
    if (missing.length) {
      for (const r of await this.dav.multiget(entry.book.href, missing)) {
        let card: ContactCardCreate;
        try {
          card = vcardToCard(r.data);
        } catch {
          continue; // vCard illisible : ignorée
        }
        const etag = r.etag || members.find((m) => m.href === r.href)?.etag || '';
        this.remember(r.href, etag, card);
        out.set(r.href, card);
      }
    }
    return out;
  }

  private stateOf(list: BookEntry[]): string {
    const b: EncodedState['b'] = {};
    let n = 0;
    for (const e of list) {
      if (e.book.supportsSync && e.book.syncToken) b[e.id] = { t: e.book.syncToken };
      else {
        b[e.id] = { e: Object.fromEntries(e.members.map((m) => [cardIdOf(m.href), etagKey(m.etag)])) };
        n += e.members.length;
      }
    }
    // trop de fiches sans sync-collection : état réduit à une empreinte (…/changes impossible)
    if (n > MAX_STATE_ENTRIES) return `h${hashOf(JSON.stringify(b), 20)}`;
    return encodeState({ v: 1, b });
  }

  private static jmapCard(id: string, bookId: string, card: ContactCardCreate): Record<string, unknown> {
    return { ...card, id, addressBookIds: { [bookId]: true } };
  }

  private static pick(obj: Record<string, unknown>, props: Set<string> | null): Record<string, unknown> {
    return props ? Object.fromEntries(Object.entries(obj).filter(([k]) => props.has(k))) : obj;
  }

  /** Toutes les fiches (ou celles des ids demandés), au format JMAP. */
  private async cardsOf(list: BookEntry[], ids: string[] | null): Promise<Array<{ id: string; href: string; etag: string; entry: BookEntry; card: Record<string, unknown> }>> {
    const want = ids ? new Set(ids) : null;
    const out: Array<{ id: string; href: string; etag: string; entry: BookEntry; card: Record<string, unknown> }> = [];
    for (const entry of list) {
      const members = want ? entry.members.filter((m) => want.has(cardIdOf(m.href))) : entry.members;
      if (!members.length) continue;
      const loaded = await this.loadCards(entry, members);
      for (const m of members) {
        const card = loaded.get(m.href);
        if (!card) continue;
        const id = cardIdOf(m.href);
        out.push({ id, href: m.href, etag: m.etag, entry, card: CardDavFacade.jmapCard(id, entry.id, card) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- AddressBook

  private static booksState(list: BookEntry[] | Array<{ id: string; book: DavBook }>): string {
    const rows = list.map((e) => [e.id, hashOf(JSON.stringify([e.book.name, e.book.description, e.book.mayWrite]), 8)]);
    return `a${Buffer.from(JSON.stringify(rows)).toString('base64url')}`;
  }

  private static bookJson(e: { id: string; book: DavBook }, i: number): Record<string, unknown> {
    return {
      id: e.id,
      name: e.book.name,
      description: e.book.description,
      sortOrder: i,
      isDefault: i === 0,
      isSubscribed: true,
      shareWith: null,
      myRights: { mayRead: true, mayWrite: e.book.mayWrite, mayDelete: false, mayShare: false },
    };
  }

  async addressBookGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const books = (await this.listBooks()).map((book) => ({ id: bookIdOf(book.href), book }));
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    const props = Array.isArray(args.properties) ? new Set(['id', ...(args.properties as string[])]) : null;
    const all = books.map((b, i) => CardDavFacade.bookJson(b, i));
    return {
      state: CardDavFacade.booksState(books),
      list: (ids ? all.filter((b) => ids.includes(b.id as string)) : all).map((b) => CardDavFacade.pick(b, props)),
      notFound: ids ? ids.filter((id) => !books.some((b) => b.id === id)) : [],
    };
  }

  async addressBookChanges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const since = typeof args.sinceState === 'string' && args.sinceState.startsWith('a') ? args.sinceState : null;
    let old: Array<[string, string]>;
    try {
      old = since ? (JSON.parse(Buffer.from(since.slice(1), 'base64url').toString('utf8')) as Array<[string, string]>) : [];
      if (!since || !Array.isArray(old)) throw new Error('bad state');
    } catch {
      throw new MethodError('cannotCalculateChanges');
    }
    const books = (await this.listBooks(true)).map((book) => ({ id: bookIdOf(book.href), book }));
    const now = new Map(JSON.parse(Buffer.from(CardDavFacade.booksState(books).slice(1), 'base64url').toString('utf8')) as Array<[string, string]>);
    const before = new Map(old);
    return {
      oldState: since,
      newState: CardDavFacade.booksState(books),
      hasMoreChanges: false,
      created: [...now.keys()].filter((id) => !before.has(id)),
      updated: [...now.keys()].filter((id) => before.has(id) && before.get(id) !== now.get(id)),
      destroyed: [...before.keys()].filter((id) => !now.has(id)),
    };
  }

  // ---------------------------------------------------------------- ContactCard

  async get(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.snapshot();
    const ids = Array.isArray(args.ids) ? (args.ids as string[]) : null;
    const props = Array.isArray(args.properties) ? new Set(['id', ...(args.properties as string[])]) : null;
    const found = await this.cardsOf(list, ids);
    return {
      state: this.stateOf(list),
      list: found.map((f) => CardDavFacade.pick(f.card, props)),
      notFound: ids ? ids.filter((id) => !found.some((f) => f.id === id)) : [],
    };
  }

  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = await this.snapshot();
    const all = await this.cardsOf(list, null);
    // filtre « text » et autres conditions évalués en mémoire sur les carnets
    let rows = all.filter((f) => matches(f.card as ContactCardCreate, args.filter));
    const sort = Array.isArray(args.sort) ? (args.sort as Array<{ property?: string; isAscending?: boolean }>)[0] : undefined;
    const key = sort?.property === 'updated' || sort?.property === 'created' ? (f: (typeof rows)[number]) => String(f.card.updated ?? '') : (f: (typeof rows)[number]) => cardSortKey(f.card as ContactCardCreate);
    rows = [...rows].sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
    if (sort?.isAscending === false) rows.reverse();
    const position = typeof args.position === 'number' ? Math.max(0, args.position) : 0;
    const limit = typeof args.limit === 'number' ? Math.max(0, args.limit) : rows.length;
    return {
      queryState: this.stateOf(list),
      canCalculateChanges: false,
      position,
      ids: rows.slice(position, position + limit).map((r) => r.id),
      ...(args.calculateTotal ? { total: rows.length } : {}),
    };
  }

  async changes(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const old = decodeState(args.sinceState);
    if (!old) throw new MethodError('cannotCalculateChanges');
    const books = await this.listBooks(true);
    const created: string[] = [];
    const updated: string[] = [];
    const destroyed: string[] = [];
    const next: EncodedState = { v: 1, b: {} };
    for (const book of books) {
      const id = bookIdOf(book.href);
      const prev = old.b[id];
      if (prev?.t && book.supportsSync) {
        const r = await this.dav.syncCollection(book.href, prev.t);
        if ('invalidToken' in r) throw new MethodError('cannotCalculateChanges');
        // sync-collection ne distingue pas création et modification : tout est rendu dans `updated`
        for (const m of r.changed) updated.push(cardIdOf(m.href));
        for (const h of r.removed) destroyed.push(cardIdOf(h));
        next.b[id] = { t: r.token ?? book.syncToken ?? prev.t };
        continue;
      }
      const members = await this.dav.listMembers(book.href);
      const now = Object.fromEntries(members.map((m) => [cardIdOf(m.href), etagKey(m.etag)]));
      const before = prev?.e ?? {};
      for (const [cid, tag] of Object.entries(now)) {
        if (!(cid in before)) created.push(cid);
        else if (before[cid] !== tag) updated.push(cid);
      }
      for (const cid of Object.keys(before)) if (!(cid in now)) destroyed.push(cid);
      if (book.supportsSync && book.syncToken) next.b[id] = { t: book.syncToken };
      else next.b[id] = { e: now };
    }
    for (const [bid, prev] of Object.entries(old.b)) {
      if (books.some((b) => bookIdOf(b.href) === bid)) continue;
      // carnet disparu : ses fiches ne sont connues que sans jeton de synchronisation
      if (!prev.e) throw new MethodError('cannotCalculateChanges');
      destroyed.push(...Object.keys(prev.e));
    }
    this.snap = null;
    return {
      oldState: args.sinceState,
      newState: encodeState(next),
      hasMoreChanges: false,
      created,
      updated: updated.filter((id) => !created.includes(id)),
      destroyed,
      updatedProperties: null,
    };
  }

  async set(args: Record<string, unknown>, resolveId: (id: string) => string, onCreated: (cid: string, id: string) => void): Promise<Record<string, unknown>> {
    const before = await this.snapshot(true);
    const oldState = this.stateOf(before);
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    const byBook = new Map(before.map((e) => [e.id, e]));
    const locate = (id: string) => {
      for (const e of before) {
        const m = e.members.find((x) => cardIdOf(x.href) === id);
        if (m) return { entry: e, member: m };
      }
      return null;
    };
    const targetBook = (ids: unknown): BookEntry => {
      if (ids === undefined || ids === null) {
        const def = before[0];
        if (!def) throw new SetError('invalidProperties', 'no address book', ['addressBookIds']);
        return def;
      }
      if (!isObject(ids)) throw new SetError('invalidProperties', 'addressBookIds must be an object', ['addressBookIds']);
      const on = Object.entries(ids)
        .filter(([, v]) => v === true)
        .map(([k]) => resolveId(k));
      if (on.length !== 1) throw new SetError('invalidProperties', 'exactly one address book is supported', ['addressBookIds']);
      const e = byBook.get(on[0]!);
      if (!e) throw new SetError('invalidProperties', 'unknown address book', ['addressBookIds']);
      if (!e.book.mayWrite) throw new SetError('forbidden', 'address book is read-only', ['addressBookIds']);
      return e;
    };
    const toVcard = (card: Record<string, unknown>) => {
      const { id: _id, addressBookIds: _books, ...rest } = card;
      void _id;
      void _books;
      return { text: cardToVcard(rest as ContactCardCreate), card: rest as ContactCardCreate };
    };
    /** Crée la ressource (nom tiré de l'uid ; suffixe aléatoire si le nom est déjà pris). */
    const createIn = async (entry: BookEntry, card: Record<string, unknown>): Promise<{ href: string; etag: string | null; card: ContactCardCreate }> => {
      const v = toVcard(card);
      const uid = typeof v.card.uid === 'string' && v.card.uid ? v.card.uid : newCardUid();
      v.card.uid = uid;
      const text = cardToVcard(v.card);
      let name = fileNameFor(uid);
      for (let attempt = 0; attempt < 3; attempt++) {
        const href = this.dav.resolve(encodeURIComponent(name), entry.book.href).href;
        const r = await this.dav.put(href, text, null);
        if (r !== 'conflict') return { href, etag: r.etag, card: v.card };
        name = `${hashOf(`${uid}:${Date.now()}:${attempt}`, 12)}.vcf`;
      }
      throw new SetError('alreadyExists', 'could not create the contact');
    };

    for (const [cid, raw] of Object.entries(isObject(args.create) ? args.create : {})) {
      try {
        if (!isObject(raw)) throw new SetError('invalidProperties');
        if ('id' in raw) throw new SetError('invalidProperties', 'id is server-set', ['id']);
        const entry = targetBook(raw.addressBookIds);
        const r = await createIn(entry, raw);
        const id = cardIdOf(r.href);
        if (r.etag) this.remember(r.href, r.etag, r.card);
        onCreated(cid, id);
        created[cid] = { id, uid: r.card.uid, addressBookIds: { [entry.id]: true } };
      } catch (e) {
        if (!(e instanceof SetError)) throw e;
        notCreated[cid] = e.toJSON();
      }
    }

    for (const [rawId, patch] of Object.entries(isObject(args.update) ? args.update : {})) {
      const id = resolveId(rawId);
      try {
        if (!isObject(patch)) throw new SetError('invalidPatch');
        const loc = locate(id);
        if (!loc) throw new SetError('notFound');
        const current = (await this.cardsOf([{ ...loc.entry, members: [loc.member] }], [id]))[0];
        if (!current) throw new SetError('notFound');
        if ('id' in patch || 'uid' in patch) throw new SetError('invalidProperties', 'id and uid are immutable', ['id' in patch ? 'id' : 'uid']);
        const next = applyPatch(current.card, patch);
        const dest = targetBook(next.addressBookIds);
        if (dest.id === loc.entry.id) {
          const v = toVcard(next);
          const r = await this.dav.put(loc.member.href, v.text, loc.member.etag || null);
          if (r === 'conflict') throw new SetError('stateMismatch', 'the contact was changed on the server (ETag)');
          if (r.etag) this.remember(loc.member.href, r.etag, v.card);
          else this.cards.delete(loc.member.href);
          updated[id] = null;
        } else {
          // déplacement : écriture dans le carnet cible, puis suppression de l'ancienne ressource (même ETag)
          const r = await createIn(dest, next);
          const del = await this.dav.delete(loc.member.href, loc.member.etag || null);
          if (del === 'conflict') {
            await this.dav.delete(r.href, r.etag).catch(() => undefined);
            throw new SetError('stateMismatch', 'the contact was changed on the server (ETag)');
          }
          this.cards.delete(loc.member.href);
          if (r.etag) this.remember(r.href, r.etag, r.card);
          updated[id] = { id: cardIdOf(r.href) };
        }
      } catch (e) {
        if (!(e instanceof SetError)) throw e;
        notUpdated[id] = e.toJSON();
      }
    }

    for (const rawId of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) {
      const id = resolveId(rawId);
      try {
        const loc = locate(id);
        if (!loc) throw new SetError('notFound');
        const r = await this.dav.delete(loc.member.href, loc.member.etag || null);
        if (r === 'conflict') throw new SetError('stateMismatch', 'the contact was changed on the server (ETag)');
        this.cards.delete(loc.member.href);
        destroyed.push(id);
      } catch (e) {
        if (!(e instanceof SetError)) throw e;
        notDestroyed[id] = e.toJSON();
      }
    }

    this.invalidate();
    const changed = Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0;
    const newState = changed ? this.stateOf(await this.snapshot(true)) : oldState;
    return {
      oldState,
      newState,
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }

  /**
   * `ContactCard/parse` : vCard téléversées → fiches (sans les créer). Une vCard : la fiche (comme Stalwart) ;
   * plusieurs : un tableau (RFC 9610) ; aucune : `notParsable`.
   */
  async parse(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(args.blobIds) ? (args.blobIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const props = Array.isArray(args.properties) ? new Set(args.properties as string[]) : null;
    const parsed: Record<string, unknown> = {};
    const notParsable: string[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const buf = await this.opts.loadUpload(id);
      if (!buf) {
        notFound.push(id);
        continue;
      }
      if (buf.length > MAX_VCF) {
        notParsable.push(id);
        continue;
      }
      const { cards } = parseVcf(buf.toString('utf8'));
      if (!cards.length) {
        notParsable.push(id);
        continue;
      }
      const shaped = cards.map((c) => CardDavFacade.pick(c as Record<string, unknown>, props));
      parsed[id] = shaped.length === 1 ? shaped[0] : shaped;
    }
    return {
      parsed: Object.keys(parsed).length ? parsed : null,
      notParsable: notParsable.length ? notParsable : null,
      notFound: notFound.length ? notFound : null,
    };
  }

  close(): void {
    this.cards.clear();
    this.snap = null;
  }
}
