/**
 * Comptes sur l'appareil : table Dexie `accounts`, mot de passe chiffré (AES-GCM, clé
 * non extractible propre à l'appareil, gardée dans `kv`), session JMAP mise en cache (`kv`, `session:<id>`).
 * Les mots de passe déchiffrés ne vivent qu'en mémoire, dans ce module ; ils ne partent que vers le
 * serveur de messagerie (en-tête `Authorization`) et ne sont jamais journalisés.
 */
import { CAP, type Session } from '@voxel/jmap';
import { db, requestPersistentStorage, type AccountRow, type MailEndpoint, type SecretBox } from './db';
import { ACCOUNT_COLORS, ApiError, codeOfStatus, isKnownCode, type ApiErrorCode, type MailboxCapabilities, type MailboxInfo } from './api';

const KEY_ID = 'device-key';
const passwords = new Map<string, string>();

// ------------------------------------------------------------------ chiffrement

/** Clé d'appareil reconnue même si elle vient d'un autre contexte (`instanceof` échoue alors). */
function isCryptoKey(v: unknown): v is CryptoKey {
  if (v instanceof CryptoKey) return true;
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'secret' && 'algorithm' in v;
}

let keyPromise: Promise<CryptoKey> | undefined;

async function loadOrCreateKey(): Promise<CryptoKey> {
  const row = await db.kv.get(KEY_ID);
  if (isCryptoKey(row?.value)) return row.value;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try {
    // jamais d'écrasement : une clé remplacée rendrait tous les secrets indéchiffrables
    await db.kv.add({ key: KEY_ID, value: key });
    return key;
  } catch (e) {
    // un autre onglet l'a créée entre-temps : on reprend la sienne
    if ((e as { name?: unknown })?.name !== 'ConstraintError') throw e;
    const stored = (await db.kv.get(KEY_ID))?.value;
    if (isCryptoKey(stored)) return stored;
    throw e;
  }
}

/** Clé d'appareil, partagée par les appels concurrents (une seule lecture/création). */
function deviceKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = loadOrCreateKey().catch((e: unknown) => {
      keyPromise = undefined;
      throw e;
    });
  }
  return keyPromise;
}

async function encrypt(text: string): Promise<SecretBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), new TextEncoder().encode(text));
  return { iv, data };
}

async function decrypt(box: SecretBox): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv as BufferSource }, await deviceKey(), box.data);
  return new TextDecoder().decode(plain);
}

/** Chiffre un secret avec la clé d'appareil (clés d'API de l'IA). */
export const encryptSecret = encrypt;
/** Déchiffre un secret chiffré par `encryptSecret`. */
export const decryptSecret = decrypt;

// ------------------------------------------------------------------ authentification

/** `Basic base64(utf8(username:password))`, encodé octet par octet (pas de `btoa` direct sur la chaîne). */
export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

let rows = new Map<string, AccountRow>();

/** `X-Voxel-Imap` / `X-Voxel-Smtp` : `<hôte>:<port>:<ssl|starttls>`. */
export function endpointHeader(e: MailEndpoint): string {
  return `${e.host}:${e.port}:${e.security}`;
}

function headersFor(r: Pick<AccountRow, 'protocol' | 'email' | 'username' | 'imap' | 'smtp' | 'sieve' | 'carddav' | 'caldav'>, password: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: basicAuth(r.username, password) };
  if (r.protocol === 'imap' && r.imap && r.smtp) {
    h['X-Voxel-Imap'] = endpointHeader(r.imap);
    h['X-Voxel-Smtp'] = endpointHeader(r.smtp);
    // ManageSieve facultatif : la passerelle annonce alors les filtres
    if (r.sieve) h['X-Voxel-Sieve'] = endpointHeader(r.sieve);
    // CardDAV facultatif : la passerelle annonce alors les contacts
    if (r.carddav && /^https:\/\/[\x21-\x7e]+$/.test(r.carddav)) h['X-Voxel-CardDav'] = r.carddav;
    // CalDAV facultatif : la passerelle annonce alors l'agenda
    if (r.caldav && /^https:\/\/[\x21-\x7e]+$/.test(r.caldav)) h['X-Voxel-CalDav'] = r.caldav;
    // adresse d'expédition par défaut quand l'identifiant IMAP n'est pas l'adresse (en-tête ASCII seulement)
    if (r.email !== r.username && /^[\x21-\x7e]+$/.test(r.email)) h['X-Voxel-Email'] = r.email;
  }
  return h;
}

/** En-têtes d'authentification d'un compte (mot de passe en mémoire), ou rien s'il n'est pas déverrouillé. */
export function authHeader(id: string): Record<string, string> {
  const row = rows.get(id);
  const pw = passwords.get(id);
  return row && pw !== undefined ? headersFor(row, pw) : {};
}

