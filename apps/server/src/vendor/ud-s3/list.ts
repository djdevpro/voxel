import { S3Error } from './errors.js';
import type { FileItem, FolderItem, ListPage } from './types.js';

/** Forme minimale d'une réponse `ListObjectsV2` (sous-ensemble du SDK). */
export interface RawListOutput {
  Contents?: Array<{
    Key?: string;
    Size?: number;
    LastModified?: Date | string;
    ETag?: string;
    StorageClass?: string;
  }>;
  CommonPrefixes?: Array<{ Prefix?: string }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
  EncodingType?: string;
}

/**
 * Décode une valeur renvoyée avec `encoding-type=url`. AWS encode les espaces
 * en `+` (forme application/x-www-form-urlencoded) et un `+` littéral en `%2B`.
 */
export function decodeS3Value(value: string, encoded: boolean): string {
  if (!encoded) return value;
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Dernier segment non vide, sans `/` final. */
export function nameOf(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** ETag sans guillemets. */
export function stripEtag(etag: string | undefined): string {
  if (!etag) return '';
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** ETag entre guillemets, tel qu'attendu par `CompleteMultipartUpload`. */
export function quoteEtag(etag: string): string {
  const bare = stripEtag(etag);
  return `"${bare}"`;
}

function isoDate(value: Date | string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export interface TransformOptions {
  prefix: string;
  /** Liste avec délimiteur (`/`) ou récursive (`null`). */
  delimited: boolean;
}

export interface TransformResult {
  folders: FolderItem[];
  files: FileItem[];
  folderMarker: boolean;
}

/**
 * Transforme une page `ListObjectsV2` : dossiers (préfixes communs) puis fichiers ;
 * le marqueur du dossier listé (clé égale au préfixe) est masqué. En liste récursive,
 * un marqueur de dossier (objet vide de clé terminée par `/`) devient un dossier.
 */
export function transformListPage(output: RawListOutput, options: TransformOptions): TransformResult {
  const encoded = (output.EncodingType ?? '').toLowerCase() === 'url';
  const folders: FolderItem[] = [];
  const files: FileItem[] = [];
  let folderMarker = false;

  for (const entry of output.CommonPrefixes ?? []) {
    if (!entry.Prefix) continue;
    const key = decodeS3Value(entry.Prefix, encoded);
    folders.push({ type: 'folder', key, name: nameOf(key) });
  }
  for (const entry of output.Contents ?? []) {
    if (entry.Key === undefined) continue;
    const key = decodeS3Value(entry.Key, encoded);
    const size = entry.Size ?? 0;
    if (key === options.prefix && options.prefix !== '') {
      folderMarker = true;
      continue;
    }
    if (!options.delimited && key.endsWith('/') && size === 0) {
      folders.push({ type: 'folder', key, name: nameOf(key) });
      continue;
    }
    const file: FileItem = {
      type: 'file',
      key,
      name: nameOf(key),
      size,
      lastModified: isoDate(entry.LastModified),
      etag: stripEtag(entry.ETag),
    };
    if (entry.StorageClass) file.storageClass = entry.StorageClass;
    files.push(file);
  }
  return { folders, files, folderMarker };
}

/** Assemble une page de l'API : dossiers d'abord, fichiers ensuite. */
export function toListPage(result: TransformResult, nextToken: string | undefined | null): ListPage {
  const page: ListPage = {
    items: [...result.folders, ...result.files],
    nextCursor: nextToken ? encodeCursor(nextToken) : null,
  };
  if (result.folderMarker) page.folderMarker = true;
  return page;
}

// --- Curseur opaque -------------------------------------------------------------------------------

const CURSOR_VERSION = 'u1';

/**
 * Encapsule le `ContinuationToken` S3 dans un curseur opaque (base64url). Le serveur peut
 * l'envelopper à son tour (chiffrement lié au principal).
 */
export function encodeCursor(token: string): string {
  return Buffer.from(`${CURSOR_VERSION}:${token}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const fail = (): never => {
    throw new S3Error({ code: 'validation', reason: 'invalid_cursor', message: 'Invalid list cursor' });
  };
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return fail();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const prefix = `${CURSOR_VERSION}:`;
  if (!text.startsWith(prefix) || text.length === prefix.length) return fail();
  return text.slice(prefix.length);
}

// --- Encodages de clés ------------------------------------------------------------------------------

/** `x-amz-copy-source` : `<bucket>/<clé encodée segment par segment>[?versionId=]`. */
export function copySource(bucket: string, key: string, versionId?: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const base = `${bucket}/${encodedKey}`;
  return versionId ? `${base}?versionId=${encodeURIComponent(versionId)}` : base;
}

/**
 * Encode les segments `.` et `..` du chemin d'une URL présignée, pour que le
 * navigateur ne normalise pas le chemin. S3 décode le chemin avant de calculer la signature.
 */
export function protectDotSegments(url: string): string {
  // Travail sur la chaîne : l'analyseur WHATWG normaliserait justement ces segments.
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(.*)$/i.exec(url);
  if (!match) return url;
  const segments = match[2]!.split('/');
  if (!segments.some((segment) => segment === '.' || segment === '..')) return url;
  const path = segments.map((segment) => (segment === '.' ? '%2E' : segment === '..' ? '%2E%2E' : segment)).join('/');
  return `${match[1]}${path}${match[3]}`;
}

/** Caractères interdits en XML 1.0 : jamais dans un corps `DeleteObjects`. */
export function isXmlUnsafeKey(key: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(key);
}

// --- Content-Disposition ----------------------------------------------------------------------------

/**
 * `Content-Disposition` selon RFC 6266 : nom ASCII de repli entre guillemets et
 * `filename*` encodé selon RFC 5987 (UTF-8).
 */
export function contentDisposition(disposition: 'inline' | 'attachment', filename?: string): string {
  if (!filename) return disposition;
  // Repli ASCII : diacritiques retirés, caractères non sûrs remplacés.
  const fallback =
    filename
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .replace(/[\r\n]/g, '_')
      .trim() || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (fallback === filename && !/[%;,]/.test(filename)) return `${disposition}; filename="${fallback}"`;
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
