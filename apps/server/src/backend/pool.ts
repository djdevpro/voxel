/**
 * Pool de façades IMAP : une façade par empreinte
 * `sha256(hôtes, ports, sécurité, username, password)`, fermée après 5 min d'inactivité
 * (sauf flux d'événements ouvert). Plafonds : 4 comptes ouverts par IP cliente, 200 au total.
 */
import { createImapBackend } from '../imap/index.js';
import { sha256 } from '../crypto.js';
import { kvStoreFor, mailboxKey } from '../kv.js';
import { ApiError } from '../http.js';
import type { BackendEvent, ImapConfig, JmapRequest, MailBackend } from './types.js';

const IDLE_MS = 5 * 60 * 1000;
export const MAX_PER_IP = 4;
export const MAX_TOTAL = 200;

/** Configuration d'une boîte telle que transmise par le navigateur à chaque requête. */
export interface GatewayTarget {
  username: string;
  password: string;
  /** Adresse de la boîte (`X-Voxel-Email`) : expéditeur par défaut ; à défaut, l'identifiant. */
  email?: string;
  imap: ImapConfig['imap'];
  smtp: ImapConfig['smtp'];
  /** ManageSieve (`X-Voxel-Sieve`), facultatif. */
  sieve?: ImapConfig['imap'];
  /** Service CardDAV (`X-Voxel-CardDav`), facultatif. */
  carddav?: string;
  /** Service CalDAV (`X-Voxel-CalDav`), facultatif. */
  caldav?: string;
}

export function fingerprint(t: GatewayTarget): string {
  const ep = (e: ImapConfig['imap']) => `${e.host.toLowerCase()}:${e.port}:${e.secure ? 'ssl' : 'starttls'}`;
  return sha256(JSON.stringify([ep(t.imap), ep(t.smtp), t.username, t.password, t.email ?? t.username, t.sieve ? ep(t.sieve) : null, t.carddav ?? null, t.caldav ?? null]));
}

interface Entry {
  backend: MailBackend;
  lastUsed: number;
  active: number;
  ips: Set<string>;
  /** Identifiants déjà vérifiés (LOGIN IMAP + AUTH SMTP). */
  verified: boolean;
}

const pool = new Map<string, Entry>();

/** Enveloppe qui tient à jour la date de dernière utilisation et le nombre de flux actifs. */
class PooledBackend implements MailBackend {
  constructor(private readonly entry: Entry) {}
  private touch(): MailBackend {
    this.entry.lastUsed = Date.now();
    return this.entry.backend;
  }
  session() {
    return this.touch().session();
  }
  api(req: JmapRequest) {
    return this.touch().api(req);
  }
  upload(accountId: string, body: ReadableStream<Uint8Array>, type: string) {
    return this.touch().upload(accountId, body, type);
  }
  download(accountId: string, blobId: string, name: string, type?: string) {
    return this.touch().download(accountId, blobId, name, type);
  }
  async *events(types: string[], signal: AbortSignal): AsyncIterable<BackendEvent> {
    const backend = this.touch();
    this.entry.active += 1;
    try {
      for await (const ev of backend.events(types, signal)) {
        this.entry.lastUsed = Date.now();
        yield ev;
      }
    } finally {
      this.entry.active -= 1;
      this.entry.lastUsed = Date.now();
    }
  }
  verify() {
    return this.touch().verify();
  }
  async probe() {
    await this.touch().probe?.();
  }
  /** La fermeture est gérée par le pool. */
  async close(): Promise<void> {}
}

function countForIp(ip: string): number {
  let n = 0;
  for (const e of pool.values()) if (e.ips.has(ip)) n++;
  return n;
}

export interface PoolHandle {
  backend: MailBackend;
  /** Identifiants déjà vérifiés pour cette empreinte. */
  verified: boolean;
  markVerified: () => void;
  /** Retire et ferme la façade (identifiants refusés). */
  discard: () => void;
}

/** Façade mutualisée pour ces identifiants. */
export function getBackend(t: GatewayTarget, ip: string): PoolHandle {
  const key = fingerprint(t);
  let entry = pool.get(key);
  if (!entry) {
    if (pool.size >= MAX_TOTAL) throw new ApiError(429, 'rate_limited', 'gateway is full');
    if (countForIp(ip) >= MAX_PER_IP) throw new ApiError(429, 'rate_limited', 'too many mailboxes open from this address');
    const cfg: ImapConfig = {
      email: t.email ?? t.username,
      username: t.username,
      auth: { password: t.password },
      imap: t.imap,
      smtp: t.smtp,
      ...(t.sieve ? { sieve: t.sieve } : {}),
      ...(t.carddav ? { carddav: t.carddav } : {}),
      ...(t.caldav ? { caldav: t.caldav } : {}),
    };
    entry = {
      backend: createImapBackend(cfg, kvStoreFor(mailboxKey(t.username, t.imap.host))),
      lastUsed: Date.now(),
      active: 0,
      ips: new Set(),
      verified: false,
    };
    pool.set(key, entry);
  }
  entry.ips.add(ip);
  const e = entry;
  return {
    backend: new PooledBackend(e),
    verified: e.verified,
    markVerified: () => {
      e.verified = true;
    },
    discard: () => {
      if (pool.get(key) === e) pool.delete(key);
      void e.backend.close().catch(() => undefined);
    },
  };
}

function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of pool) {
    if (entry.active === 0 && now - entry.lastUsed > IDLE_MS) {
      pool.delete(key);
      void entry.backend.close().catch(() => undefined);
    }
  }
}

setInterval(sweep, 60 * 1000).unref();

export async function closeAllBackends(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.allSettled(entries.map((e) => e.backend.close()));
}

/** Pour les tests. */
export function poolSize(): number {
  return pool.size;
}
