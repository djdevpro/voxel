import { httpStatusForError, type ApiError, type ErrorCode, type ErrorDetails } from './contracts.js';

/** Informations S3 d'origine, sans corps XML ni URL. */
export interface S3ErrorOrigin {
  code: string;
  requestId?: string;
}

export interface S3ErrorInit {
  code: ErrorCode;
  message?: string;
  reason?: string;
  retryable?: boolean;
  retryAfter?: number;
  cause?: string;
  s3?: S3ErrorOrigin;
  details?: Record<string, unknown>;
}

/** Erreur du moteur, déjà traduite vers les codes fermés de l'API. */
export class S3Error extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly s3?: { code: string; requestId?: string };
  readonly details: ErrorDetails;

  constructor(init: S3ErrorInit) {
    super(init.message ?? defaultMessage(init.code, init.s3?.code));
    this.name = 'S3Error';
    this.code = init.code;
    this.status = httpStatusForError(init.code);
    this.retryable = init.retryable ?? false;
    if (init.s3) this.s3 = { ...init.s3 };
    const details: ErrorDetails = { ...(init.details ?? {}), retryable: this.retryable };
    if (init.reason) details.reason = init.reason;
    if (init.retryAfter !== undefined) details.retryAfter = init.retryAfter;
    if (init.cause) details.cause = init.cause;
    this.details = details;
  }

  /** Motif précis (`details.reason`). */
  get reason(): string | undefined {
    return this.details.reason;
  }

  /** Enveloppe d'erreur `{ error, message, details?, s3? }` de l'API. */
  toApiError(): ApiError {
    const out: ApiError = { error: this.code, message: this.message, details: { ...this.details } };
    if (this.s3) out.s3 = { ...this.s3 };
    return out;
  }
}

function defaultMessage(code: ErrorCode, s3Code?: string): string {
  return s3Code ? `S3 error ${s3Code} (${code})` : `S3 engine error (${code})`;
}

/** Contexte facultatif de la traduction : affine les cas sans corps (HEAD) et les préconditions. */
export interface S3ErrorContext {
  /** Nom de l'opération S3 (`HeadObject`, `HeadBucket`, `CopyObject`…). */
  operation?: string;
  /** Une version précise était demandée. */
  versionId?: boolean;
  /** L'écriture portait `If-None-Match: *`. */
  ifNoneMatch?: boolean;
  /** Valeurs à retirer des messages (identifiants connus du client). */
  secrets?: readonly string[];
}

interface Mapping {
  code: ErrorCode;
  reason?: string;
  retryable?: boolean;
}

