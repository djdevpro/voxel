/**
 * Quota (RFC 9425) : choix du quota affiché, niveau d'alerte et mise en forme des tailles.
 * Module pur (Intl seulement).
 */
import type { Quota } from './types.ts';

/** Quota affiché : type `octets` de portée `account`, sinon le premier `octets`, sinon le premier. */
export function pickQuota(list: Quota[]): Quota | null {
  return (
    list.find((q) => q.resourceType === 'octets' && q.scope === 'account') ??
    list.find((q) => q.resourceType === 'octets') ??
    list[0] ??
    null
  );
}

export type QuotaLevel = 'ok' | 'warn' | 'danger';

/** Alerte à partir de 90 %, rouge à 98 %. */
export function quotaLevel(used: number, limit: number): QuotaLevel {
  if (!(limit > 0)) return 'ok';
  const r = used / limit;
  return r >= 0.98 ? 'danger' : r >= 0.9 ? 'warn' : 'ok';
}

export function quotaRatio(used: number, limit: number): number {
  return limit > 0 ? Math.min(Math.max(used / limit, 0), 1) : 0;
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** « 1,2 Go » en français, « 1.2 GB » en anglais (unités décimales de la langue, Intl.NumberFormat). */
export function formatBytes(n: number, locale: string): string {
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return new Intl.NumberFormat(locale, { style: 'unit', unit: UNITS[i], unitDisplay: 'short', maximumFractionDigits: digits }).format(v);
}
