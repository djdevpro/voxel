import { createHash } from 'node:crypto';
import { Agent as HttpAgent, type ClientRequestArgs } from 'node:http';
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions } from 'node:https';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
  type CopyObjectCommandInput,
  type CreateMultipartUploadCommandInput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { deleteEntryError, S3Error, toS3Error, type S3ErrorContext } from './errors.js';
import {
  checkConnectAddress,
  createPinnedLookup,
  validateEndpoint,
  type GuardedEndpoint,
  type LookupFunction,
} from './netguard.js';
import {
  contentDisposition,
  copySource,
  decodeCursor,
  isXmlUnsafeKey,
  protectDotSegments,
  quoteEtag,
  stripEtag,
  toListPage,
  transformListPage,
  type TransformResult,
} from './list.js';
import { planParts, PART_SIZE_PREFERENCE } from './multipart.js';
import { detectProvider, getProvider, type ProviderPreset } from './providers.js';
import type { CreateS3Options, DeleteObjectsResult, ObjectHead, SignedRequest, UdS3 } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SOCKETS = 32;
const CONNECT_TIMEOUT_MS = 5_000;
/** Opérations longues : `CopyObject`, `UploadPartCopy`, `CompleteMultipartUpload`. */
const LONG_OPERATION_TIMEOUT_MS = 15 * 60_000;
const MAX_EMPTY_PAGES = 20;
const DELETE_BATCH = 1_000;
const COPY_CONCURRENCY = 4;
const MAX_PRESIGN_SECONDS = 604_800;

// --- Agents gardés ------------------------------------------------------------------------------

interface GuardContext {
  endpoint: GuardedEndpoint;
  requirePrivate: boolean;
}

/** Contrôle une IP littérale, que Node ne fait pas passer par `lookup`. */
function guardLiteral(options: ClientRequestArgs, guard: GuardContext): void {
  const host = (options.host ?? options.hostname ?? '').replace(/^\[|\]$/g, '');
  if (host && isIP(host)) {
    const refusal = checkConnectAddress(host, guard);
    if (refusal) throw refusal;
  }
}

class GuardedHttpsAgent extends HttpsAgent {
  readonly #guard: GuardContext;
  constructor(options: HttpsAgentOptions, guard: GuardContext) {
    super(options);
    this.#guard = guard;
  }
  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    guardLiteral(options, this.#guard);
    return super.createConnection(options, callback);
  }
}

class GuardedHttpAgent extends HttpAgent {
  readonly #guard: GuardContext;
  constructor(options: ConstructorParameters<typeof HttpAgent>[0], guard: GuardContext) {
    super(options);
    this.#guard = guard;
  }
  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    guardLiteral(options, this.#guard);
    return super.createConnection(options, callback);
  }
}

// --- Middleware Content-MD5 -------------------------------------------------------------------------

