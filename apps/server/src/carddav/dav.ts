/**
 * Client WebDAV / CardDAV / CalDAV léger (RFC 4918, RFC 6352, RFC 4791, RFC 6578) pour les façades Contacts
 * et Agenda des boîtes IMAP : PROPFIND, REPORT `sync-collection` (sinon `getctag` +
 * `getetag`), `addressbook-multiget` / `calendar-multiget`, `calendar-query` avec `time-range`, PUT et DELETE
 * avec `If-Match`. XML lu par `fast-xml-parser` (espaces de noms retirés). Un même client sert les deux
 * protocoles : `kind` (`card` ou `cal`) choisit la maison, le type de collection et le rapport multiget.
 *
 * Toutes les requêtes passent par `safeFetch` (netguard : https, hôte public vérifié à la connexion,
 * Authorization retiré sur une redirection vers une autre origine) ; port 443 seulement. Délais et tailles
 * bornés. Ni les identifiants ni les en-têtes ne sont journalisés.
 *
 * Comportements de Stalwart v1.0.1 relevés (2026-11-03) et pris en compte :
 * - `sync-collection` avec un jeton vide renvoie aussi la collection elle-même parmi les membres (filtrée) ;
 * - un jeton inconnu ne produit pas d'erreur `valid-sync-token` mais la liste complète ;
 * - `/.well-known/carddav` répond 307 vers `/dav/card`, dont le PROPFIND donne directement `addressbook-home-set`.
 */
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { BlockedHostError, safeFetch, type SafeFetchOptions } from '../netguard.js';

export type DavFetch = (url: string, opts: SafeFetchOptions) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const MAX_BODY = 20 * 1024 * 1024;
const MULTIGET_CHUNK = 100;

export class DavError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DavError';
  }
}

/** Identifiants refusés par le serveur CardDAV / CalDAV (401 / 403 sur la découverte). */
export class DavAuthError extends DavError {
  constructor() {
    super(401, 'DAV authentication failed');
    this.name = 'DavAuthError';
  }
}

/** URL du service : https, port 443 (sauf VOXEL_ALLOW_PRIVATE_HOSTS), sans identifiants ni fragment. */
export function parseDavUrl(raw: string | undefined): URL | null {
  if (!raw || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (!isAllowedDavUrl(u)) return null;
  return u;
}

export function isAllowedDavUrl(u: URL): boolean {
  if (config.allowPrivateHosts) return u.protocol === 'https:' || u.protocol === 'http:';
  return u.protocol === 'https:' && (u.port === '' || u.port === '443');
}

// ------------------------------------------------------------------ XML

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['response', 'propstat', 'href', 'privilege', 'supported-report'].includes(name),
});

export interface DavResponse {
  href: string;
  /** Statut global (`<status>` hors propstat), ex. 404 d'un multiget. */
  status: number | null;
  /** Propriétés trouvées (propstat 200). */
  props: Record<string, unknown>;
}

const statusCode = (s: unknown): number | null => {
  const m = typeof s === 'string' ? s.match(/\s(\d{3})\s?/) : null;
  return m ? Number(m[1]) : null;
};

/** `<multistatus>` → réponses (href, statut, propriétés 200) et `sync-token` éventuel. */
export function parseMultistatus(xml: string): { responses: DavResponse[]; syncToken: string | null } {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const ms = (doc.multistatus ?? {}) as Record<string, unknown>;
  const responses: DavResponse[] = [];
  for (const r of (ms.response as Array<Record<string, unknown>> | undefined) ?? []) {
    const href = String(((r.href as unknown[]) ?? [])[0] ?? '');
    const props: Record<string, unknown> = {};
    for (const ps of (r.propstat as Array<Record<string, unknown>> | undefined) ?? []) {
      const code = statusCode(ps.status);
      if (code !== null && (code < 200 || code >= 300)) continue;
      Object.assign(props, (ps.prop as Record<string, unknown>) ?? {});
    }
    responses.push({ href, status: statusCode(r.status), props });
  }
  const tok = ms['sync-token'];
  return { responses, syncToken: typeof tok === 'string' && tok ? tok : null };
}

