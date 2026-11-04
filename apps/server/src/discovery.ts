/**
 * Découverte automatique de la configuration d'une adresse.
 * Ordre : JMAP (.well-known du domaine, des MX et de mail.<domaine>, SRV) → IMAP (autoconfig, ISPDB, SRV,
 * supposition MX). Résultat mis en cache en mémoire par domaine.
 */
import { resolveMx, resolveSrv, resolveTxt } from 'node:dns/promises';
import type { ImapEndpoint } from './backend/types.js';
import net from 'node:net';
import { finalUrl, isAllowedPort, pinHostCandidates, safeFetch } from './netguard.js';

export type Discovery =
  | { protocol: 'jmap'; sessionUrl: string }
  | {
      protocol: 'imap';
      imap: ImapEndpoint;
      smtp: ImapEndpoint;
      /** Modèle de nom d'utilisateur annoncé par l'autoconfig : 'email' (défaut) ou 'localpart'. */
      username?: 'email' | 'localpart';
      /** ManageSieve, s'il est trouvé. */
      sieve?: ImapEndpoint;
      /** Service CardDAV (URL https), s'il est trouvé. */
      carddav?: string;
      /** Service CalDAV (URL https), s'il est trouvé. */
      caldav?: string;
    };

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

const CACHE_TTL_MS = 24 * 3600 * 1000;
/** Un échec est retenu moins longtemps : la configuration DNS peut être corrigée. */
const NEGATIVE_TTL_MS = 3600 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const MAX_PROBES = 10;
const CAP_CORE = 'urn:ietf:params:jmap:core';

// ---------- sondes ----------

class ProbeBudget {
  private used = 0;
  take(): boolean {
    if (this.used >= MAX_PROBES) return false;
    this.used += 1;
    return true;
  }
}