interface MutableRequest {
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * `DeleteObjects` exige une somme : le SDK v3 envoie CRC32, que plusieurs fournisseurs
 * refusent. On envoie `Content-MD5` (accepté partout) et on retire les sommes du SDK.
 */
function contentMd5Middleware(next: (args: { request: unknown }) => Promise<unknown>, context: { commandName?: string }) {
  return async (args: { request: unknown }) => {
    const request = args.request as MutableRequest | undefined;
    if (context.commandName === 'DeleteObjectsCommand' && request?.headers && typeof request.body === 'string') {
      for (const name of Object.keys(request.headers)) {
        const lower = name.toLowerCase();
        if (lower.startsWith('x-amz-checksum-') || lower === 'x-amz-sdk-checksum-algorithm' || lower === 'content-md5') {
          delete request.headers[name];
        }
      }
      request.headers['content-md5'] = createHash('md5').update(request.body, 'utf8').digest('base64');
    }
    return next(args);
  };
}

// --- Reprises -----------------------------------------------------------------------------------

const NON_REPLAYABLE_REASONS = new Set(['conditional_conflict', 'checksum_unsupported', 'tagging_unsupported', 'presign_expired']);

function shouldRetry(error: S3Error, skewRetried: boolean): boolean {
  if (!error.retryable) return false;
  if (error.code === 'not_implemented') return false;
  if (error.reason && NON_REPLAYABLE_REASONS.has(error.reason)) return false;
  if (error.code === 'clock_skew') return !skewRetried;
  return true;
}

function backoffMs(error: S3Error, attempt: number): number {
  if (error.details.retryAfter !== undefined) return Math.min(60, error.details.retryAfter) * 1000;
  const ceiling = Math.min(20_000, 200 * 2 ** attempt);
  const delay = Math.random() * ceiling;
  return error.reason === 'operation_aborted' ? Math.max(2_000, delay) : delay;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Validation des entrées ------------------------------------------------------------------------

function requireBucket(bucket: string): void {
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new S3Error({ code: 'validation', reason: 'bucket_name', message: 'Bucket name is required' });
  }
}

function requireKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new S3Error({ code: 'validation', reason: 'key_empty', message: 'Object key is required' });
  }
  if (Buffer.byteLength(key, 'utf8') > 1024) {
    throw new S3Error({ code: 'validation', reason: 'key_too_long', message: 'Object key exceeds 1024 bytes' });
  }
}

function requireExpires(expiresIn: number, maxSeconds: number): void {
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > Math.min(MAX_PRESIGN_SECONDS, maxSeconds)) {
    throw new S3Error({ code: 'validation', reason: 'expires_out_of_range', message: 'Presign duration is out of range' });
  }
}

function requireLength(contentLength: number, max: number): void {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new S3Error({ code: 'validation', reason: 'size_invalid', message: 'Content length must be a non-negative integer' });
  }
  if (contentLength > max) {
    throw new S3Error({
      code: 'entity_too_large',
      reason: 'provider_max',
      message: 'Content length exceeds the provider limit',
      details: { maxBytes: max },
    });
  }
}

function requireCredentials(options: CreateS3Options): void {
  const { credentials } = options;
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new S3Error({ code: 'validation', reason: 'credentials_missing', message: 'Credentials are required' });
  }
  if (!options.region) {
    throw new S3Error({ code: 'validation', reason: 'region_missing', message: 'Region is required' });
  }
}

function isoDate(value: Date | undefined): string {
  return (value ?? new Date(0)).toISOString();
}

/** Lit `X-Amz-SignedHeaders` d'une URL présignée. */
function signedHeadersOf(url: string): string[] {
  const value = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
  return value.split(';').filter(Boolean);
}

// --- Fabrique -----------------------------------------------------------------------------------

