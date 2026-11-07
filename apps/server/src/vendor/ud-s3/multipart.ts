import { S3Error } from './errors.js';
import { DEFAULT_LIMITS, type ProviderLimits } from './providers.js';

const MIB = 1024 * 1024;

/** Préférences de taille de partie. */
export const PART_SIZE_PREFERENCE = {
  browser: 8 * MIB,
  stream: 16 * MIB,
  copy: 512 * MIB,
} as const;

export interface PartPlan {
  partSize: number;
  partCount: number;
}

/**
 * Plan des parties : `max(préférence, ceil(taille / maxParts))` arrondi au Mio
 * supérieur, borné à `[min, max]` ; toutes les parties font `partSize` sauf la dernière.
 */
export function planParts(
  totalSize: number,
  preference: number = PART_SIZE_PREFERENCE.browser,
  limits: Pick<ProviderLimits, 'minPartSize' | 'maxPartSize' | 'maxParts'> = DEFAULT_LIMITS,
): PartPlan {
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new S3Error({ code: 'validation', reason: 'size_invalid', message: 'Size must be a non-negative integer' });
  }
  const min = Math.max(5 * MIB, limits.minPartSize);
  const max = Math.min(5 * 1024 * MIB, limits.maxPartSize);
  let partSize = Math.max(preference, Math.ceil(totalSize / limits.maxParts));
  partSize = Math.ceil(partSize / MIB) * MIB;
  partSize = Math.min(max, Math.max(min, partSize));
  const partCount = totalSize === 0 ? 1 : Math.ceil(totalSize / partSize);
  if (partCount > limits.maxParts) {
    throw new S3Error({
      code: 'entity_too_large',
      reason: 'provider_max',
      message: 'Object is too large for a multipart upload',
      details: { maxBytes: max * limits.maxParts },
    });
  }
  return { partSize, partCount };
}

export const MULTIPART: {
  minPartSize: number;
  maxPartSize: number;
  maxParts: number;
  choosePartSize(totalSize: number): number;
} = {
  minPartSize: DEFAULT_LIMITS.minPartSize,
  maxPartSize: DEFAULT_LIMITS.maxPartSize,
  maxParts: DEFAULT_LIMITS.maxParts,
  choosePartSize(totalSize: number): number {
    return planParts(totalSize).partSize;
  },
};