// ------------------------------------------------------------------ sessions JMAP en cache

const sessions = new Map<string, Session>();

export async function cachedSession(id: string): Promise<Session | undefined> {
  try {
    const s = (await db.kv.get(`session:${id}`))?.value as Session | undefined;
    if (s) sessions.set(id, s);
    return s;
  } catch {
    return undefined;
  }
}

/** Dernière session connue d'un compte (lecture synchrone, après `listAccounts`). */
export function peekSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function saveSession(id: string, s: Session) {
  sessions.set(id, s);
  void db.kv.put({ key: `session:${id}`, value: s }).catch(() => undefined);
}

/** Capacités utiles à l'interface, calculées depuis la session JMAP. */
export function capabilitiesOf(s: Session | undefined): MailboxCapabilities {
  if (!s) return { vacation: false, sieve: false, contacts: false, submissionDelay: false, quota: false, contactsParse: false, calendars: false, calendarsParse: false };
  const caps = s.capabilities ?? {};
  const mailId = s.primaryAccounts?.[CAP.mail];
  const sub = (mailId ? s.accounts?.[mailId]?.accountCapabilities?.[CAP.submission] : undefined) as { maxDelayedSend?: number } | undefined;
  return {
    vacation: 'urn:ietf:params:jmap:vacationresponse' in caps,
    sieve: 'urn:ietf:params:jmap:sieve' in caps,
    contacts: 'urn:ietf:params:jmap:contacts' in caps,
    submissionDelay: (sub?.maxDelayedSend ?? 0) > 0,
    quota: CAP.quota in caps,
    contactsParse: CAP.contactsParse in caps,
    calendars: CAP.calendars in caps,
    calendarsParse: CAP.calendarsParse in caps,
    webpush: CAP.webpush in caps,
  };
}

// ------------------------------------------------------------------ lecture

function toInfo(r: AccountRow, s: Session | undefined): MailboxInfo {
  return {
    id: r.id,
    email: r.email,
    username: r.username,
    protocol: r.protocol ?? 'jmap',
    sessionUrl: r.sessionUrl,
    ...(r.imap ? { imap: r.imap } : {}),
    ...(r.smtp ? { smtp: r.smtp } : {}),
    ...(r.carddav ? { carddav: r.carddav } : {}),
    ...(r.caldav ? { caldav: r.caldav } : {}),
    displayName: r.displayName,
    color: r.color,
    capabilities: capabilitiesOf(s),
    sortOrder: r.sortOrder,
  };
}

/**
 * Déverrouille les comptes au démarrage : déchiffre les secrets stockés (avant le premier rendu,
 * pour que l'appli s'ouvre directement, même hors ligne).
 */
export async function unlockAccounts(): Promise<void> {
  try {
    const list = await db.accounts.toArray();
    rows = new Map(list.map((r) => [r.id, r]));
    await Promise.all(
      list.map(async (r) => {
        if (!r.secret || passwords.has(r.id)) return;
        try {
          passwords.set(r.id, await decrypt(r.secret));
        } catch {
          /* clé perdue ou secret corrompu : il faudra se reconnecter */
        }
      }),
    );
    // demande au navigateur de ne pas évincer IndexedDB (comptes et mots de passe chiffrés)
    if (list.some((r) => r.secret)) void requestPersistentStorage();
  } catch {
    /* base indisponible (navigation privée stricte) */
  }
}

/** Boîtes utilisables sur cet appareil (mot de passe connu), triées ; aucune requête réseau. */
export async function listAccounts(): Promise<MailboxInfo[]> {
  const list = await db.accounts.toArray();
  rows = new Map(list.map((r) => [r.id, r]));
  const open = list.filter((r) => passwords.has(r.id)).sort((a, b) => a.sortOrder - b.sortOrder);
  return Promise.all(open.map(async (r) => toInfo(r, await cachedSession(r.id))));
}

export function accountRow(id: string): AccountRow | undefined {
  return rows.get(id);
}

export async function findAccountByEmail(email: string): Promise<AccountRow | undefined> {
  const e = email.trim().toLowerCase();
  return db.accounts.where('email').equals(e).first();
}

// ------------------------------------------------------------------ connexion

/** URL de session de la passerelle IMAP (même origine). */
export const IMAP_SESSION_URL = '/imap/session';

