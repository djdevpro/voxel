import type { ErrorCode } from './contracts.js';
import type { ProviderId } from './providers.js';

export type Addressing = 'path' | 'virtual';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CreateS3Options {
  /** https://… ; http seulement avec allowPrivate vers un hôte privé ou loopback. */
  endpoint: string;
  region: string;
  addressing: Addressing;
  credentials: S3Credentials;
  /** Défaut 30000 (UD_S3_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Défaut 32 (UD_S3_CONCURRENCY). */
  maxSockets?: number;
  /** UD_ALLOW_PRIVATE_ENDPOINTS. */
  allowPrivate?: boolean;
  /** UD_ALLOWED_ENDPOINTS (motifs d'hôtes, ex. *.your-objectstorage.com). */
  allowedEndpoints?: string[];
  /** Préréglage fournisseur ; déduit de l'hôte sinon. */
  provider?: ProviderId;
  /** Tentatives pour les opérations rejouables, défaut 5 ; 1 désactive les reprises. */
  maxAttempts?: number;
  /** Seuil au-delà duquel une copie passe par UploadPartCopy, défaut 5 Gio (réglage et tests). */
  copyMultipartThreshold?: number;
  /** Taille de partie préférée d'une copie multipart, défaut 512 Mio. */
  copyPartSize?: number;
}

export interface FolderItem {
  type: 'folder';
  key: string;
  name: string;
}

export interface FileItem {
  type: 'file';
  key: string;
  name: string;
  size: number;
  lastModified: string;
  etag: string;
  storageClass?: string;
}

export interface ListPage {
  items: Array<FolderItem | FileItem>;
  nextCursor: string | null;
  /** Un marqueur de clé égale au préfixe existe (il n'est pas dans `items`). */
  folderMarker?: true;
}

export interface ObjectHead {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
  contentType?: string;
  versionId?: string;
  metadata: Record<string, string>;
  storageClass?: string;
}

/** Requête présignée : le client DOIT envoyer exactement ces en-têtes. */
export interface SignedRequest {
  url: string;
  method: 'GET' | 'PUT';
  headers: Record<string, string>;
  /** Date d'expiration ISO 8601. */
  expiresAt?: string;
}

export interface DeleteObjectsResult {
  deleted: string[];
  errors: Array<{ key: string; code: ErrorCode; message: string }>;
}

export interface UdS3 {
  headBucket(input: { bucket: string }): Promise<void>;
  listObjects(input: {
    bucket: string;
    prefix: string;
    delimiter?: '/' | null;
    cursor?: string | null;
    limit?: number;
  }): Promise<ListPage>;
  headObject(input: { bucket: string; key: string; versionId?: string }): Promise<ObjectHead>;
  presignGet(input: {
    bucket: string;
    key: string;
    versionId?: string;
    expiresIn: number;
    disposition?: 'inline' | 'attachment';
    filename?: string;
    contentType?: string;
  }): Promise<SignedRequest>;
  presignPut(input: {
    bucket: string;
    key: string;
    expiresIn: number;
    contentLength: number;
    contentType?: string;
  }): Promise<SignedRequest>;
  createMultipart(input: { bucket: string; key: string; contentType?: string }): Promise<{ uploadId: string }>;
  presignPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresIn: number;
  }): Promise<SignedRequest>;
  listParts(input: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<Array<{ partNumber: number; etag: string; size: number }>>;
  completeMultipart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<{ etag: string; versionId?: string }>;
  abortMultipart(input: { bucket: string; key: string; uploadId: string }): Promise<void>;
  /** Marqueur de dossier. */
  putEmpty(input: { bucket: string; key: string }): Promise<void>;
  /** Préserve métadonnées, type, classe. */
  copyObject(input: {
    bucket: string;
    key: string;
    sourceBucket: string;
    sourceKey: string;
    sourceVersionId?: string;
  }): Promise<{ etag: string; versionId?: string }>;
  deleteObject(input: { bucket: string; key: string; versionId?: string }): Promise<void>;
  deleteObjects(input: { bucket: string; keys: Array<{ key: string; versionId?: string }> }): Promise<DeleteObjectsResult>;
  /** Tout le sous-arbre, sans délimiteur. */
  sumPrefix(input: { bucket: string; prefix: string }): Promise<{ bytes: number; objects: number }>;
  destroy(): void;
}