/** Annexe B de 02 : code S3 → code stable et motif. */
const S3_CODE_MAP: Record<string, Mapping> = {
  AccessDenied: { code: 'access_denied', reason: 'iam' },
  AllAccessDisabled: { code: 'access_denied', reason: 'all_access_disabled' },
  AccountProblem: { code: 'access_denied', reason: 'account_problem' },
  InvalidAccessKeyId: { code: 'invalid_credentials', reason: 'access_key' },
  InvalidClientTokenId: { code: 'invalid_credentials', reason: 'access_key' },
  SignatureDoesNotMatch: { code: 'signature_mismatch', reason: 'secret' },
  RequestTimeTooSkewed: { code: 'clock_skew', reason: 'skew_too_large', retryable: true },
  ExpiredToken: { code: 'token_expired', reason: 'session_token_expired' },
  TokenRefreshRequired: { code: 'token_expired', reason: 'session_token_expired' },
  InvalidToken: { code: 'token_expired', reason: 'session_token_invalid' },
  AuthorizationHeaderMalformed: { code: 'wrong_region', reason: 'authorization_header' },
  PermanentRedirect: { code: 'wrong_region', reason: 'permanent_redirect' },
  TemporaryRedirect: { code: 'wrong_region', reason: 'temporary_redirect' },
  Redirect: { code: 'wrong_region', reason: 'temporary_redirect' },
  IllegalLocationConstraintException: { code: 'wrong_region', reason: 'location_constraint' },
  InvalidLocationConstraint: { code: 'wrong_region', reason: 'location_constraint' },
  NoSuchBucket: { code: 'bucket_not_found' },
  NoSuchKey: { code: 'key_not_found' },
  NoSuchVersion: { code: 'version_not_found' },
  NoSuchUpload: { code: 'not_found', reason: 'upload_gone' },
  BucketAlreadyExists: { code: 'already_exists', reason: 'global_name' },
  BucketAlreadyOwnedByYou: { code: 'already_exists', reason: 'owned_by_you' },
  BucketNotEmpty: { code: 'bucket_not_empty' },
  OperationAborted: { code: 'conflict', reason: 'operation_aborted', retryable: true },
  ConditionalRequestConflict: { code: 'conflict', reason: 'conditional_conflict', retryable: true },
  InvalidBucketState: { code: 'conflict', reason: 'invalid_bucket_state' },
  InvalidBucketAclWithObjectOwnership: { code: 'conflict', reason: 'bucket_acl_grants' },
  InvalidBucketName: { code: 'validation', reason: 'bucket_name' },
  TooManyBuckets: { code: 'quota_exceeded', reason: 'bucket_count' },
  EntityTooLarge: { code: 'entity_too_large', reason: 'provider_max' },
  EntityTooSmall: { code: 'invalid_request', reason: 'part_too_small' },
  InvalidPart: { code: 'invalid_request', reason: 'parts_mismatch' },
  InvalidPartOrder: { code: 'invalid_request', reason: 'parts_mismatch' },
  MaxMessageLengthExceeded: { code: 'invalid_request', reason: 'request_too_large' },
  MaxPostPreDataLengthExceeded: { code: 'invalid_request', reason: 'request_too_large' },
  InlineDataTooLarge: { code: 'invalid_request', reason: 'request_too_large' },
  PreconditionFailed: { code: 'precondition_failed', reason: 'etag_mismatch' },
  InvalidRange: { code: 'invalid_request', reason: 'range_not_satisfiable' },
  SlowDown: { code: 'slow_down', reason: 'provider_throttled', retryable: true },
  ServiceUnavailable: { code: 'slow_down', reason: 'provider_throttled', retryable: true },
  InternalError: { code: 'upstream_error', reason: 'provider_error', retryable: true },
  RequestTimeout: { code: 'upstream_error', reason: 'request_timeout', retryable: true },
  IncompleteBody: { code: 'invalid_request', reason: 'incomplete_body' },
  BadDigest: { code: 'checksum_mismatch', reason: 'bad_digest' },
  XAmzContentSHA256Mismatch: { code: 'checksum_mismatch', reason: 'sha256_mismatch' },
  InvalidDigest: { code: 'checksum_mismatch', reason: 'invalid_digest' },
  NotImplemented: { code: 'not_implemented', reason: 'provider' },
  InvalidObjectState: { code: 'invalid_object_state', reason: 'archived' },
  AccessControlListNotSupported: { code: 'acl_not_supported', reason: 'ownership_enforced' },
  UnresolvableGrantByEmailAddress: { code: 'invalid_request', reason: 'email_grantee_unsupported' },
  InvalidArgument: { code: 'validation', reason: 'argument' },
  InvalidRequest: { code: 'invalid_request', reason: 's3_message' },
  MalformedXML: { code: 'validation', reason: 'xml' },
  MalformedPolicy: { code: 'validation', reason: 'policy' },
  InvalidPolicyDocument: { code: 'validation', reason: 'policy' },
  MalformedACLError: { code: 'validation', reason: 'acl' },
  KeyTooLongError: { code: 'validation', reason: 'key_too_long' },
  MetadataTooLarge: { code: 'validation', reason: 'metadata_too_large' },
  InvalidTag: { code: 'validation', reason: 'tags' },
  InvalidStorageClass: { code: 'invalid_request', reason: 'invalid_storage_class' },
  InvalidEncryptionAlgorithmError: { code: 'invalid_request', reason: 'kms' },
  GlacierExpeditedRetrievalNotAvailable: { code: 'slow_down', reason: 'expedited_unavailable', retryable: true },
  CrossLocationLoggingProhibited: { code: 'invalid_request', reason: 'logging_target' },
  InvalidTargetBucketForLogging: { code: 'invalid_request', reason: 'logging_target' },
  XMinioAdminBucketQuotaExceeded: { code: 'quota_exceeded', reason: 'provider_quota' },
  QuotaExceeded: { code: 'quota_exceeded', reason: 'provider_quota' },
  StorageCapExceeded: { code: 'quota_exceeded', reason: 'provider_quota' },
  TransactionCapExceeded: { code: 'quota_exceeded', reason: 'provider_quota' },
  XMinioStorageFull: { code: 'quota_exceeded', reason: 'storage_full' },
  InsufficientStorage: { code: 'quota_exceeded', reason: 'storage_full' },
  AnnotationLimitExceeded: { code: 'validation', reason: 'annotation' },
  AnnotationNameTooLong: { code: 'validation', reason: 'annotation' },
  InvalidAnnotationName: { code: 'validation', reason: 'annotation' },
  UnsupportedMediaType: { code: 'validation', reason: 'annotation' },
  IdempotencyParameterMismatch: { code: 'conflict', reason: 'idempotency_mismatch' },
  // Autres 400 de la référence AWS : message S3 conservé en anglais.
  InvalidSecurity: { code: 'invalid_request', reason: 's3_message' },
  InvalidURI: { code: 'invalid_request', reason: 's3_message' },
  MissingSecurityHeader: { code: 'invalid_request', reason: 's3_message' },
  MissingRequestBodyError: { code: 'invalid_request', reason: 's3_message' },
  UnexpectedContent: { code: 'invalid_request', reason: 's3_message' },
  InvalidPayer: { code: 'invalid_request', reason: 's3_message' },
  RequestIsNotMultiPartContent: { code: 'invalid_request', reason: 's3_message' },
  InvalidAddressingHeader: { code: 'invalid_request', reason: 's3_message' },
  UserKeyMustBeSpecified: { code: 'invalid_request', reason: 's3_message' },
  MissingContentMD5: { code: 'invalid_request', reason: 's3_message' },
  MissingContentLength: { code: 'invalid_request', reason: 's3_message' },
  InvalidContentLength: { code: 'invalid_request', reason: 's3_message' },
};

