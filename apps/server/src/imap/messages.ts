/**
 * Messages IMAP ↔ objets Email/Thread JMAP : Email/get|query|set|changes|queryChanges,
 * Thread/get|changes, SearchSnippet/get, blobs de messages et de parties.
 */
import type { FetchMessageObject, ImapFlow, MessageAddressObject, SearchObject } from 'imapflow';
import type { KvStore } from '../backend/types.js';
import type { BlobStore } from './blobs.js';
import type { ChangeLog } from './changelog.js';
import { Folders, type Folder } from './folders.js';
import {
  composeMime,
  decodeCharset,
  decodeTransfer,
  findPart,
  hasRealAttachment,
  headerNameOf,
  headerProperty,
  headerValues,
  makePreview,
  parseHeaderBlock,
  parseMessageIds,
  splitBody,
  structureToPart,
  type BodyPart,
  type ComposeInput,
  type JmapAddress,
  type RawHeader,
} from './mime.js';
import type { ImapPool } from './pool.js';
import {
  bufferFromStream,
  chunk,
  decodeEmailId,
  encodeEmailId,
  hashOf,
  isObject,
  LRU,
  MethodError,
  SetError,
  setErrorOf,
  toSeqSet,
  unescapePointerToken,
  utcDate,
  type EmailKey,
} from './util.js';

// ------------------------------------------------------------------ constantes

const BASE_HEADERS = ['message-id', 'in-reply-to', 'references', 'list-unsubscribe', 'list-unsubscribe-post'];
const THREAD_HEADERS = ['message-id', 'in-reply-to', 'references'];
/** Taille max d'un dossier indexé en mémoire pour reconstituer les fils (au-delà : SEARCH HEADER). */
const INDEX_MAX = 5000;

const DEFAULT_PROPS = [
  'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'messageId', 'inReplyTo', 'references',
  'sender', 'from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'sentAt', 'hasAttachment', 'preview',
  'bodyValues', 'textBody', 'htmlBody', 'attachments',
];
const KNOWN_PROPS = new Set([...DEFAULT_PROPS, 'bodyStructure', 'headers']);
const DEFAULT_BODY_PROPS = ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'language', 'location'];
const BODY_PROPS_NEEDING_FETCH = new Set(['bodyValues', 'textBody', 'htmlBody', 'attachments', 'bodyStructure', 'hasAttachment', 'preview']);

const FLAG_TO_KW: Record<string, string> = { '\\seen': '$seen', '\\flagged': '$flagged', '\\answered': '$answered', '\\draft': '$draft' };
const KW_TO_FLAG: Record<string, string> = {
  $seen: '\\Seen',
  $flagged: '\\Flagged',
  $answered: '\\Answered',
  $draft: '\\Draft',
  $forwarded: '$Forwarded',
  $junk: '$Junk',
  $notjunk: '$NotJunk',
  $phishing: '$Phishing',
  $mdnsent: '$MDNSent',
};

export function flagsToKeywords(flags: Set<string> | undefined): Record<string, true> {
  const out: Record<string, true> = {};
  for (const f of flags ?? []) {
    const low = f.toLowerCase();
    if (FLAG_TO_KW[low]) out[FLAG_TO_KW[low]!] = true;
    else if (!low.startsWith('\\')) out[low] = true;
  }
  return out;
}

export function keywordToFlag(kw: string): string {
  const low = kw.toLowerCase();
  return KW_TO_FLAG[low] ?? kw;
}

function validKeyword(kw: string): boolean {
  return /^[\x21-\x7e]{1,255}$/.test(kw) && !/[()\]{%*"\\]/.test(kw);
}

// ------------------------------------------------------------------ types internes

interface StaticInfo {
  internalDate: number;
  size: number;
  envelope: FetchMessageObject['envelope'];
  root: BodyPart;
  textBody: BodyPart[];
  htmlBody: BodyPart[];
  attachments: BodyPart[];
  headers: RawHeader[];
  headerNames: Set<string>;
  threadId: string;
  preview?: string;
}

interface Located {
  id: string; // id demandé
  current: string; // id après résolution des alias
  key: EmailKey;
  folder: Folder;
}

interface QueryEntry {
  id: string;
  date: number;
  uid: number;
  folder: Folder;
}

interface QueryResult {
  entries: QueryEntry[];
  collapsed: string[] | null;
  rawCursor: number;
  seenThreads: Set<string>;
  complete: boolean;
}

export interface EmailEnvelopeInfo {
  from: JmapAddress[];
  to: JmapAddress[];
  cc: JmapAddress[];
  bcc: JmapAddress[];
  sender: JmapAddress[];
  messageId: string | null;
}

function addrList(list: MessageAddressObject[] | undefined): JmapAddress[] | null {
  const out = (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name || null, email: a.address! }));
  return out.length ? out : null;
}

function threadIdOf(headers: RawHeader[], fallback: string): { threadId: string; root: string } {
  const refs = parseMessageIds(headerValues(headers, 'references').at(-1));
  const irt = parseMessageIds(headerValues(headers, 'in-reply-to').at(-1));
  const mid = parseMessageIds(headerValues(headers, 'message-id').at(-1));
  const root = refs?.[0] ?? irt?.[0] ?? mid?.[0] ?? fallback;
  return { threadId: `T${hashOf(root, 14)}`, root };
}