/** Texte d'une propriété (chaîne ou objet vide). */
export function textProp(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Premier href contenu dans une propriété (`<current-user-principal><href>…`). */
export function hrefProp(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const h = (v as { href?: unknown[] }).href?.[0];
  return typeof h === 'string' && h ? h : null;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';
const NS_CAL = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

/** Collections d'un protocole : CardDAV (carnets) ou CalDAV (agendas). */
export type DavKind = 'card' | 'cal';
const KIND = {
  card: { ns: NS, home: 'addressbook-home-set', type: 'addressbook', description: 'addressbook-description', multiget: 'addressbook-multiget', data: 'address-data', extra: '' },
  cal: { ns: NS_CAL, home: 'calendar-home-set', type: 'calendar', description: 'calendar-description', multiget: 'calendar-multiget', data: 'calendar-data', extra: '<ic:calendar-color/><c:supported-calendar-component-set/>' },
} as const;

// ------------------------------------------------------------------ client

export interface DavBook {
  href: string;
  name: string;
  description: string | null;
  ctag: string | null;
  syncToken: string | null;
  supportsSync: boolean;
  mayWrite: boolean;
  /** CalDAV : couleur (`calendar-color` d'Apple, `#RRGGBB`). */
  color?: string | null;
  /** CalDAV : la collection accepte-t-elle des VEVENT (`supported-calendar-component-set`) ? */
  events?: boolean;
}

export interface DavMember {
  href: string;
  etag: string;
}

export class DavClient {
  private readonly auth: string;
  private readonly fetchImpl: DavFetch;

  constructor(
    readonly serviceUrl: URL,
    username: string,
    password: string,
    fetchImpl?: DavFetch,
  ) {
    this.auth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    this.fetchImpl = fetchImpl ?? safeFetch;
  }

  /** URL absolue d'un href (résolu par rapport au service), refusée si hors des règles (https, port 443). */
  resolve(href: string, base: URL | string = this.serviceUrl): URL {
    const u = new URL(href, base);
    if (!isAllowedDavUrl(u)) throw new BlockedHostError(u.host);
    return u;
  }

  private async request(
    method: string,
    url: URL,
    opts: { body?: string; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const res = await this.fetchImpl(url.href, {
      method,
      headers: { Authorization: this.auth, ...(opts.body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const text = await readLimited(res);
    if (res.status === 401) throw new DavAuthError();
    return { status: res.status, text, headers: res.headers };
  }

  private async multistatus(method: string, url: URL, body: string, depth: '0' | '1', opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const r = await this.request(method, url, { body, headers: { Depth: depth }, ...opts });
    if (r.status !== 207) throw new DavError(r.status, `${method} ${r.status}`);
    return parseMultistatus(r.text);
  }

  /**
   * Carnets du compte : principal (`current-user-principal`) → `addressbook-home-set` → collections
   * `addressbook` de la maison. Si l'URL du service est elle-même un carnet, il est le seul carnet.
   */
  async discoverBooks(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DavBook[]> {
    return this.discoverCollections('card', opts);
  }

  /** Agendas du compte (CalDAV) : comme les carnets, avec `calendar-home-set` ; seulement ceux qui acceptent les VEVENT. */
  async discoverCalendars(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DavBook[]> {
    return (await this.discoverCollections('cal', opts)).filter((c) => c.events !== false);
  }

  async discoverCollections(kind: DavKind, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DavBook[]> {
    const K = KIND[kind];
    const step1 = await this.multistatus(
      'PROPFIND',
      this.serviceUrl,
      `<?xml version="1.0" encoding="utf-8"?><d:propfind ${K.ns}><d:prop><d:current-user-principal/><c:${K.home}/><d:resourcetype/></d:prop></d:propfind>`,
      '0',
      opts,
    );
    const first = step1.responses[0];
    const base = first?.href ? this.resolve(first.href) : this.serviceUrl;
    let home = hrefProp(first?.props[K.home]);
    if (!home) {
      const principal = hrefProp(first?.props['current-user-principal']);
      if (principal) {
        const step2 = await this.multistatus(
          'PROPFIND',
          this.resolve(principal, base),
          `<?xml version="1.0" encoding="utf-8"?><d:propfind ${K.ns}><d:prop><c:${K.home}/></d:prop></d:propfind>`,
          '0',
          opts,
        );
        home = hrefProp(step2.responses[0]?.props[K.home]);
      }
    }
    const homeUrl = home ? this.resolve(home, base) : base;
    const listing = await this.multistatus(
      'PROPFIND',
      homeUrl,
      `<?xml version="1.0" encoding="utf-8"?><d:propfind ${K.ns}><d:prop><d:resourcetype/><d:displayname/><c:${K.description}/><cs:getctag/><d:sync-token/><d:supported-report-set/><d:current-user-privilege-set/>${K.extra}</d:prop></d:propfind>`,
      '1',
      opts,
    );
    const books: DavBook[] = [];
    for (const r of listing.responses) {
      const rt = r.props.resourcetype;
      if (!rt || typeof rt !== 'object' || !(K.type in rt)) continue;
      const url = this.resolve(r.href, homeUrl);
      const reports = JSON.stringify(r.props['supported-report-set'] ?? '');
      const privs = JSON.stringify(r.props['current-user-privilege-set'] ?? '');
      books.push({
        href: url.pathname.endsWith('/') ? url.href : `${url.href}/`,
        name: textProp(r.props.displayname) || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? ''),
        description: textProp(r.props[K.description]) || null,
        ctag: textProp(r.props.getctag) || null,
        syncToken: textProp(r.props['sync-token']) || null,
        supportsSync: reports.includes('sync-collection'),
        // sans privilèges annoncés : on suppose l'écriture possible (le serveur tranchera)
        mayWrite: !r.props['current-user-privilege-set'] || /"(all|write|write-content|bind)"/.test(privs),
        ...(kind === 'cal' ? { color: normalizeColor(textProp(r.props['calendar-color'])), events: supportsEvents(r.props['supported-calendar-component-set']) } : {}),
      });
    }
    return books;
  }

  /** Membres d'un carnet (href + ETag), par PROPFIND Depth 1. */
  async listMembers(bookHref: string): Promise<DavMember[]> {
    const book = this.resolve(bookHref);
    const ms = await this.multistatus('PROPFIND', book, `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`, '1');
    const out: DavMember[] = [];
    for (const r of ms.responses) {
      const url = this.resolve(r.href, book);
      if (sameCollection(url, book)) continue;
      const rt = r.props.resourcetype;
      if (rt && typeof rt === 'object' && 'collection' in rt) continue;
      const etag = textProp(r.props.getetag);
      if (etag) out.push({ href: url.href, etag });
    }
    return out;
  }

  /**
   * REPORT `sync-collection` (RFC 6578) : changements depuis `token` (vide = tout). `invalidToken` si le serveur
   * refuse le jeton (403/409 `valid-sync-token`).
   */
  async syncCollection(
    bookHref: string,
    token: string,
  ): Promise<{ changed: DavMember[]; removed: string[]; token: string | null } | { invalidToken: true }> {
    const book = this.resolve(bookHref);
    const r = await this.request('REPORT', book, {
      headers: { Depth: '0' },
      body: `<?xml version="1.0" encoding="utf-8"?><d:sync-collection ${NS}><d:sync-token>${xmlEscape(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
    });
    if (r.status === 403 || r.status === 409 || (r.status === 400 && /valid-sync-token/.test(r.text))) return { invalidToken: true };
    if (r.status !== 207) throw new DavError(r.status, `REPORT sync-collection ${r.status}`);
    const ms = parseMultistatus(r.text);
    const changed: DavMember[] = [];
    const removed: string[] = [];
    for (const res of ms.responses) {
      if (!res.href) continue;
      const url = this.resolve(res.href, book);
      if (sameCollection(url, book)) continue;
      if (res.status === 404) removed.push(url.href);
      else {
        const etag = textProp(res.props.getetag);
        if (etag) changed.push({ href: url.href, etag });
      }
    }
    return { changed, removed, token: ms.syncToken };
  }

  /** `addressbook-multiget` (ou `calendar-multiget`) : texte et ETag des membres demandés (absents : ignorés), par lots de 100. */
  async multiget(bookHref: string, hrefs: string[], kind: DavKind = 'card'): Promise<Array<DavMember & { data: string }>> {
    const K = KIND[kind];
    const book = this.resolve(bookHref);
    const out: Array<DavMember & { data: string }> = [];
    for (let i = 0; i < hrefs.length; i += MULTIGET_CHUNK) {
      const part = hrefs.slice(i, i + MULTIGET_CHUNK).map((h) => `<d:href>${xmlEscape(new URL(h, book).pathname)}</d:href>`);
      const ms = await this.multistatus(
        'REPORT',
        book,
        `<?xml version="1.0" encoding="utf-8"?><c:${K.multiget} ${K.ns}><d:prop><d:getetag/><c:${K.data}/></d:prop>${part.join('')}</c:${K.multiget}>`,
        '1',
      );
      for (const r of ms.responses) {
        if (r.status !== null && r.status !== 200) continue;
        const data = textProp(r.props[K.data]);
        const etag = textProp(r.props.getetag);
        if (data) out.push({ href: this.resolve(r.href, book).href, etag, data });
      }
    }
    return out;
  }

  /**
   * `calendar-query` (RFC 4791 §7.8) : VEVENT qui touchent la plage [start, end[ (UTC), avec leur ETag.
   * Le serveur développe lui-même les récurrences pour le filtre `time-range`.
   */
  async calendarQuery(calHref: string, range: { start?: Date; end?: Date } = {}): Promise<DavMember[]> {
    const cal = this.resolve(calHref);
    const fmt = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    const tr = range.start || range.end ? `<c:time-range${range.start ? ` start="${fmt(range.start)}"` : ''}${range.end ? ` end="${fmt(range.end)}"` : ''}/>` : '';
    const ms = await this.multistatus(
      'REPORT',
      cal,
      `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS_CAL}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${tr}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      '1',
    );
    const out: DavMember[] = [];
    for (const r of ms.responses) {
      if (!r.href) continue;
      const url = this.resolve(r.href, cal);
      if (sameCollection(url, cal)) continue;
      const etag = textProp(r.props.getetag);
      if (etag) out.push({ href: url.href, etag });
    }
    return out;
  }

  /**
   * Écrit une ressource (vCard par défaut, `text/calendar` pour CalDAV). `etag` : `If-Match` (mise à jour), `null` : `If-None-Match: *` (création).
   * Renvoie l'ETag (s'il est donné) ou `conflict` sur 412.
   */
  async put(href: string, data: string, etag: string | null, contentType = 'text/vcard; charset=utf-8'): Promise<{ etag: string | null } | 'conflict'> {
    const r = await this.request('PUT', this.resolve(href), {
      body: data,
      headers: { 'Content-Type': contentType, ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) },
    });
    if (r.status === 412) return 'conflict';
    if (r.status < 200 || r.status >= 300) throw new DavError(r.status, `PUT ${r.status}`);
    return { etag: r.headers.get('etag') };
  }

  /** Supprime une vCard (`If-Match` si l'ETag est connu) ; `conflict` sur 412, `gone` sur 404. */
  async delete(href: string, etag: string | null): Promise<'ok' | 'conflict' | 'gone'> {
    const r = await this.request('DELETE', this.resolve(href), { headers: etag ? { 'If-Match': etag } : {} });
    if (r.status === 412) return 'conflict';
    if (r.status === 404) return 'gone';
    if (r.status < 200 || r.status >= 300) throw new DavError(r.status, `DELETE ${r.status}`);
    return 'ok';
  }
}

/** `#RRGGBBAA` (Apple) → `#RRGGBB` ; autre valeur : `null`. */
function normalizeColor(v: string): string | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/**
 * `supported-calendar-component-set` : l'analyseur ignore les attributs (`<comp name="VEVENT"/>`), on ne peut donc
 * pas lire les noms ; on garde toute collection `calendar` (un agenda de tâches seules affiche simplement zéro
 * événement, et une écriture y serait refusée par le serveur).
 */
function supportsEvents(_v: unknown): boolean {
  return true;
}

function sameCollection(a: URL, b: URL): boolean {
  const n = (u: URL) => decodeURIComponent(u.pathname).replace(/\/+$/, '');
  return a.origin === b.origin && n(a) === n(b);
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new DavError(413, 'DAV response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