/** Erreurs réseau Node → `endpoint_unreachable` (motifs de 01). */
const NETWORK_CODES: Record<string, Mapping> = {
  ENOTFOUND: { code: 'endpoint_unreachable', reason: 'dns' },
  EAI_AGAIN: { code: 'endpoint_unreachable', reason: 'dns', retryable: true },
  ECONNREFUSED: { code: 'endpoint_unreachable', reason: 'refused' },
  EHOSTUNREACH: { code: 'endpoint_unreachable', reason: 'refused' },
  ENETUNREACH: { code: 'endpoint_unreachable', reason: 'refused' },
  ECONNRESET: { code: 'endpoint_unreachable', reason: 'refused', retryable: true },
  EPIPE: { code: 'endpoint_unreachable', reason: 'refused', retryable: true },
  ETIMEDOUT: { code: 'endpoint_unreachable', reason: 'timeout', retryable: true },
  ESOCKETTIMEDOUT: { code: 'endpoint_unreachable', reason: 'timeout', retryable: true },
  ECONNABORTED: { code: 'endpoint_unreachable', reason: 'timeout', retryable: true },
  CERT_HAS_EXPIRED: { code: 'tls_error', reason: 'cert_expired' },
  DEPTH_ZERO_SELF_SIGNED_CERT: { code: 'tls_error', reason: 'self_signed' },
  SELF_SIGNED_CERT_IN_CHAIN: { code: 'tls_error', reason: 'self_signed' },
  ERR_TLS_CERT_ALTNAME_INVALID: { code: 'tls_error', reason: 'hostname_mismatch' },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: { code: 'tls_error', reason: 'untrusted' },
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: { code: 'tls_error', reason: 'untrusted' },
  UNABLE_TO_GET_ISSUER_CERT: { code: 'tls_error', reason: 'untrusted' },
  CERT_UNTRUSTED: { code: 'tls_error', reason: 'untrusted' },
  EPROTO: { code: 'tls_error', reason: 'protocol' },
};