function dateOf(d: Date | string | undefined): number {
  if (!d) return 0;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ------------------------------------------------------------------ classe principale

export class Messages {
  private statics = new LRU<string, StaticInfo>(3000);
  private bodies = new LRU<string, Map<string, string>>(200);
  private flags = new Map<string, { stamp: string; flags: Set<string> }>();
  private dates = new Map<string, Map<number, number>>(); // `${mbId}|${uidValidity}` → uid → date
  private threadOfEmail = new LRU<string, string>(50_000);
  private threadRoots = new LRU<string, string>(20_000);
  private threadMembers = new LRU<string, Set<string>>(5_000);
  private threadCache = new LRU<string, { state: string; emailIds: string[] }>(500);
  private queries = new LRU<string, QueryResult>(40);
  private aliases = new LRU<string, string>(5_000);
  private folderIndex = new Map<string, { stamp: string; uids: number[] }>();

  constructor(
    private readonly pool: ImapPool,
    private readonly folders: Folders,
    private readonly kv: KvStore,
    private readonly blobs: BlobStore,
    private readonly onChange: () => void,
  ) {}

  // ---------------------------------------------------------------- ids, alias, threads

  /** Suit les alias créés par les déplacements (un MOVE change l'UID et le dossier). */
  resolveAlias(id: string): string {
    let cur = id;
    for (let i = 0; i < 8; i++) {
      const next = this.aliases.get(cur) ?? this.kv.get(`al:${cur}`);
      if (!next || next === cur) break;
      if (!this.aliases.has(cur)) this.aliases.set(cur, next);
      cur = next;
    }
    return cur;
  }

  private addAlias(oldId: string, newId: string) {
    this.aliases.set(oldId, newId);
    this.kv.set(`al:${oldId}`, newId);
  }

  private rememberThread(emailId: string, threadId: string, root: string, persist: boolean) {
    this.threadOfEmail.set(emailId, threadId);
    const members = this.threadMembers.get(threadId) ?? new Set<string>();
    members.add(emailId);
    this.threadMembers.set(threadId, members);
    if (!this.threadRoots.has(threadId)) {
      this.threadRoots.set(threadId, root);
      if (persist && this.kv.get(`th:${threadId}`) !== root) this.kv.set(`th:${threadId}`, root);
    } else if (persist && this.kv.get(`th:${threadId}`) === undefined) this.kv.set(`th:${threadId}`, root);
  }

  private rootOf(threadId: string): string | undefined {
    const r = this.threadRoots.get(threadId) ?? this.kv.get(`th:${threadId}`);
    if (r) this.threadRoots.set(threadId, r);
    return r;
  }

  private dateMap(folder: Folder): Map<number, number> {
    const k = `${folder.id}|${folder.uidValidity}`;
    let m = this.dates.get(k);
    if (!m) {
      m = new Map();
      this.dates.set(k, m);
    }
    return m;
  }

  async locate(ids: string[]): Promise<{ found: Located[]; notFound: string[] }> {
    const list = await this.folders.list();
    const found: Located[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const current = typeof id === 'string' ? this.resolveAlias(id) : '';
      const key = decodeEmailId(current);
      const folder = key ? list.find((f) => f.id === key.mbId) : undefined;
      if (!key || !folder || folder.uidValidity !== key.uidValidity) notFound.push(id);
      else found.push({ id, current, key, folder });
    }
    return { found, notFound };
  }

  invalidateQueries() {
    this.queries.clear();
    this.threadCache.clear();
  }

  // ---------------------------------------------------------------- récupération IMAP

  private storeStatic(folder: Folder, m: FetchMessageObject, headerNames: string[]): StaticInfo {
    const id = encodeEmailId(folder.id, folder.uidValidity, m.uid);
    const root = m.bodyStructure
      ? structureToPart(m.bodyStructure, id)
      : structureToPart({ type: 'text/plain', part: '1', size: m.size ?? 0 }, id);
    const split = splitBody(root);
    const headers = parseHeaderBlock(m.headers);
    const { threadId, root: troot } = threadIdOf(headers, id);
    const prev = this.statics.get(id);
    const info: StaticInfo = {
      internalDate: dateOf(m.internalDate),
      size: m.size ?? 0,
      envelope: m.envelope,
      root,
      ...split,
      headers,
      headerNames: new Set(headerNames),
      threadId,
      ...(prev?.preview !== undefined ? { preview: prev.preview } : {}),
    };
    this.statics.set(id, info);
    this.dateMap(folder).set(m.uid, info.internalDate);
    this.rememberThread(id, threadId, troot, true);
    if (m.flags) this.flags.set(id, { stamp: Folders.stamp(folder), flags: m.flags });
    return info;
  }

  private async fetchStatic(c: ImapFlow, folder: Folder, uids: number[], headerNames: string[]): Promise<Set<number>> {
    const got = new Set<number>();
    for (const part of chunk(uids, 200)) {
      for await (const m of c.fetch(
        toSeqSet(part),
        { uid: true, flags: true, internalDate: true, size: true, envelope: true, bodyStructure: true, headers: headerNames },
        { uid: true },
      )) {
        this.storeStatic(folder, m, headerNames);
        got.add(m.uid);
      }
    }
    return got;
  }

  private async fetchFlags(c: ImapFlow, folder: Folder, uids: number[]): Promise<Set<number>> {
    const got = new Set<number>();
    const stamp = Folders.stamp(folder);
    for (const part of chunk(uids, 500)) {
      for await (const m of c.fetch(toSeqSet(part), { uid: true, flags: true }, { uid: true })) {
        this.flags.set(encodeEmailId(folder.id, folder.uidValidity, m.uid), { stamp, flags: m.flags ?? new Set() });
        got.add(m.uid);
      }
    }
    return got;
  }

  /** Dates de réception + clés de fil (en-têtes légers) ; mis en cache (immuables pour un UID). */
  private async fetchKeys(c: ImapFlow, folder: Folder, uids: number[], withThreads: boolean) {
    const dm = this.dateMap(folder);
    const need = uids.filter((u) => !dm.has(u) || (withThreads && !this.threadOfEmail.has(encodeEmailId(folder.id, folder.uidValidity, u))));
    for (const part of chunk(need, 1000)) {
      const query = withThreads ? { uid: true, internalDate: true, headers: THREAD_HEADERS } : { uid: true, internalDate: true };
      for await (const m of c.fetch(toSeqSet(part), query, { uid: true })) {
        dm.set(m.uid, dateOf(m.internalDate));
        if (withThreads) {
          const id = encodeEmailId(folder.id, folder.uidValidity, m.uid);
          const t = threadIdOf(parseHeaderBlock(m.headers), id);
          this.rememberThread(id, t.threadId, t.root, false);
        }
      }
    }
  }

  private previewPart(st: StaticInfo): BodyPart | undefined {
    return st.textBody.find((p) => p.type === 'text/plain') ?? st.htmlBody.find((p) => p.type === 'text/html') ?? st.textBody.find((p) => p.type.startsWith('text/'));
  }

  private async fetchPreviews(c: ImapFlow, folder: Folder, uids: number[]) {
    const groups = new Map<string, Array<{ uid: number; st: StaticInfo; part: BodyPart }>>();
    for (const uid of uids) {
      const st = this.statics.get(encodeEmailId(folder.id, folder.uidValidity, uid));
      if (!st || st.preview !== undefined) continue;
      const part = this.previewPart(st);
      if (!part?.partId) {
        st.preview = '';
        continue;
      }
      const list = groups.get(part.partId) ?? [];
      list.push({ uid, st, part });
      groups.set(part.partId, list);
    }
    for (const [partId, items] of groups) {
      const byUid = new Map(items.map((i) => [i.uid, i]));
      for (const part of chunk(items.map((i) => i.uid), 200)) {
        for await (const m of c.fetch(toSeqSet(part), { uid: true, bodyParts: [{ key: partId, maxLength: 4096 }] }, { uid: true })) {
          const it = byUid.get(m.uid);
          if (!it) continue;
          const raw = m.bodyParts?.get(partId) ?? m.bodyParts?.get(partId.toUpperCase()) ?? m.bodyParts?.values().next().value;
          if (!raw) {
            it.st.preview = '';
            continue;
          }
          const decoded = decodeCharset(decodeTransfer(raw, it.part.encoding ?? undefined, true), it.part.charset ?? undefined);
          it.st.preview = makePreview(decoded, it.part.type === 'text/html');
        }
      }
      for (const it of items) if (it.st.preview === undefined) it.st.preview = '';
    }
  }

  private async fetchBodyValues(c: ImapFlow, folder: Folder, uid: number, st: StaticInfo, parts: BodyPart[]): Promise<Map<string, string>> {
    const id = encodeEmailId(folder.id, folder.uidValidity, uid);
    const cache = this.bodies.get(id) ?? new Map<string, string>();
    const missing = parts.filter((p) => p.partId && !cache.has(p.partId));
    if (missing.length) {
      for await (const m of c.fetch(String(uid), { uid: true, bodyParts: missing.map((p) => p.partId!) }, { uid: true })) {
        for (const p of missing) {
          const raw = m.bodyParts?.get(p.partId!) ?? m.bodyParts?.get(p.partId!.toUpperCase());
          cache.set(p.partId!, raw ? decodeCharset(decodeTransfer(raw, p.encoding ?? undefined), p.charset ?? undefined) : '');
        }
      }
      this.bodies.set(id, cache);
    }
    if (st.preview === undefined) {
      const pp = this.previewPart(st);
      st.preview = pp?.partId && cache.has(pp.partId) ? makePreview(cache.get(pp.partId)!, pp.type === 'text/html') : st.preview;
    }
    return cache;
  }

  // ---------------------------------------------------------------- Email/get

  async get(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.folders.emailState();
    const ids = args.ids;
    if (ids === null || ids === undefined) throw new MethodError('requestTooLarge', 'ids: null is not supported, use Email/query');
    if (!Array.isArray(ids)) throw new MethodError('invalidArguments', 'ids must be an array');
    if (ids.length > 500) throw new MethodError('requestTooLarge', 'too many ids');
    // RFC 8620 §5.1 : « id » est toujours renvoyé, même s'il n'est pas demandé
    const props = Array.isArray(args.properties) ? [...new Set(['id', ...(args.properties as string[])])] : DEFAULT_PROPS;
    for (const p of props) if (!KNOWN_PROPS.has(p) && !p.startsWith('header:')) throw new MethodError('invalidArguments', `unknown property ${p}`);
    const bodyProps = Array.isArray(args.bodyProperties) ? (args.bodyProperties as string[]) : DEFAULT_BODY_PROPS;
    const fetchText = args.fetchTextBodyValues === true;
    const fetchHtml = args.fetchHTMLBodyValues === true;
    const fetchAll = args.fetchAllBodyValues === true;
    const maxBytes = typeof args.maxBodyValueBytes === 'number' && args.maxBodyValueBytes > 0 ? args.maxBodyValueBytes : 0;
    const wantBodyValues = props.includes('bodyValues') && (fetchText || fetchHtml || fetchAll);
    const needStructure = props.some((p) => BODY_PROPS_NEEDING_FETCH.has(p));
    const needKeywords = props.includes('keywords');
    const needPreview = props.includes('preview');
    const extraHeaders = props.map(headerNameOf).filter((x): x is string => !!x);
    const headerNames = [...new Set([...BASE_HEADERS, ...extraHeaders])];
    // propriétés sans en-têtes ni structure : un simple FETCH FLAGS suffit (et vérifie l'existence)
    const cheap = props.every((p) => p === 'id' || p === 'mailboxIds' || p === 'keywords');

    const { found, notFound } = await this.locate(ids as string[]);
    const byFolder = new Map<string, Located[]>();
    for (const l of found) {
      const list = byFolder.get(l.folder.id) ?? [];
      list.push(l);
      byFolder.set(l.folder.id, list);
    }
    const missing = new Set<string>();
    const bodyMaps = new Map<string, Map<string, string>>();
    {
      await Promise.all(
        [...byFolder.values()].map((group) =>
          this.pool.withMailbox(group[0]!.folder.path, async (c) => {
            const folder = group[0]!.folder;
            const mb = c.mailbox;
            if (!mb || mb.uidValidity !== folder.uidValidity) {
              group.forEach((g) => missing.add(g.id));
              return;
            }
            const needStatic = group.filter((g) => {
              if (cheap) return false;
              const st = this.statics.get(g.current);
              return !st || extraHeaders.some((h) => !st.headerNames.has(h));
            });
            const fetchedFlags = new Set<number>();
            if (needStatic.length) {
              const got = await this.fetchStatic(c, folder, needStatic.map((g) => g.key.uid), headerNames);
              for (const g of needStatic) {
                if (!got.has(g.key.uid)) missing.add(g.id);
                else fetchedFlags.add(g.key.uid);
              }
            }
            const alive = group.filter((g) => !missing.has(g.id));
            if (cheap) {
              const got = await this.fetchFlags(c, folder, alive.map((g) => g.key.uid));
              for (const g of alive) if (!got.has(g.key.uid)) missing.add(g.id);
            } else if (needKeywords) {
              const stamp = Folders.stamp(folder);
              const stale = alive.filter((g) => !fetchedFlags.has(g.key.uid) && this.flags.get(g.current)?.stamp !== stamp);
              if (stale.length) {
                const got = await this.fetchFlags(c, folder, stale.map((g) => g.key.uid));
                for (const g of stale) if (!got.has(g.key.uid)) missing.add(g.id);
              }
            }
            const alive2 = group.filter((g) => !missing.has(g.id));
            if (wantBodyValues) {
              for (const g of alive2) {
                const st = this.statics.get(g.current)!;
                let parts: BodyPart[] = [];
                if (fetchAll) parts = flattenLeaves(st.root).filter((p) => p.type.startsWith('text/'));
                else {
                  if (fetchText) parts.push(...st.textBody);
                  if (fetchHtml) parts.push(...st.htmlBody);
                  parts = parts.filter((p) => p.type.startsWith('text/'));
                }
                bodyMaps.set(g.current, await this.fetchBodyValues(c, folder, g.key.uid, st, uniqueParts(parts)));
              }
            }
            if (needPreview) await this.fetchPreviews(c, folder, alive2.map((g) => g.key.uid));
          }),
        ),
      );
    }

    const list: Record<string, unknown>[] = [];
    for (const l of found) {
      if (missing.has(l.id)) {
        notFound.push(l.id);
        continue;
      }
      const st = this.statics.get(l.current);
      if (!st && needStructure) {
        notFound.push(l.id);
        continue;
      }
      list.push(this.build(l, st, props, bodyProps, bodyMaps.get(l.current), maxBytes));
    }
    void needStructure;
    return { state, list, notFound };
  }

  private build(
    l: Located,
    st: StaticInfo | undefined,
    props: string[],
    bodyProps: string[],
    bodyMap: Map<string, string> | undefined,
    maxBytes: number,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const env = st?.envelope;
    const part = (p: BodyPart): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (const k of bodyProps) {
        if (k === 'subParts') o.subParts = p.subParts ? p.subParts.map(part) : null;
        else if (k === 'headers') o.headers = [];
        else if (k in p) o[k] = (p as unknown as Record<string, unknown>)[k];
      }
      if (p.subParts && !('subParts' in o)) o.subParts = p.subParts.map(part);
      return o;
    };
    for (const p of props) {
      switch (p) {
        case 'id':
          out.id = l.current;
          break;
        case 'blobId':
          out.blobId = l.current;
          break;
        case 'threadId':
          out.threadId = st?.threadId ?? this.threadOfEmail.get(l.current) ?? `T${hashOf(l.current, 14)}`;
          break;
        case 'mailboxIds':
          out.mailboxIds = { [l.folder.id]: true };
          break;
        case 'keywords':
          out.keywords = flagsToKeywords(this.flags.get(l.current)?.flags);
          break;
        case 'size':
          out.size = st?.size ?? 0;
          break;
        case 'receivedAt':
          out.receivedAt = utcDate(st?.internalDate ?? 0);
          break;
        case 'sentAt':
          out.sentAt = env?.date ? utcDate(env.date) : null;
          break;
        case 'subject':
          out.subject = env?.subject ?? null;
          break;
        case 'from':
        case 'to':
        case 'cc':
        case 'bcc':
        case 'sender':
        case 'replyTo':
          out[p] = addrList(env?.[p]);
          break;
        case 'messageId':
          out.messageId = parseMessageIds(headerValues(st?.headers ?? [], 'message-id').at(-1)) ?? (env?.messageId ? parseMessageIds(env.messageId) : null);
          break;
        case 'inReplyTo':
          out.inReplyTo = parseMessageIds(headerValues(st?.headers ?? [], 'in-reply-to').at(-1)) ?? (env?.inReplyTo ? parseMessageIds(env.inReplyTo) : null);
          break;
        case 'references':
          out.references = parseMessageIds(headerValues(st?.headers ?? [], 'references').at(-1));
          break;
        case 'hasAttachment':
          out.hasAttachment = st ? hasRealAttachment(st.attachments) : false;
          break;
        case 'preview':
          out.preview = st?.preview ?? '';
          break;
        case 'bodyStructure':
          out.bodyStructure = st ? part(st.root) : null;
          break;
        case 'textBody':
          out.textBody = st ? st.textBody.map(part) : [];
          break;
        case 'htmlBody':
          out.htmlBody = st ? st.htmlBody.map(part) : [];
          break;
        case 'attachments':
          out.attachments = st ? st.attachments.map(part) : [];
          break;
        case 'bodyValues': {
          const bv: Record<string, unknown> = {};
          for (const [pid, value] of bodyMap ?? []) {
            let v = value;
            let truncated = false;
            if (maxBytes && Buffer.byteLength(v) > maxBytes) {
              v = Buffer.from(v).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
              truncated = true;
            }
            bv[pid] = { value: v, isEncodingProblem: false, isTruncated: truncated };
          }
          out.bodyValues = bv;
          break;
        }
        case 'headers':
          out.headers = (st?.headers ?? []).map((h) => ({ name: h.name, value: ` ${h.value}` }));
          break;
        default:
          if (p.startsWith('header:')) out[p] = headerProperty(st?.headers ?? [], p);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Email/query

  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sort = Array.isArray(args.sort) ? (args.sort as Array<{ property?: string; isAscending?: boolean }>) : [];
    for (const s of sort) if (s.property !== 'receivedAt' && s.property !== 'sentAt') throw new MethodError('unsupportedSort', `cannot sort by ${s.property}`);
    const asc = sort[0]?.isAscending === true;
    const collapse = args.collapseThreads === true;
    const filter = (args.filter ?? null) as Record<string, unknown> | null;
    const state = await this.folders.emailState();
    const key = `${state}|${JSON.stringify({ filter, asc, collapse })}`;
    let q = this.queries.get(key);
    if (!q) {
      q = { entries: await this.runSearch(filter, asc), collapsed: collapse ? [] : null, rawCursor: 0, seenThreads: new Set(), complete: !collapse };
      this.queries.set(key, q);
    }
    let position = typeof args.position === 'number' ? Math.trunc(args.position) : 0;
    const limit = typeof args.limit === 'number' && args.limit >= 0 ? Math.min(Math.trunc(args.limit), 1000) : 256;
    const anchor = typeof args.anchor === 'string' ? this.resolveAlias(args.anchor) : null;

    let ids: string[];
    let total: number;
    if (collapse) {
      // dépliage progressif par lots ; complet si la liste est raisonnable (total exact)
      const want = anchor ? Number.MAX_SAFE_INTEGER : position >= 0 ? position + limit : Number.MAX_SAFE_INTEGER;
      const full = args.calculateTotal === true && q.entries.length <= 3000;
      await this.collapseUntil(q, full ? Number.MAX_SAFE_INTEGER : want);
      const list = q.collapsed!;
      total = q.complete ? list.length : q.entries.length;
      if (anchor) {
        const idx = list.indexOf(anchor);
        if (idx < 0) throw new MethodError('anchorNotFound');
        position = Math.max(0, idx + (typeof args.anchorOffset === 'number' ? args.anchorOffset : 0));
      } else if (position < 0) position = Math.max(0, list.length + position);
      ids = list.slice(position, position + limit);
    } else {
      const list = q.entries;
      total = list.length;
      if (anchor) {
        const idx = list.findIndex((e) => e.id === anchor);
        if (idx < 0) throw new MethodError('anchorNotFound');
        position = Math.max(0, idx + (typeof args.anchorOffset === 'number' ? args.anchorOffset : 0));
      } else if (position < 0) position = Math.max(0, total + position);
      ids = list.slice(position, position + limit).map((e) => e.id);
    }
    const res: Record<string, unknown> = { queryState: state, canCalculateChanges: false, position, ids };
    if (args.calculateTotal === true) res.total = total;
    if (typeof args.limit === 'number') res.limit = limit;
    return res;
  }

  private async collapseUntil(q: QueryResult, want: number) {
    while (!q.complete && q.collapsed!.length < want) {
      const batch = q.entries.slice(q.rawCursor, q.rawCursor + 300);
      if (!batch.length) {
        q.complete = true;
        break;
      }
      // clés de fil manquantes, par dossier
      const byFolder = new Map<string, QueryEntry[]>();
      for (const e of batch) {
        if (this.threadOfEmail.has(e.id)) continue;
        const l = byFolder.get(e.folder.id) ?? [];
        l.push(e);
        byFolder.set(e.folder.id, l);
      }
      await Promise.all(
        [...byFolder.values()].map((list) =>
          this.pool.withMailbox(list[0]!.folder.path, (c) => this.fetchKeys(c, list[0]!.folder, list.map((e) => e.uid), true)),
        ),
      );
      for (const e of batch) {
        q.rawCursor++;
        const t = this.threadOfEmail.get(e.id) ?? e.id;
        if (q.seenThreads.has(t)) continue;
        q.seenThreads.add(t);
        q.collapsed!.push(e.id);
        if (q.collapsed!.length >= want) break;
      }
      if (q.rawCursor >= q.entries.length) q.complete = true;
    }
  }

  private async runSearch(filter: Record<string, unknown> | null, asc: boolean): Promise<QueryEntry[]> {
    const folders = await this.folders.list();
    const dateBounds = topLevelDateBounds(filter);
    const tasks = folders.map((folder) => async () => {
      const compiled = filter ? compileFilter(filter, folder, (id) => id) : true;
      if (compiled === false || folder.messages === 0) return [] as QueryEntry[];
      return this.pool.withMailbox(folder.path, async (c) => {
        // vue en retard sur le relevé STATUS (messages arrivés par une autre connexion) : resynchronisation
        if (c.mailbox && c.mailbox.exists !== folder.messages) await c.noop();
        const mb = c.mailbox;
        const live: Folder = mb && mb.uidValidity !== folder.uidValidity ? { ...folder, uidValidity: mb.uidValidity } : folder;
        if (mb && mb.exists === 0) return [];
        const r = await c.search(compiled === true ? { all: true } : compiled, { uid: true });
        let uids = Array.isArray(r) ? r : [];
        if (uids.length > 20_000) uids = uids.sort((a, b) => b - a).slice(0, 20_000);
        await this.fetchKeys(c, live, uids, false);
        const dm = this.dateMap(live);
        return uids.map((uid) => ({ id: encodeEmailId(live.id, live.uidValidity, uid), uid, date: dm.get(uid) ?? 0, folder: live }));
      });
    });
    // parallélisme limité à la taille du pool
    const results: QueryEntry[][] = [];
    const queue = [...tasks];
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, async () => {
        for (let t = queue.shift(); t; t = queue.shift()) results.push(await t());
      }),
    );
    let entries = results.flat();
    if (dateBounds.before !== undefined) entries = entries.filter((e) => e.date < dateBounds.before!);
    if (dateBounds.after !== undefined) entries = entries.filter((e) => e.date >= dateBounds.after!);
    entries.sort((a, b) => (asc ? a.date - b.date || a.uid - b.uid : b.date - a.date || b.uid - a.uid));
    return entries;
  }

  async queryChanges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.folders.emailState();
    if (args.sinceQueryState === state) {
      const r = await this.query({ ...args, position: 0, limit: 0, calculateTotal: true });
      return { oldQueryState: state, newQueryState: state, removed: [], added: [], ...(args.calculateTotal ? { total: r.total } : {}) };
    }
    throw new MethodError('cannotCalculateChanges', 'IMAP facade cannot compute query changes');
  }

  /** Journal des changements (branché par la façade) ; sans lui, seul « aucun changement » est calculable. */
  changelog: ChangeLog | null = null;

  async changes(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.sinceState !== 'string') throw new MethodError('invalidArguments', 'sinceState required');
    const max = args.maxChanges == null ? null : Number(args.maxChanges);
    if (max !== null && (!Number.isInteger(max) || max <= 0)) throw new MethodError('invalidArguments', 'maxChanges must be a positive integer');
    // Un client qui demande des changements veut être tenu à jour : on active le journal (sans effet s'il l'est déjà).
    this.changelog?.activate();
    const state = await this.folders.emailState();
    if (args.sinceState === state) return { oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
    const r = this.changelog ? await this.changelog.changes(args.sinceState, max) : null;
    if (r) return { ...r };
    throw new MethodError('cannotCalculateChanges', 'state too old or unknown to the IMAP facade (restart or outside the change log)');
  }

  async threadChanges(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.folders.emailState();
    if (args.sinceState === state) return { oldState: state, newState: state, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
    throw new MethodError('cannotCalculateChanges', 'IMAP facade cannot compute thread changes');
  }

  // ---------------------------------------------------------------- Thread/get

  /** UID d'un dossier dont les clés de fil sont connues (mis à jour seulement si le dossier a changé). */
  private async ensureIndex(c: ImapFlow, folder: Folder): Promise<number[]> {
    const stamp = Folders.stamp(folder);
    const idx = this.folderIndex.get(folder.id);
    if (idx && idx.stamp === stamp) return idx.uids;
    const r = await c.search({ all: true }, { uid: true });
    let uids = (Array.isArray(r) ? r : []).sort((a, b) => a - b);
    if (uids.length > INDEX_MAX) uids = uids.slice(-INDEX_MAX);
    await this.fetchKeys(c, folder, uids, true);
    this.folderIndex.set(folder.id, { stamp, uids });
    return uids;
  }

  async threads(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.folders.emailState();
    if (!Array.isArray(args.ids)) throw new MethodError('invalidArguments', 'ids must be an array');
    const ids = [...new Set(args.ids as string[])];
    const folders = await this.folders.list();
    const sent = folders.find((f) => f.role === 'sent');
    const inbox = folders.find((f) => f.role === 'inbox');
    const result = new Map<string, string[]>();
    const notFound: string[] = [];
    const toSearch = new Map<string, Set<string>>(); // folderId → threadIds
    const roots = new Map<string, string>();
    for (const tid of ids) {
      const cached = this.threadCache.get(tid);
      if (cached && cached.state === state) {
        result.set(tid, cached.emailIds);
        continue;
      }
      const root = this.rootOf(tid);
      if (!root) {
        notFound.push(tid);
        continue;
      }
      roots.set(tid, root);
      const fids = new Set<string>();
      if (sent) fids.add(sent.id);
      const members = [...(this.threadMembers.get(tid) ?? [])].map((m) => decodeEmailId(this.resolveAlias(m))).filter((k): k is EmailKey => !!k);
      for (const k of members) fids.add(k.mbId);
      if (!members.length && inbox) fids.add(inbox.id);
      for (const fid of fids) {
        const s = toSearch.get(fid) ?? new Set<string>();
        s.add(tid);
        toSearch.set(fid, s);
      }
    }
    const foundBy = new Map<string, Array<{ id: string; date: number }>>();
    await Promise.all(
      [...toSearch.entries()].map(async ([fid, tids]) => {
        const folder = folders.find((f) => f.id === fid);
        if (!folder || folder.messages === 0) return;
        await this.pool.withMailbox(folder.path, async (c) => {
          const uids = new Set<number>();
          if (folder.messages <= INDEX_MAX) {
            // index des clés de fil du dossier (incrémental, en cache) : évite les SEARCH HEADER, lents
            for (const uid of await this.ensureIndex(c, folder)) uids.add(uid);
          } else for (const part of chunk([...tids], 20)) {
            const conds: SearchObject[] = [];
            for (const tid of part) {
              const root = roots.get(tid)!;
              const term = root.replace(/^<|>$/g, '');
              conds.push({ header: { 'message-id': term } }, { header: { references: term } }, { header: { 'in-reply-to': term } });
            }
            const r = await c.search(conds.length === 1 ? conds[0]! : { or: conds }, { uid: true });
            if (Array.isArray(r)) r.forEach((u) => uids.add(u));
          }
          if (!uids.size) return;
          await this.fetchKeys(c, folder, [...uids], true);
          const dm = this.dateMap(folder);
          for (const uid of uids) {
            const id = encodeEmailId(folder.id, folder.uidValidity, uid);
            const tid = this.threadOfEmail.get(id);
            if (!tid || !tids.has(tid)) continue;
            const l = foundBy.get(tid) ?? [];
            l.push({ id, date: dm.get(uid) ?? 0 });
            foundBy.set(tid, l);
          }
        });
      }),
    );
    for (const tid of roots.keys()) {
      let list = foundBy.get(tid) ?? [];
      if (!list.length) {
        // repli : membres connus encore présents
        const members = [...(this.threadMembers.get(tid) ?? [])].map((m) => this.resolveAlias(m));
        const { found } = await this.locate(members);
        list = found.map((f) => ({ id: f.current, date: this.dateMap(f.folder).get(f.key.uid) ?? 0 }));
      }
      if (!list.length) {
        notFound.push(tid);
        continue;
      }
      const uniq = [...new Map(list.map((x) => [x.id, x])).values()].sort((a, b) => a.date - b.date);
      const emailIds = uniq.map((x) => x.id);
      this.threadCache.set(tid, { state, emailIds });
      result.set(tid, emailIds);
    }
    const list = ids.filter((t) => result.has(t)).map((t) => ({ id: t, emailIds: result.get(t)! }));
    return { state, list, notFound };
  }

  // ---------------------------------------------------------------- SearchSnippet/get

  async snippets(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ids = Array.isArray(args.emailIds) ? (args.emailIds as string[]) : [];
    const r = await this.get({ ids, properties: ['id', 'subject', 'preview'] });
    const list = (r.list as Array<{ id: string; subject: string | null; preview: string }>).map((e) => ({ emailId: e.id, subject: null, preview: e.preview || null }));
    return { filter: args.filter ?? null, list, notFound: r.notFound };
  }

  // ---------------------------------------------------------------- Email/set

  async set(args: Record<string, unknown>, resolveId: (id: string) => string, onCreated: (cid: string, id: string) => void): Promise<Record<string, unknown>> {
    const oldState = await this.folders.emailState();
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    let updated: Record<string, unknown> = {};
    let notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    let changed = false;

    for (const [cid, obj] of isObject(args.create) ? Object.entries(args.create) : []) {
      try {
        const r = await this.create(obj, resolveId);
        onCreated(cid, r.id as string);
        created[cid] = r;
        changed = true;
      } catch (e) {
        notCreated[cid] = setErrorOf(e);
      }
    }

    if (isObject(args.update)) {
      const r = await this.update(args.update as Record<string, unknown>, resolveId);
      updated = r.updated;
      notUpdated = r.notUpdated;
      if (Object.keys(updated).length) changed = true;
    }

    if (Array.isArray(args.destroy)) {
      const r = await this.destroy((args.destroy as string[]).map((x) => ({ raw: x, id: resolveId(x) })));
      destroyed.push(...r.destroyed);
      Object.assign(notDestroyed, r.notDestroyed);
      if (r.destroyed.length) changed = true;
    }

    if (changed) {
      this.folders.invalidate();
      this.invalidateQueries();
      this.onChange();
    }
    return {
      oldState,
      newState: await this.folders.emailState(),
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }

  /** Contenu d'un blob (téléversé, message entier ou partie). */
  async loadBlob(blobId: string): Promise<{ data: Buffer; type: string } | null> {
    const up = await this.blobs.get(blobId);
    if (up) return up;
    const dot = blobId.indexOf('.');
    const emailPart = dot > 0 ? blobId.slice(0, dot) : blobId;
    const partId = dot > 0 ? blobId.slice(dot + 1) : null;
    if (partId !== null && !/^[0-9]+(\.[0-9]+)*$/.test(partId)) return null;
    const { found } = await this.locate([emailPart]);
    const l = found[0];
    if (!l) return null;
    return this.pool.withMailbox(l.folder.path, async (c) => {
      if (!c.mailbox || c.mailbox.uidValidity !== l.folder.uidValidity) return null;
      if (!partId) {
        const d = await c.download(String(l.key.uid), undefined, { uid: true });
        if (!d.content) return null;
        return { data: await bufferFromStream(d.content), type: 'message/rfc822' };
      }
      let st = this.statics.get(l.current);
      if (!st) {
        await this.fetchStatic(c, l.folder, [l.key.uid], BASE_HEADERS);
        st = this.statics.get(l.current);
      }
      const part = st ? findPart(st.root, partId) : undefined;
      if (st && !part) return null;
      const d = await c.download(String(l.key.uid), partId, { uid: true, decodeText: false });
      if (!d.content) return null;
      return { data: await bufferFromStream(d.content), type: part?.type ?? d.meta?.contentType ?? 'application/octet-stream' };
    });
  }

  private async create(obj: unknown, resolveId: (id: string) => string): Promise<Record<string, unknown>> {
    if (!isObject(obj)) throw new SetError('invalidProperties', 'object expected');
    const mbIds = isObject(obj.mailboxIds) ? Object.keys(obj.mailboxIds).filter((k) => (obj.mailboxIds as Record<string, unknown>)[k]).map(resolveId) : [];
    if (!mbIds.length) throw new SetError('invalidProperties', 'mailboxIds required', ['mailboxIds']);
    const folders = await this.folders.list();
    const targets = mbIds.map((id) => folders.find((f) => f.id === id));
    if (targets.some((t) => !t)) throw new SetError('invalidProperties', 'mailbox not found', ['mailboxIds']);
    const keywords = isObject(obj.keywords) ? Object.keys(obj.keywords).filter((k) => (obj.keywords as Record<string, unknown>)[k]) : [];
    for (const k of keywords) if (!validKeyword(k)) throw new SetError('invalidProperties', `invalid keyword ${k}`, ['keywords']);

    const input = await this.composeInput(obj);
    const raw = await composeMime(input);
    const flags = keywords.map(keywordToFlag);
    const idate = typeof obj.receivedAt === 'string' ? new Date(obj.receivedAt) : new Date();
    const firstId = await this.appendTo(targets as Folder[], raw, flags, idate, input.messageId);
    const tid = threadIdOf(
      [
        ...(input.references?.length ? [{ name: 'References', value: input.references.map((r) => `<${r}>`).join(' ') }] : []),
        ...(input.inReplyTo?.length ? [{ name: 'In-Reply-To', value: input.inReplyTo.map((r) => `<${r}>`).join(' ') }] : []),
        { name: 'Message-ID', value: `<${input.messageId}>` },
      ],
      firstId,
    );
    this.rememberThread(firstId, tid.threadId, tid.root, true);
    return { id: firstId, blobId: firstId, threadId: tid.threadId, size: raw.length };
  }

  /** APPEND d'un message brut dans chaque dossier cible ; renvoie l'id du premier exemplaire. */
  private async appendTo(targets: Folder[], raw: Buffer, flags: string[], idate: Date, messageId: string | null): Promise<string> {
    let firstId = '';
    for (const folder of targets) {
      const res = await this.pool.use(async (c) => {
        const r = await c.append(folder.path, raw, flags, idate);
        if (!r) throw new SetError('serverFail', 'APPEND failed');
        let uid = r.uid;
        let uidValidity = r.uidValidity;
        if ((!uid || !uidValidity) && messageId) {
          // serveur sans UIDPLUS : on retrouve le message par son Message-ID
          const lock = await c.getMailboxLock(folder.path);
          try {
            const found = await c.search({ header: { 'message-id': messageId } }, { uid: true });
            uid = Array.isArray(found) && found.length ? Math.max(...found) : undefined;
            uidValidity = c.mailbox ? c.mailbox.uidValidity : undefined;
          } finally {
            lock.release();
          }
        }
        if (!uid || !uidValidity) throw new SetError('serverFail', 'cannot locate appended message');
        return { uid, uidValidity };
      });
      const id = encodeEmailId(folder.id, res.uidValidity, res.uid);
      this.dateMap({ ...folder, uidValidity: res.uidValidity }).set(res.uid, idate.getTime());
      if (!firstId) firstId = id;
    }
    return firstId;
  }

  // ---------------------------------------------------------------- Email/import

  /**
   * Email/import (RFC 8621 §4.8) : APPEND du blob téléversé (message RFC 5322 brut) dans les dossiers
   * demandés, avec ses mots-clés et sa date de réception.
   */
  async importEmails(args: Record<string, unknown>, onCreated: (cid: string, id: string) => void, resolveId: (id: string) => string): Promise<Record<string, unknown>> {
    const oldState = await this.folders.emailState();
    if (typeof args.ifInState === 'string' && args.ifInState !== oldState) throw new MethodError('stateMismatch');
    if (!isObject(args.emails)) throw new MethodError('invalidArguments', 'emails required');
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [cid, obj] of Object.entries(args.emails)) {
      try {
        if (!isObject(obj) || typeof obj.blobId !== 'string') throw new SetError('invalidProperties', 'blobId required', ['blobId']);
        const mbIds = isObject(obj.mailboxIds) ? Object.keys(obj.mailboxIds).filter((k) => (obj.mailboxIds as Record<string, unknown>)[k]).map(resolveId) : [];
        if (!mbIds.length) throw new SetError('invalidProperties', 'mailboxIds required', ['mailboxIds']);
        const folders = await this.folders.list();
        const targets = mbIds.map((id) => folders.find((f) => f.id === id));
        if (targets.some((t) => !t)) throw new SetError('invalidProperties', 'mailbox not found', ['mailboxIds']);
        const keywords = isObject(obj.keywords) ? Object.keys(obj.keywords).filter((k) => (obj.keywords as Record<string, unknown>)[k]) : [];
        for (const k of keywords) if (!validKeyword(k)) throw new SetError('invalidProperties', `invalid keyword ${k}`, ['keywords']);
        const blob = await this.loadBlob(resolveId(obj.blobId));
        if (!blob) throw new SetError('blobNotFound', `blob ${obj.blobId} not found`, ['blobId']);
        const end = blob.data.indexOf('\r\n\r\n');
        const end2 = end >= 0 ? end : blob.data.indexOf('\n\n');
        const headers = parseHeaderBlock(blob.data.subarray(0, end2 >= 0 ? end2 : Math.min(blob.data.length, 65536)));
        if (!headers.length) throw new SetError('invalidEmail', 'not an RFC 5322 message', ['blobId']);
        const messageId = parseMessageIds(headerValues(headers, 'message-id').at(-1))?.[0] ?? null;
        const idate = typeof obj.receivedAt === 'string' && !Number.isNaN(Date.parse(obj.receivedAt)) ? new Date(obj.receivedAt) : new Date();
        const id = await this.appendTo(targets as Folder[], blob.data, keywords.map(keywordToFlag), idate, messageId);
        const tid = threadIdOf(headers, id);
        this.rememberThread(id, tid.threadId, tid.root, true);
        onCreated(cid, id);
        created[cid] = { id, blobId: id, threadId: tid.threadId, size: blob.data.length };
      } catch (e) {
        notCreated[cid] = setErrorOf(e);
      }
    }
    if (Object.keys(created).length) {
      this.folders.invalidate();
      this.invalidateQueries();
      this.onChange();
    }
    return {
      oldState,
      newState: await this.folders.emailState(),
      created: Object.keys(created).length ? created : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
    };
  }

  private async composeInput(obj: Record<string, unknown>): Promise<ComposeInput & { messageId: string }> {
    const addrs = (k: string): JmapAddress[] | null => {
      const v = obj[k];
      if (v === undefined || v === null) return null;
      if (!Array.isArray(v)) throw new SetError('invalidProperties', `${k} must be an array`, [k]);
      return (v as Array<{ name?: string | null; email?: string }>).filter((a) => a && typeof a.email === 'string').map((a) => ({ name: a.name ?? null, email: a.email! }));
    };
    const ids = (k: string): string[] | null => (Array.isArray(obj[k]) ? (obj[k] as string[]).filter((x) => typeof x === 'string') : null);
    const bodyValues = isObject(obj.bodyValues) ? (obj.bodyValues as Record<string, { value?: string }>) : {};
    let text: string | null = null;
    let html: string | null = null;
    const attachments: ComposeInput['attachments'] = [];
    const valueOf = (p: Record<string, unknown>): string | null => {
      const pid = typeof p.partId === 'string' ? p.partId : null;
      if (!pid) return null;
      const v = bodyValues[pid]?.value;
      if (typeof v !== 'string') throw new SetError('invalidProperties', `missing bodyValues.${pid}`, ['bodyValues']);
      return v;
    };
    const addAttachment = async (p: Record<string, unknown>) => {
      const blobId = typeof p.blobId === 'string' ? p.blobId : '';
      const blob = await this.loadBlob(blobId);
      if (!blob) throw new SetError('blobNotFound', `blob ${blobId} not found`, ['attachments']);
      const cid = typeof p.cid === 'string' ? p.cid : null;
      attachments.push({
        filename: typeof p.name === 'string' ? p.name : null,
        content: blob.data,
        contentType: typeof p.type === 'string' && p.type ? p.type : blob.type,
        cid,
        inline: p.disposition === 'inline' || (!!cid && p.disposition !== 'attachment'),
      });
    };
    const textBody = Array.isArray(obj.textBody) ? (obj.textBody as Record<string, unknown>[]) : [];
    const htmlBody = Array.isArray(obj.htmlBody) ? (obj.htmlBody as Record<string, unknown>[]) : [];
    if (textBody.length || htmlBody.length) {
      for (const p of textBody) {
        const v = valueOf(p);
        if (v !== null) text = (text ?? '') + v;
      }
      for (const p of htmlBody) {
        const v = valueOf(p);
        if (v !== null) html = (html ?? '') + v;
      }
    } else if (isObject(obj.bodyStructure)) {
      const walk = async (p: Record<string, unknown>) => {
        const type = typeof p.type === 'string' ? p.type.toLowerCase() : '';
        if (Array.isArray(p.subParts)) {
          for (const s of p.subParts as Record<string, unknown>[]) await walk(s);
          return;
        }
        if (typeof p.partId === 'string') {
          const v = valueOf(p);
          if (type === 'text/html') html = (html ?? '') + (v ?? '');
          else text = (text ?? '') + (v ?? '');
        } else if (typeof p.blobId === 'string') await addAttachment(p);
      };
      await walk(obj.bodyStructure);
    }
    for (const a of Array.isArray(obj.attachments) ? (obj.attachments as Record<string, unknown>[]) : []) await addAttachment(a);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith('header:')) continue;
      const name = k.split(':')[1];
      if (name && typeof v === 'string') headers[name] = v.trim();
    }
    const from = addrs('from');
    const domain = from?.[0]?.email.split('@')[1] ?? 'localhost';
    const messageId = ids('messageId')?.[0] ?? `${randomUuid()}@${domain}`;
    return {
      from,
      to: addrs('to'),
      cc: addrs('cc'),
      bcc: addrs('bcc'),
      replyTo: addrs('replyTo'),
      sender: addrs('sender'),
      subject: typeof obj.subject === 'string' ? obj.subject : null,
      sentAt: typeof obj.sentAt === 'string' ? obj.sentAt : null,
      messageId,
      inReplyTo: ids('inReplyTo'),
      references: ids('references'),
      text,
      html,
      attachments,
      headers,
    };
  }

  private async update(
    update: Record<string, unknown>,
    resolveId: (id: string) => string,
  ): Promise<{ updated: Record<string, unknown>; notUpdated: Record<string, unknown> }> {
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const folders = await this.folders.list();
    interface Plan {
      raw: string;
      loc: Located;
      add: Set<string>;
      remove: Set<string>;
      setAll: Set<string> | null;
      targets: string[] | null; // dossiers finaux
    }
    const plans: Plan[] = [];
    const entries = Object.entries(update);
    const { found, notFound } = await this.locate(entries.map(([id]) => resolveId(id)));
    const locByResolved = new Map(found.map((l) => [l.id, l]));
    for (const id of notFound) {
      const raw = entries.find(([r]) => resolveId(r) === id)?.[0] ?? id;
      notUpdated[raw] = { type: 'notFound' };
    }
    for (const [raw, patch] of entries) {
      const loc = locByResolved.get(resolveId(raw));
      if (!loc) continue;
      try {
        if (!isObject(patch)) throw new SetError('invalidPatch');
        const plan: Plan = { raw, loc, add: new Set(), remove: new Set(), setAll: null, targets: null };
        let mbSet: Set<string> | null = null;
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'keywords') {
            if (!isObject(v)) throw new SetError('invalidProperties', 'keywords must be an object', ['keywords']);
            plan.setAll = new Set(Object.keys(v).filter((x) => v[x]));
          } else if (k.startsWith('keywords/')) {
            const kw = unescapePointerToken(k.slice(9));
            if (!validKeyword(kw)) throw new SetError('invalidProperties', `invalid keyword ${kw}`, ['keywords']);
            if (v === true) plan.add.add(kw);
            else if (v === null || v === false) plan.remove.add(kw);
            else throw new SetError('invalidPatch', `bad value for ${k}`);
          } else if (k === 'mailboxIds') {
            if (!isObject(v)) throw new SetError('invalidProperties', 'mailboxIds must be an object', ['mailboxIds']);
            mbSet = new Set(Object.keys(v).filter((x) => v[x]).map(resolveId));
          } else if (k.startsWith('mailboxIds/')) {
            const mid = resolveId(unescapePointerToken(k.slice(11)));
            mbSet ??= new Set([loc.folder.id]);
            if (v === true) mbSet.add(mid);
            else if (v === null || v === false) mbSet.delete(mid);
            else throw new SetError('invalidPatch', `bad value for ${k}`);
          } else throw new SetError('invalidProperties', `cannot update ${k}`, [k.split('/')[0]!]);
        }
        if (mbSet) {
          if (!mbSet.size) throw new SetError('invalidProperties', 'an email must belong to at least one mailbox', ['mailboxIds']);
          for (const mid of mbSet) if (!folders.some((f) => f.id === mid)) throw new SetError('invalidProperties', `mailbox ${mid} not found`, ['mailboxIds']);
          plan.targets = [...mbSet];
        }
        plans.push(plan);
      } catch (e) {
        notUpdated[raw] = setErrorOf(e);
      }
    }

    // par dossier source : mots-clés puis déplacements/copies
    const bySource = new Map<string, Plan[]>();
    for (const p of plans) {
      const l = bySource.get(p.loc.folder.id) ?? [];
      l.push(p);
      bySource.set(p.loc.folder.id, l);
    }
    await Promise.all(
      [...bySource.values()].map((group) =>
        this.pool.withMailbox(group[0]!.loc.folder.path, async (c) => {
          const folder = group[0]!.loc.folder;
          if (!c.mailbox || c.mailbox.uidValidity !== folder.uidValidity) {
            for (const p of group) notUpdated[p.raw] = { type: 'notFound' };
            return;
          }
          const failed = new Set<Plan>();
          // mots-clés : regroupement par (opération, drapeau)
          const ops = new Map<string, Plan[]>();
          for (const p of group) {
            if (p.setAll) {
              ops.set(`set:${p.loc.key.uid}`, [p]);
              continue;
            }
            for (const kw of p.add) ops.set(`add:${kw}`, [...(ops.get(`add:${kw}`) ?? []), p]);
            for (const kw of p.remove) ops.set(`rem:${kw}`, [...(ops.get(`rem:${kw}`) ?? []), p]);
          }
          for (const [op, ps] of ops) {
            const live = ps.filter((p) => !failed.has(p));
            if (!live.length) continue;
            const set = toSeqSet(live.map((p) => p.loc.key.uid));
            try {
              if (op.startsWith('set:')) {
                const flags = [...live[0]!.setAll!].map(keywordToFlag);
                await c.messageFlagsSet(set, flags, { uid: true });
              } else {
                const kw = op.slice(4);
                if (op.startsWith('add:')) await c.messageFlagsAdd(set, [keywordToFlag(kw)], { uid: true });
                else await c.messageFlagsRemove(set, [keywordToFlag(kw)], { uid: true });
              }
            } catch (e) {
              for (const p of live) {
                failed.add(p);
                notUpdated[p.raw] = setErrorOf(e);
              }
            }
          }
          // mise à jour locale des drapeaux en cache
          for (const p of group) {
            if (failed.has(p)) continue;
            const cur = this.flags.get(p.loc.current);
            if (!cur) continue;
            const next = new Set(cur.flags);
            if (p.setAll) {
              for (const f of [...next]) if (!f.startsWith('\\') || ['\\seen', '\\flagged', '\\answered', '\\draft'].includes(f.toLowerCase())) next.delete(f);
              for (const kw of p.setAll) next.add(keywordToFlag(kw));
            }
            for (const kw of p.add) next.add(keywordToFlag(kw));
            for (const kw of p.remove) for (const f of [...next]) if (f.toLowerCase() === keywordToFlag(kw).toLowerCase()) next.delete(f);
            this.flags.set(p.loc.current, { stamp: '', flags: next });
          }
          // déplacements : dossier final unique → MOVE ; plusieurs → COPY puis éventuellement MOVE
          const moves = new Map<string, Plan[]>();
          const copies = new Map<string, Plan[]>();
          for (const p of group) {
            if (failed.has(p) || !p.targets) continue;
            const others = p.targets.filter((t) => t !== folder.id);
            if (!others.length) continue;
            const keep = p.targets.includes(folder.id);
            const [first, ...rest] = others as [string, ...string[]];
            for (const t of rest) copies.set(t, [...(copies.get(t) ?? []), p]);
            if (keep) copies.set(first, [...(copies.get(first) ?? []), p]);
            else moves.set(first, [...(moves.get(first) ?? []), p]);
          }
          for (const [dest, ps] of copies) {
            const df = folders.find((f) => f.id === dest)!;
            try {
              await c.messageCopy(toSeqSet(ps.map((p) => p.loc.key.uid)), df.path, { uid: true });
            } catch (e) {
              for (const p of ps) {
                failed.add(p);
                notUpdated[p.raw] = setErrorOf(e);
              }
            }
          }
          for (const [dest, ps] of moves) {
            const live = ps.filter((p) => !failed.has(p));
            if (!live.length) continue;
            const df = folders.find((f) => f.id === dest)!;
            try {
              const r = await c.messageMove(toSeqSet(live.map((p) => p.loc.key.uid)), df.path, { uid: true });
              if (r && r.uidMap && r.uidValidity !== undefined) {
                for (const p of live) {
                  const nu = r.uidMap.get(p.loc.key.uid);
                  if (!nu) continue;
                  const newId = encodeEmailId(df.id, r.uidValidity, nu);
                  this.addAlias(p.loc.current, newId);
                  const st = this.statics.get(p.loc.current);
                  if (st) {
                    this.statics.set(newId, st);
                    this.rememberThread(newId, st.threadId, this.rootOf(st.threadId) ?? newId, false);
                  }
                  const fl = this.flags.get(p.loc.current);
                  if (fl) this.flags.set(newId, { stamp: '', flags: fl.flags });
                  const dt = this.dateMap(folder).get(p.loc.key.uid);
                  if (dt !== undefined) this.dateMap({ ...df, uidValidity: r.uidValidity }).set(nu, dt);
                }
              }
            } catch (e) {
              for (const p of live) {
                failed.add(p);
                notUpdated[p.raw] = setErrorOf(e);
              }
            }
          }
          for (const p of group) if (!failed.has(p)) updated[p.raw] = null;
        }),
      ),
    );
    return { updated, notUpdated };
  }

  async destroy(items: Array<{ raw: string; id: string }>): Promise<{ destroyed: string[]; notDestroyed: Record<string, unknown> }> {
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    const { found, notFound } = await this.locate(items.map((i) => i.id));
    for (const id of notFound) notDestroyed[items.find((i) => i.id === id)?.raw ?? id] = { type: 'notFound' };
    const rawOf = (l: Located) => items.find((i) => i.id === l.id)?.raw ?? l.id;
    const direct = found;
    const byFolder = new Map<string, Located[]>();
    for (const l of direct) byFolder.set(l.folder.id, [...(byFolder.get(l.folder.id) ?? []), l]);
    await Promise.all(
      [...byFolder.values()].map((group) =>
        this.pool.withMailbox(group[0]!.folder.path, async (c) => {
          if (!c.mailbox || c.mailbox.uidValidity !== group[0]!.folder.uidValidity) {
            for (const l of group) notDestroyed[rawOf(l)] = { type: 'notFound' };
            return;
          }
          const set = toSeqSet(group.map((l) => l.key.uid));
          const exist = await c.search({ uid: set }, { uid: true });
          const alive = new Set(Array.isArray(exist) ? exist : []);
          const live = group.filter((l) => alive.has(l.key.uid));
          for (const l of group) if (!alive.has(l.key.uid)) notDestroyed[rawOf(l)] = { type: 'notFound' };
          if (!live.length) return;
          try {
            await c.messageDelete(toSeqSet(live.map((l) => l.key.uid)), { uid: true });
            for (const l of live) {
              destroyed.push(rawOf(l));
              this.statics.delete(l.current);
              this.flags.delete(l.current);
              this.bodies.delete(l.current);
            }
          } catch (e) {
            for (const l of live) notDestroyed[rawOf(l)] = setErrorOf(e);
          }
        }),
      ),
    );
    return { destroyed, notDestroyed };
  }

  /** En-têtes d'adressage d'un message (pour l'enveloppe SMTP). */
  async envelopeOf(emailId: string): Promise<EmailEnvelopeInfo | null> {
    const r = await this.get({ ids: [emailId], properties: ['from', 'to', 'cc', 'bcc', 'sender', 'messageId'] });
    const e = (r.list as Array<Record<string, unknown>>)[0];
    if (!e) return null;
    const a = (k: string) => (e[k] as JmapAddress[] | null) ?? [];
    return { from: a('from'), to: a('to'), cc: a('cc'), bcc: a('bcc'), sender: a('sender'), messageId: (e.messageId as string[] | null)?.[0] ?? null };
  }
}

