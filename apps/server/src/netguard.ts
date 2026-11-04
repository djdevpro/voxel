/**
 * Garde-fous SSRF : le serveur ne contacte que des hôtes publics,
 * sauf VOXEL_ALLOW_PRIVATE_HOSTS=1 (réseau local, tests).
 *
 * - isPrivateIp : liste de refus IPv4 + IPv6 avec décodage des formes qui embarquent une IPv4
 *   (::ffff:a.b.c.d ou ::ffff:7f00:1, ::ffff:0:a.b.c.d, 6to4 2002::/16) ; ::/96, NAT64, Teredo refusés.
 *   Tout ce qui n'est pas de l'unicast global (2000::/3) est refusé, de même que ce qui n'est pas analysable.
 * - publicLookup : résolveur qui refuse les IP privées, utilisé AU MOMENT DE LA CONNEXION
 *   (fetch via un Agent undici, IMAP/SMTP via pinHost) ⇒ pas de contournement par DNS rebinding.
 */
import { lookup as dnsLookupCb, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';

export class BlockedHostError extends Error {
  constructor(host: string) {
    super(`host not allowed: ${host}`);
    this.name = 'BlockedHostError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isPrivateV4Int(n: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

/** Analyse une IPv6 (avec éventuelle IPv4 finale en notation pointée) en 8 mots de 16 bits ; null si invalide. */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s)) return null;
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = s.slice(lastColon + 1);
    if (lastColon < 0 || isIP(v4) !== 4) return null;
    const n = ipv4ToInt(v4);
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const toWords = (p: string) => (p === '' ? [] : p.split(':'));
  const head = toWords(parts[0]!);
  const rest = parts.length === 2 ? toWords(parts[1]!) : [];
  for (const w of [...head, ...rest]) if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
  const total = head.length + rest.length;
  if (parts.length === 1 ? total !== 8 : total > 7) return null;
  const zeros = new Array<number>(8 - total).fill(0);
  return [...head.map((w) => parseInt(w, 16)), ...zeros, ...rest.map((w) => parseInt(w, 16))];
}

function isPrivateV6(words: number[]): boolean {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words as [number, number, number, number, number, number, number, number];
  const v4 = ((w6 << 16) >>> 0) + w7;
  const firstFourZero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0;
  if (firstFourZero && w4 === 0 && w5 === 0xffff) return isPrivateV4Int(v4); // ::ffff:0:0/96 (IPv4 mappée)
  if (firstFourZero && w4 === 0xffff && w5 === 0) return isPrivateV4Int(v4); // ::ffff:0:0:0/96 (traduite)
  if (firstFourZero && w4 === 0 && w5 === 0) return true; // ::/96 (compatible IPv4, ::, ::1) : jamais légitime
  if (w0 === 0x2002) return isPrivateV4Int(((w1 << 16) >>> 0) + w2); // 6to4
  if (w0 === 0x64 && w1 === 0xff9b) return true; // NAT64 (64:ff9b::/96, 64:ff9b:1::/48)
  if (w0 === 0x2001 && w1 < 0x200) return true; // 2001::/23 (Teredo, ORCHID, benchmark…)
  if (w0 === 0x2001 && w1 === 0xdb8) return true; // documentation
  if ((w0 & 0xe000) !== 0x2000) return true; // hors unicast global 2000::/3 (ULA, link-local, fec0::/10, multicast, 100::/64…)
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4Int(ipv4ToInt(ip));
  if (family === 6) {
    const words = parseIpv6(ip);
    return !words || isPrivateV6(words);
  }
  return true;
}

function isBlockedName(h: string): boolean {
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.');
}

/** Résout un hôte et ne renvoie que des adresses publiques (lève BlockedHostError sinon). */
export async function resolvePublic(host: string): Promise<LookupAddress[]> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(h)) {
    if (!config.allowPrivateHosts && isPrivateIp(h)) throw new BlockedHostError(host);
    return [{ address: h, family: isIP(h) }];
  }
  if (!config.allowPrivateHosts && isBlockedName(h)) throw new BlockedHostError(host);
  let addrs: LookupAddress[];
  try {
    addrs = await resolver.lookupAll(h);
  } catch {
    throw new BlockedHostError(host);
  }
  if (!addrs.length) throw new BlockedHostError(host);
  if (!config.allowPrivateHosts && addrs.some((a) => isPrivateIp(a.address))) throw new BlockedHostError(host);
  return addrs;
}