/** Crée un moteur S3. Lève `S3Error` `endpoint_not_allowed` si netguard refuse le point de terminaison. */
export function createS3(options: CreateS3Options): UdS3 {
  requireCredentials(options);
  const netOptions: { allowPrivate?: boolean; allowedEndpoints?: readonly string[] } = {};
  if (options.allowPrivate !== undefined) netOptions.allowPrivate = options.allowPrivate;
  if (options.allowedEndpoints !== undefined) netOptions.allowedEndpoints = options.allowedEndpoints;
  const endpoint = validateEndpoint(options.endpoint, netOptions);
  const preset: ProviderPreset = options.provider ? getProvider(options.provider) : detectProvider(endpoint.origin);
  const limits = preset.limits;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSockets = options.maxSockets ?? DEFAULT_MAX_SOCKETS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const copyThreshold = options.copyMultipartThreshold ?? limits.maxCopySize;
  const copyPartPreference = options.copyPartSize ?? PART_SIZE_PREFERENCE.copy;
  const secrets = [options.credentials.secretAccessKey, options.credentials.sessionToken ?? '', options.credentials.accessKeyId];

  // `http:` sans entrée explicite : seules des adresses privées sont acceptées à la résolution.
  const guard: GuardContext = { endpoint, requirePrivate: endpoint.protocol === 'http:' && !endpoint.explicitHttp };
  const lookup: LookupFunction = createPinnedLookup(guard);
  const agentOptions = { keepAlive: true, maxSockets, lookup: lookup as never };
  const agent =
    endpoint.protocol === 'https:'
      ? new GuardedHttpsAgent({ ...agentOptions, minVersion: 'TLSv1.2', rejectUnauthorized: true }, guard)
      : new GuardedHttpAgent(agentOptions, guard);

  const handler = new NodeHttpHandler({
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: timeoutMs,
    throwOnRequestTimeout: true,
    ...(endpoint.protocol === 'https:' ? { httpsAgent: agent as HttpsAgent } : { httpAgent: agent as HttpAgent }),
  });

  const credentials = { ...options.credentials };
  const clients = new Map<'path' | 'virtual', S3Client>();

  function buildClient(forcePathStyle: boolean): S3Client {
    const client = new S3Client({
      region: options.region,
      endpoint: endpoint.origin,
      forcePathStyle,
      credentials,
      requestHandler: handler,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
      followRegionRedirects: false,
      useArnRegion: false,
      disableMultiregionAccessPoints: true,
      useDualstackEndpoint: false,
      useFipsEndpoint: false,
    });
    client.middlewareStack.add(contentMd5Middleware as never, { step: 'build', priority: 'low', name: 'udContentMd5' });
    return client;
  }

  /** Client de l'adressage voulu ; un bucket à point est toujours adressé par chemin. */
  function clientFor(bucket: string): S3Client {
    const style: 'path' | 'virtual' = options.addressing === 'path' || bucket.includes('.') ? 'path' : 'virtual';
    let client = clients.get(style);
    if (!client) {
      client = buildClient(style === 'path');
      clients.set(style, client);
    }
    return client;
  }

  interface CallOptions {
    idempotent: boolean;
    context?: S3ErrorContext;
    long?: boolean;
  }

  async function call<T>(operation: string, bucket: string, run: (client: S3Client, timeout: number) => Promise<T>, callOptions: CallOptions): Promise<T> {
    const client = clientFor(bucket);
    const timeout = callOptions.long ? LONG_OPERATION_TIMEOUT_MS : timeoutMs;
    const context: S3ErrorContext = { ...(callOptions.context ?? {}), operation, secrets };
    let skewRetried = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run(client, timeout);
      } catch (error) {
        const mapped = toS3Error(error, context);
        const canRetry = callOptions.idempotent || mapped.code === 'clock_skew';
        if (!canRetry || attempt + 1 >= maxAttempts || !shouldRetry(mapped, skewRetried)) throw mapped;
        if (mapped.code === 'clock_skew') skewRetried = true;
        await sleep(backoffMs(mapped, attempt));
      }
    }
  }

  function signingDate(client: S3Client): Date {
    const offset = (client.config as { systemClockOffset?: number }).systemClockOffset ?? 0;
    return new Date(Date.now() + offset);
  }

  async function presign(
    bucket: string,
    command: GetObjectCommand | PutObjectCommand | UploadPartCommand,
    method: 'GET' | 'PUT',
    expiresIn: number,
    values: Record<string, string>,
  ): Promise<SignedRequest> {
    const client = clientFor(bucket);
    const signable = new Set(Object.keys(values));
    let url: string;
    try {
      url = await getSignedUrl(client, command as never, {
        expiresIn,
        signingDate: signingDate(client),
        ...(signable.size > 0 ? { signableHeaders: signable } : {}),
      });
    } catch (error) {
      throw toS3Error(error, { operation: 'Presign', secrets });
    }
    const signed = signedHeadersOf(url);
    const headers: Record<string, string> = {};
    for (const name of signed) {
      if (name === 'host') continue;
      const value = values[name];
      if (value === undefined) {
        throw new S3Error({ code: 'internal', reason: 'unexpected_signed_header', message: `Unexpected signed header ${name}` });
      }
      headers[name] = value;
    }
    for (const name of signable) {
      if (!signed.includes(name)) {
        throw new S3Error({ code: 'internal', reason: 'header_not_signed', message: `Header ${name} was not signed` });
      }
    }
    return {
      url: protectDotSegments(url),
      method,
      headers,
      expiresAt: new Date(signingDate(client).getTime() + expiresIn * 1000).toISOString(),
    };
  }

  async function headRaw(bucket: string, key: string, versionId?: string): Promise<HeadObjectCommandOutput> {
    return call(
      'HeadObject',
      bucket,
      (client, timeout) =>
        client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }), {
          requestTimeout: timeout,
        }),
      { idempotent: true, context: { versionId: Boolean(versionId) } },
    );
  }

  function toHead(key: string, output: HeadObjectCommandOutput): ObjectHead {
    const head: ObjectHead = {
      key,
      size: output.ContentLength ?? 0,
      lastModified: isoDate(output.LastModified),
      etag: stripEtag(output.ETag),
      metadata: { ...(output.Metadata ?? {}) },
    };
    if (output.ContentType) head.contentType = output.ContentType;
    if (output.VersionId) head.versionId = output.VersionId;
    if (output.StorageClass) head.storageClass = output.StorageClass;
    return head;
  }

  async function listPage(bucket: string, prefix: string, delimiter: '/' | null, token: string | undefined, limit: number) {
    return call<ListObjectsV2CommandOutput>(
      'ListObjectsV2',
      bucket,
      (client, timeout) =>
        client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix || undefined,
            Delimiter: delimiter ?? undefined,
            MaxKeys: limit,
            EncodingType: 'url',
            ...(token ? { ContinuationToken: token } : {}),
          }),
          { requestTimeout: timeout },
        ),
      { idempotent: true },
    );
  }

  /** Objets archivés non restaurés : la copie est refusée. */
  function assertCopyable(head: HeadObjectCommandOutput): void {
    const archived = head.StorageClass === 'GLACIER' || head.StorageClass === 'DEEP_ARCHIVE' || Boolean(head.ArchiveStatus);
    if (!archived) return;
    const restore = head.Restore ?? '';
    if (/ongoing-request="false"/.test(restore)) return;
    throw new S3Error({
      code: 'invalid_object_state',
      reason: /ongoing-request="true"/.test(restore) ? 'restore_in_progress' : 'archived',
      message: 'Source object is archived',
    });
  }

  /** Attributs à préserver lors d'une réécriture. */
  function preservedAttributes(head: HeadObjectCommandOutput): Partial<CopyObjectCommandInput> {
    const out: Partial<CopyObjectCommandInput> = {};
    if (head.StorageClass && head.StorageClass !== 'STANDARD') out.StorageClass = head.StorageClass as CopyObjectCommandInput['StorageClass'];
    if (head.WebsiteRedirectLocation) out.WebsiteRedirectLocation = head.WebsiteRedirectLocation;
    if (head.ServerSideEncryption === 'aws:kms' || head.ServerSideEncryption === 'aws:kms:dsse') {
      out.ServerSideEncryption = head.ServerSideEncryption;
      if (head.SSEKMSKeyId) out.SSEKMSKeyId = head.SSEKMSKeyId;
      if (head.BucketKeyEnabled !== undefined) out.BucketKeyEnabled = head.BucketKeyEnabled;
    } else if (head.ServerSideEncryption === 'AES256') {
      out.ServerSideEncryption = 'AES256';
    }
    return out;
  }

  async function copyMultipart(
    input: { bucket: string; key: string; sourceBucket: string; sourceKey: string; sourceVersionId?: string },
    head: HeadObjectCommandOutput,
  ): Promise<{ etag: string; versionId?: string }> {
    const size = head.ContentLength ?? 0;
    const plan = planParts(size, copyPartPreference, limits);
    let tagging: string | undefined;
    try {
      const tags = await call(
        'GetObjectTagging',
        input.sourceBucket,
        (client, timeout) =>
          client.send(
            new GetObjectTaggingCommand({
              Bucket: input.sourceBucket,
              Key: input.sourceKey,
              ...(input.sourceVersionId ? { VersionId: input.sourceVersionId } : {}),
            }),
            { requestTimeout: timeout },
          ),
        { idempotent: true },
      );
      const set = tags.TagSet ?? [];
      if (set.length > 0) {
        tagging = set.map((tag) => `${encodeURIComponent(tag.Key ?? '')}=${encodeURIComponent(tag.Value ?? '')}`).join('&');
      }
    } catch {
      // Étiquettes illisibles ou non prises en charge : la copie continue sans elles.
    }
    const createInput: CreateMultipartUploadCommandInput = {
      Bucket: input.bucket,
      Key: input.key,
      ...(preservedAttributes(head) as Partial<CreateMultipartUploadCommandInput>),
      Metadata: { ...(head.Metadata ?? {}) },
    };
    if (head.ContentType) createInput.ContentType = head.ContentType;
    if (head.CacheControl) createInput.CacheControl = head.CacheControl;
    if (head.ContentDisposition) createInput.ContentDisposition = head.ContentDisposition;
    if (head.ContentEncoding) createInput.ContentEncoding = head.ContentEncoding;
    if (head.ContentLanguage) createInput.ContentLanguage = head.ContentLanguage;
    if (head.ExpiresString) createInput.Expires = new Date(head.ExpiresString);
    if (tagging) createInput.Tagging = tagging;

    const created = await call(
      'CreateMultipartUpload',
      input.bucket,
      (client, timeout) => client.send(new CreateMultipartUploadCommand(createInput), { requestTimeout: timeout }),
      { idempotent: false },
    );
    const uploadId = created.UploadId;
    if (!uploadId) throw new S3Error({ code: 'upstream_error', reason: 'not_s3', message: 'Missing upload id' });

    const source = copySource(input.sourceBucket, input.sourceKey, input.sourceVersionId);
    const parts: Array<{ PartNumber: number; ETag: string }> = new Array(plan.partCount);
    try {
      let next = 0;
      const worker = async () => {
        while (next < plan.partCount) {
          const index = next;
          next += 1;
          const start = index * plan.partSize;
          const end = Math.min(size, start + plan.partSize) - 1;
          const result = await call(
            'UploadPartCopy',
            input.bucket,
            (client, timeout) =>
              client.send(
                new UploadPartCopyCommand({
                  Bucket: input.bucket,
                  Key: input.key,
                  UploadId: uploadId,
                  PartNumber: index + 1,
                  CopySource: source,
                  CopySourceRange: `bytes=${start}-${end}`,
                  ...(head.ETag ? { CopySourceIfMatch: head.ETag } : {}),
                }),
                { requestTimeout: timeout },
              ),
            { idempotent: true, long: true },
          );
          parts[index] = { PartNumber: index + 1, ETag: quoteEtag(result.CopyPartResult?.ETag ?? '') };
        }
      };
      await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, plan.partCount) }, worker));
      const completed = await call(
        'CompleteMultipartUpload',
        input.bucket,
        (client, timeout) =>
          client.send(
            new CompleteMultipartUploadCommand({
              Bucket: input.bucket,
              Key: input.key,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
            }),
            { requestTimeout: timeout },
          ),
        { idempotent: false, long: true },
      );
      const out: { etag: string; versionId?: string } = { etag: stripEtag(completed.ETag) };
      if (completed.VersionId) out.versionId = completed.VersionId;
      return out;
    } catch (error) {
      await abortQuietly(input.bucket, input.key, uploadId);
      throw toS3Error(error, { secrets });
    }
  }

  async function abortQuietly(bucket: string, key: string, uploadId: string): Promise<void> {
    try {
      await engine.abortMultipart({ bucket, key, uploadId });
    } catch {
      // L'abandon est au mieux ; le cycle de vie nettoiera les restes (07).
    }
  }

  async function deleteOne(bucket: string, key: string, versionId?: string): Promise<void> {
    try {
      await call(
        'DeleteObject',
        bucket,
        (client, timeout) =>
          client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }), {
            requestTimeout: timeout,
          }),
        { idempotent: true },
      );
    } catch (error) {
      const mapped = toS3Error(error, { secrets });
      // Clé déjà absente : succès.
      if (mapped.code === 'key_not_found') return;
      throw mapped;
    }
  }

  const engine: UdS3 = {
    async headBucket({ bucket }) {
      requireBucket(bucket);
      await call('HeadBucket', bucket, (client, timeout) => client.send(new HeadBucketCommand({ Bucket: bucket }), { requestTimeout: timeout }), {
        idempotent: true,
      });
    },

    async listObjects({ bucket, prefix, delimiter = '/', cursor = null, limit }) {
      requireBucket(bucket);
      const max = Math.min(limits.maxKeys, 1_000);
      const pageSize = limit === undefined ? max : Math.max(1, Math.min(max, Math.floor(limit)));
      let token = cursor ? decodeCursor(cursor) : undefined;
      const delimited = delimiter === '/';
      const merged: TransformResult = { folders: [], files: [], folderMarker: false };
      // Une page vide tronquée est suivie automatiquement, 20 pages S3 au plus.
      for (let page = 0; page < MAX_EMPTY_PAGES; page += 1) {
        const output = await listPage(bucket, prefix, delimited ? '/' : null, token, pageSize);
        const result = transformListPage(output, { prefix, delimited });
        merged.folders.push(...result.folders);
        merged.files.push(...result.files);
        merged.folderMarker ||= result.folderMarker;
        token = output.IsTruncated ? output.NextContinuationToken : undefined;
        if (!token || merged.folders.length + merged.files.length > 0) break;
      }
      return toListPage(merged, token);
    },

    async headObject({ bucket, key, versionId }) {
      requireBucket(bucket);
      requireKey(key);
      return toHead(key, await headRaw(bucket, key, versionId));
    },

    async presignGet({ bucket, key, versionId, expiresIn, disposition, filename, contentType }) {
      requireBucket(bucket);
      requireKey(key);
      requireExpires(expiresIn, limits.maxPresignSeconds);
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(versionId ? { VersionId: versionId } : {}),
        ...(disposition || filename ? { ResponseContentDisposition: contentDisposition(disposition ?? 'attachment', filename) } : {}),
        ...(contentType ? { ResponseContentType: contentType } : {}),
      });
      return presign(bucket, command, 'GET', expiresIn, {});
    },

    async presignPut({ bucket, key, expiresIn, contentLength, contentType }) {
      requireBucket(bucket);
      requireKey(key);
      requireExpires(expiresIn, limits.maxPresignSeconds);
      requireLength(contentLength, limits.maxPutSize);
      const values: Record<string, string> = { 'content-length': String(contentLength) };
      if (contentType) values['content-type'] = contentType;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentLength: contentLength,
        ...(contentType ? { ContentType: contentType } : {}),
      });
      return presign(bucket, command, 'PUT', expiresIn, values);
    },

    async createMultipart({ bucket, key, contentType }) {
      requireBucket(bucket);
      requireKey(key);
      const output = await call(
        'CreateMultipartUpload',
        bucket,
        (client, timeout) =>
          client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ...(contentType ? { ContentType: contentType } : {}) }), {
            requestTimeout: timeout,
          }),
        { idempotent: false },
      );
      if (!output.UploadId) throw new S3Error({ code: 'upstream_error', reason: 'not_s3', message: 'Missing upload id' });
      return { uploadId: output.UploadId };
    },

    async presignPart({ bucket, key, uploadId, partNumber, contentLength, expiresIn }) {
      requireBucket(bucket);
      requireKey(key);
      requireExpires(expiresIn, limits.maxPresignSeconds);
      if (!uploadId) throw new S3Error({ code: 'validation', reason: 'upload_id', message: 'Upload id is required' });
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > limits.maxParts) {
        throw new S3Error({ code: 'validation', reason: 'part_number', message: 'Part number is out of range' });
      }
      requireLength(contentLength, limits.maxPartSize);
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      });
      return presign(bucket, command, 'PUT', expiresIn, { 'content-length': String(contentLength) });
    },

    async listParts({ bucket, key, uploadId }) {
      requireBucket(bucket);
      requireKey(key);
      const parts: Array<{ partNumber: number; etag: string; size: number }> = [];
      let marker: string | undefined;
      for (;;) {
        const output = await call(
          'ListParts',
          bucket,
          (client, timeout) =>
            client.send(
              new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MaxParts: 1_000, ...(marker ? { PartNumberMarker: marker } : {}) }),
              { requestTimeout: timeout },
            ),
          { idempotent: true },
        );
        for (const part of output.Parts ?? []) {
          if (part.PartNumber === undefined) continue;
          parts.push({ partNumber: part.PartNumber, etag: stripEtag(part.ETag), size: part.Size ?? 0 });
        }
        if (!output.IsTruncated || !output.NextPartNumberMarker || output.NextPartNumberMarker === marker) break;
        marker = output.NextPartNumberMarker;
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    async completeMultipart({ bucket, key, uploadId, parts }) {
      requireBucket(bucket);
      requireKey(key);
      if (parts.length === 0) {
        throw new S3Error({ code: 'invalid_request', reason: 'parts_mismatch', message: 'No part to complete' });
      }
      const sorted = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({ PartNumber: part.partNumber, ETag: quoteEtag(part.etag) }));
      const output = await call(
        'CompleteMultipartUpload',
        bucket,
        (client, timeout) =>
          client.send(
            new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: sorted } }),
            { requestTimeout: timeout },
          ),
        { idempotent: false, long: true },
      );
      const result: { etag: string; versionId?: string } = { etag: stripEtag(output.ETag) };
      if (output.VersionId) result.versionId = output.VersionId;
      return result;
    },

    async abortMultipart({ bucket, key, uploadId }) {
      requireBucket(bucket);
      requireKey(key);
      try {
        await call(
          'AbortMultipartUpload',
          bucket,
          (client, timeout) => client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { requestTimeout: timeout }),
          { idempotent: true },
        );
      } catch (error) {
        const mapped = toS3Error(error, { secrets });
        // Envoi déjà disparu : succès.
        if (mapped.code === 'not_found' && mapped.reason === 'upload_gone') return;
        throw mapped;
      }
    },

    async putEmpty({ bucket, key }) {
      requireBucket(bucket);
      requireKey(key);
      await call(
        'PutObject',
        bucket,
        (client, timeout) =>
          client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: '',
              ContentLength: 0,
              ...(key.endsWith('/') ? { ContentType: 'application/x-directory' } : {}),
            }),
            { requestTimeout: timeout },
          ),
        { idempotent: true },
      );
    },

    async copyObject(input) {
      requireBucket(input.bucket);
      requireBucket(input.sourceBucket);
      requireKey(input.key);
      requireKey(input.sourceKey);
      const head = await headRaw(input.sourceBucket, input.sourceKey, input.sourceVersionId);
      if (head.SSECustomerAlgorithm) {
        throw new S3Error({ code: 'not_implemented', reason: 'capability', message: 'SSE-C copy is not supported', details: { capability: 'sse_c' } });
      }
      assertCopyable(head);
      const size = head.ContentLength ?? 0;
      if (size > copyThreshold) return copyMultipart(input, head);
      const output = await call(
        'CopyObject',
        input.bucket,
        (client, timeout) =>
          client.send(
            new CopyObjectCommand({
              Bucket: input.bucket,
              Key: input.key,
              CopySource: copySource(input.sourceBucket, input.sourceKey, input.sourceVersionId),
              MetadataDirective: 'COPY',
              TaggingDirective: 'COPY',
              ...(head.ETag ? { CopySourceIfMatch: head.ETag } : {}),
              ...preservedAttributes(head),
            }),
            { requestTimeout: timeout },
          ),
        { idempotent: true, long: true },
      ).catch((error: unknown) => {
        const mapped = toS3Error(error, { secrets });
        // La source a changé depuis la lecture.
        if (mapped.code === 'precondition_failed') {
          throw new S3Error({ code: 'precondition_failed', reason: 'source_changed', message: 'Source object changed during copy', ...(mapped.s3 ? { s3: mapped.s3 } : {}) });
        }
        throw mapped;
      });
      const result: { etag: string; versionId?: string } = { etag: stripEtag(output.CopyObjectResult?.ETag) };
      if (output.VersionId) result.versionId = output.VersionId;
      return result;
    },

    async deleteObject({ bucket, key, versionId }) {
      requireBucket(bucket);
      requireKey(key);
      await deleteOne(bucket, key, versionId);
    },

    async deleteObjects({ bucket, keys }) {
      requireBucket(bucket);
      const result: DeleteObjectsResult = { deleted: [], errors: [] };
      const unit = keys.filter((entry) => isXmlUnsafeKey(entry.key));
      const batchable = keys.filter((entry) => !isXmlUnsafeKey(entry.key));
      const deleteUnit = async (entry: { key: string; versionId?: string }) => {
        try {
          await deleteOne(bucket, entry.key, entry.versionId);
          result.deleted.push(entry.key);
        } catch (error) {
          const mapped = toS3Error(error, { secrets });
          result.errors.push({ key: entry.key, code: mapped.code, message: mapped.message });
        }
      };
      for (let start = 0; start < batchable.length; start += DELETE_BATCH) {
        const chunk = batchable.slice(start, start + DELETE_BATCH);
        let output;
        try {
          output = await call(
            'DeleteObjects',
            bucket,
            (client, timeout) =>
              client.send(
                new DeleteObjectsCommand({
                  Bucket: bucket,
                  Delete: {
                    Quiet: true,
                    Objects: chunk.map((entry) => ({ Key: entry.key, ...(entry.versionId ? { VersionId: entry.versionId } : {}) })),
                  },
                }),
                { requestTimeout: timeout },
              ),
            { idempotent: true },
          );
        } catch (error) {
          const mapped = toS3Error(error, { secrets });
          // Fournisseur sans DeleteObjects : repli unitaire.
          if (mapped.code === 'not_implemented') {
            for (const entry of chunk) await deleteUnit(entry);
            continue;
          }
          throw mapped;
        }
        const failed = new Set<string>();
        for (const entry of output.Errors ?? []) {
          const key = entry.Key ?? '';
          const mapped = deleteEntryError(entry.Code, entry.Message);
          if (mapped.code === 'key_not_found') continue;
          failed.add(`${key}\u0000${entry.VersionId ?? ''}`);
          result.errors.push({ key, code: mapped.code, message: mapped.message });
        }
        for (const entry of chunk) {
          if (!failed.has(`${entry.key}\u0000${entry.versionId ?? ''}`) && !failed.has(`${entry.key}\u0000`)) result.deleted.push(entry.key);
        }
      }
      for (const entry of unit) await deleteUnit(entry);
      return result;
    },

    async sumPrefix({ bucket, prefix }) {
      requireBucket(bucket);
      let bytes = 0;
      let objects = 0;
      let token: string | undefined;
      do {
        const output = await listPage(bucket, prefix, null, token, 1_000);
        for (const entry of output.Contents ?? []) {
          bytes += entry.Size ?? 0;
          objects += 1;
        }
        token = output.IsTruncated ? output.NextContinuationToken : undefined;
      } while (token);
      return { bytes, objects };
    },

    destroy() {
      for (const client of clients.values()) client.destroy();
      clients.clear();
      handler.destroy();
      agent.destroy();
    },
  };

  return engine;
}
