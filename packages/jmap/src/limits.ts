/**
 * Limites de session JMAP (RFC 8620 §2) : lecture dans la session, sémaphore des requêtes en vol,
 * pointeurs JSON des références arrière (résolues côté client quand un lot est découpé).
 */
import { CAP, type Session } from './types.ts';
import { JmapError } from './client.ts';

/** Limites de session (RFC 8620 §2). Valeurs par défaut : minimums suggérés par la RFC, quand le serveur n'annonce rien d'utilisable. */
export interface SessionLimits {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxSizeUpload: 50_000_000,
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
};

/** Limites lues dans `capabilities["urn:ietf:params:jmap:core"]` ; un champ absent ou non entier positif prend sa valeur par défaut. */
export function limitsOf(session: Session | undefined): SessionLimits {
  const core = (session?.capabilities[CAP.core] ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(out) as (keyof SessionLimits)[]) {
    const v = core[k];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

/** Sémaphore FIFO dont le plafond peut changer (session rechargée). */
export class Semaphore {
  max: number;
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(max: number) {
    this.max = max;
  }

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.pump();
        });
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length && this.active < this.max) this.queue.shift()!();
  }
}

function unescapePointerToken(t: string): string {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** JSON Pointer avec l'extension `*` de JMAP (RFC 8620 §3.7) ; lève JmapError('…', 'invalidResultReference'). */
export function evalPointer(value: unknown, path: string): unknown {
  if (path === '' || path === '/') return value;
  if (!path.startsWith('/')) throw new JmapError(`bad path ${path}`, 'invalidResultReference');
  const tokens = path.slice(1).split('/').map(unescapePointerToken);
  const walk = (obj: unknown, toks: string[]): unknown => {
    if (!toks.length) return obj;
    const [t, ...rest] = toks as [string, ...string[]];
    if (Array.isArray(obj)) {
      if (t === '*') {
        const out: unknown[] = [];
        for (const item of obj) {
          const v = walk(item, rest);
          if (Array.isArray(v)) out.push(...v);
          else out.push(v);
        }
        return out;
      }
      const i = Number(t);
      if (!Number.isInteger(i) || i < 0 || i >= obj.length) throw new JmapError(`index ${t} out of range`, 'invalidResultReference');
      return walk(obj[i], rest);
    }
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, t)) return walk((obj as Record<string, unknown>)[t], rest);
    throw new JmapError(`path ${path} not found`, 'invalidResultReference');
  };
  return walk(value, tokens);
}

/** Erreur de limite levée par le client avant tout envoi. */
export function limitError(limit: keyof SessionLimits): JmapError {
  return new JmapError(`Request exceeds ${limit}`, 'urn:ietf:params:jmap:error:limit', undefined, { type: 'urn:ietf:params:jmap:error:limit', limit });
}
