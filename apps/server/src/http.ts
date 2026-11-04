import type { Context } from 'hono';
import { config } from './config.js';
import { BackendAuthError, BackendUnavailableError } from './backend/types.js';
import { BlobNotFoundError, BlobTooLargeError } from './imap/index.js';

export type AppEnv = { Variables: Record<string, never> };

/** Codes d'erreur stables, traduits par le front. */
export type ErrorCode =
  | 'invalid_credentials'
  | 'discovery_failed'
  | 'domain_not_allowed'
  | 'rate_limited'
  | 'upstream_unreachable'
  | 'upstream_auth'
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'internal';

/** Erreur à renvoyer telle quelle au client. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message?: string,
    readonly headers: Record<string, string> = {},
    /** Champs supplémentaires du corps JSON (ex. `hint` de `invalid_credentials`). */
    readonly extra: Record<string, string> = {},
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export function apiError(c: Context, status: number, error: ErrorCode, message?: string, extra: Record<string, string> = {}): Response {
  return c.json({ error, message: message ?? error, ...extra }, status as 400);
}

/** Convertit une exception en réponse JSON `{ error, message }`. */
export function handleError(err: unknown, c: Context): Response {
  if (err instanceof ApiError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return apiError(c, err.status, err.code, err.message, err.extra);
  }
  // Erreurs des backends → codes stables ; messages courts et fixes : jamais de pile ni de détail amont au client.
  if (err instanceof BlobNotFoundError) return apiError(c, 404, 'not_found', 'blob not found');
  if (err instanceof BlobTooLargeError) return apiError(c, 413, 'validation', 'blob too large');
  // 401 : le navigateur affiche « Reconnectez-vous » (pas de dialogue natif : aucun WWW-Authenticate).
  if (err instanceof BackendAuthError) {
    console.warn('[voxel] upstream auth:', err.message);
    return apiError(c, 401, 'upstream_auth', 'the mail server rejected the credentials');
  }
  if (err instanceof BackendUnavailableError) {
    console.warn('[voxel] upstream unreachable:', err.message);
    return apiError(c, 502, 'upstream_unreachable', 'the mail server is unreachable');
  }
  console.error('[voxel]', err);
  return apiError(c, 500, 'internal', 'internal error');
}

export function clientIp(c: Context): string {
  // X-Forwarded-For n'est fiable que derrière un proxy qui le réécrit (Traefik) : VOXEL_TRUST_PROXY=1.
  // On prend l'entrée ajoutée par le proxy de confiance (la plus à droite, ou la n-ième en partant de la droite
  // avec VOXEL_TRUST_PROXY_HOPS=n) : les entrées de gauche viennent du client et peuvent être forgées.
  if (config.trustProxy) {
    const parts = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const fwd = parts[parts.length - config.trustProxyHops];
    if (fwd) return fwd;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Lit un corps JSON objet ; lève `validation` s'il est absent ou invalide. */
export async function readJson<T = Record<string, unknown>>(c: Context): Promise<Partial<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'validation', 'JSON object body expected');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'validation', 'JSON object body expected');
  }
  return body as Partial<T>;
}
