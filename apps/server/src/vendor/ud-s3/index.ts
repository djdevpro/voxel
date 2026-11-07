// @ud/s3 : moteur S3 serveur pour Node 24 (P0).
export type {
  Addressing,
  CreateS3Options,
  DeleteObjectsResult,
  FileItem,
  FolderItem,
  ListPage,
  ObjectHead,
  S3Credentials,
  SignedRequest,
  UdS3,
} from './types.js';
export { createS3 } from './client.js';
export {
  S3Error,
  toS3Error,
  sanitizeText,
  parseRetryAfter,
  type S3ErrorContext,
  type S3ErrorInit,
  type S3ErrorOrigin,
} from './errors.js';
export { MULTIPART, PART_SIZE_PREFERENCE, planParts, type PartPlan } from './multipart.js';
export {
  DEFAULT_LIMITS,
  PROVIDER_PRESETS,
  detectProvider,
  getProvider,
  type ProviderId,
  type ProviderLimits,
  type ProviderPreset,
  type ProviderQuirk,
} from './providers.js';
export {
  BAD_PORTS,
  classifyAddress,
  classifyHostname,
  createPinnedLookup,
  isAddressAllowed,
  parseAllowedEndpoints,
  validateEndpoint,
  type AddressVerdict,
  type GuardedEndpoint,
  type NetguardOptions,
  type NetguardReason,
} from './netguard.js';
export {
  contentDisposition,
  copySource,
  decodeCursor,
  encodeCursor,
  nameOf,
  transformListPage,
  type RawListOutput,
} from './list.js';
