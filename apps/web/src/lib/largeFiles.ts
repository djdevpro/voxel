/**
 * Pièces jointes volumineuses (S3) : au-delà du seuil du serveur (1 Mo), un fichier joint part dans le stockage S3
 * de l'expéditeur et le message porte un lien de téléchargement à sa place (routes `/files/*` du serveur Voxel).
 *
 * - Seulement sur le web, pour une boîte JMAP du serveur de messagerie de `config.json` : le serveur Voxel vérifie
 *   l'expéditeur auprès de ce serveur avec les identifiants de la boîte (en-tête `Authorization`, comme pour JMAP).
 * - Compte S3 créé par le serveur à la première utilisation : l'appli prévient seulement (`account.exists`).
 * - Octets envoyés directement à S3 (URL présignée) ; si le navigateur ne peut pas (CORS du bucket), relais par le
 *   serveur. Le lien du message est `/f/<id>/<nom>` sur l'origine de l'appli, valable `linkDays` jours.
 */
import i18n from '@/i18n';
import { accountRow, authHeader } from './accounts';
import { sessionUrlFor } from './config';
import { fileSize } from './format';
import { isDesktop } from './platform';
import type { MailboxInfo } from './api';

export interface LargeFilesConfig {
  enabled: boolean;
  /** Octets au-delà desquels une pièce jointe part par lien. */
  threshold: number;
  /** Espace de chaque compte, en octets. */
  quota: number;
  /** Validité d'un lien, en jours. */
  linkDays: number;
}

/** Fichier envoyé par lien (gardé dans l'état de la rédaction). */
export interface LinkedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  /** URL absolue du lien de téléchargement. */
  url: string;
  expiresAt: string;
  /** Boîte dont le compte S3 garde le fichier (pour le retirer). */
  accountId?: string;
}

export interface LargeFilesAccount {
  exists: boolean;
  createdAt: string | null;
  used: number;
  quota: number;
}

export type LargeFileErrorCode = 'quota_exceeded' | 'upstream_auth' | 'forbidden' | 'storage' | 'network' | 'aborted';

export class LargeFileError extends Error {
  constructor(
    readonly code: LargeFileErrorCode,
    readonly used?: number,
    readonly quota?: number,
  ) {
    super(code);
    this.name = 'LargeFileError';
  }
}

const DISABLED: LargeFilesConfig = { enabled: false, threshold: 0, quota: 0, linkDays: 0 };
let configPromise: Promise<LargeFilesConfig> | undefined;

/** Réglages du serveur, lus une fois (désactivé sur le bureau, sans serveur ou hors ligne). */
export function largeFilesConfig(): Promise<LargeFilesConfig> {
  if (isDesktop) return Promise.resolve(DISABLED);
  configPromise ??= fetch('/files/config', { cache: 'no-store', credentials: 'omit' })
    .then(async (res) => {
      const body = res.ok ? ((await res.json()) as Partial<LargeFilesConfig>) : null;
      if (!body?.enabled || !Number(body.threshold) || !Number(body.quota)) return DISABLED;
      return { enabled: true, threshold: Number(body.threshold), quota: Number(body.quota), linkDays: Number(body.linkDays) || 0 };
    })
    .catch(() => {
      configPromise = undefined;
      return DISABLED;
    });
  return configPromise;
}

function absolute(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

/** Boîte qui peut envoyer par lien : JMAP, sur le serveur que `config.json` donne pour son domaine. */
export function largeFilesEligible(account: Pick<MailboxInfo, 'protocol' | 'email' | 'sessionUrl'> | undefined): boolean {
  if (!account || isDesktop || account.protocol !== 'jmap') return false;
  const configured = sessionUrlFor(account.email);
  return !!configured && absolute(configured) === absolute(account.sessionUrl);
}

function headersOf(accountId: string, json = false): Record<string, string> {
  const email = accountRow(accountId)?.email ?? '';
  return { ...authHeader(accountId), 'X-Voxel-Email': email, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function failure(res: Response): Promise<LargeFileError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; used?: string; quota?: string };
  if (body.error === 'quota_exceeded') return new LargeFileError('quota_exceeded', Number(body.used), Number(body.quota));
  if (res.status === 401) return new LargeFileError('upstream_auth');
  if (res.status === 403) return new LargeFileError('forbidden');
  return new LargeFileError('storage');
}

async function call(accountId: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: 'omit', cache: 'no-store', headers: { ...headersOf(accountId, typeof init.body === 'string'), ...(init.headers as Record<string, string> | undefined) } });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new LargeFileError('aborted');
    throw new LargeFileError('network');
  }
  if (!res.ok) throw await failure(res);
  return res;
}