// ------------------------------------------------------------------ filtres → SEARCH

function flattenLeaves(p: BodyPart): BodyPart[] {
  if (p.subParts) return p.subParts.flatMap(flattenLeaves);
  return [p];
}

function uniqueParts(parts: BodyPart[]): BodyPart[] {
  const seen = new Set<string>();
  return parts.filter((p) => p.partId && !seen.has(p.partId) && seen.add(p.partId));
}

function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

type Compiled = SearchObject | boolean;

function andAll(list: Compiled[]): Compiled {
  if (list.some((x) => x === false)) return false;
  const objs = list.filter((x): x is SearchObject => x !== true);
  if (!objs.length) return true;
  // fusion des clés ; conflit → De Morgan (NOT (OR (NOT a) (NOT b)))
  const merged: SearchObject = {};
  const extra: SearchObject[] = [];
  for (const o of objs) {
    const conflict = Object.keys(o).some((k) => k in merged);
    if (conflict) extra.push(o);
    else Object.assign(merged, o);
  }
  if (!extra.length) return merged;
  const all = [merged, ...extra];
  return { not: { or: all.map((x) => ({ not: x })) } };
}

function orAll(list: Compiled[]): Compiled {
  if (list.some((x) => x === true)) return true;
  const objs = list.filter((x): x is SearchObject => x !== false);
  if (!objs.length) return false;
  if (objs.length === 1) return objs[0]!;
  return { or: objs };
}