async function mxHosts(domain: string): Promise<string[]> {
  try {
    const records = await resolveMx(domain);
    return records
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function srv(name: string): Promise<{ name: string; port: number } | null> {
  try {
    const records = await resolveSrv(name);
    const best = records.filter((r) => r.name && r.name !== '.').sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    return best ? { name: best.name.toLowerCase().replace(/\.$/, ''), port: best.port } : null;
  } catch {
    return null;
  }
}

/**
 * Sonde un point d'entrée JMAP. Valide la réponse finale (redirections suivies) :
 * JSON avec capabilities[core] (session anonyme, ex. Stalwart), ou 401 + WWW-Authenticate sur un chemin /jmap.
 * Une page HTML (site web du domaine) est ignorée.
 */
async function probeJmap(url: string, budget: ProbeBudget): Promise<Discovery | null> {
  if (!budget.take()) return null;
  try {
    const res = await safeFetch(url, { headers: { Accept: 'application/json' }, timeoutMs: PROBE_TIMEOUT_MS });
    const final = finalUrl(res, url);
    const ctype = res.headers.get('content-type') ?? '';
    if (res.ok && /json/i.test(ctype)) {
      const text = await res.text();
      if (text.length > 1024 * 1024) return null;
      const json = JSON.parse(text) as Record<string, unknown>;
      const caps = json.capabilities as Record<string, unknown> | undefined;
      if (caps && typeof caps === 'object' && caps[CAP_CORE]) {
        return { protocol: 'jmap', sessionUrl: final };
      }
      return null;
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 && res.headers.get('www-authenticate') && /jmap/i.test(new URL(final).pathname)) {
      return { protocol: 'jmap', sessionUrl: final };
    }
  } catch {
    /* sonde échouée : on passe à la suivante */
  }
  return null;
}

function xmlServer(xml: string, tag: 'incomingServer' | 'outgoingServer', type: 'imap' | 'smtp') {
  const re = new RegExp(`<${tag}\\s+type=["']${type}["'][^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const pick = (block: string, name: string) => block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i'))?.[1];
  const out: Array<ImapEndpoint & { username?: string }> = [];
  for (const m of xml.matchAll(re)) {
    const block = m[1] ?? '';
    const host = pick(block, 'hostname');
    const port = Number(pick(block, 'port'));
    const socket = (pick(block, 'socketType') ?? '').toUpperCase();
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (socket !== 'SSL' && socket !== 'STARTTLS') continue; // jamais en clair
    const username = pick(block, 'username');
    out.push({ host: host.toLowerCase(), port, secure: socket === 'SSL', ...(username ? { username } : {}) });
  }
  // TLS implicite d'abord.
  return out.sort((a, b) => Number(b.secure) - Number(a.secure))[0];
}

async function probeAutoconfig(url: string, budget: ProbeBudget): Promise<Discovery | null> {
  if (!budget.take()) return null;
  try {
    const res = await safeFetch(url, { headers: { Accept: 'application/xml, text/xml' }, timeoutMs: PROBE_TIMEOUT_MS });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const xml = await res.text();
    if (xml.length > 512 * 1024 || !/<clientConfig/i.test(xml)) return null;
    const imap = xmlServer(xml, 'incomingServer', 'imap');
    const smtp = xmlServer(xml, 'outgoingServer', 'smtp');
    if (!imap || !smtp) return null;
    const username = imap.username?.includes('%EMAILLOCALPART%') ? 'localpart' : 'email';
    return {
      protocol: 'imap',
      imap: { host: imap.host, port: imap.port, secure: imap.secure },
      smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
      username,
    };
  } catch {
    return null;
  }
}

// ---------- orchestration ----------

async function discoverUncached(email: string, domain: string): Promise<Discovery | null> {
  const mx = await mxHosts(domain);

  const budget = new ProbeBudget();

  // JMAP
  const jmapHosts: string[] = [];
  const addHost = (h: string) => {
    if (h && !jmapHosts.includes(h)) jmapHosts.push(h);
  };
  addHost(domain);
  for (const h of mx.slice(0, 2)) addHost(h);
  addHost(`mail.${domain}`);
  for (const host of jmapHosts) {
    const found = await probeJmap(`https://${host}/.well-known/jmap`, budget);
    if (found) return found;
  }
  const jmapSrv = await srv(`_jmap._tcp.${domain}`);
  if (jmapSrv) {
    const port = jmapSrv.port === 443 ? '' : `:${jmapSrv.port}`;
    const found = await probeJmap(`https://${jmapSrv.name}${port}/.well-known/jmap`, budget);
    if (found) return found;
  }

  // IMAP : autoconfig, ISPDB
  const enc = encodeURIComponent(email);
  for (const url of [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${enc}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${enc}`,
    `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
  ]) {
    const found = await probeAutoconfig(url, budget);
    if (found) return found;
  }

  // IMAP : SRV (RFC 6186 / 8314)
  const imaps = await srv(`_imaps._tcp.${domain}`);
  const submissions = await srv(`_submissions._tcp.${domain}`);
  const submission = submissions ? null : await srv(`_submission._tcp.${domain}`);
  if (imaps && (submissions || submission)) {
    return {
      protocol: 'imap',
      imap: { host: imaps.name, port: imaps.port, secure: true },
      smtp: submissions
        ? { host: submissions.name, port: submissions.port, secure: true }
        : { host: submission!.name, port: submission!.port, secure: false },
    };
  }

  // Supposition à partir du MX principal.
  const first = mx[0];
  if (first) {
    return {
      protocol: 'imap',
      imap: { host: first, port: 993, secure: true },
      smtp: { host: first, port: 465, secure: true },
    };
  }
  return null;
}

/** Le port répond-il (connexion TCP, adresse publique vérifiée) ? 3 s au plus. */
async function tcpOpen(host: string, port: number): Promise<boolean> {
  try {
    const [first] = await pinHostCandidates(host);
    if (!first) return false;
    return await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: first.host, port });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(3000, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  } catch {
    return false;
  }
}

/** ManageSieve : SRV `_sieve._tcp` (STARTTLS, RFC 5804 §1.8), puis le port 4190 de l'hôte IMAP. */
async function discoverSieve(domain: string, imapHost: string): Promise<ImapEndpoint | null> {
  const rec = await srv(`_sieve._tcp.${domain}`);
  if (rec && isAllowedPort('sieve', rec.port)) return { host: rec.name, port: rec.port, secure: false };
  if (await tcpOpen(imapHost, 4190)) return { host: imapHost, port: 4190, secure: false };
  return null;
}

/** Lit l'enregistrement TXT `path=` d'un SRV DAV (RFC 6764 §4). */
async function txtPath(name: string): Promise<string | null> {
  try {
    for (const rec of await resolveTxt(name)) {
      const m = rec.join('').match(/^path=(\/.*)$/);
      if (m) return m[1]!;
    }
  } catch {
    /* pas de TXT */
  }
  return null;
}

/**
 * Le point d'entrée répond-il comme un service CardDAV (sans identifiants) ? PROPFIND suivi des redirections :
 * 207, ou 401 avec `WWW-Authenticate` (ou en-tête `DAV`). Renvoie l'URL finale (sans requête ni fragment).
 */
async function probeDav(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, { method: 'PROPFIND', headers: { Depth: '0' }, timeoutMs: PROBE_TIMEOUT_MS });
    await res.body?.cancel().catch(() => undefined);
    const ok = res.status === 207 || (res.status === 401 && (!!res.headers.get('www-authenticate') || !!res.headers.get('dav')));
    if (!ok) return null;
    const final = new URL(finalUrl(res, url));
    if (final.protocol !== 'https:' || (final.port !== '' && final.port !== '443') || final.username || final.password) return null;
    final.search = '';
    final.hash = '';
    return final.href;
  } catch {
    return null;
  }
}

