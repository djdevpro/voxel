/**
 * Expéditeur d'une pièce jointe volumineuse, vérifié auprès de son serveur de messagerie.
 *
 * La requête porte les identifiants de la boîte (`Authorization: Basic …` ou `Bearer …`, ceux que l'appli envoie
 * déjà au serveur JMAP) et son adresse (`X-Voxel-Email`). Le serveur JMAP vient de `config.json` côté serveur,
 * jamais de la requête : seules les boîtes des serveurs de l'exploitant ont un compte de stockage. Le compte est
 * celui de l'identifiant renvoyé par la session JMAP (`username`), pas de l'adresse annoncée.
 * Une vérification réussie est gardée 10 min en mémoire (empreinte des identifiants) ; un refus compte dans la
 * limite des échecs de connexion. Les identifiants ne sont ni journalisés ni stockés.
 */
import type { Context } from 'hono';
import { sha256 } from '../crypto.js';
import { ApiError, clientIp } from '../http.js';
import { safeFetch } from '../netguard.js';
import { assertNotLimited, recordAttempt } from '../ratelimit.js';
import { trustedSessionUrl, type FilesSettings } from './settings.js';

export interface Sender {
  /** Compte de stockage : sha256(URL de session + "\n" + identifiant en minuscules). */
  accountId: string;
  email: string;
}

const TTL_MS = 10 * 60_000;
const MAX_CACHED = 500;
const verified = new Map<string, { sender: Sender; until: number }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** Pour les tests. */
export function resetSenderCache(): void {
  verified.clear();
}

/** Adresse annoncée par la requête, en minuscules. */
export function claimedEmail(c: Context): string {
  const email = c.req.header('x-voxel-email')?.trim().toLowerCase() ?? '';
  if (!email || email.length > 320 || !EMAIL_RE.test(email)) throw new ApiError(400, 'validation', 'X-Voxel-Email must be an email address');
  return email;
}

export async function verifySender(c: Context, settings: FilesSettings): Promise<Sender> {
  const authorization = c.req.header('authorization')?.trim() ?? '';
  if (!/^(Basic|Bearer)\s+\S+$/i.test(authorization) || authorization.length > 8192) {
    throw new ApiError(401, 'invalid_credentials', 'mailbox credentials required');
  }
  const email = claimedEmail(c);
  const sessionUrl = trustedSessionUrl(settings, email);
  if (!sessionUrl) throw new ApiError(403, 'forbidden', 'large attachments are not available for this address');

  const key = sha256(`${sessionUrl}\n${authorization}`);
  const now = Date.now();
  const hit = verified.get(key);
  if (hit && hit.until > now) return { ...hit.sender, email };

  const ip = clientIp(c);
  assertNotLimited('login', ip, email);
  let res: Response;
  try {
    res = await safeFetch(sessionUrl, { headers: { authorization, accept: 'application/json' }, timeoutMs: 10_000 });
  } catch (e) {
    console.warn('[voxel] pièces jointes volumineuses : serveur JMAP injoignable :', (e as Error).message);
    throw new ApiError(502, 'upstream_unreachable', 'the mail server is unreachable');
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    recordAttempt('login', ip, email);
    throw new ApiError(401, 'upstream_auth', 'the mail server rejected the credentials');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ApiError(502, 'upstream_unreachable', 'the mail server is unreachable');
  }
  let username: unknown;
  try {
    username = ((await res.json()) as { username?: unknown }).username;
  } catch {
    username = undefined;
  }
  if (typeof username !== 'string' || !username.trim()) throw new ApiError(502, 'upstream_unreachable', 'unexpected JMAP session');

  const sender: Sender = { accountId: sha256(`${sessionUrl}\n${username.trim().toLowerCase()}`), email };
  if (verified.size >= MAX_CACHED) verified.delete(verified.keys().next().value!);
  verified.set(key, { sender, until: now + TTL_MS });
  return sender;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of verified) if (v.until <= now) verified.delete(k);
}, 60_000).unref();