function dayStr(t: number): Date {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Traduit un filtre JMAP en critères SEARCH pour un dossier donné (true = tout, false = rien). */
export function compileFilter(f: Record<string, unknown>, folder: Folder, resolveId: (id: string) => string): Compiled {
  if (typeof f.operator === 'string') {
    const subs = (Array.isArray(f.conditions) ? (f.conditions as Record<string, unknown>[]) : []).map((c) => compileFilter(c, folder, resolveId));
    switch (f.operator) {
      case 'AND':
        return andAll(subs);
      case 'OR':
        return orAll(subs);
      case 'NOT': {
        const o = orAll(subs);
        return o === true ? false : o === false ? true : { not: o };
      }
      default:
        throw new MethodError('unsupportedFilter', `unknown operator ${String(f.operator)}`);
    }
  }
  const parts: Compiled[] = [];
  for (const [k, v] of Object.entries(f)) {
    switch (k) {
      case 'inMailbox':
        parts.push(resolveId(String(v)) === folder.id);
        break;
      case 'inMailboxOtherThan':
        parts.push(!(Array.isArray(v) ? (v as string[]).map(resolveId) : []).includes(folder.id));
        break;
      case 'text':
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
      case 'subject':
      case 'body':
        if (typeof v === 'string' && v.trim()) parts.push({ [k]: v.trim() });
        break;
      case 'before': {
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) throw new MethodError('invalidArguments', 'bad before date');
        parts.push({ before: new Date(dayStr(t).getTime() + 2 * 86400_000) });
        break;
      }
      case 'after': {
        const t = Date.parse(String(v));
        if (Number.isNaN(t)) throw new MethodError('invalidArguments', 'bad after date');
        parts.push({ since: new Date(dayStr(t).getTime() - 86400_000) });
        break;
      }
      case 'minSize':
        parts.push({ larger: Math.max(0, Number(v) - 1) });
        break;
      case 'maxSize':
        parts.push({ smaller: Number(v) });
        break;
      case 'hasKeyword':
      case 'notKeyword': {
        const has = k === 'hasKeyword';
        const flag = keywordToFlag(String(v));
        const sys: Record<string, keyof SearchObject> = { '\\Seen': 'seen', '\\Flagged': 'flagged', '\\Answered': 'answered', '\\Draft': 'draft' };
        const key = sys[flag];
        if (key) parts.push({ [key]: has } as SearchObject);
        else parts.push(has ? { keyword: flag } : { unKeyword: flag });
        break;
      }
      case 'hasAttachment':
        parts.push(v ? { header: { 'content-type': 'multipart/mixed' } } : { not: { header: { 'content-type': 'multipart/mixed' } } });
        break;
      case 'header': {
        const arr = Array.isArray(v) ? (v as string[]) : [];
        if (!arr[0]) throw new MethodError('invalidArguments', 'header filter needs a name');
        parts.push({ header: { [arr[0].toLowerCase()]: arr[1] ?? true } });
        break;
      }
      case 'allInThreadHaveKeyword':
      case 'someInThreadHaveKeyword':
      case 'noneInThreadHaveKeyword':
        throw new MethodError('unsupportedFilter', `${k} is not supported`);
      default:
        throw new MethodError('unsupportedFilter', `unknown filter ${k}`);
    }
  }
  return andAll(parts);
}

/** Le filtre (y compris ses sous-conditions) utilise-t-il la clé `key` ? */
export function mentionsKey(filter: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!filter || typeof filter !== 'object') return false;
  if (key in filter) return true;
  return Array.isArray(filter.conditions) && (filter.conditions as Record<string, unknown>[]).some((c) => mentionsKey(c, key));
}

/** Bornes de date exactes appliquées après la recherche (seulement au premier niveau du filtre). */
function topLevelDateBounds(filter: Record<string, unknown> | null): { before?: number; after?: number } {
  const out: { before?: number; after?: number } = {};
  if (!filter) return out;
  const conds = filter.operator === 'AND' ? ((filter.conditions as Record<string, unknown>[]) ?? []) : filter.operator ? [] : [filter];
  for (const c of conds) {
    if (typeof c.before === 'string') {
      const t = Date.parse(c.before);
      if (!Number.isNaN(t)) out.before = Math.min(out.before ?? Infinity, t);
    }
    if (typeof c.after === 'string') {
      const t = Date.parse(c.after);
      if (!Number.isNaN(t)) out.after = Math.max(out.after ?? -Infinity, t);
    }
  }
  return out;
}
