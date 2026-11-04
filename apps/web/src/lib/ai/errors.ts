/**
 * Erreurs d'IA : codes, classement et messages traduits. Module léger (sans l'AI SDK) : l'arbre principal
 * l'importe sans charger le moteur IA.
 */
import i18n from '@/i18n';
import type { AiProvider } from './types';

export type AiErrorCode =
  | 'not_configured'
  | 'missing_key'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'bad_request'
  | 'tools_unsupported'
  | 'aborted'
  | 'unknown';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly params: Record<string, string> = {},
  ) {
    super(code);
    this.name = 'AiError';
  }
}

/** Champs utiles d'une `APICallError` de l'AI SDK, reconnue par son nom (sans importer le SDK). */
export interface ApiCallErrorLike {
  message: string;
  statusCode?: number;
  responseBody?: string;
  url: string;
}

export function isApiCallError(e: unknown): e is ApiCallErrorLike {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AI_APICallError';
}

export function hostOf(p: AiProvider): string {
  try {
    return new URL(p.baseUrl, location.origin).host;
  } catch {
    return p.baseUrl;
  }
}

function classify(e: unknown, provider: string, host: string): { code: AiErrorCode; params: Record<string, string>; detail?: string } {
  if (e instanceof AiError) return { code: e.code, params: { provider, host, ...e.params }, detail: e.params.detail };
  if (isApiCallError(e)) {
    const status = e.statusCode;
    if (!status) return { code: 'network', params: { provider, host } };
    if (status === 401 || status === 403) return { code: 'auth', params: { provider } };
    if (status === 404) return { code: 'not_found', params: { provider } };
    if (status === 429) return { code: 'rate_limited', params: { provider } };
    if (status === 400 || status === 422) {
      const detail = (e.responseBody ?? e.message).slice(0, 200);
      return { code: 'bad_request', params: { provider, detail }, detail };
    }
    if (status >= 500) return { code: 'server', params: { provider, status: String(status) } };
    return { code: 'unknown', params: {}, detail: e.message };
  }
  if (e instanceof TypeError && /fetch|NetworkError|Load failed/.test(e.message)) return { code: 'network', params: { provider, host } };
  if ((e instanceof DOMException || e instanceof Error) && e.name === 'AbortError') return { code: 'aborted', params: {} };
  return { code: 'unknown', params: {}, detail: e instanceof Error ? e.message : String(e) };
}

/** `AI_RetryError` (reconnue par son nom) → sa dernière erreur. */
function unwrapRetry(e: unknown): unknown {
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AI_RetryError') {
    const last = (e as { lastError?: unknown }).lastError;
    if (last !== undefined) return last;
  }
  return e;
}

/** Code, message traduit (`ai:errors.<code>`) et détail éventuel d'une erreur d'IA. */
export function describeAiError(error: unknown, p?: AiProvider): { code: AiErrorCode; message: string; detail?: string } {
  // après les nouvelles tentatives, l'erreur utile est la dernière (429, 5xx…)
  const e = unwrapRetry(error);
  const host = p ? hostOf(p) : isApiCallError(e) ? safeHost(e.url) : '';
  const provider = p?.name ?? host;
  const { code, params, detail } = classify(e, provider, host);
  return { code, message: i18n.t(`ai:errors.${code}`, params), ...(detail ? { detail } : {}) };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** "Qwen/Qwen3.6-35B-A3B-FP8" → "Qwen3.6-35B-A3B-FP8" */
export function shortModelName(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1) || id;
}
