/**
 * Limitation de débit en mémoire, par IP et par adresse, sur 15 min glissantes.
 * - login : 10 échecs de connexion (une vérification réussie ne compte pas) ;
 * - discover : 30 appels.
 * Une IP non routable (passerelle Docker, réseau local) n'identifie pas un client : clé commune au seuil plus large.
 */
import { ApiError } from './http.js';
import { isPrivateIp } from './netguard.js';

const WINDOW_MS = 15 * 60 * 1000;

export const LIMITS = { login: 10, discover: 30 } as const;
const SHARED_LIMITS = { login: 50, discover: 300 } as const;

export type Bucket = keyof typeof LIMITS;

const hits = new Map<string, number[]>();

function keysFor(bucket: Bucket, ip: string, email?: string): Array<[string, number]> {
  const keys: Array<[string, number]> = [isPrivateIp(ip) ? [`${bucket}:shared`, SHARED_LIMITS[bucket]] : [`${bucket}:ip:${ip}`, LIMITS[bucket]]];
  if (email) keys.push([`${bucket}:email:${email.toLowerCase()}`, LIMITS[bucket]]);
  return keys;
}

function recent(key: string): number[] {
  const since = Date.now() - WINDOW_MS;
  const list = (hits.get(key) ?? []).filter((t) => t > since);
  if (list.length) hits.set(key, list);
  else hits.delete(key);
  return list;
}

/** Lève `rate_limited` (429 + Retry-After) si une des clés a atteint sa limite. */
export function assertNotLimited(bucket: Bucket, ip: string, email?: string): void {
  for (const [key, limit] of keysFor(bucket, ip, email)) {
    const list = recent(key);
    if (list.length >= limit) {
      const retry = Math.max(1, Math.ceil((list[0]! + WINDOW_MS - Date.now()) / 1000));
      throw new ApiError(429, 'rate_limited', 'too many attempts, try again later', { 'Retry-After': String(retry) });
    }
  }
}

export function recordAttempt(bucket: Bucket, ip: string, email?: string): void {
  const now = Date.now();
  for (const [key] of keysFor(bucket, ip, email)) hits.set(key, [...recent(key), now]);
}

/** Nettoyage périodique des fenêtres expirées. */
setInterval(() => {
  for (const key of [...hits.keys()]) recent(key);
}, 60_000).unref();

/** Pour les tests. */
export function resetRateLimits(): void {
  hits.clear();
}
