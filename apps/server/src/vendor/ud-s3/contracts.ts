/**
 * Ce qu'utilise `@ud/s3` de `@ud/contracts` (djdevpro/s3drive, packages/contracts/src/errors.ts) : la liste
 * fermée des codes d'erreur, leur statut HTTP et la forme de l'enveloppe d'erreur. Les mêmes valeurs, en types
 * TypeScript au lieu des schémas zod, que le serveur de Voxel n'emploie pas.
 */

/** Liste fermée des codes d'erreur (A1). */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'csrf',
  'not_found',
  'validation',
  'rate_limited',
  'internal',
  'invalid_credentials',
  'signature_mismatch',
  'token_expired',
  'clock_skew',
  'endpoint_unreachable',
  'endpoint_not_allowed',
  'tls_error',
  'wrong_region',
  'access_denied',
  'bucket_not_found',
  'key_not_found',
  'version_not_found',
  'already_exists',
  'bucket_not_empty',
  'precondition_failed',
  'conflict',
  'not_implemented',
  'invalid_request',
  'entity_too_large',
  'slow_down',
  'quota_exceeded',
  'object_locked',
  'invalid_object_state',
  'acl_not_supported',
  'cors_missing',
  'scope_denied',
  'delegation_required',
  'share_expired',
  'share_revoked',
  'share_suspended',
  'share_password_required',
  'share_otp_required',
  'share_limit_reached',
  'checksum_mismatch',
  'upstream_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Refus d'identifiants par le fournisseur : 400 à `/auth/connect`, 502 sur une connexion existante. */
export const PROVIDER_CREDENTIAL_ERROR_CODES = ['invalid_credentials', 'signature_mismatch', 'token_expired'] as const satisfies readonly ErrorCode[];

/** Table fermée des statuts HTTP, valeur hors `/auth/connect`. */
export const ERROR_HTTP_STATUS = {
  validation: 400,
  invalid_request: 400,
  checksum_mismatch: 400,
  unauthorized: 401,
  share_password_required: 401,
  share_otp_required: 401,
  forbidden: 403,
  csrf: 403,
  access_denied: 403,
  endpoint_not_allowed: 403,
  scope_denied: 403,
  quota_exceeded: 403,
  not_found: 404,
  bucket_not_found: 404,
  key_not_found: 404,
  version_not_found: 404,
  already_exists: 409,
  bucket_not_empty: 409,
  conflict: 409,
  wrong_region: 409,
  acl_not_supported: 409,
  invalid_object_state: 409,
  cors_missing: 409,
  delegation_required: 409,
  share_expired: 410,
  share_revoked: 410,
  share_limit_reached: 410,
  precondition_failed: 412,
  entity_too_large: 413,
  object_locked: 423,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  upstream_error: 502,
  endpoint_unreachable: 502,
  tls_error: 502,
  invalid_credentials: 502,
  signature_mismatch: 502,
  token_expired: 502,
  slow_down: 503,
  clock_skew: 503,
  share_suspended: 503,
} as const satisfies Record<ErrorCode, number>;

export interface ErrorStatusContext {
  /** Vrai pour une réponse de `/api/v1/auth/connect` (le refus vient de l'appelant). */
  atConnect?: boolean;
}

export function httpStatusForError(code: ErrorCode, context: ErrorStatusContext = {}): number {
  if (context.atConnect && (PROVIDER_CREDENTIAL_ERROR_CODES as readonly string[]).includes(code)) return 400;
  return ERROR_HTTP_STATUS[code];
}

/** Champ `details` : ouvert, comme `z.looseObject` dans `@ud/contracts`. */
export interface ErrorDetails {
  reason?: string;
  retryable?: boolean;
  /** Secondes. */
  retryAfter?: number;
  limit?: string;
  attemptsLeft?: number;
  cause?: string;
  blockers?: unknown[];
  lockoutRisks?: unknown[];
  [key: string]: unknown;
}

/** Enveloppe d'erreur `{ error, message, details?, s3? }` ; `message` est en anglais, pour les journaux. */
export interface ApiError {
  error: ErrorCode;
  message: string;
  details?: ErrorDetails;
  s3?: { code: string; requestId?: string };
}