/** CardDAV : SRV `_carddavs._tcp` (+ TXT `path`), puis `/.well-known/carddav` du domaine, puis de l'hôte IMAP. */
export function discoverCardDav(domain: string, imapHost: string): Promise<string | null> {
  return discoverDav('carddav', domain, imapHost);
}

/** CalDAV : SRV `_caldavs._tcp` (+ TXT `path`), puis `/.well-known/caldav` du domaine, puis de l'hôte IMAP. */
export function discoverCalDav(domain: string, imapHost: string): Promise<string | null> {
  return discoverDav('caldav', domain, imapHost);
}

async function discoverDav(kind: 'carddav' | 'caldav', domain: string, imapHost: string): Promise<string | null> {
  const rec = await srv(`_${kind}s._tcp.${domain}`);
  if (rec && rec.port === 443) {
    const path = (await txtPath(`_${kind}s._tcp.${domain}`)) ?? `/.well-known/${kind}`;
    const found = await probeDav(`https://${rec.name}${path}`);
    if (found) return found;
  }
  for (const host of [...new Set([domain, imapHost])]) {
    const found = await probeDav(`https://${host}/.well-known/${kind}`);
    if (found) return found;
  }
  return null;
}

const cache = new Map<string, { at: number; result: Discovery | null }>();

function readCache(domain: string): { result: Discovery | null } | undefined {
  const row = cache.get(domain);
  if (!row) return undefined;
  const ttl = row.result ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  if (Date.now() - row.at > ttl) {
    cache.delete(domain);
    return undefined;
  }
  return row;
}

const inflight = new Map<string, Promise<Discovery | null>>();

/** Découvre la configuration d'une adresse (n'échoue jamais : null si rien trouvé). */
export async function discover(email: string): Promise<Discovery | null> {
  const domain = emailDomain(email);
  if (!domain) return null;
  const cached = readCache(domain);
  if (cached) return cached.result;
  const pending = inflight.get(domain);
  if (pending) return pending;
  const p = (async () => {
    let result: Discovery | null = null;
    try {
      result = await discoverUncached(email, domain);
      if (result?.protocol === 'imap') {
        const [sieve, carddav, caldav] = await Promise.all([discoverSieve(domain, result.imap.host), discoverCardDav(domain, result.imap.host), discoverCalDav(domain, result.imap.host)]);
        if (sieve) result = { ...result, sieve };
        if (carddav) result = { ...result, carddav };
        if (caldav) result = { ...result, caldav };
      }
    } catch (err) {
      console.warn(`[voxel] découverte ${domain} :`, (err as Error).message);
    }
    if (cache.size > 5000) cache.clear();
    cache.set(domain, { at: Date.now(), result });
    return result;
  })().finally(() => inflight.delete(domain));
  inflight.set(domain, p);
  return p;
}
