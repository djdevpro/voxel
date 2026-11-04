/**
 * Erreurs et types partagés du client. Plus de serveur applicatif : les erreurs viennent
 * du serveur de messagerie (JMAP) ou du réseau, et portent un code stable traduit via l'espace `errors`.
 */
import { JmapError } from '@voxel/jmap';
import type { MailEndpoint } from './db';
import i18n from '@/i18n';

/** Codes d'erreur stables (traduits dans `errors`). */
export const API_ERROR_CODES = [
  'invalid_credentials',
  'discovery_failed',
  'domain_not_allowed',
  'upstream_unreachable',
  'upstream_auth',
  'rate_limited',
  'forbidden',
  'not_found',
  'validation',
  'internal',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Code stable (`unknown` si absent ou inconnu). */
  readonly code: ApiErrorCode | 'unknown';
  constructor(message: string, status: number, body?: unknown, code?: ApiErrorCode | 'unknown') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = code ?? 'unknown';
  }
}

export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof Error && /network|fetch|Failed to fetch|Load failed/i.test(e.message));
}

export function isKnownCode(c: unknown): c is ApiErrorCode {
  return typeof c === 'string' && (API_ERROR_CODES as readonly string[]).includes(c);
}

/** Code d'erreur déduit d'un statut HTTP du serveur de messagerie. */
export function codeOfStatus(status: number): ApiErrorCode | 'unknown' {
  if (status === 401) return 'upstream_auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  if (status === 502 || status === 503 || status === 504) return 'upstream_unreachable';
  if (status >= 500) return 'internal';
  return 'unknown';
}

/** Message traduit pour une erreur quelconque (code, erreur JMAP, réseau, ou message brut en dernier recours). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'unknown') return i18n.t('errors:unknown', { status: e.status });
    return i18n.t(`errors:${e.code}`);
  }
  if (e instanceof JmapError && e.status) {
    // passerelle IMAP : corps `{ error, message }`
    const c = e.body && typeof e.body === 'object' ? (e.body as { error?: unknown }).error : undefined;
    if (isKnownCode(c)) return i18n.t(`errors:${c}`);
    const code = codeOfStatus(e.status);
    return code === 'unknown' ? i18n.t('errors:unknown', { status: e.status }) : i18n.t(`errors:${code}`);
  }
  if (isNetworkError(e)) return i18n.t('errors:network');
  return (e as Error)?.message || i18n.t('errors:internal');
}

/** Signale qu'une boîte a vu ses identifiants refusés par le serveur mail (mot de passe changé…). */
export function reportUpstreamAuth(mailboxId: string) {
  window.dispatchEvent(new CustomEvent<string>('voxel:upstream-auth', { detail: mailboxId }));
}

// ------------------------------------------------------------------ types

export interface MailboxCapabilities {
  vacation: boolean;
  sieve: boolean;
  contacts: boolean;
  submissionDelay: boolean;
  /** `urn:ietf:params:jmap:quota` (RFC 9425). */
  quota: boolean;
  /** `urn:ietf:params:jmap:contacts:parse` : import `.vcf` par le serveur. */
  contactsParse?: boolean;
  /** `urn:ietf:params:jmap:calendars` (agenda). */
  calendars?: boolean;
  /** `urn:ietf:params:jmap:calendars:parse` : import `.ics` et invitations par le serveur. */
  calendarsParse?: boolean;
  /** `urn:ietf:params:jmap:webpush-vapid` : notifications push, onglet fermé. */
  webpush?: boolean;
}

/** Boîte ouverte sur cet appareil (table Dexie `accounts` + capacités de sa session JMAP). */
export interface MailboxInfo {
  /** Identifiant local stable (jamais affiché ; les URL utilisent l'adresse). */
  id: string;
  email: string;
  /** Identifiant de connexion (= adresse par défaut). */
  username: string;
  protocol: 'jmap' | 'imap';
  sessionUrl: string;
  imap?: MailEndpoint;
  smtp?: MailEndpoint;
  /** Service CardDAV (boîte IMAP). */
  carddav?: string;
  /** Service CalDAV (boîte IMAP). */
  caldav?: string;
  displayName: string;
  color: string;
  capabilities: MailboxCapabilities;
  /** Ordre d'affichage dans le rail. */
  sortOrder?: number;
}

/** Alias historique : le reste du front parle de « compte ». */
export type Account = MailboxInfo;

export interface SessionInfo {
  mailboxes: MailboxInfo[];
}

/** Préférences de boîte propres à l'appareil (Dexie `kv`, clé `mbset:<id>`). */
export interface MailboxSettings {
  folderColors?: Record<string, string>;
  defaultIdentityId?: string | null;
}

export const ACCOUNT_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#78716c'];