export interface LoginInput {
  email: string;
  username?: string;
  protocol: 'jmap' | 'imap';
  /** Boîte JMAP : URL de session ; ignorée pour IMAP. */
  sessionUrl?: string;
  imap?: MailEndpoint;
  smtp?: MailEndpoint;
  /** ManageSieve (boîte IMAP), facultatif. */
  sieve?: MailEndpoint;
  /** Service CardDAV (boîte IMAP), facultatif : URL https. */
  carddav?: string;
  /** Service CalDAV (boîte IMAP), facultatif : URL https. */
  caldav?: string;
  password: string;
  /** « Rester connecté sur cet appareil » : secret chiffré dans Dexie, sinon en mémoire seulement. */
  remember: boolean;
}

/**
 * Vérifie les identifiants (`GET` de l'URL de session avec Basic ; IMAP : passerelle avec `X-Voxel-Imap`/`X-Voxel-Smtp`),
 * puis ajoute ou met à jour le compte. Erreurs : `invalid_credentials`, `rate_limited`, `upstream_unreachable`
 * (réseau, CORS), ou le code renvoyé par la passerelle.
 */
export async function loginAccount(input: LoginInput): Promise<MailboxInfo> {
  const email = input.email.trim().toLowerCase();
  const username = input.username?.trim() || email;
  const imap = input.protocol === 'imap';
  if (imap && (!input.imap || !input.smtp)) throw new ApiError('IMAP and SMTP servers required', 400, undefined, 'validation');
  if (!imap && !input.sessionUrl) throw new ApiError('JMAP session URL required', 400, undefined, 'validation');
  const sessionUrl = imap ? IMAP_SESSION_URL : input.sessionUrl!;
  let res: Response;
  try {
    res = await fetch(sessionUrl, {
      method: 'GET',
      headers: { ...headersFor({ protocol: input.protocol, email, username, imap: input.imap, smtp: input.smtp, sieve: input.sieve, carddav: input.carddav, caldav: input.caldav }, input.password), Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Mail server unreachable', 0, undefined, 'upstream_unreachable');
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const given = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    let code: ApiErrorCode | 'unknown' = isKnownCode(given) ? given : codeOfStatus(res.status);
    if (res.status === 401 || code === 'upstream_auth') code = 'invalid_credentials';
    if (code === 'unknown') code = 'upstream_unreachable';
    throw new ApiError(`HTTP ${res.status}`, res.status, body, code);
  }
  let session: Session;
  try {
    session = (await res.json()) as Session;
  } catch {
    throw new ApiError('Invalid JMAP session', res.status, undefined, 'upstream_unreachable');
  }
  // session anonyme (aucun compte mail) : identifiants non reconnus
  if (!session?.primaryAccounts?.[CAP.mail]) throw new ApiError('No mail account', 200, undefined, 'invalid_credentials');

  const existing = await findAccountByEmail(email);
  const all = await db.accounts.toArray();
  const row: AccountRow = existing
    ? { ...existing, username, protocol: input.protocol, sessionUrl }
    : {
        id: crypto.randomUUID(),
        email,
        username,
        protocol: input.protocol,
        sessionUrl,
        displayName: '',
        color: ACCOUNT_COLORS[all.length % 8]!,
        sortOrder: all.reduce((m, r) => Math.max(m, r.sortOrder + 1), 0),
        createdAt: Date.now(),
      };
  if (imap) {
    row.imap = input.imap;
    row.smtp = input.smtp;
    if (input.sieve) row.sieve = input.sieve;
    else delete row.sieve;
    if (input.carddav) row.carddav = input.carddav;
    else delete row.carddav;
    if (input.caldav) row.caldav = input.caldav;
    else delete row.caldav;
  } else {
    delete row.imap;
    delete row.smtp;
    delete row.sieve;
    delete row.carddav;
    delete row.caldav;
  }
  if (input.remember) row.secret = await encrypt(input.password);
  else delete row.secret;
  await db.accounts.put(row);
  saveSession(row.id, session);
  rows.set(row.id, row);
  passwords.set(row.id, input.password);
  // demande au navigateur de ne pas évincer IndexedDB (comptes et mots de passe chiffrés)
  if (input.remember) void requestPersistentStorage();
  return toInfo(row, session);
}

/** Renomme ou recolore une boîte (préférence propre à l'appareil). */
export async function updateAccount(id: string, patch: { displayName?: string; color?: string }) {
  await db.accounts.update(id, patch);
  const r = rows.get(id);
  if (r) rows.set(id, { ...r, ...patch });
}

/** Supprime le compte et son secret (le reste du cache est purgé par l'appelant). */
export async function removeAccount(id: string) {
  passwords.delete(id);
  rows.delete(id);
  sessions.delete(id);
  await db.accounts.delete(id).catch(() => undefined);
}

/** Oublie tous les mots de passe en mémoire (« Tout déconnecter »). */
export function forgetAllPasswords() {
  passwords.clear();
  rows.clear();
  sessions.clear();
}