/** Vérifie qu'un hôte (nom ou IP) ne résout que vers des adresses publiques. */
export async function assertPublicHost(host: string): Promise<void> {
  if (config.allowPrivateHosts) return;
  await resolvePublic(host);
}

/**
 * Épinglage pour une connexion TCP/TLS directe (imapflow, nodemailer) : renvoie l'IP vérifiée à utiliser
 * comme `host` et le nom d'origine pour le SNI et la vérification du certificat (`servername`).
 */
export async function pinHost(host: string): Promise<{ host: string; servername?: string }> {
  return (await pinHostCandidates(host))[0]!;
}

/**
 * Toutes les adresses vérifiées d'un hôte, IPv4 d'abord (le conteneur de prod n'a pas d'IPv6 sortant alors que
 * beaucoup de serveurs publient des AAAA), puis IPv6, ordre DNS conservé dans chaque famille.
 * Avec VOXEL_ALLOW_PRIVATE_HOSTS, l'hôte est rendu tel quel (Node le résout à la connexion, avec repli entre familles).
 */
export async function pinHostCandidates(host: string): Promise<Array<{ host: string; servername?: string }>> {
  if (config.allowPrivateHosts) return [{ host }];
  const addrs = preferIpv4(await resolvePublic(host));
  const bare = host.replace(/^\[|\]$/g, '');
  return addrs.map((a) => (isIP(bare) ? { host: a.address } : { host: a.address, servername: bare }));
}

/** Trie les adresses : IPv4 d'abord, ordre d'origine conservé dans chaque famille. */
export function preferIpv4<T extends { family: number }>(list: T[]): T[] {
  return [...list.filter((a) => a.family === 4), ...list.filter((a) => a.family !== 4)];
}

/** Codes d'échec d'ouverture de connexion (adresse injoignable) : on peut essayer l'adresse suivante sans risque. */
const CONNECT_FAILURE_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT', 'EAFNOSUPPORT', 'CONNECT_TIMEOUT']);

/** Vrai si l'erreur dit que l'adresse n'a pas pu être jointe (avant tout échange applicatif). */
export function isConnectFailure(e: unknown): boolean {
  const err = e as { code?: string; originalCode?: string; errno?: string | number; command?: string } | undefined;
  if (!err) return false;
  // nodemailer : code = ESOCKET/ECONNECTION, code système d'origine dans originalCode, commande « CONN » à l'ouverture
  if (err.command && err.command !== 'CONN') return false;
  return [err.code, err.originalCode, typeof err.errno === 'string' ? err.errno : undefined].some((c) => !!c && CONNECT_FAILURE_CODES.has(c));
}

/**
 * Essaie `attempt` sur chaque adresse candidate tant que l'échec est un échec de connexion (isConnectFailure) ;
 * toute autre erreur (authentification, protocole) est renvoyée immédiatement.
 */
export async function tryCandidates<C, T>(candidates: C[], attempt: (c: C) => Promise<T>): Promise<T> {
  let last: unknown = new Error('no address');
  for (const c of candidates) {
    try {
      return await attempt(c);
    } catch (e) {
      last = e;
      if (!isConnectFailure(e)) throw e;
    }
  }
  throw last;
}

// ---------- résolution (remplaçable dans les tests) ----------