/** Opérations sans corps de réponse (correspondance par statut). */
const HEAD_OPERATIONS = new Set(['HeadObject', 'HeadBucket']);

const MAX_CAUSE_LENGTH = 500;

/**
 * Retire d'un texte tout ce qui pourrait trahir un secret : URL (signées ou non),
 * paramètres `X-Amz-*`, en-têtes d'autorisation, identifiants AWS et valeurs connues.
 */
export function sanitizeText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/X-Amz-[A-Za-z-]+=[^&\s"'<>]*/g, '[redacted]')
    .replace(/(authorization|x-amz-security-token|x-amz-signature|x-amz-credential)\s*[:=]\s*[^\s,;"'<>]+/gi, '$1: [redacted]')
    .replace(/AWS4-HMAC-SHA256[^\n]*/g, '[redacted]')
    .replace(/\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{12,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > MAX_CAUSE_LENGTH ? `${out.slice(0, MAX_CAUSE_LENGTH - 1)}…` : out;
}

interface RawError {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: number; requestId?: string; extendedRequestId?: string };
  $response?: { statusCode?: number; headers?: Record<string, string | undefined> };
  $fault?: unknown;
  cause?: unknown;
}

function asRaw(error: unknown): RawError {
  return typeof error === 'object' && error !== null ? (error as RawError) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function headerOf(raw: RawError, name: string): string | undefined {
  const headers = raw.$response?.headers;
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** `Retry-After` en secondes (nombre ou date HTTP), borné à 60 s. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(60, Math.max(0, seconds));
}

/** Code réseau Node, éventuellement niché dans `cause`. */
function networkCode(raw: RawError): string | undefined {
  let current: unknown = raw;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = stringOf((current as RawError).code);
    if (code && (NETWORK_CODES[code] || code.startsWith('ERR_SSL_'))) return code;
    current = (current as RawError).cause;
  }
  return undefined;
}

function fromStatus(status: number | undefined): Mapping {
  if (status === undefined) return { code: 'upstream_error', reason: 'unknown_code' };
  if (status === 503) return { code: 'slow_down', reason: 'provider_throttled', retryable: true };
  if (status >= 500) return { code: 'upstream_error', reason: 'provider_error', retryable: true };
  if (status === 301 || status === 307) return { code: 'wrong_region', reason: 'permanent_redirect' };
  if (status === 403) return { code: 'access_denied', reason: 'iam' };
  if (status === 404) return { code: 'not_found' };
  if (status === 409) return { code: 'conflict' };
  if (status === 412) return { code: 'precondition_failed', reason: 'etag_mismatch' };
  if (status === 413) return { code: 'entity_too_large', reason: 'provider_max' };
  if (status === 416) return { code: 'invalid_request', reason: 'range_not_satisfiable' };
  if (status === 429) return { code: 'slow_down', reason: 'provider_throttled', retryable: true };
  if (status === 501) return { code: 'not_implemented', reason: 'provider' };
  if (status === 200) return { code: 'upstream_error', reason: 'not_s3' };
  if (status >= 400) return { code: 'invalid_request', reason: 's3_message' };
  return { code: 'upstream_error', reason: 'unknown_code' };
}

/** Correspondance par statut des opérations sans corps. */
function fromHeadStatus(status: number | undefined, raw: RawError, context: S3ErrorContext): Mapping | undefined {
  if (status === undefined) return undefined;
  if (status === 404) {
    if (context.operation === 'HeadBucket') return { code: 'bucket_not_found' };
    return context.versionId ? { code: 'version_not_found' } : { code: 'key_not_found' };
  }
  if (status === 403) return { code: 'access_denied', reason: 'iam' };
  if (status === 405 && headerOf(raw, 'x-amz-delete-marker') === 'true') {
    return { code: 'key_not_found', reason: 'delete_marker' };
  }
  if ((status === 301 || status === 400) && headerOf(raw, 'x-amz-bucket-region')) {
    return { code: 'wrong_region', reason: 'permanent_redirect' };
  }
  if (status === 412) return { code: 'precondition_failed', reason: 'etag_mismatch' };
  return undefined;
}

/** Affinage par le message S3 (lignes « citant… » de l'annexe B). */
function refine(s3Code: string, message: string, mapping: Mapping, raw: RawError, context: S3ErrorContext): Mapping {
  if (s3Code === 'AccessDenied') {
    if (/request has expired/i.test(message)) return { code: 'access_denied', reason: 'presign_expired', retryable: true };
    if (/not yet valid/i.test(message)) return { code: 'clock_skew', reason: 'skew_too_large' };
    if (/HeadersNotSigned|headers?.*not signed/i.test(message)) return { code: 'invalid_request', reason: 'headers_not_signed' };
    if (/BlockPublicAcls/i.test(message)) return { code: 'access_denied', reason: 'block_public_acls' };
    if (/BlockPublicPolicy/i.test(message)) return { code: 'access_denied', reason: 'block_public_policy' };
    if (/retention|object lock/i.test(message)) return { code: 'object_locked', reason: 'retention' };
    if (/legal hold/i.test(message)) return { code: 'object_locked', reason: 'legal_hold' };
  }
  if (s3Code === 'InvalidRequest') {
    if (/content-md5|x-amz-checksum/i.test(message) && /object lock|retention/i.test(message)) {
      return { code: 'invalid_request', reason: 'content_md5_required' };
    }
    if (/retention|legal hold/i.test(message)) return { code: 'object_locked', reason: 'retention' };
    if (/mp-object-size/i.test(message)) return { code: 'invalid_request', reason: 'size_mismatch' };
  }
  if (s3Code === 'InvalidArgument') {
    if (/x-amz-checksum/i.test(message)) return { code: 'not_implemented', reason: 'checksum_unsupported', retryable: true };
    if (/x-amz-tagging/i.test(message)) return { code: 'not_implemented', reason: 'tagging_unsupported', retryable: true };
  }
  if (s3Code === 'PreconditionFailed' && context.ifNoneMatch) return { code: 'already_exists', reason: 'key_exists' };
  if (s3Code === 'ConditionalRequestConflict' && context.operation === 'CompleteMultipartUpload') {
    return { code: 'conflict', reason: 'restart_required' };
  }
  if (s3Code === 'InvalidObjectState' && /restore/i.test(headerOf(raw, 'x-amz-restore') ?? '')) {
    return { code: 'invalid_object_state', reason: 'restore_in_progress' };
  }
  if (s3Code === 'MethodNotAllowed') {
    if (headerOf(raw, 'x-amz-delete-marker') === 'true') return { code: 'key_not_found', reason: 'delete_marker' };
    return { code: 'not_implemented', reason: 'method_not_allowed' };
  }
  if (s3Code.startsWith('KMS.')) return { code: 'access_denied', reason: 'kms' };
  return mapping;
}

/**
 * Traduit toute erreur (S3, SDK, réseau, netguard) en `S3Error` aux codes fermés de l'API.
 * Le message ne contient jamais d'URL signée, d'identifiant ni de corps XML.
 */
export function toS3Error(error: unknown, context: S3ErrorContext = {}): S3Error {
  if (error instanceof S3Error) return error;
  const raw = asRaw(error);
  const secrets = context.secrets ?? [];
  const status = raw.$metadata?.httpStatusCode ?? raw.$response?.statusCode;
  const requestId = stringOf(raw.$metadata?.requestId) ?? headerOf(raw, 'x-amz-request-id');
  const retryAfter = parseRetryAfter(headerOf(raw, 'retry-after'));
  const name = stringOf(raw.name);
  const rawMessage = stringOf(raw.message) ?? '';

  // Délai ou annulation côté client.
  if (name === 'TimeoutError' || name === 'RequestTimeoutError') {
    return new S3Error({ code: 'endpoint_unreachable', reason: 'timeout', retryable: true, message: 'S3 request timed out' });
  }
  if (name === 'AbortError') {
    return new S3Error({ code: 'upstream_error', reason: 'aborted', message: 'S3 request aborted' });
  }

  const netCode = networkCode(raw);
  if (netCode && !raw.$metadata?.httpStatusCode) {
    const mapping = NETWORK_CODES[netCode] ?? { code: 'tls_error' as const, reason: 'protocol' };
    return new S3Error({
      code: mapping.code,
      reason: mapping.reason,
      retryable: mapping.retryable ?? false,
      message: `Network error ${netCode}`,
    });
  }

  const s3Code = stringOf(raw.Code) ?? (name && name !== 'Error' && name !== 'Unknown' && name !== 'UnknownError' ? name : undefined);
  const isHead = context.operation !== undefined && HEAD_OPERATIONS.has(context.operation);

  let mapping: Mapping | undefined;
  if (isHead) mapping = fromHeadStatus(status, raw, context);
  if (!mapping && s3Code) {
    const known = S3_CODE_MAP[s3Code];
    if (known) mapping = refine(s3Code, rawMessage, known, raw, context);
    else if (s3Code === 'MethodNotAllowed' || s3Code.startsWith('KMS.')) mapping = refine(s3Code, rawMessage, { code: 'upstream_error' }, raw, context);
    else if (s3Code === 'NotFound') mapping = context.versionId ? { code: 'version_not_found' } : { code: 'key_not_found' };
  }
  if (!mapping && raw.$metadata) {
    // Corps illisible (HTML, JSON) : réponse non S3 ; sinon correspondance par statut.
    const deserialization = /deserializ|not well-formed|unexpected token|char '<'/i.test(rawMessage);
    mapping = deserialization || status === 200 ? { code: 'upstream_error', reason: 'not_s3' } : fromStatus(status);
    // Code S3 inconnu : `upstream_error` / `unknown_code`, sauf les 5xx traités par statut.
    if (s3Code && mapping.reason !== 'not_s3' && (status === undefined || status < 500)) {
      mapping = { code: 'upstream_error', reason: 'unknown_code' };
    }
  }
  if (!mapping) {
    return new S3Error({ code: 'internal', reason: 'unexpected', message: 'Unexpected S3 engine error' });
  }

  const cause = rawMessage ? sanitizeText(rawMessage, secrets) : undefined;
  const origin: S3ErrorOrigin | undefined = s3Code || requestId ? { code: s3Code ?? `HTTP${status ?? ''}` } : undefined;
  if (origin && requestId) origin.requestId = requestId;
  const init: S3ErrorInit = {
    code: mapping.code,
    retryable: mapping.retryable ?? false,
    message: s3Code ? `S3 error ${s3Code}${status ? ` (HTTP ${status})` : ''}` : `S3 error (HTTP ${status ?? 'unknown'})`,
  };
  if (mapping.reason) init.reason = mapping.reason;
  if (retryAfter !== undefined) init.retryAfter = retryAfter;
  if (cause) init.cause = cause;
  if (origin) init.s3 = origin;
  return new S3Error(init);
}

/** Traduit un élément `Error` d'une réponse `DeleteObjects`. */
export function deleteEntryError(code: string | undefined, message: string | undefined): S3Error {
  const s3Code = code || 'Unknown';
  const mapping = S3_CODE_MAP[s3Code] ?? { code: 'upstream_error' as const, reason: 'unknown_code' };
  const init: S3ErrorInit = {
    code: mapping.code,
    retryable: mapping.retryable ?? false,
    message: `S3 error ${s3Code}`,
    s3: { code: s3Code },
  };
  if (mapping.reason) init.reason = mapping.reason;
  if (message) init.cause = sanitizeText(message);
  return new S3Error(init);
}
