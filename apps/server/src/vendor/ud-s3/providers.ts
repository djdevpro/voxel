import type { Addressing } from './types.js';

/**
 * Préréglages fournisseurs (P0 réduit) : adressage, mode de région, quirks
 * et limites utiles au moteur. Les a priori de capacités et la configuration des buckets
 * (07) viendront compléter ces profils.
 */

export type ProviderId = 'aws' | 'hetzner' | 'r2' | 'minio' | 'garage' | 'ceph' | 'rustfs' | 'generic';

export type ProviderQuirk =
  | 'path-style-required'
  | 'region-auto'
  | 'uniform-part-size'
  | 'copy-same-bucket-only'
  | 'bucket-names-no-dots'
  | 'no-post-policy'
  | 'dot-segment-unsafe'
  | 'mp-object-size';

export interface ProviderLimits {
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  maxObjectSize: number;
  maxPutSize: number;
  maxCopySize: number;
  maxPresignSeconds: number;
  maxKeys: number;
}

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Motifs d'hôtes (`*.suffixe` ou hôte exact). */
  hostPatterns: readonly string[];
  defaultAddressing: Addressing;
  regionMode: 'from-host' | 'auto' | 'explicit';
  /** Région par défaut quand l'utilisateur n'en donne pas. */
  defaultRegion: string;
  quirks: readonly ProviderQuirk[];
  limits: ProviderLimits;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

export const DEFAULT_LIMITS: ProviderLimits = {
  minPartSize: 5 * MIB,
  maxPartSize: 5 * GIB,
  maxParts: 10_000,
  maxObjectSize: 5 * TIB,
  maxPutSize: 5 * GIB,
  maxCopySize: 5 * GIB,
  maxPresignSeconds: 604_800,
  maxKeys: 1_000,
};

export const PROVIDER_PRESETS: Readonly<Record<ProviderId, ProviderPreset>> = {
  aws: {
    id: 'aws',
    label: 'Amazon S3',
    hostPatterns: ['s3.amazonaws.com', '*.amazonaws.com', '*.amazonaws.com.cn', '*.amazonaws.eu'],
    defaultAddressing: 'virtual',
    regionMode: 'from-host',
    defaultRegion: 'us-east-1',
    quirks: ['mp-object-size'],
    // 10 000 parties × 5 Gio.
    limits: { ...DEFAULT_LIMITS, maxObjectSize: 53_687_091_200_000 },
  },
  hetzner: {
    id: 'hetzner',
    label: 'Hetzner Object Storage',
    hostPatterns: ['*.your-objectstorage.com'],
    defaultAddressing: 'virtual',
    regionMode: 'from-host',
    defaultRegion: 'fsn1',
    quirks: ['copy-same-bucket-only', 'bucket-names-no-dots'],
    limits: { ...DEFAULT_LIMITS, maxObjectSize: 5_000_000_000_000 },
  },
  r2: {
    id: 'r2',
    label: 'Cloudflare R2',
    hostPatterns: ['*.r2.cloudflarestorage.com'],
    defaultAddressing: 'path',
    regionMode: 'auto',
    defaultRegion: 'auto',
    quirks: ['region-auto', 'uniform-part-size', 'no-post-policy'],
    limits: { ...DEFAULT_LIMITS },
  },
  minio: {
    id: 'minio',
    label: 'MinIO',
    hostPatterns: [],
    defaultAddressing: 'path',
    regionMode: 'explicit',
    defaultRegion: 'us-east-1',
    quirks: ['path-style-required'],
    limits: { ...DEFAULT_LIMITS },
  },
  garage: {
    id: 'garage',
    label: 'Garage',
    hostPatterns: [],
    defaultAddressing: 'path',
    regionMode: 'explicit',
    defaultRegion: 'garage',
    quirks: ['path-style-required'],
    limits: { ...DEFAULT_LIMITS },
  },
  ceph: {
    id: 'ceph',
    label: 'Ceph RGW',
    hostPatterns: [],
    defaultAddressing: 'path',
    regionMode: 'explicit',
    defaultRegion: 'us-east-1',
    quirks: ['path-style-required'],
    limits: { ...DEFAULT_LIMITS },
  },
  rustfs: {
    id: 'rustfs',
    label: 'RustFS',
    hostPatterns: [],
    defaultAddressing: 'path',
    regionMode: 'explicit',
    defaultRegion: 'us-east-1',
    // `dot-segment-unsafe` constaté sur RustFS 1.0.4 (test d'intégration) : signature sur le chemin brut.
    quirks: ['path-style-required', 'no-post-policy', 'dot-segment-unsafe'],
    limits: { ...DEFAULT_LIMITS },
  },
  generic: {
    id: 'generic',
    label: 'S3-compatible',
    hostPatterns: [],
    defaultAddressing: 'path',
    regionMode: 'explicit',
    defaultRegion: 'us-east-1',
    quirks: [],
    limits: { ...DEFAULT_LIMITS },
  },
};

function matchHostPattern(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/** Préréglage déduit de l'hôte du point de terminaison ; `generic` faute de mieux. */
export function detectProvider(endpoint: string): ProviderPreset {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return PROVIDER_PRESETS.generic;
  }
  for (const preset of Object.values(PROVIDER_PRESETS)) {
    if (preset.hostPatterns.some((pattern) => matchHostPattern(pattern, host))) return preset;
  }
  return PROVIDER_PRESETS.generic;
}

export function getProvider(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[id];
}