const accountCache = new Map<string, Promise<LargeFilesAccount>>();

/** Compte S3 de l'expéditeur (existe-t-il, espace utilisé), gardé pour la session de la page. */
export function largeFilesAccount(accountId: string, opts: { fresh?: boolean } = {}): Promise<LargeFilesAccount> {
  let p = opts.fresh ? undefined : accountCache.get(accountId);
  if (!p) {
    p = call(accountId, '/files/account').then((r) => r.json() as Promise<LargeFilesAccount>);
    p.catch(() => accountCache.delete(accountId));
    accountCache.set(accountId, p);
  }
  return p;
}

/** En-têtes que le navigateur pose lui-même : la longueur signée est celle du fichier envoyé. */
const BROWSER_MANAGED = new Set(['content-length', 'host', 'connection']);

/** PUT par XHR (progression d'envoi) ; résout le statut HTTP, 0 pour une erreur réseau ou CORS. */
function put(url: string, headers: Record<string, string>, file: File, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [name, value] of Object.entries(headers)) if (!BROWSER_MANAGED.has(name.toLowerCase())) xhr.setRequestHeader(name, value);
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      done();
      resolve(xhr.status);
    };
    xhr.onerror = () => {
      done();
      resolve(0);
    };
    xhr.onabort = () => {
      done();
      reject(new LargeFileError('aborted'));
    };
    xhr.send(file);
  });
}

/**
 * Envoie un fichier dans le stockage S3 de la boîte et renvoie son lien ; `created` : le compte vient d'être créé.
 * `onProgress` reçoit la part envoyée (0 à 1).
 */
export async function uploadLargeFile(
  accountId: string,
  file: File,
  opts: { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
): Promise<{ file: LinkedFile; created: boolean }> {
  const progress = (loaded: number) => opts.onProgress?.(file.size ? Math.min(1, loaded / file.size) : 1);
  const r = await call(accountId, '/files/uploads', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }),
    signal: opts.signal,
  });
  const created = (await r.json()) as { id: string; upload: { url: string; headers: Record<string, string> }; account: { created: boolean } };
  accountCache.delete(accountId);
  const id = encodeURIComponent(created.id);
  try {
    let status = await put(created.upload.url, created.upload.headers, file, progress, opts.signal);
    // le bucket refuse l'origine de l'appli (CORS) ou S3 est injoignable d'ici : le serveur relaie
    if (status < 200 || status >= 300) {
      progress(0);
      status = await put(`/files/uploads/${id}/data`, { ...headersOf(accountId), 'Content-Type': file.type || 'application/octet-stream' }, file, progress, opts.signal);
    }
    if (status === 0) throw new LargeFileError('network');
    if (status < 200 || status >= 300) throw new LargeFileError('storage');
    const done = (await (await call(accountId, `/files/uploads/${id}/complete`, { method: 'POST', signal: opts.signal })).json()) as LinkedFile;
    return { file: { ...done, url: absolute(done.url) }, created: created.account.created };
  } catch (e) {
    void deleteLargeFile(accountId, created.id);
    throw e;
  }
}

/** Retire un fichier envoyé par lien (pièce enlevée, brouillon supprimé) ; ne lève jamais. */
export async function deleteLargeFile(accountId: string, id: string): Promise<void> {
  try {
    await call(accountId, `/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    accountCache.delete(accountId);
  } catch {
    /* fichier déjà parti : il expirera de toute façon */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Bloc ajouté au message, avant la signature : la liste des liens et leur date de fin, dans la langue du message
 * (`lang`) si l'appli la connaît. HTML simple, lisible par tous les clients de messagerie.
 */
export function linksHtml(files: LinkedFile[], lang?: string): string {
  if (!files.length) return '';
  const lng = lang && i18n.hasResourceBundle(lang, 'compose') ? lang : undefined;
  const t = i18n.getFixedT(lng ?? null, 'compose');
  const last = Math.min(...files.map((f) => Date.parse(f.expiresAt)).filter(Number.isFinite));
  const date = Number.isFinite(last) ? new Intl.DateTimeFormat(lng ?? i18n.language, { dateStyle: 'long' }).format(new Date(last)) : '';
  const items = files
    .map((f) => `<li><a href="${escapeHtml(f.url)}">${escapeHtml(f.name)}</a> (${escapeHtml(fileSize(f.size))})</li>`)
    .join('');
  return `<div class="voxel-links"><p>${escapeHtml(t('largeFiles.block', { count: files.length, date }))}</p><ul>${items}</ul></div>`;
}