type LookupAllFn = (host: string) => Promise<LookupAddress[]>;
type LookupCbFn = (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;
const defaultResolver: { lookupAll: LookupAllFn; lookupCb: LookupCbFn } = {
  lookupAll: (h) => lookup(h, { all: true, verbatim: true }),
  lookupCb: (h, cb) => dnsLookupCb(h, { all: true, verbatim: true }, cb),
};
let resolver = defaultResolver;

/** Tests : remplace la résolution DNS (null = résolution système). */
export function setResolverForTests(r: { lookupAll: LookupAllFn } | null): void {
  resolver = r
    ? {
        lookupAll: r.lookupAll,
        lookupCb: (h, cb) =>
          void r.lookupAll(h).then(
            (a) => cb(null, a),
            (e: NodeJS.ErrnoException) => cb(e, []),
          ),
      }
    : defaultResolver;
}

/** Ports acceptés pour IMAP et SMTP (hors VOXEL_ALLOW_PRIVATE_HOSTS) : limite le balayage de ports internes ou tiers. */
export const IMAP_PORTS = [143, 993];
export const SMTP_PORTS = [465, 587];
/** ManageSieve (RFC 5804). */
export const SIEVE_PORTS = [4190];

export function isAllowedPort(kind: 'imap' | 'smtp' | 'sieve', port: number): boolean {
  if (config.allowPrivateHosts) return true;
  return (kind === 'imap' ? IMAP_PORTS : kind === 'smtp' ? SMTP_PORTS : SIEVE_PORTS).includes(port);
}

export function assertAllowedPort(kind: 'imap' | 'smtp' | 'sieve', port: number): void {
  if (!isAllowedPort(kind, port)) throw new BlockedHostError(`${kind} port ${port}`);
}

/** lookup() compatible net/tls/undici qui refuse les IP privées (appelé à la connexion). */
type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export function publicLookup(hostname: string, options: { all?: boolean; family?: number | string } | number, cb: LookupCb): void {
  const opts = typeof options === 'number' ? { family: options } : (options ?? {});
  const family = opts.family === 6 || opts.family === 'IPv6' ? 6 : opts.family === 4 || opts.family === 'IPv4' ? 4 : 0;
  resolver.lookupCb(hostname, (err, addrs) => {
    if (err) return cb(err, opts.all ? [] : '', 0);
    // IPv4 d'abord : sans « happy eyeballs » (autoSelectFamily désactivé), seule la première adresse est essayée.
    const list = preferIpv4((addrs ?? []).filter((a) => !family || a.family === family));
    if (!config.allowPrivateHosts && (!list.length || list.some((a) => isPrivateIp(a.address)))) {
      const e = new BlockedHostError(hostname) as NodeJS.ErrnoException;
      e.code = 'EBLOCKEDHOST';
      return cb(e, opts.all ? [] : '', 0);
    }
    if (opts.all) return cb(null, list);
    const first = list[0];
    if (!first) {
      const e = new Error(`no address for ${hostname}`) as NodeJS.ErrnoException;
      e.code = 'ENOTFOUND';
      return cb(e, '', 0);
    }
    cb(null, first.address, first.family);
  });
}

// ---------- fetch épinglé ----------

type Dispatcher = object;
let guardedDispatcher: Dispatcher | null | undefined;

/**
 * Agent undici (celui qu'embarque Node pour fetch) dont la résolution DNS passe par publicLookup.
 * Node n'exporte pas undici : on reprend le constructeur du répartiteur global.
 */
export async function getDispatcher(): Promise<Dispatcher | null> {
  if (guardedDispatcher !== undefined) return guardedDispatcher;
  try {
    const sym = Symbol.for('undici.globalDispatcher.1');
    const read = () => (globalThis as Record<symbol, unknown>)[sym] as { constructor: new (o: unknown) => Dispatcher } | undefined;
    if (!read()) await fetch('data:,').catch(() => undefined);
    const global = read();
    guardedDispatcher = global ? new global.constructor({ connect: { lookup: publicLookup, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 300 } }) : null;
  } catch {
    guardedDispatcher = null;
  }
  if (!guardedDispatcher) console.warn('[voxel] netguard: agent undici indisponible, vérification DNS sans épinglage');
  return guardedDispatcher;
}

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

/**
 * fetch qui vérifie chaque saut (redirections suivies à la main) : schéma https (http seulement avec
 * VOXEL_ALLOW_PRIVATE_HOSTS), hôte public, IP vérifiée au moment de la connexion (Agent épinglé).
 * L'en-tête Authorization n'est conservé que pour les redirections vers la même origine.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 5000, maxRedirects = 5, signal, ...init } = opts;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = new URL(url);
  const origin = current.origin;
  let headers = new Headers(init.headers);
  let method = init.method ?? 'GET';
  let body = init.body;
  const dispatcher = await getDispatcher();
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:' && !(current.protocol === 'http:' && config.allowPrivateHosts)) {
      throw new BlockedHostError(current.href);
    }
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual',
      signal: combined,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= maxRedirects) throw new Error('too many redirects');
      await res.body?.cancel().catch(() => undefined);
      current = new URL(res.headers.get('location')!, current);
      if (current.origin !== origin) {
        headers = new Headers(headers);
        headers.delete('authorization');
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    Object.defineProperty(res, 'finalUrl', { value: current.href });
    return res;
  }
}

/** URL finale après redirections d'une réponse de safeFetch. */
export function finalUrl(res: Response, fallback: string): string {
  return (res as Response & { finalUrl?: string }).finalUrl ?? (res.url || fallback);
}
